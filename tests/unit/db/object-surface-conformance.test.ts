import { describe, test, expect } from "bun:test";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";

function fakeProvider(overrides: Record<string, unknown> = {}) {
  return {
    getCapabilities: () => ({
      queryLanguage: "sql",
      containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
      objectKinds: [
        { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
        { id: "view", role: "relation", label: "View", labelPlural: "Views" },
      ],
    }),
    listContainers: async () => [{ path: ["app"], name: "app", level: 0 }],
    countObjects: async () => ({ table: { count: 2 }, view: { count: 4 } }),
    listObjects: async (_c: readonly string[], kind: string) =>
      kind === "view"
        ? [{ path: ["app", "order_summary"], name: "order_summary", kind: "view" }]
        : [{ path: ["app", "orders"], name: "orders", kind }],
    describeObject: async (path: readonly string[]) => ({ path, columns: [], indexes: [], foreignKeys: [] }),
    ...overrides,
  };
}

describe("assertObjectSurface", () => {
  test("passes a provider whose four methods agree with its declarations", async () => {
    await assertObjectSurface(fakeProvider() as never, {
      containers: [["app"]],
      kinds: { table: 2, view: 4 },
      sampleObject: { path: ["app", "order_summary"], kind: "view" },
    });
  });

  test("rejects a count for a kind the provider never declared", async () => {
    const provider = fakeProvider({ countObjects: async () => ({ package: { count: 1 } }) });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        kinds: { package: 1 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/undeclared kind "package"/);
  });

  test("rejects an object whose path does not start with its container", async () => {
    const provider = fakeProvider({
      listObjects: async (_c: readonly string[], kind: string) => [{ path: ["other", "x"], name: "x", kind }],
    });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        kinds: { table: 2, view: 4 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/path \["other","x"\] is not inside container \["app"\]/);
  });

  test("rejects a kind declared with no counterpart in countObjects", async () => {
    const provider = fakeProvider({ countObjects: async () => ({ table: { count: 2 } }) });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        kinds: { table: 2 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/declared kind "view" is missing from countObjects/);
  });

  // Not in the task brief. Five of the engines this helper is written for declare no
  // container level at all, so `expected.containers` is empty and every object is
  // addressed at the root container `[]`. That is the arm the `?? []` fallback exists
  // for, and no test in the brief reaches it.
  test("an engine with no container level reads its objects at the root container", async () => {
    const provider = fakeProvider({
      getCapabilities: () => ({
        queryLanguage: "sql",
        objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
      }),
      listContainers: async () => [],
      countObjects: async (container: readonly string[]) => {
        expect(container).toEqual([]);
        return { table: { count: 1 } };
      },
      listObjects: async () => [{ path: ["users"], name: "users", kind: "table" }],
    });
    await assertObjectSurface(provider as never, {
      containers: [],
      kinds: { table: 1 },
      sampleObject: { path: ["users"], kind: "table" },
    });
  });

  // Not in the task brief. A refused read is the third state `KindCount` exists to
  // carry, and a provider that reports it where the expectation names a number has not
  // met the expectation: the engine's own sentence has to reach the failure message
  // rather than being compared against a number as if it were zero.
  test("rejects a refused count and carries the engine's own sentence into the failure", async () => {
    const provider = fakeProvider({
      countObjects: async () => ({
        table: { unavailable: "permission denied for schema app" },
        view: { count: 4 },
      }),
    });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        kinds: { table: 2, view: 4 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/kind "table" was unavailable: permission denied for schema app/);
  });

  // The vacuity the Task 2 review measured: this provider declares `view`, reports four
  // of them, and lists none. The first version of this helper certified it, because the
  // path loop iterated zero times and describeObject was handed a path the TEST AUTHOR
  // typed rather than one the provider produced.
  test("rejects a provider that counts a kind and then lists nothing of it", async () => {
    const provider = fakeProvider({
      listObjects: async (_c: readonly string[], kind: string) =>
        kind === "view" ? [] : [{ path: ["app", "orders"], name: "orders", kind }],
    });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        kinds: { table: 2, view: 4 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/countObjects reported 4 of kind "view" and listObjects returned none/);
  });

  // The same hole with one object in the list: the sample has to be THAT object.
  test("rejects a listing that does not contain the expected sample", async () => {
    const provider = fakeProvider({
      listObjects: async (_c: readonly string[], kind: string) =>
        kind === "view"
          ? [{ path: ["app", "daily_sales"], name: "daily_sales", kind: "view" }]
          : [{ path: ["app", "orders"], name: "orders", kind }],
    });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        kinds: { table: 2, view: 4 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/did not return the expected sample .*it returned \[\["app","daily_sales"\]\]/);
  });

  // Asserted by IDENTITY, not by value. A deep-equality assertion here would pass against
  // the old helper too, because the path a test types and the path a provider returns are
  // equal arrays when the provider is correct - which is exactly why the vacuity survived
  // review. Only reference identity can tell "the provider produced this" from "the test
  // author typed this".
  test("hands describeObject the path listObjects produced, not the one the test typed", async () => {
    const listed = [
      { path: ["app", "order_summary"], name: "order_summary", kind: "view" },
      { path: ["app", "daily_sales"], name: "daily_sales", kind: "view" },
    ];
    const asked: (readonly string[])[] = [];
    const askedKinds: string[] = [];
    const provider = fakeProvider({
      listObjects: async (_c: readonly string[], kind: string) =>
        kind === "view" ? listed : [{ path: ["app", "orders"], name: "orders", kind }],
      describeObject: async (path: readonly string[], kind: string) => {
        asked.push(path);
        askedKinds.push(kind);
        return { path, columns: [], indexes: [], foreignKeys: [] };
      },
    });
    const typed = ["app", "order_summary"];
    await assertObjectSurface(provider as never, {
      containers: [["app"]],
      kinds: { table: 2, view: 4 },
      sampleObject: { path: typed, kind: "view" },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe(listed[0].path);
    expect(asked[0]).not.toBe(typed);
    // The kind travels with the path, so a provider never has to infer what it holds
    // from what the name happens to match.
    expect(askedKinds).toEqual(["view"]);
  });

  // A tree addresses by path, so two objects sharing one is two rows it cannot tell
  // apart. This is what an engine that identifies a routine by name AND signature does
  // when a provider lists `proname` alone.
  test("rejects two objects in one listing that share a path", async () => {
    const provider = fakeProvider({
      listObjects: async (_c: readonly string[], kind: string) =>
        kind === "view"
          ? [
              { path: ["app", "order_total"], name: "order_total", kind: "view" },
              { path: ["app", "order_total"], name: "order_total", kind: "view" },
            ]
          : [{ path: ["app", "orders"], name: "orders", kind }],
    });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        kinds: { table: 2, view: 4 },
        sampleObject: { path: ["app", "order_total"], kind: "view" },
      }),
    ).rejects.toThrow(/two objects of kind "view" both answer the path \["app","order_total"\]/);
  });

  // `name` labels and `path` addresses, and they are allowed to differ: an overloaded
  // PostgreSQL routine is `["app", "order_total(integer)"]` shown as `order_total`. The
  // helper used to assert they were equal, which would now fail a correct provider.
  test("accepts an object whose name is not its last path segment", async () => {
    const provider = fakeProvider({
      listObjects: async (_c: readonly string[], kind: string) =>
        kind === "view"
          ? [
              { path: ["app", "order_total(integer)"], name: "order_total", kind: "view" },
              { path: ["app", "order_total(text)"], name: "order_total", kind: "view" },
            ]
          : [{ path: ["app", "orders"], name: "orders", kind }],
    });
    await assertObjectSurface(provider as never, {
      containers: [["app"]],
      kinds: { table: 2, view: 4 },
      sampleObject: { path: ["app", "order_total(text)"], kind: "view" },
    });
  });

  // The vacuity one kind narrower, and the third appearance of this defect class in the
  // epic. listObjects used to be called ONCE, for the sample's kind, so a provider that
  // declared seven kinds, counted seven and listed nothing for six of them was certified.
  test("rejects a provider that counts a kind it is not the sample of and lists none of it", async () => {
    const provider = fakeProvider({
      listObjects: async (_c: readonly string[], kind: string) =>
        kind === "view" ? [{ path: ["app", "order_summary"], name: "order_summary", kind: "view" }] : [],
    });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        kinds: { table: 2, view: 4 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/countObjects reported 2 of kind "table" and listObjects returned none/);
  });

  // A kind expected to hold nothing is the one case where listing nothing is right, so it
  // is skipped rather than demanded.
  test("does not demand a listing for a kind expected to hold nothing", async () => {
    const asked: string[] = [];
    const provider = fakeProvider({
      countObjects: async () => ({ table: { count: 0 }, view: { count: 4 } }),
      listObjects: async (_c: readonly string[], kind: string) => {
        asked.push(kind);
        return kind === "view" ? [{ path: ["app", "order_summary"], name: "order_summary", kind: "view" }] : [];
      },
    });
    await assertObjectSurface(provider as never, {
      containers: [["app"]],
      kinds: { table: 0, view: 4 },
      sampleObject: { path: ["app", "order_summary"], kind: "view" },
    });
    expect(asked).toEqual(["view"]);
  });

  // Uniqueness is WITHIN a kind, not across kinds, and the relaxation is deliberate.
  // `DatabaseObject.path` promises a segment unique within its PARENT, and a tree row is
  // identified by path plus kind id, not by path alone - `describeObject` takes the kind
  // for the same reason. MySQL is expected to be exactly this engine: its stored routines
  // live in a namespace separate from its tables, so a table and a procedure may share a
  // name in one schema, and asserting across kinds would report that as a provider defect.
  test("accepts one path answered by two different kinds", async () => {
    const provider = fakeProvider({
      listObjects: async (_c: readonly string[], kind: string) => [
        { path: ["app", "order_summary"], name: "order_summary", kind },
      ],
    });
    await assertObjectSurface(provider as never, {
      containers: [["app"]],
      kinds: { table: 2, view: 4 },
      sampleObject: { path: ["app", "order_summary"], kind: "view" },
    });
  });

  // The other direction of the same relaxation: within ONE kind a shared path is still two
  // rows a tree cannot tell apart, because kind no longer distinguishes them.
  test("still rejects two objects of the SAME kind sharing a path", async () => {
    const provider = fakeProvider({
      listObjects: async (_c: readonly string[], kind: string) =>
        kind === "table"
          ? [
              { path: ["app", "orders"], name: "orders", kind: "table" },
              { path: ["app", "orders"], name: "orders", kind: "table" },
            ]
          : [{ path: ["app", "order_summary"], name: "order_summary", kind }],
    });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        kinds: { table: 2, view: 4 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/two objects of kind "table" both answer the path \["app","orders"\]/);
  });

  test("rejects a listing whose objects carry a kind other than the one requested", async () => {
    const provider = fakeProvider({
      listObjects: async () => [{ path: ["app", "orders"], name: "orders", kind: "table" }],
    });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        kinds: { view: 4 },
        sampleObject: { path: ["app", "orders"], kind: "view" },
      }),
    ).rejects.toThrow(/listObjects\("view"\) returned an object of kind "table"/);
  });

  // The sample's kind need not be one the expectation counts, so it is listed on its own
  // when the per-kind loop did not already reach it.
  test("lists the sample's kind even when the expectation does not count it", async () => {
    const asked: string[] = [];
    const provider = fakeProvider({
      listObjects: async (_c: readonly string[], kind: string) => {
        asked.push(kind);
        return kind === "view"
          ? [{ path: ["app", "order_summary"], name: "order_summary", kind: "view" }]
          : [{ path: ["app", "orders"], name: "orders", kind }];
      },
    });
    await assertObjectSurface(provider as never, {
      containers: [["app"]],
      kinds: { table: 2 },
      sampleObject: { path: ["app", "order_summary"], kind: "view" },
    });
    expect(asked).toEqual(["table", "view"]);
  });

  // One level up, and the same defect: with nothing declared, both kind loops iterate
  // zero times and the helper certifies a provider that declares no object model at all.
  // Derived from emptiness, never pinned to a number - a count here would have to be
  // edited per engine and would then be asserting the engine's inventory, not this
  // contract.
  test("rejects a provider that declares no object kinds", async () => {
    const provider = fakeProvider({
      getCapabilities: () => ({ queryLanguage: "sql", objectKinds: [] }),
    });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        kinds: { table: 2 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/declares no object kinds/);
  });

  test("rejects an expectation that names no kinds", async () => {
    await expect(
      assertObjectSurface(fakeProvider() as never, {
        containers: [["app"]],
        kinds: {},
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/names no kinds/);
  });

  // Not in the task brief. This is the caller's own mistake rather than a provider
  // defect, and it is the one a per-engine caller actually makes: a kind id typed into
  // the expectation that this engine never declares. Without the explicit throw it
  // surfaces as `Cannot use 'in' operator ... in undefined`, which names neither the
  // kind nor the expectation.
  test("rejects an expectation naming a kind that countObjects never answered for", async () => {
    await expect(
      assertObjectSurface(fakeProvider() as never, {
        containers: [["app"]],
        kinds: { materialized_view: 1 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/countObjects returned nothing for expected kind "materialized_view"/);
  });
});
