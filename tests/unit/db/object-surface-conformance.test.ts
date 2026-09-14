import { describe, test, expect } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { applySourceBound, callerBoundTruncationReason, sourceBoundTruncationReason } from "@/lib/db/object-kinds";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";

function fakeProvider(overrides: Record<string, any> = {}) {
  const base = {
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
    // Two tables and one view, because the bulk-read guard needs a kind holding TWO objects:
    // a limit of 1 against a kind holding one returns the whole answer, and a provider that
    // stops short silently could not then be told from one that reports its bound.
    listObjects: async (_c: readonly string[], kind: string) =>
      kind === "view"
        ? [{ path: ["app", "order_summary"], name: "order_summary", kind: "view" }]
        : [
            { path: ["app", "orders"], name: "orders", kind },
            { path: ["app", "customers"], name: "customers", kind },
          ],
    describeObject: async (path: readonly string[]) => ({ path, columns: [], indexes: [], foreignKeys: [] }),
    ...overrides,
  };
  // DERIVED from whatever `listObjects` this fake ended up with, rather than written out
  // beside it: every test that overrides the listing would otherwise have to override the
  // bulk read in step, and a double whose two halves disagree fails the guard for a reason
  // that has nothing to do with what the test is about.
  return {
    ...base,
    describeObjects:
      overrides.describeObjects ??
      (async (container: readonly string[], kind: string, limit?: number) => {
        const listed = (await base.listObjects(container, kind)) as { path: readonly string[] }[];
        const kept = limit === undefined ? listed : listed.slice(0, limit);
        return {
          details: kept.map((object) => ({ path: object.path, columns: [], indexes: [], foreignKeys: [] })),
          ...(kept.length < listed.length
            ? { truncated: { limit: limit as number, reason: callerBoundTruncationReason(limit as number) } }
            : {}),
        };
      }),
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
            : [
                { path: ["app", "orders"], name: "orders", kind },
                { path: ["app", "customers"], name: "customers", kind },
              ]
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
    ).rejects.toThrow(/whose prefix \["warehouse"\] listContainers did not answer/);
  });

  // The three below are the container WALK (#789), which replaced a lookup in the parentless
  // listing. Trino is why: its schemas are only ever answered by `listContainers(["memory"])`,
  // so the old check refused a schema that exists, and a schema is the only depth at which
  // Trino can count its functions.
  test("accepts a container deeper than the root listing, and runs the contract there", async () => {
    const asked: (readonly string[] | undefined)[] = [];
    const provider = fakeProvider({
      listContainers: async (parent?: readonly string[]) => {
        asked.push(parent);
        return parent === undefined
          ? [{ path: ["app"], name: "app", level: 0 }]
          : [{ path: [...parent, "inner"], name: "inner", level: 1 }];
      },
      countObjects: async (container: readonly string[]) => {
        expect(container).toEqual(["app", "inner"]);
        return { table: { count: 2 }, view: { count: 4 } };
      },
      listObjects: async (_c: readonly string[], kind: string) =>
        kind === "view"
          ? [{ path: ["app", "inner", "order_summary"], name: "order_summary", kind: "view" }]
          : [
              { path: ["app", "inner", "orders"], name: "orders", kind },
              { path: ["app", "inner", "customers"], name: "customers", kind },
            ],
    });
    await assertObjectSurface(provider as never, {
      containers: [["app"]],
      container: ["app", "inner"],
      kinds: { table: 2, view: 4 },
      sampleObject: { path: ["app", "inner", "order_summary"], kind: "view" },
    });
    // The walk asks the provider one level at a time and never below the named container.
    expect(asked).toContainEqual(["app"]);
  });

  test("rejects a deep container whose LAST segment the provider never answered", async () => {
    const provider = fakeProvider({
      listContainers: async (parent?: readonly string[]) =>
        parent === undefined
          ? [{ path: ["app"], name: "app", level: 0 }]
          : [{ path: [...parent, "inner"], name: "inner", level: 1 }],
    });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        container: ["app", "gone"],
        kinds: { table: 2, view: 4 },
        sampleObject: { path: ["app", "gone", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/whose prefix \["app","gone"\] listContainers did not answer/);
  });

  test("rejects an expectation naming the EMPTY container, which certifies nothing", async () => {
    await expect(
      assertObjectSurface(fakeProvider() as never, {
        containers: [["app"]],
        container: [],
        kinds: { table: 2, view: 4 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/names the container \[\], which selects nothing and certifies nothing/);
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
        return { table: { count: 2 } };
      },
      listObjects: async () => [
        { path: ["users"], name: "users", kind: "table" },
        { path: ["orders"], name: "orders", kind: "table" },
      ],
    });
    await assertObjectSurface(provider as never, {
      containers: [],
      kinds: { table: 2 },
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
        return kind === "view"
          ? [
              { path: ["app", "order_summary"], name: "order_summary", kind: "view" },
              { path: ["app", "order_totals"], name: "order_totals", kind: "view" },
            ]
          : [];
      },
    });
    await assertObjectSurface(provider as never, {
      containers: [["app"]],
      kinds: { table: 0, view: 4 },
      sampleObject: { path: ["app", "order_summary"], kind: "view" },
    });
    // Deduplicated because the bulk read in this double is DERIVED from the listing, so a
    // kind that is listed at all is listed twice. The property under test is unaffected: a
    // kind counted as zero appears here not at all.
    expect([...new Set(asked)]).toEqual(["view"]);
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
        { path: ["app", "order_total"], name: "order_total", kind },
      ],
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
          : [
              { path: ["app", "orders"], name: "orders", kind },
              { path: ["app", "customers"], name: "customers", kind },
            ];
      },
    });
    await assertObjectSurface(provider as never, {
      containers: [["app"]],
      kinds: { table: 2 },
      sampleObject: { path: ["app", "order_summary"], kind: "view" },
    });
    expect([...new Set(asked)]).toEqual(["table", "view"]);
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

  // THE defect this whole invariant exists to catch, and the one the guard could not see
  // until it was written down (#789): a bulk read that answers for fewer objects than the
  // folder lists, and says nothing. Every check above walks `batch.details` and asks
  // whether each one was listed; nothing asked the other way, so dropping an object passed
  // all of them. After Task 26b deletes the flat surface, an object missing from the bulk
  // read is an object that exists nowhere in the product.
  test("rejects a complete bulk read that describes fewer objects than were listed", async () => {
    const provider = bulkProvider({
      describeObjects: async (_c: readonly string[], kind: string, limit?: number) => {
        const all = detailsFor(kind);
        const kept = kind === "table" ? all.slice(1) : all;
        if (limit !== undefined && kept.length > limit) {
          return { details: kept.slice(0, limit), truncated: { limit, reason: callerBoundTruncationReason(limit) } };
        }
        return { details: kept };
      },
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /describeObjects\("table"\) reported no truncation and did not describe \["app","orders"\], which listObjects named/,
    );
  });

  // The exemption is read from the DECLARATION and not from the answer, so a relation kind
  // that describes none of its objects is a drop rather than a columnless kind.
  test("rejects a relation kind whose bulk read describes none of the objects it listed", async () => {
    const provider = bulkProvider({
      describeObjects: async (_c: readonly string[], kind: string) =>
        kind === "table" ? { details: [] } : { details: detailsFor(kind) },
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /describeObjects\("table"\) reported no truncation and did not describe \["app","orders"\], \["app","products"\], which listObjects named/,
    );
  });

  // A routine has no columns on any engine, so a provider answers `{ details: [] }` for it
  // with no round trip at all, and holding that kind to completeness would fail every
  // correct provider in the fleet. The exemption covers an EMPTY batch and nothing wider:
  // the next test is the same kind describing some of its objects and not the rest.
  const withRoutine = {
    getCapabilities: () => ({
      queryLanguage: "sql",
      containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
      objectKinds: [
        { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
        { id: "view", role: "relation", label: "View", labelPlural: "Views" },
        { id: "procedure", role: "routine", label: "Procedure", labelPlural: "Procedures" },
      ],
    }),
    countObjects: async () => ({ table: { count: 2 }, view: { count: 4 }, procedure: { count: 2 } }),
  };
  const routineListed = [
    { path: ["app", "touch_order"], name: "touch_order", kind: "procedure" },
    { path: ["app", "archive_order"], name: "archive_order", kind: "procedure" },
  ];
  const routineExpectation = {
    containers: [["app"]],
    kinds: { table: 2, view: 4, procedure: 2 },
    sampleObject: { path: ["app", "order_summary"], kind: "view" },
  };

  test("accepts a columnless kind that describes nothing at all", async () => {
    const provider = bulkProvider({
      ...withRoutine,
      listObjects: async (_c: readonly string[], kind: string) =>
        kind === "procedure" ? routineListed : (listed[kind] ?? []),
      describeObjects: async (_c: readonly string[], kind: string, limit?: number) => {
        if (kind === "procedure") return { details: [] };
        const all = detailsFor(kind);
        if (limit !== undefined && all.length > limit) {
          return { details: all.slice(0, limit), truncated: { limit, reason: callerBoundTruncationReason(limit) } };
        }
        return { details: all };
      },
    });
    await assertObjectSurface(provider as never, routineExpectation);
  });

  test("rejects a columnless kind that describes some of its objects and not the rest", async () => {
    const provider = bulkProvider({
      ...withRoutine,
      listObjects: async (_c: readonly string[], kind: string) =>
        kind === "procedure" ? routineListed : (listed[kind] ?? []),
      describeObjects: async (_c: readonly string[], kind: string, limit?: number) => {
        if (kind === "procedure") {
          return { details: [{ path: routineListed[0].path, columns: [], indexes: [], foreignKeys: [] }] };
        }
        const all = detailsFor(kind);
        if (limit !== undefined && all.length > limit) {
          return { details: all.slice(0, limit), truncated: { limit, reason: callerBoundTruncationReason(limit) } };
        }
        return { details: all };
      },
    });
    await expect(assertObjectSurface(provider as never, routineExpectation)).rejects.toThrow(
      /describeObjects\("procedure"\) reported no truncation and did not describe \["app","archive_order"\], which listObjects named/,
    );
  });

  // The other half of the same rule. A provider may not buy its way out of completeness by
  // reporting a bound it was never given: an unbounded call has no caller limit to report,
  // so a caller-bound sentence on one is a claim about a number nobody passed.
  test("rejects an unbounded read that reports the caller's bound", async () => {
    const provider = bulkProvider({
      describeObjects: async (_c: readonly string[], kind: string) => {
        const all = detailsFor(kind);
        return {
          details: all.slice(1),
          truncated: { limit: all.length - 1, reason: callerBoundTruncationReason(all.length - 1) },
        };
      },
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /describeObjects\("table"\) was called with no limit and reported one: "the bulk column read was bounded at 1 object by its caller"/,
    );
  });

  // A provider with a bound of its OWN is not the case above and must stay certifiable:
  // redis and libredb walk a bounded keyspace, so their unbounded read legitimately stops
  // short and says so in their own words, and the completeness check gives way to the
  // truncation flag exactly as it does on a bounded read.
  test("accepts an unbounded read that stops short on a bound of the provider's own", async () => {
    // Three tables listed and two described, which keeps the fixture bar met: the richest
    // kind still holds two column sets, so the bounded probe below is not vacuous.
    const walked = [...listed.table, { path: ["app", "shipments"], name: "shipments", kind: "table" }];
    const provider = bulkProvider({
      listObjects: async (_c: readonly string[], kind: string) => (kind === "table" ? walked : (listed[kind] ?? [])),
      describeObjects: async (_c: readonly string[], kind: string, limit?: number) => {
        const all = (kind === "table" ? walked : (listed[kind] ?? [])).map((object) => ({
          path: object.path,
          columns: [],
          indexes: [],
          foreignKeys: [],
        }));
        if (limit !== undefined && all.length > limit) {
          return { details: all.slice(0, limit), truncated: { limit, reason: callerBoundTruncationReason(limit) } };
        }
        if (kind !== "table") return { details: all };
        return {
          details: all.slice(0, 2),
          truncated: { limit: 2, reason: "the key walk stopped at the first 1,000 keys of one SCAN walk" },
        };
      },
    });
    await assertObjectSurface(provider as never, expectation);
  });

  // A bounded read that reports a limit and returns FEWER than it than the objects it had
  // is the same silent drop wearing the truncation flag: with two tables and a limit of 1,
  // one column set is the only complete answer.
  test("rejects a bounded read that returns fewer column sets than the bound it reports", async () => {
    const provider = bulkProvider({
      describeObjects: async (_c: readonly string[], kind: string, limit?: number) => {
        const all = detailsFor(kind);
        if (limit === undefined) return { details: all };
        return { details: [], truncated: { limit, reason: callerBoundTruncationReason(limit) } };
      },
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /describeObjects\("table", limit 1\) returned 0 column sets under a bound of 1 while 2 objects were listed/,
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

/**
 * The source half (#789 Phase 2).
 *
 * Every test here drives a deliberately WRONG provider double and asserts the helper
 * throws, because a correct provider passes a weak helper: "conformance passes" is
 * evidence about the provider and never about the helper.
 */
describe("assertObjectSurface and the object source read", () => {
  const listed: Record<string, { path: readonly string[]; name: string; kind: string }[]> = {
    table: [
      { path: ["app", "orders"], name: "orders", kind: "table" },
      { path: ["app", "products"], name: "products", kind: "table" },
    ],
    view: [{ path: ["app", "order_summary"], name: "order_summary", kind: "view" }],
    function: [
      { path: ["app", "order_total(integer)"], name: "order_total", kind: "function" },
      { path: ["app", "order_tax(integer)"], name: "order_tax", kind: "function" },
    ],
  };

  const readable = "SELECT 1 FROM orders";
  const absentName = "no_such_routine(integer)";

  // Every positive double raises for the absent path, because the helper drives the absence
  // arm on every provider it certifies. A double that answered a document there would fail
  // for the one reason the test is not about.
  function raiseIfAbsent(path: readonly string[]): void {
    if (path[path.length - 1] === absentName) {
      throw new QueryError(`no routine called "${absentName}" in schema app`, "postgres");
    }
  }

  function capabilities(kindOverrides: Record<string, unknown> = {}) {
    return {
      queryLanguage: "sql",
      containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
      objectKinds: [
        { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
        { id: "view", role: "relation", label: "View", labelPlural: "Views" },
        {
          id: "function",
          role: "routine",
          label: "Function",
          labelPlural: "Functions",
          hasSource: true,
          sourceLanguage: "sql",
          ...kindOverrides,
        },
      ],
    };
  }

  function sourceProvider(overrides: Record<string, unknown> = {}) {
    return fakeProvider({
      type: "postgres",
      getCapabilities: () => capabilities(),
      countObjects: async () => ({ table: { count: 2 }, view: { count: 1 }, function: { count: 2 } }),
      listObjects: async (_c: readonly string[], kind: string) => listed[kind] ?? [],
      readObjectSource: async (path: readonly string[], kind: string, limit?: number) => {
        raiseIfAbsent(path);
        return {
          path,
          kind,
          parts: [
            {
              id: "definition",
              label: "Definition",
              ...applySourceBound(readable, limit),
              language: "sql",
              form: "complete",
              origin: "regenerated",
            },
          ],
        };
      },
      ...overrides,
    });
  }

  const expectation = {
    containers: [["app"]],
    kinds: { table: 2, view: 1, function: 2 },
    sampleObject: { path: ["app", "order_summary"], kind: "view" },
    absentSource: { path: ["app", absentName], kind: "function" },
  };

  // The one positive case. It is here so the twelve refusals below are known to be
  // refusing something a correct provider does not do.
  test("passes a provider whose declaration, method and answers agree", async () => {
    await assertObjectSurface(sourceProvider() as never, expectation);
  });

  // The pairing, in both directions. It is the only assertion in this block that certifies
  // a provider implementing NOTHING, which is fifteen of the seventeen on the day it lands.
  test("a provider that declares a source-bearing kind and implements no method is refused", async () => {
    const provider = sourceProvider({ readObjectSource: undefined });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /declares 1 source-bearing kind\(s\) and does not implement readObjectSource/,
    );
  });

  test("a provider that implements the method and declares no source-bearing kind is refused", async () => {
    const provider = sourceProvider({ getCapabilities: () => capabilities({ hasSource: undefined }) });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /declares 0 source-bearing kind\(s\) and implements readObjectSource/,
    );
  });

  test("an expectation with no absentSource is refused, so the absence raise is always driven", async () => {
    const { absentSource: _absentSource, ...noAbsent } = expectation;
    await expect(assertObjectSurface(sourceProvider() as never, noAbsent)).rejects.toThrow(/names no absentSource/);
  });

  // ONE notch narrower than "exercised none", which is where this class of guard has been
  // wrong three times in this epic: Oracle declares nine source-bearing kinds, and an
  // expectation naming one of them would silence a "none" guard while eight went unread.
  test("an expectation that exercises only some source-bearing kinds is refused by name", async () => {
    const twoSourceKinds = sourceProvider({
      getCapabilities: () => ({
        ...capabilities(),
        objectKinds: capabilities().objectKinds.map((kind) =>
          kind.id === "view" ? { ...kind, hasSource: true, sourceLanguage: "sql" } : kind,
        ),
      }),
    });
    const { view: _view, ...withoutView } = expectation.kinds;
    await expect(assertObjectSurface(twoSourceKinds as never, { ...expectation, kinds: withoutView })).rejects.toThrow(
      /source-bearing kinds the expectation never exercised \(view\)/,
    );
  });

  /**
   * The zero, which is the one expectation that READS NOTHING (Task 1b, #789).
   *
   * The eight tests below are the whole of it. A source-bearing kind counted above zero is
   * read by the loop; a source-bearing kind the expectation OMITS is refused by the test
   * above; and between those two sits a kind the expectation NAMES AT ZERO, which is
   * exercised by nothing and passed in silence. Oracle declares nine source-bearing kinds,
   * so an expectation naming eight truthfully and the ninth at zero certified that ninth
   * unread. Requiring a non-zero instead would be wrong, because legitimate zeros are already
   * committed here: Trino counts `materialized_view` at 0 and Druid counts `lookup` and
   * `system_table` at 0. So what is required is the REASON, and the reason is held to four bars: it exists, it
   * is not blank, it is not one of four named verdicts, and `listObjects` agrees the fixture
   * really holds none of the kind.
   *
   * `view` is source-bearing and empty in every double here, so the kind under test is
   * genuinely at zero rather than made zero by the expectation alone.
   */
  function emptyViewProvider(overrides: Record<string, unknown> = {}) {
    return sourceProvider({
      getCapabilities: () => ({
        ...capabilities(),
        objectKinds: capabilities().objectKinds.map((kind) =>
          kind.id === "view" ? { ...kind, hasSource: true, sourceLanguage: "sql" } : kind,
        ),
      }),
      countObjects: async () => ({ table: { count: 2 }, view: { count: 0 }, function: { count: 2 } }),
      listObjects: async (_c: readonly string[], kind: string) => (kind === "view" ? [] : (listed[kind] ?? [])),
      ...overrides,
    });
  }

  const emptyViewExpectation = {
    ...expectation,
    kinds: { table: 2, view: 0, function: 2 },
    sampleObject: { path: ["app", "order_total(integer)"], kind: "function" },
  };

  test("a source-bearing kind expected at zero passes when the expectation says why", async () => {
    await assertObjectSurface(emptyViewProvider() as never, {
      ...emptyViewExpectation,
      emptyKinds: { view: "the fixture defines no view over the two probe tables yet" },
    });
  });

  test("a source-bearing kind expected at zero with no reason is refused by name", async () => {
    await expect(assertObjectSurface(emptyViewProvider() as never, emptyViewExpectation)).rejects.toThrow(
      /counts the source-bearing kind "view" at 0, which reads nothing, and emptyKinds carries no reason for it/,
    );
  });

  // Whitespace and not only the empty string, because a reason nobody can read is the same
  // absence wearing an answer's clothes, which is the bar `assertSourceDocument` already
  // holds an engine's own refusal sentence to.
  test("a blank reason for a kind expected at zero is refused", async () => {
    await expect(
      assertObjectSurface(emptyViewProvider() as never, { ...emptyViewExpectation, emptyKinds: { view: "  \n " } }),
    ).rejects.toThrow(/emptyKinds\["view"\] carries no sentence a person can read/);
  });

  // The other direction, so a sentence cannot outlive the absence it describes: `function`
  // holds two objects and is read by the loop, so a reason for it explains nothing.
  test("a reason for a kind that is not a source-bearing kind at zero is refused", async () => {
    await expect(
      assertObjectSurface(emptyViewProvider() as never, {
        ...emptyViewExpectation,
        emptyKinds: { view: "the fixture defines no view yet", function: "stale, this kind holds two" },
      }),
    ).rejects.toThrow(
      /emptyKinds names "function", which is not a source-bearing kind this expectation counts at zero/,
    );
  });

  // Fix round 1, finding 3: the one half of the reason's truthfulness a machine CAN decide.
  // The listing loop skips a kind counted at zero, so a count and a listing that disagree
  // for that kind let a sentence saying the fixture holds none of it stand beside a listing
  // that holds one. The helper tolerates count/listing disagreement in magnitude on purpose
  // (two reads at two instants), but zero against non-empty is not a magnitude.
  test("a reason for a kind listObjects actually returns objects for is refused", async () => {
    await expect(
      assertObjectSurface(
        emptyViewProvider({
          listObjects: async (_c: readonly string[], kind: string) =>
            kind === "view" ? [{ path: ["app", "order_summary"], name: "order_summary", kind: "view" }] : listed[kind],
        }) as never,
        { ...emptyViewExpectation, emptyKinds: { view: "the fixture defines no view yet" } },
      ),
    ).rejects.toThrow(/while listObjects\("view"\) returned 1 object\(s\), the first at \["app","order_summary"\]/);
  });

  // Fix round 1, finding 5: the docblock named three strings as not-reasons and the helper
  // refused none of them, so a task under gate pressure could write `none` and turn a
  // silence into a different silence. Trimmed and case-folded, because `  None ` is the
  // same non-answer.
  test("a verdict rather than a fact is refused for a kind expected at zero", async () => {
    for (const verdict of ["none", "  N/A ", "Not Applicable", "TODO"]) {
      await expect(
        assertObjectSurface(emptyViewProvider() as never, { ...emptyViewExpectation, emptyKinds: { view: verdict } }),
      ).rejects.toThrow(/states no fact; write what is absent and why/);
    }
  });

  // Fix round 1, finding 6: the stale-reason guard sat AFTER the `readObjectSource === undefined`
  // return, so a reason on a provider bearing no source at all was ignored rather than refused.
  // That is the exact state a provider task reaches by dropping a `hasSource` declaration and
  // leaving the sentence behind.
  test("a reason on a provider that bears no source at all is refused, not ignored", async () => {
    const noSource = sourceProvider({
      getCapabilities: () => capabilities({ hasSource: undefined, sourceLanguage: undefined }),
      readObjectSource: undefined,
    });
    await expect(
      assertObjectSurface(noSource as never, {
        ...expectation,
        emptyKinds: { view: "a sentence about a kind that bears no source" },
      }),
    ).rejects.toThrow(/emptyKinds names "view", which is not a source-bearing kind this expectation counts at zero/);
  });

  // Fix round 1, finding 7: `zeroed` tested `=== 0` while `wanted` tested `> 0`, so a count
  // that is neither left a source-bearing kind unread AND unexplained. The two predicates are
  // exact complements now, and the message carries the count rather than the word zero.
  test("a source-bearing kind counted below zero is held to the same reason", async () => {
    // Listing an object for `view` is the reviewer's own probe shape: with an empty listing
    // the loop above refuses the negative count first, and it is the pair that reached the
    // source half unread.
    const negative = emptyViewProvider({
      countObjects: async () => ({ table: { count: 2 }, view: { count: -1 }, function: { count: 2 } }),
      listObjects: async (_c: readonly string[], kind: string) =>
        kind === "view" ? [{ path: ["app", "order_summary"], name: "order_summary", kind: "view" }] : listed[kind],
    });
    await expect(
      assertObjectSurface(negative as never, { ...emptyViewExpectation, kinds: { table: 2, view: -1, function: 2 } }),
    ).rejects.toThrow(/counts the source-bearing kind "view" at -1, which reads nothing/);
  });

  // Fix round 1, finding 8, escalated to the orchestrator in the report and given a
  // diagnostic here so a wave-4 task meets a named gap rather than a puzzle. A kind that
  // declares `hasSource` and whose count is the `{ unavailable }` arm (cassandra/objects.ts
  // and trino/index.ts both answer it structurally) can be neither NAMED, which throws in the
  // count loop, nor OMITTED, which throws as unexercised, so the expectation is
  // unsatisfiable and the cheap repair under gate pressure is to drop the declaration.
  test("a source-bearing kind whose count is unavailable says why the expectation cannot be written", async () => {
    const unavailable = sourceProvider({
      countObjects: async () => ({
        table: { count: 2 },
        view: { count: 1 },
        function: { unavailable: 'Cassandra has no statement that lists the kind "function"' },
      }),
    });
    await expect(assertObjectSurface(unavailable as never, expectation)).rejects.toThrow(
      /declares hasSource, which this expectation shape cannot express/,
    );
  });

  test("an absentSource naming a kind the source loop never read has no control, and is refused", async () => {
    await expect(
      assertObjectSurface(sourceProvider() as never, {
        ...expectation,
        absentSource: { path: ["app", "nope"], kind: "table" },
      }),
    ).rejects.toThrow(/absentSource names the kind "table", which the source loop never read/);
  });

  // Both doubles below are correct in EVERY other respect: they raise for the absent path and
  // they honour the caller's bound. Without that the helper throws for the bound instead and
  // the assertion pins nothing, which a mutation of the path and kind checks proved.
  test("a document answering for a different path than it was asked is refused", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string, limit?: number) => {
        raiseIfAbsent(path);
        return {
          path: ["app", "somewhere_else"],
          kind,
          parts: [
            {
              id: "definition",
              label: "Definition",
              ...applySourceBound(readable, limit),
              language: "sql",
              form: "complete",
              origin: "stored",
            },
          ],
        };
      },
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(/somewhere_else/);
  });

  test("a document answering for a different kind than it was asked is refused", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], _kind: string, limit?: number) => {
        raiseIfAbsent(path);
        return {
          path,
          kind: "procedure",
          parts: [
            {
              id: "definition",
              label: "Definition",
              ...applySourceBound(readable, limit),
              language: "sql",
              form: "complete",
              origin: "stored",
            },
          ],
        };
      },
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(/procedure/);
  });

  test("a part with an empty text is refused, because an empty definition is not a definition", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string) => ({
        path,
        kind,
        parts: [
          { id: "definition", label: "Definition", text: "   ", language: "sql", form: "complete", origin: "stored" },
        ],
      }),
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(/answered a part with no text/);
  });

  test("a refusal with an empty sentence is refused", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string) => ({
        path,
        kind,
        parts: [{ id: "definition", label: "Definition", unavailable: "  " }],
      }),
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /answered a refusal with no sentence/,
    );
  });

  test("two parts sharing one id are refused, because neither can be addressed", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string) => ({
        path,
        kind,
        parts: [
          {
            id: "definition",
            label: "Specification",
            text: readable,
            language: "sql",
            form: "complete",
            origin: "stored",
          },
          { id: "definition", label: "Body", text: readable, language: "sql", form: "complete", origin: "stored" },
        ],
      }),
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(/share the id "definition"/);
  });

  test("a language that disagrees with the kind's declared default is refused", async () => {
    const provider = sourceProvider({
      getCapabilities: () => capabilities({ sourceLanguage: "lua" }),
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /declares sourceLanguage "lua" and the part carries "sql"/,
    );
  });

  // A kind that declares no `sourceLanguage` leaves the part's id to the provider, so the
  // comparison is skipped rather than defaulted. Without this the arm never runs.
  test("a kind that declares no sourceLanguage accepts whatever the part carries", async () => {
    const provider = sourceProvider({ getCapabilities: () => capabilities({ sourceLanguage: undefined }) });
    await assertObjectSurface(provider as never, expectation);
  });

  test("a provider whose every part is a refusal cannot be bound-checked, and says so", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string) => ({
        path,
        kind,
        parts: [{ id: "definition", label: "Definition", unavailable: "Encrypted." }],
      }),
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /no source-bearing kind answered a readable part/,
    );
  });

  test("a provider whose longest definition is under the probe cannot be bound-checked, and says so", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string) => ({
        path,
        kind,
        parts: [
          { id: "definition", label: "Definition", text: "x", language: "sql", form: "complete", origin: "stored" },
        ],
      }),
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /so a bound cannot be told from no bound/,
    );
  });

  test("a provider that ignores the limit is refused", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string) => ({
        path,
        kind,
        parts: [
          {
            id: "definition",
            label: "Definition",
            text: readable,
            language: "sql",
            form: "complete",
            origin: "stored",
          },
        ],
      }),
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /limit \d+\) returned \d+ characters/,
    );
  });

  test("a provider that bounds a part and reports nothing is refused", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string, limit?: number) => ({
        path,
        kind,
        parts: [
          {
            id: "definition",
            label: "Definition",
            text: limit === undefined ? readable : readable.slice(0, limit),
            language: "sql",
            form: "complete",
            origin: "stored",
          },
        ],
      }),
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(/reported no truncation/);
  });

  test("a provider that reports its bound in its own words, without the shared sentence, is refused", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string, limit?: number) => ({
        path,
        kind,
        parts: [
          {
            id: "definition",
            label: "Definition",
            text: limit === undefined ? readable : readable.slice(0, limit),
            language: "sql",
            form: "complete",
            origin: "stored",
            ...(limit === undefined ? {} : { truncated: { limit, reason: "source limit reached" } }),
          },
        ],
      }),
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /which does not carry the one sentence a caller's bound is reported with/,
    );
  });

  // The NUMBER and the SENTENCE are two facts and a provider can get one right while the
  // other is wrong. This double reports the correct sentence beside a limit it never applied,
  // which is exactly what a reader would be shown as the size of the bound.
  test("a provider that reports the right sentence beside the wrong limit number is refused", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string, limit?: number) => {
        raiseIfAbsent(path);
        const bounded = applySourceBound(readable, limit);
        return {
          path,
          kind,
          parts: [
            {
              id: "definition",
              label: "Definition",
              text: bounded.text,
              language: "sql",
              form: "complete",
              origin: "stored",
              ...(bounded.truncated === undefined
                ? {}
                : { truncated: { limit: bounded.truncated.limit + 1, reason: bounded.truncated.reason } }),
            },
          ],
        };
      },
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /reported the bound as 11, which is not the limit it was given \(10\)/,
    );
  });

  /*
    The union does NOT make this shape unrepresentable, which is the opposite of what the
    helper's own docblock claimed until this test was written. MEASURED with tsc 6.0.3 and
    NO cast anywhere: a part literal carrying `unavailable` beside `text`, `language`, `form`
    and `origin` compiles as an `ObjectSourcePart`, because TypeScript's excess-property check
    on a union admits any property declared on ANY member of it. `isSourcePartUnavailable`
    then narrows it to the refusal arm and the document-shape walk continues past every check
    below, so a Source pane would render the refusal sentence over a definition the engine
    really returned. That is the DBeaver shape this contract exists to make impossible,
    running in the one direction the type does not close.
  */
  test("a part carrying both a refusal and a text is refused, because the union does not stop it", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string) => {
        raiseIfAbsent(path);
        return {
          path,
          kind,
          parts: [
            {
              id: "definition",
              label: "Definition",
              text: readable,
              language: "sql",
              form: "complete",
              origin: "regenerated",
              unavailable: "Encrypted.",
            },
          ],
        };
      },
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /answered a part that carries both a refusal and a text/,
    );
  });

  // A provider with a SECOND bound of its own names both, so the guard asks for CONTAINS
  // and never for equality.
  test("accepts a bound reason that carries the shared sentence inside a composed one", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string, limit?: number) => {
        raiseIfAbsent(path);
        const bounded = applySourceBound(readable, limit);
        return {
          path,
          kind,
          parts: [
            {
              id: "definition",
              label: "Definition",
              text: bounded.text,
              language: "sql",
              form: "complete",
              origin: "stored",
              ...(bounded.truncated === undefined
                ? {}
                : {
                    truncated: {
                      limit: bounded.truncated.limit,
                      reason: `${bounded.truncated.reason}, and the catalog stores only the first 4,000 characters`,
                    },
                  }),
            },
          ],
        };
      },
    });
    await assertObjectSurface(provider as never, expectation);
  });

  // The escape hatch a bounded probe would otherwise leave open: a provider could answer
  // short on an unbounded call and wave the caller's flag at it.
  test("a provider that reports a caller's bound on an UNBOUNDED read is refused", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string) => ({
        path,
        kind,
        parts: [
          {
            id: "definition",
            label: "Definition",
            text: readable,
            language: "sql",
            form: "complete",
            origin: "stored",
            truncated: { limit: 4, reason: sourceBoundTruncationReason(4) },
          },
        ],
      }),
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /was called with no limit and reported one/,
    );
  });

  // A bound of the provider's OWN on an unbounded read stays certifiable, which is the
  // other side of the same assertion: redis and libredb walk a bounded keyspace and say so.
  test("accepts a provider's own bound on an unbounded read", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string, limit?: number) => {
        raiseIfAbsent(path);
        const bounded = applySourceBound(readable, limit);
        return {
          path,
          kind,
          parts: [
            {
              id: "definition",
              label: "Definition",
              text: bounded.text,
              language: "sql",
              form: "complete",
              origin: "stored",
              truncated: bounded.truncated ?? { limit: 4000, reason: "the catalog stores only 4,000 characters" },
            },
          ],
        };
      },
    });
    await assertObjectSurface(provider as never, expectation);
  });

  test("a provider that answers a document for an absent object instead of raising is refused", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string, limit?: number) => ({
        path,
        kind,
        parts: [
          {
            id: "definition",
            label: "Definition",
            ...applySourceBound(readable, limit),
            language: "sql",
            form: "complete",
            origin: "stored",
          },
        ],
      }),
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /did not raise for \["app","no_such_routine\(integer\)"\]; it answered a document/,
    );
  });

  test("a provider that raises something other than a QueryError for an absent object is refused", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string, limit?: number) => {
        if (path[path.length - 1] === "no_such_routine(integer)") throw new TypeError("undefined is not a function");
        return {
          path,
          kind,
          parts: [
            {
              id: "definition",
              label: "Definition",
              ...applySourceBound(readable, limit),
              language: "sql",
              form: "complete",
              origin: "stored",
            },
          ],
        };
      },
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /did not raise for .*; it answered TypeError: undefined is not a function/,
    );
  });

  test("a raise that does not name the object is refused, because the reader cannot tell which one", async () => {
    const provider = sourceProvider({
      readObjectSource: async (path: readonly string[], kind: string, limit?: number) => {
        if (path[path.length - 1] === "no_such_routine(integer)") throw new QueryError("not found", "postgres");
        return {
          path,
          kind,
          parts: [
            {
              id: "definition",
              label: "Definition",
              ...applySourceBound(readable, limit),
              language: "sql",
              form: "complete",
              origin: "stored",
            },
          ],
        };
      },
    });
    await expect(assertObjectSurface(provider as never, expectation)).rejects.toThrow(
      /without naming "no_such_routine\(integer\)"/,
    );
  });
});
