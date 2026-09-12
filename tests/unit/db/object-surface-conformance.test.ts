import { describe, test, expect } from "bun:test";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
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
    // The FLAT reading, spelled the way an engine's display rule spells it: the default
    // container is dropped, which is exactly the spelling the join has to resolve.
    getSchema: async () => [
      { name: "orders", columns: [], indexes: [] },
      { name: "order_summary", columns: [], indexes: [] },
    ],
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

  /**
   * WHICH container the contract runs in, where the first one the engine answers is not
   * the one holding its objects (#789).
   *
   * Druid is why. It publishes five schemas and the server orders them by name, so
   * `containers[0]` is `INFORMATION_SCHEMA`: the contract ran against four system tables
   * while the datasources a person came for sat in `druid`, and the flat reading, which
   * `getSchema()` scopes to `TABLE_SCHEMA = 'druid'`, then shared no name with the listing
   * and the join was vacuous on a provider whose join is fine.
   *
   * It is additive and defaults to `containers[0]`, so no other expectation changes, and
   * it is not a way out of a red: the container named still has to be one the provider
   * ANSWERED, which is what the next test pins.
   */
  test("the contract runs in the container the expectation names, not in the first one listed", async () => {
    const provider = fakeProvider({
      listContainers: async () => [
        { path: ["INFORMATION_SCHEMA"], name: "INFORMATION_SCHEMA", level: 0 },
        { path: ["app"], name: "app", level: 0, isSessionDefault: true },
      ],
      countObjects: async (container: readonly string[]) => {
        expect(container).toEqual(["app"]);
        return { table: { count: 2 }, view: { count: 4 } };
      },
      // The other container holds its own objects, and the fake has to say so. The join
      // resolves against every container the provider answered, so a fake that returned
      // `app`'s rows whatever it was asked for would put two `["app","orders"]` in one pool
      // and report a correct provider as ambiguous.
      listObjects: async (container: readonly string[], kind: string) =>
        container[0] === "app"
          ? kind === "view"
            ? [{ path: ["app", "order_summary"], name: "order_summary", kind: "view" }]
            : [{ path: ["app", "orders"], name: "orders", kind }]
          : [{ path: ["INFORMATION_SCHEMA", `columns_${kind}`], name: `columns_${kind}`, kind }],
    });
    await assertObjectSurface(provider as never, {
      containers: [["INFORMATION_SCHEMA"], ["app"]],
      container: ["app"],
      kinds: { table: 2, view: 4 },
      sampleObject: { path: ["app", "order_summary"], kind: "view" },
    });
  });

  test("rejects an expectation naming a container the provider never answered", async () => {
    await expect(
      assertObjectSurface(fakeProvider() as never, {
        containers: [["app"]],
        container: ["warehouse"],
        kinds: { table: 2, view: 4 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/the expectation names the container \["warehouse"\], which listContainers did not answer/);
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
      getSchema: async () => [{ name: "users", columns: [], indexes: [] }],
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
    // Spelled as MySQL's own case rather than as two relations, because the flat-join
    // invariant below now reads the relation kinds: a table and a VIEW sharing one address
    // really cannot be joined from a flat name, and refusing that is correct. A table and a
    // PROCEDURE sharing one is the engine behaviour this relaxation exists for, and the
    // flat reading holds relations only, so the join is untroubled by it.
    const provider = fakeProvider({
      getCapabilities: () => ({
        queryLanguage: "sql",
        containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
        objectKinds: [
          { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
          { id: "procedure", role: "routine", label: "Procedure", labelPlural: "Procedures" },
        ],
      }),
      countObjects: async () => ({ table: { count: 2 }, procedure: { count: 4 } }),
      listObjects: async (_c: readonly string[], kind: string) => [
        { path: ["app", "order_summary"], name: "order_summary", kind },
      ],
      getSchema: async () => [{ name: "order_summary", columns: [], indexes: [] }],
    });
    await assertObjectSurface(provider as never, {
      containers: [["app"]],
      kinds: { table: 2, procedure: 4 },
      sampleObject: { path: ["app", "order_summary"], kind: "procedure" },
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

/**
 * The fifth method (#789). A provider that does not declare `describeObjects` is skipped
 * entirely, which is why every test above still describes a four-method fake: sixteen
 * providers are in that state while the bulk read lands one family at a time.
 */
/**
 * The invariant that ties a provider's FLAT spelling to its object path (#789).
 *
 * `tagObjectKinds` had one unit test file of hand-written fixtures and no integration
 * caller, so the join the object browser actually renders was asserted by nobody and a
 * provider whose two readings cannot be joined looked healthy from both sides. These are
 * the helper's own tests, which are the only thing that guards the helper's strictness: a
 * correct provider passes a weak check, so a green provider suite says nothing about this.
 */
describe("assertObjectSurface ties the flat reading to the object paths", () => {
  const expectation = {
    containers: [["app"]],
    kinds: { table: 2, view: 4 },
    sampleObject: { path: ["app", "order_summary"], kind: "view" },
  };

  test("rejects a flat name no listed object's address ends with", async () => {
    // Trino's defect, in the small: every flat name spelled against paths it is not a
    // suffix of, so not one object joined while both readings looked complete.
    const provider = fakeProvider({
      getSchema: async () => [{ name: "warehouse.orders", columns: [], indexes: [] }],
      listObjects: async (_c: readonly string[], kind: string) => [{ path: ["app", "orders"], name: "orders", kind }],
    });
    await expect(
      assertObjectSurface(provider as never, {
        ...expectation,
        sampleObject: { path: ["app", "orders"], kind: "view" },
      }),
    ).rejects.toThrow(/spells an object "warehouse.orders" and the object reading cannot be joined on it/);
  });

  test("rejects a flat name two listed objects answer to", async () => {
    const provider = fakeProvider({
      getSchema: async () => [{ name: "orders", columns: [], indexes: [] }],
      listObjects: async (_c: readonly string[], kind: string) =>
        kind === "view"
          ? [{ path: ["app", "sales", "orders"], name: "orders", kind }]
          : [{ path: ["app", "ops", "orders"], name: "orders", kind }],
    });
    await expect(
      assertObjectSurface(provider as never, {
        ...expectation,
        sampleObject: { path: ["app", "sales", "orders"], kind: "view" },
      }),
    ).rejects.toThrow(/2 listed objects answer to it/);
  });

  test("rejects a provider whose flat reading is empty, rather than certifying a vacuous join", async () => {
    // The zero-iteration case: with no flat entries the loop below never runs and every
    // provider passes. This helper has been vacuous three times in this epic already.
    const provider = fakeProvider({ getSchema: async () => [] });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(/getSchema answered no objects/);
  });

  test("rejects two readings of two different populations", async () => {
    // Non-empty on both sides and sharing nothing, which is a fixture that never put one
    // object in front of both surfaces. It certifies nothing and it must not look green.
    const provider = fakeProvider({ getSchema: async () => [{ name: "elsewhere", columns: [], indexes: [] }] });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /name no object in common, so this join is vacuous/,
    );
  });

  test("rejects a provider that listed nothing of a relation kind", async () => {
    const provider = fakeProvider({
      getCapabilities: () => ({
        queryLanguage: "sql",
        containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
        objectKinds: [{ id: "sequence", role: "config", label: "Sequence", labelPlural: "Sequences" }],
      }),
      countObjects: async () => ({ sequence: { count: 1 } }),
      listObjects: async () => [{ path: ["app", "order_seq"], name: "order_seq", kind: "sequence" }],
    });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        kinds: { sequence: 1 },
        sampleObject: { path: ["app", "order_seq"], kind: "sequence" },
      }),
    ).rejects.toThrow(/no listing above is of a relation kind/);
  });

  test("the session default container breaks a tie, exactly as the app's join does", async () => {
    // Not a re-derivation of the rule: the preferred container comes from
    // `enumerateContainers`, the same walk `/api/db/objects/inventory` reads the default
    // off, so a provider that marks `isSessionDefault` is joined here the way it is in the
    // browser. TWO LEVELS, because that is the only shape where this arm is reachable: a
    // two-level engine listed at its CATALOG answers objects from every schema under it, so
    // a bare flat name really does tie across containers. Measured: DuckDB and Couchbase
    // both go red the moment the container stops being passed.
    const provider = fakeProvider({
      getCapabilities: () => ({
        queryLanguage: "sql",
        containerLevels: [
          { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
          { id: "schema", label: "Schema", labelPlural: "Schemas" },
        ],
        objectKinds: [
          { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
          { id: "view", role: "relation", label: "View", labelPlural: "Views" },
        ],
      }),
      listContainers: async (parent?: readonly string[]) =>
        parent === undefined
          ? [{ path: ["main"], name: "main", level: 0, isSessionDefault: true }]
          : [
              { path: [...parent, "app"], name: "app", level: 1, isSessionDefault: true },
              { path: [...parent, "archive"], name: "archive", level: 1 },
            ],
      countObjects: async () => ({ table: { count: 2 }, view: { count: 4 } }),
      listObjects: async (_c: readonly string[], kind: string) =>
        kind === "view"
          ? [{ path: ["main", "archive", "orders"], name: "orders", kind }]
          : [{ path: ["main", "app", "orders"], name: "orders", kind }],
      getSchema: async () => [{ name: "orders", columns: [], indexes: [] }],
    });

    await assertObjectSurface(provider as never, {
      containers: [["main"]],
      kinds: { table: 2, view: 4 },
      sampleObject: { path: ["main", "app", "orders"], kind: "table" },
    });
  });

  /**
   * The two tests below are one pair, and they are what closes the hole the wave that added
   * this join MEASURED in it (#789).
   *
   * The hole: on a fixture with ONE container a bare flat name is a valid suffix of every
   * address, so it always resolves and the guard proved the join returns SOMETHING rather
   * than the right object. Respelling PostgreSQL's `app` rows as if they sat in `public`,
   * which drops the qualifier the engine really emits, still passed.
   *
   * What closes it is that the pool is now every container `listContainers` ANSWERED, not
   * just the contract's, plus INJECTIVITY: two flat rows landing on one object is the
   * doubled header the join exists to prevent, and it is precisely what a dropped qualifier
   * produces. The first test is the correct provider, where the tie-breaker is the thing
   * doing the work; the second is the same provider with the qualifier dropped.
   */
  const twoSchemas = {
    listContainers: async () => [
      { path: ["app"], name: "app", level: 0, isSessionDefault: false },
      { path: ["public"], name: "public", level: 0, isSessionDefault: true },
    ],
    countObjects: async () => ({ table: { count: 1 }, view: { count: 0 } }),
    listObjects: async (container: readonly string[], kind: string) =>
      kind === "table" ? [{ path: [container[0], "orders"], name: "orders", kind }] : [],
  };
  const twoSchemasExpectation = {
    containers: [["app"], ["public"]],
    kinds: { table: 1, view: 0 },
    sampleObject: { path: ["app", "orders"], kind: "table" },
  };

  test("joins a flat name against every container the provider answered, and the default decides the bare one", async () => {
    const provider = fakeProvider({
      ...twoSchemas,
      // The engine's own spelling: the session default container is dropped and every other
      // one is kept, which is what postgres.ts does with `public`.
      getSchema: async () => [
        { name: "app.orders", columns: [], indexes: [] },
        { name: "orders", columns: [], indexes: [] },
      ],
    });

    await assertObjectSurface(provider as never, twoSchemasExpectation);
  });

  test("rejects two flat names that both join onto one object", async () => {
    const provider = fakeProvider({
      ...twoSchemas,
      // The defect: the qualifier is dropped for BOTH schemas, so the two rows are one
      // string twice. Each resolves on its own - a bare name is a suffix of both addresses
      // and the default breaks the tie - and the pair cannot address two objects.
      getSchema: async () => [
        { name: "orders", columns: [], indexes: [] },
        { name: "orders", columns: [], indexes: [] },
      ],
    });

    await expect(assertObjectSurface(provider as never, twoSchemasExpectation)).rejects.toThrow(
      /both join onto the same listed object \["public","orders"\]/,
    );
  });
});

describe("assertObjectSurface and the bulk column read", () => {
  const listed: Record<string, { path: readonly string[]; name: string; kind: string }[]> = {
    table: [
      { path: ["app", "orders"], name: "orders", kind: "table" },
      { path: ["app", "products"], name: "products", kind: "table" },
    ],
    view: [{ path: ["app", "order_summary"], name: "order_summary", kind: "view" }],
  };

  function detailsFor(kind: string) {
    return (listed[kind] ?? []).map((object) => ({
      path: object.path,
      columns: [],
      indexes: [],
      foreignKeys: [],
    }));
  }

  function bulkProvider(overrides: Record<string, unknown> = {}) {
    return fakeProvider({
      listObjects: async (_c: readonly string[], kind: string) => listed[kind] ?? [],
      describeObjects: async (_c: readonly string[], kind: string, limit?: number) => {
        const all = detailsFor(kind);
        if (limit !== undefined && all.length > limit) {
          return { details: all.slice(0, limit), truncated: { limit, reason: callerBoundTruncationReason(limit) } };
        }
        return { details: all };
      },
      ...overrides,
    });
  }

  const expectation = {
    containers: [["app"]],
    kinds: { table: 2, view: 4 },
    sampleObject: { path: ["app", "order_summary"], kind: "view" },
  };

  test("passes a provider whose bulk read describes exactly what it listed", async () => {
    await assertObjectSurface(bulkProvider() as never, expectation);
  });

  // Property 2 of the ruling: keyed by PATH, never by a joined name. A provider that
  // answers `"app.orders"` matches nothing the listing named, and this is the assertion
  // that says so rather than letting the caller's join quietly return zero columns.
  test("rejects a column set for an object listObjects never named", async () => {
    const provider = bulkProvider({
      describeObjects: async () => ({
        details: [{ path: ["app.orders"], columns: [], indexes: [], foreignKeys: [] }],
      }),
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /describeObjects\("table"\) answered for \["app.orders"\], which listObjects did not name/,
    );
  });

  test("rejects two column sets answering to one path", async () => {
    const provider = bulkProvider({
      describeObjects: async (_c: readonly string[], kind: string) => {
        const all = detailsFor(kind);
        return { details: kind === "table" ? [all[0], all[0]] : all };
      },
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /describeObjects\("table"\) answered twice for \["app","orders"\]/,
    );
  });

  // The vacuity this block would otherwise have: every loop over `details` iterates zero
  // times for a provider that answers `{ details: [] }` everywhere, so each assertion
  // above passes and nothing has been checked.
  test("rejects a provider that describes nothing for any kind it listed", async () => {
    const provider = bulkProvider({ describeObjects: async () => ({ details: [] }) });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /describeObjects answered no column set for any listed kind/,
    );
  });

  // Property 3: it reports its own truncation. A provider that silently returns one of
  // two objects is the #414 defect, and the only way to see it is to bound a read whose
  // unbounded answer is already known to be larger.
  test("rejects a bounded read that stops short and says nothing", async () => {
    const provider = bulkProvider({
      describeObjects: async (_c: readonly string[], kind: string, limit?: number) => ({
        details: limit === undefined ? detailsFor(kind) : detailsFor(kind).slice(0, limit),
      }),
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /describeObjects\("table", limit 1\) returned 1 of 2 column sets and reported no truncation/,
    );
  });

  test("rejects a bounded read that returns more than the bound it reports", async () => {
    const provider = bulkProvider({
      describeObjects: async (_c: readonly string[], kind: string, limit?: number) =>
        limit === undefined
          ? { details: detailsFor(kind) }
          : { details: detailsFor(kind), truncated: { limit, reason: callerBoundTruncationReason(limit) } },
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /describeObjects\("table"\) reported a limit of 1 and returned 2 column sets/,
    );
  });

  // One sentence for one event, across every engine (#789). A non-empty reason was the old
  // bar, and eleven implementers cleared it with three unrelated phrasings, so the same
  // bound read three ways depending on which engine was open. This is the check that makes
  // the twelfth follow the eleven rather than inventing a fourth.
  test("rejects a caller-bounded batch whose reason is not the shared sentence", async () => {
    const provider = bulkProvider({
      describeObjects: async (_c: readonly string[], kind: string, limit?: number) => {
        const all = detailsFor(kind);
        if (limit !== undefined && all.length > limit) {
          return { details: all.slice(0, limit), truncated: { limit, reason: "column read limit reached" } };
        }
        return { details: all };
      },
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /reported "column read limit reached", which does not carry the one sentence a caller's bound is reported with/,
    );
  });

  // A provider with a SECOND bound of its own names both, so the guard asks for CONTAINS
  // and never for equality: redis and libredb join the caller's sentence to their scan
  // bound's, and an equality check would fail both of them for being more informative.
  test("accepts a reason that carries the shared sentence inside a composed one", async () => {
    const provider = bulkProvider({
      describeObjects: async (_c: readonly string[], kind: string, limit?: number) => {
        const all = detailsFor(kind);
        if (limit !== undefined && all.length > limit) {
          return {
            details: all.slice(0, limit),
            truncated: { limit, reason: `${callerBoundTruncationReason(limit)}, and the key walk stopped early` },
          };
        }
        return { details: all };
      },
    });
    await assertObjectSurface(provider as never, expectation);
  });

  test("rejects a truncation carrying no reason a person can read", async () => {
    const provider = bulkProvider({
      describeObjects: async (_c: readonly string[], kind: string, limit?: number) => {
        const all = detailsFor(kind);
        if (limit !== undefined && all.length > limit) {
          return { details: all.slice(0, limit), truncated: { limit, reason: "" } };
        }
        return { details: all };
      },
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /describeObjects\("table"\) reported truncation with no reason/,
    );
  });

  // The bar is on the FIXTURE, and it is stated rather than skipped: with one object of
  // every kind, a limit of 1 returns everything and the truncation check can only pass.
  test("rejects a fixture too small to exercise the bound", async () => {
    const single = { table: [listed.table[0]], view: listed.view };
    const provider = bulkProvider({
      listObjects: async (_c: readonly string[], kind: string) => single[kind as keyof typeof single] ?? [],
      describeObjects: async (_c: readonly string[], kind: string) => ({
        details: (single[kind as keyof typeof single] ?? []).map((object) => ({
          path: object.path,
          columns: [],
          indexes: [],
          foreignKeys: [],
        })),
      }),
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /no kind holds two objects, so a bounded read cannot be told from an unbounded one/,
    );
  });

  // The container and kind the bulk read is asked for are the ones that were listed, not
  // a pair the helper composed: a provider answering for a different container would
  // otherwise satisfy every path check by accident on a single-container fixture.
  test("asks the bulk read for the same container and kind it listed", async () => {
    const asked: { container: readonly string[]; kind: string; limit?: number }[] = [];
    const provider = bulkProvider({
      describeObjects: async (container: readonly string[], kind: string, limit?: number) => {
        asked.push({ container, kind, limit });
        const all = detailsFor(kind);
        if (limit !== undefined && all.length > limit) {
          return { details: all.slice(0, limit), truncated: { limit, reason: callerBoundTruncationReason(limit) } };
        }
        return { details: all };
      },
    });
    await assertObjectSurface(provider as never, expectation);
    expect(asked).toEqual([
      { container: ["app"], kind: "table", limit: undefined },
      { container: ["app"], kind: "view", limit: undefined },
      { container: ["app"], kind: "table", limit: 1 },
    ]);
  });
});
