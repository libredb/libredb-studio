/**
 * Elasticsearch / OpenSearch schema introspection (issue #424, Phase 1)
 *
 * Driven entirely through a hand-built `SearchTransport` - the point of the seam:
 * no `fetch` mocking, no `mock.module()` (process-wide in bun) and no server. Every
 * index row and mapping shape below was captured from the live probe clusters on
 * 2026-08-19 (Elasticsearch 9.1.4 and OpenSearch 3.8.0, stock single nodes), so the
 * fake speaks exactly what the transport speaks:
 *
 * - `probe_shapes` maps `address` as an object with `address.city`, and `note` as
 *   `text` with a `keyword` multi-field. `GET /probe_shapes/_mapping` and
 *   `DESCRIBE probe_shapes` were both re-measured for this test: the flattened set
 *   is `address`/object, `address.city`/keyword, `note`/text, `note.keyword`/keyword.
 * - `SELECT note, note.keyword, address.city FROM probe_shapes` answers HTTP 200
 *   with all three columns (measured), while `SELECT address FROM probe_shapes` is
 *   HTTP 400 `verification_exception`, "line 1:8: Cannot use field [address] type
 *   [object] only its subfields". That pair is the whole column decision: the
 *   container is not a column, its leaf is, and a `text` parent stays one.
 * - `probe_orders` reports `docs.count` 1 and `pri.store.size` 5913, and a closed
 *   index reports JSON `null` for both while still saying `"status":"close"`.
 *
 * The fake's `query()` THROWS on purpose. Introspection reading a statement would be
 * a design regression, not a test failure: `introspect.ts:9-16` records that
 * `SELECT *` describes the statement rather than the index - measured, an index
 * mapping `flattened` and `nested` answers `SELECT *` with `{"columns":[],"rows":[[]]}` -
 * so the mapping is the only honest source.
 */
import { describe, expect, test } from "bun:test";
import {
  getSchema,
  isSystemIndex,
  SEARCH_CONTAINER_TYPES,
  SEARCH_MAPPING_CONCURRENCY,
} from "@/lib/db/providers/sql/search/introspect";
import type {
  SearchClusterHealth,
  SearchIndexInfo,
  SearchMappingField,
  SearchQueryResult,
  SearchTransport,
} from "@/lib/db/providers/sql/search/transport";
import { SearchTransportError } from "@/lib/db/providers/sql/search/transport";

// ============================================================================
// Fake transport
// ============================================================================

interface FakeOptions {
  indices?: SearchIndexInfo[];
  /** Mapping per index name. An index absent from here answers an empty mapping. */
  mappings?: Record<string, SearchMappingField[]>;
  /** Raised instead of returning a mapping, per index name. */
  failures?: Record<string, Error>;
  /** Milliseconds each index's mapping read takes, per index name. */
  delays?: Record<string, number>;
}

interface Recorded {
  /** Index names in the order `mapping()` was entered. */
  mappingCalls: string[];
  /** The signal each seam call received, so forwarding can be asserted. */
  signals: (AbortSignal | undefined)[];
  /** The highest number of mapping reads in flight at once. */
  peakInFlight: number;
}

function index(name: string, overrides: Partial<SearchIndexInfo> = {}): SearchIndexInfo {
  return {
    name,
    docCount: 1,
    sizeBytes: 5913,
    status: "open",
    // Both products mark their own with a leading dot; the transport also flags
    // OpenSearch's date-suffixed query-insights index, which carries none
    // (`http-transport.ts:263-264`). Introspection reads the flag, never the name.
    isSystem: false,
    ...overrides,
  };
}

function field(path: string, type: string, hasSubfields = false, isMultiField = false): SearchMappingField {
  return { path, type, hasSubfields, isMultiField };
}

function createTransport(options: FakeOptions = {}) {
  const recorded: Recorded = { mappingCalls: [], signals: [], peakInFlight: 0 };
  let inFlight = 0;

  const transport: SearchTransport = {
    dialect: "elasticsearch",

    indices: async (signal?: AbortSignal): Promise<SearchIndexInfo[]> => {
      recorded.signals.push(signal);
      return options.indices ?? [];
    },

    mapping: async (name: string, signal?: AbortSignal): Promise<SearchMappingField[]> => {
      recorded.mappingCalls.push(name);
      recorded.signals.push(signal);
      inFlight += 1;
      recorded.peakInFlight = Math.max(recorded.peakInFlight, inFlight);
      // A real read suspends, which is the only way the concurrency limit is
      // observable at all: without a suspension every worker would finish before
      // the next one starts and any limit would look respected.
      await new Promise((resolve) => setTimeout(resolve, options.delays?.[name] ?? 1));
      inFlight -= 1;

      const failure = options.failures?.[name];
      if (failure) throw failure;
      return options.mappings?.[name] ?? [];
    },

    // Introspection must never reach these three. See the file header for why
    // `query()` in particular is a design boundary rather than a convenience.
    query: (): Promise<SearchQueryResult> => {
      throw new Error("introspection ran a statement; the schema comes from the mapping");
    },
    version: (): Promise<{ version: string; product: string }> => {
      throw new Error("introspection read the version");
    },
    health: (): Promise<SearchClusterHealth> => {
      throw new Error("introspection read cluster health");
    },
  };

  return { transport, recorded };
}

/** The `probe_shapes` mapping as the transport flattens it, measured. */
function probeShapesMapping(): SearchMappingField[] {
  return [
    field("address", "object", true),
    field("address.city", "keyword"),
    field("note", "text", true),
    // A MULTI-FIELD, and the flag matters: the transport marks everything below a
    // mapping's `fields` this way, and introspection drops that kind because
    // OpenSearch cannot select it. The fake has to say so or it stops speaking what
    // the transport speaks.
    field("note.keyword", "keyword", false, true),
  ];
}

function names(columns: { name: string }[]): string[] {
  return columns.map((column) => column.name);
}

// ============================================================================
// Constants
// ============================================================================

describe("the container decision", () => {
  // Measured on Elasticsearch 9.1.4: `SELECT address FROM probe_shapes` is HTTP 400,
  // `verification_exception`, "Cannot use field [address] type [object] only its
  // subfields", and `nested` is refused with the same wording. `query-generators.ts`
  // builds its starter query by enumerating every declared column, so listing a
  // container would hand the user a query that cannot run at all.
  test("names exactly the two types the engine refuses to project", () => {
    expect([...SEARCH_CONTAINER_TYPES]).toEqual(["object", "nested"]);
  });

  // One definition is the point (`introspect.ts:86-89`): the completion and
  // labelling surfaces have to agree with the schema tree about what a column is.
  test("is frozen, so no caller can widen it at runtime", () => {
    expect(Object.isFrozen(SEARCH_CONTAINER_TYPES)).toBe(true);
  });

  test("reads four at a time, the number Couchbase's per-collection inference settled on", () => {
    expect(SEARCH_MAPPING_CONCURRENCY).toBe(4);
  });
});

describe("the multi-field decision", () => {
  // Measured 2026-08-19. Elasticsearch 9.1.4 selects `note.keyword` happily (its own
  // DESCRIBE lists the path), and OpenSearch 3.8.0 refuses it in every spelling with
  // `SemanticCheckException`, "can't resolve Symbol(namespace=FIELD_NAME,
  // name=note.keyword) in type env". An OBJECT subfield (`addr.city`) selects on
  // both. Since dynamic mapping gives every text field a `keyword` multi-field
  // automatically, listing them would put an unselectable column in the tree and in
  // the generated starter query for essentially every dynamically-mapped OpenSearch
  // index - so they are dropped on BOTH products, by the same rule that drops
  // containers: a column that works on one product and fails on the other is worse
  // than one that works on both.
  test("a multi-field is not offered as a column", async () => {
    const { transport } = createTransport({
      indices: [index("orders")],
      mappings: {
        orders: [field("note", "text", true), field("note.keyword", "keyword", false, true)],
      },
    });

    const [table] = await getSchema(transport);

    expect(table?.columns.map((column) => column.name)).toEqual(["note"]);
  });

  test("an object subfield IS offered, because both products select it", async () => {
    const { transport } = createTransport({
      indices: [index("orders")],
      mappings: {
        orders: [field("addr", "object", true), field("addr.city", "text")],
      },
    });

    const [table] = await getSchema(transport);

    // The container itself is dropped, its leaf is kept.
    expect(table?.columns.map((column) => column.name)).toEqual(["addr.city"]);
  });

  test("a multi-field nested under an object is dropped too", async () => {
    // Everything below `fields` is a multi-field whatever it is nested in, so the
    // flag is inherited rather than recomputed per level.
    const { transport } = createTransport({
      indices: [index("orders")],
      mappings: {
        orders: [
          field("addr", "object", true),
          field("addr.city", "text", true),
          field("addr.city.keyword", "keyword", false, true),
        ],
      },
    });

    const [table] = await getSchema(transport);

    expect(table?.columns.map((column) => column.name)).toEqual(["addr.city"]);
  });
});

// ============================================================================
// System indices
// ============================================================================

describe("isSystemIndex", () => {
  /**
   * The rule is deliberately the flag and nothing more (`introspect.ts:150-154`).
   * The NAME shapes that produce the flag - the leading dot both products use by
   * convention, and OpenSearch's date-suffixed query-insights index - are
   * `http-transport.ts:263-264,751`, which is where a test of the rule itself
   * belongs; what is verified here is that introspection adds no second opinion.
   */
  test.each<[string, string]>([
    ["a dot-prefixed index, the convention on both products", ".plugins-ml-config"],
    ["OpenSearch's query-insights index, which carries no dot", "top_queries-2026.08.18-74305"],
  ])("hides %s", (_label, name) => {
    expect(isSystemIndex(index(name, { isSystem: true }))).toBe(true);
  });

  test("keeps a user's index", () => {
    expect(isSystemIndex(index("probe_orders"))).toBe(false);
  });

  // The discriminating case: two of the three indices on a stock OpenSearch 3.8.0
  // node are the engine's own, and only one of them is recognisable by its dot. If
  // this file re-derived the rule from the name, an index the transport did NOT
  // flag would still be hidden - two definitions of "system", and the one that can
  // be measured against a real cluster is the one on the wire side.
  test.each([".plugins-ml-config", "top_queries-2026.08.18-74305"])(
    "trusts the flag over the name, so an unflagged %s stays the user's data",
    (name) => {
      expect(isSystemIndex(index(name, { isSystem: false }))).toBe(false);
    },
  );
});

// ============================================================================
// Selection
// ============================================================================

describe("getSchema index selection", () => {
  function stockOpenSearchNode(): SearchIndexInfo[] {
    // The three indices measured on a stock OpenSearch 3.8.0 with nothing indexed
    // by hand: two thirds of the cluster is not the user's.
    return [
      index(".plugins-ml-config", { isSystem: true, sizeBytes: 4783 }),
      index("probe_orders", { sizeBytes: 4807 }),
      index("top_queries-2026.08.18-74305", { isSystem: true, docCount: 6, sizeBytes: 58284 }),
    ];
  }

  test("hides the engine's own indices by default", async () => {
    const { transport, recorded } = createTransport({ indices: stockOpenSearchNode() });

    const tables = await getSchema(transport);

    expect(tables.map((table) => table.name)).toEqual(["probe_orders"]);
    // And costs nothing for the hidden ones: a mapping read per index is one
    // request, so the filter has to happen before the reads, not after.
    expect(recorded.mappingCalls).toEqual(["probe_orders"]);
  });

  // An operator debugging why ML inference fails wants `.plugins-ml-config` in the
  // tree; a developer writing a query does not (`introspect.ts:127-134`).
  test("includes them when the caller asks, in the listing's order", async () => {
    const { transport } = createTransport({ indices: stockOpenSearchNode() });

    const tables = await getSchema(transport, { includeSystemIndices: true });

    expect(tables.map((table) => table.name)).toEqual([
      ".plugins-ml-config",
      "probe_orders",
      "top_queries-2026.08.18-74305",
    ]);
  });

  // Only `true` includes them: the option is optional, so `undefined` and a
  // deliberate `false` have to mean the same thing.
  test.each<[string, { includeSystemIndices?: boolean }]>([
    ["an empty options object", {}],
    ["an explicit false", { includeSystemIndices: false }],
  ])("hides them for %s", async (_label, options) => {
    const { transport } = createTransport({ indices: stockOpenSearchNode() });

    expect((await getSchema(transport, options)).map((table) => table.name)).toEqual(["probe_orders"]);
  });

  // Measured: a closed index still answers `_mapping` in full and its `_cat` row
  // reports null counts, so it can be described completely and honestly. Dropping
  // it would tell the user their index is gone when it is merely closed.
  test("keeps a closed index", async () => {
    const closed = index("probe_closed", { status: "close", docCount: null, sizeBytes: null });
    const { transport } = createTransport({
      indices: [closed],
      mappings: { probe_closed: [field("customer", "keyword")] },
    });

    const [table] = await getSchema(transport);

    expect(table.name).toBe("probe_closed");
    expect(names(table.columns)).toEqual(["customer"]);
  });

  test("answers an empty cluster with no tables and no mapping reads", async () => {
    const { transport, recorded } = createTransport({ indices: [] });

    expect(await getSchema(transport)).toEqual([]);
    expect(recorded.mappingCalls).toEqual([]);
  });
});

// ============================================================================
// Columns
// ============================================================================

describe("getSchema columns", () => {
  async function columnsOf(mapping: SearchMappingField[]): Promise<{ name: string; type: string }[]> {
    const { transport } = createTransport({
      indices: [index("probe_shapes")],
      mappings: { probe_shapes: mapping },
    });

    // Name and type only: `nullable` / `isPrimary` are asserted once, below, where
    // the measurement that fixes them is written down.
    return (await getSchema(transport))[0].columns.map((column) => ({ name: column.name, type: column.type }));
  }

  /**
   * The measured pair that specifies this whole function. `SELECT note,
   * note.keyword, address.city FROM probe_shapes` is HTTP 200 with three columns;
   * `SELECT address FROM probe_shapes` is HTTP 400 "Cannot use field [address] type
   * [object] only its subfields". So `hasSubfields` is the WRONG test - `note` has
   * one and is perfectly selectable - and the field's own TYPE is the test.
   */
  test("drops the container and the multi-field, keeps both their selectable leaves", async () => {
    // `note` stays: a `text` parent with a `keyword` multi-field is itself
    // selectable on both products. `note.keyword` goes: only Elasticsearch can
    // select it (see "the multi-field decision" above). `address` goes as a
    // container, `address.city` stays as its leaf.
    expect(await columnsOf(probeShapesMapping())).toEqual([
      { name: "address.city", type: "keyword" },
      { name: "note", type: "text" },
    ]);
  });

  // `nested` is refused with the same wording as `object`, and its leaf is
  // reachable, so it is dropped the same way.
  test("drops a nested container and keeps the field inside it", async () => {
    const columns = await columnsOf([field("items", "nested", true), field("items.sku", "keyword")]);

    expect(names(columns)).toEqual(["items.sku"]);
  });

  /**
   * The recorded limitation (`introspect.ts:46-52`): `flattened` on Elasticsearch is
   * refused with "Cannot use field [blob] with unsupported type [flattened]" while
   * the mapping declares it like any other field. It is still listed, because the
   * mapping does not say which types SQL supports and a per-version list this file
   * cannot verify would hide fields a future version reads perfectly well.
   */
  test("lists a type the mapping declares and the SQL surface cannot read", async () => {
    const columns = await columnsOf([field("blob", "flattened"), field("customer", "keyword")]);

    expect(names(columns)).toEqual(["blob", "customer"]);
  });

  /**
   * Sorting is by path and by CODE UNIT, not by the server's order and not by
   * locale. `Beta` sorts before `address.city` because `B` is code unit 66 and `a`
   * is 97 - a locale comparison would have put `alpha` first - and `address.city`
   * sorts before `alpha` because `.` (46) precedes `l`, which is what keeps the
   * `address.*` fields grouped where their dropped container used to be.
   */
  test("orders by code unit, not by the server's order or a locale", async () => {
    const columns = await columnsOf([
      field("note.keyword", "keyword"),
      field("alpha", "long"),
      field("Beta", "long"),
      field("address.city", "keyword"),
      field("address", "object", true),
    ]);

    expect(names(columns)).toEqual(["Beta", "address.city", "alpha", "note.keyword"]);
  });

  test("keeps identical paths stable rather than dropping one", async () => {
    // The transport emits multi-fields after a level's own children, so the
    // comparator must return 0 for equal paths instead of treating them as
    // unordered - a sort that loses a row would silently lose a column.
    const columns = await columnsOf([field("note", "text"), field("note", "text")]);

    expect(names(columns)).toEqual(["note", "note"]);
  });

  /**
   * Every column nullable and no column primary, both measured rather than hedged
   * (`introspect.ts:202-221`): a document indexed without `note` answers `SELECT
   * note` with null, and the only unique thing in an index is the document `_id` -
   * metadata rather than a mapped field, and one Elasticsearch's SQL does not even
   * expose ("Unknown column [_id]", measured, while OpenSearch's returns it).
   * `isPrimary` is stated as FACT wherever it is read - "(PK)" in completions, " PK"
   * in the agent's schema context, "Primary key changed" in schema-diff - so a key
   * invented here becomes a key the product asserts.
   */
  test("declares every column nullable, never primary, and carries no default", async () => {
    const { transport } = createTransport({
      indices: [index("probe_shapes")],
      mappings: { probe_shapes: probeShapesMapping() },
    });

    const [table] = await getSchema(transport);

    expect(table.columns).toEqual([
      { name: "address.city", type: "keyword", nullable: true, isPrimary: false },
      { name: "note", type: "text", nullable: true, isPrimary: false },
    ]);
    // `defaultValue` is absent rather than empty: a mapping's `null_value` is a
    // term substituted into the INDEX, not a value any document carries.
    expect(table.columns.every((column) => !("defaultValue" in column))).toBe(true);
  });

  // Measured on both products: an index created with no mapping answers
  // `{"<index>":{"mappings":{}}}`, which the seam reports as an empty list. A
  // brand-new index really has no fields, so this is a fact, not an error.
  test("describes an index with no mapping yet as having no columns", async () => {
    const { transport } = createTransport({ indices: [index("probe_empty")] });

    expect((await getSchema(transport))[0].columns).toEqual([]);
  });
});

// ============================================================================
// Table shape
// ============================================================================

describe("getSchema table shape", () => {
  test("reports the index name verbatim, hyphens, dots and all", async () => {
    // Measured: OpenSearch's own `top_queries-2026.08.18-74305` carries both, and
    // quoting belongs to whoever builds a statement, not to the inventory.
    const { transport } = createTransport({
      indices: [index("top_queries-2026.08.18-74305", { isSystem: true })],
    });

    const [table] = await getSchema(transport, { includeSystemIndices: true });

    expect(table.name).toBe("top_queries-2026.08.18-74305");
  });

  /**
   * An Elasticsearch index is the TABLE here, so there is no secondary-index object
   * to report: every mapped field is inverted-indexed as a property of being
   * mapped, so nothing was declared and no DDL could declare one. `foreignKeys` is
   * empty because the engine has no such constraint in its model at all - which is
   * why the provider must also declare `declaresForeignKeys: false`, since an empty
   * array alone cannot distinguish "none exist" from "the role cannot see them".
   */
  test("reports no secondary indexes and no foreign keys", async () => {
    const { transport } = createTransport({
      indices: [index("probe_orders")],
      mappings: { probe_orders: [field("customer", "keyword")] },
    });

    const [table] = await getSchema(transport);

    expect(table.indexes).toEqual([]);
    expect(table.foreignKeys).toEqual([]);
  });

  // The document count is what a row IS on this surface, and 5913 bytes is what
  // `pri.store.size` reported for `probe_orders` under `bytes=b` (measured; the
  // string-to-number parsing is the transport's problem, not this file's).
  test("reports the document count as the row count and formats the store size", async () => {
    const { transport } = createTransport({
      indices: [index("probe_orders", { docCount: 1, sizeBytes: 5913 })],
    });

    const [table] = await getSchema(transport);

    expect(table.rowCount).toBe(1);
    expect(table.size).toBe("5.77 KB");
  });

  /**
   * Measured on a closed index: `docs.count` and `pri.store.size` both arrive JSON
   * `null` while the row still reports `"status":"close"`. Undefined is "unknown";
   * zero would claim an empty index, and "0 B" would claim an empty store.
   */
  test("omits the count and the size when the cluster reported neither", async () => {
    const { transport } = createTransport({
      indices: [index("probe_closed", { status: "close", docCount: null, sizeBytes: null })],
    });

    const [table] = await getSchema(transport);

    expect("rowCount" in table).toBe(false);
    expect("size" in table).toBe(false);
  });

  // The two are independent: a listing can report one and not the other, so each
  // key has to be omitted on its own.
  test.each<[string, Partial<SearchIndexInfo>, boolean, boolean]>([
    ["a count without a size", { docCount: 7, sizeBytes: null }, true, false],
    ["a size without a count", { docCount: null, sizeBytes: 4783 }, false, true],
  ])("keeps %s", async (_label, overrides, hasCount, hasSize) => {
    const { transport } = createTransport({ indices: [index("probe_orders", overrides)] });

    const [table] = await getSchema(transport);

    expect("rowCount" in table).toBe(hasCount);
    expect("size" in table).toBe(hasSize);
  });

  // Zero is a number the cluster really reported, so it must survive: an empty
  // index is not an unknown one.
  test("reports a genuine zero rather than treating it as unknown", async () => {
    const { transport } = createTransport({ indices: [index("probe_empty", { docCount: 0, sizeBytes: 0 })] });

    const [table] = await getSchema(transport);

    expect(table.rowCount).toBe(0);
    expect(table.size).toBe("0 B");
  });
});

// ============================================================================
// Failures
// ============================================================================

describe("getSchema mapping failures", () => {
  function twoIndices(failure: Error) {
    return createTransport({
      indices: [index("probe_orders"), index("probe_shapes")],
      mappings: { probe_orders: [field("customer", "keyword")], probe_shapes: probeShapesMapping() },
      failures: { probe_shapes: failure },
    });
  }

  /**
   * The two failures that cost ONE index's columns instead of the tree
   * (`introspect.ts:105-117`): `auth`, because a security plugin grants index
   * privileges per index, so a role that lists twenty indices and may describe
   * nineteen is an ordinary configuration; and `unknown-object`, because the
   * listing is a snapshot and an index deleted between the listing and its mapping
   * read is a race on a live cluster, not a fault.
   */
  test.each<[string, string]>([
    ["a per-index privilege denial", "auth"],
    ["an index deleted between the listing and the read", "unknown-object"],
  ])("degrades to no columns for %s, and keeps the rest of the tree", async (_label, category) => {
    const { transport } = twoIndices(
      new SearchTransportError(
        category as "auth" | "unknown-object",
        "no permissions for [indices:admin/mappings/get] and index [probe_shapes]",
      ),
    );

    const tables = await getSchema(transport);

    expect(tables.map((table) => [table.name, table.columns.length])).toEqual([
      ["probe_orders", 1],
      ["probe_shapes", 0],
    ]);
  });

  /**
   * Everything else propagates on purpose. An unreachable cluster or an expired
   * deadline would otherwise render every index with zero columns, which reads as
   * "these indices have no fields" - a fabricated schema, and the failure mode that
   * hides the real error forever.
   */
  test.each<[string, Error]>([
    ["the cluster is gone", new SearchTransportError("unreachable", "Elasticsearch could not be reached")],
    ["the deadline expired", new SearchTransportError("timeout", "the request ran past its deadline")],
    ["the caller cancelled", new SearchTransportError("cancelled", "the request was cancelled")],
    ["the engine refused", new SearchTransportError("engine", "rejected the request with HTTP 500")],
    ["the grammar has no such thing", new SearchTransportError("unsupported", "not implemented")],
    ["the failure is not the seam's at all", new TypeError("payload.mappings is not an object")],
  ])("propagates when %s", async (_label, failure) => {
    const { transport } = twoIndices(failure);

    await expect(getSchema(transport)).rejects.toThrow(failure);
  });
});

// ============================================================================
// Reads
// ============================================================================

describe("getSchema mapping reads", () => {
  function manyIndices(count: number): SearchIndexInfo[] {
    return Array.from({ length: count }, (_unused, position) => index(`probe_${position}`));
  }

  test("reads no more than SEARCH_MAPPING_CONCURRENCY mappings at once", async () => {
    const indices = manyIndices(10);
    const { transport, recorded } = createTransport({ indices });

    await getSchema(transport);

    expect(recorded.mappingCalls).toHaveLength(10);
    expect(recorded.peakInFlight).toBe(SEARCH_MAPPING_CONCURRENCY);
  });

  test("runs in parallel rather than serially, and still reads every index", async () => {
    const indices = manyIndices(3);
    const { transport, recorded } = createTransport({ indices });

    await getSchema(transport);

    // Three indices and a limit of four: every read starts before any finishes.
    expect(recorded.peakInFlight).toBe(3);
    expect(recorded.mappingCalls).toEqual(["probe_0", "probe_1", "probe_2"]);
  });

  /**
   * Results are written BY INDEX, so a slow read cannot reorder the tree. The
   * delays here finish the reads in reverse, which is the case a `push`-based
   * collector would silently get wrong: `probe_0`'s columns would end up on
   * `probe_2`, and a schema tree that attributes one index's fields to another is
   * worse than one that fails.
   */
  test("keeps each index's columns with that index when the reads finish out of order", async () => {
    const indices = manyIndices(4);
    const { transport } = createTransport({
      indices,
      mappings: {
        probe_0: [field("zero", "long")],
        probe_1: [field("one", "long")],
        probe_2: [field("two", "long")],
        probe_3: [field("three", "long")],
      },
      delays: { probe_0: 8, probe_1: 6, probe_2: 4, probe_3: 1 },
    });

    const tables = await getSchema(transport);

    expect(tables.map((table) => [table.name, names(table.columns)])).toEqual([
      ["probe_0", ["zero"]],
      ["probe_1", ["one"]],
      ["probe_2", ["two"]],
      ["probe_3", ["three"]],
    ]);
  });

  /**
   * The signal reaches BOTH seam calls. Without it a cancelled sidebar load would
   * leave one listing plus one request per index running against the cluster, and
   * the transport's `cancelled` category would never be reached at all.
   */
  test("forwards the abort signal to the listing and to every mapping read", async () => {
    const controller = new AbortController();
    const { transport, recorded } = createTransport({ indices: [index("a"), index("b")] });

    await getSchema(transport, {}, controller.signal);

    expect(recorded.signals).toHaveLength(3);
    expect(recorded.signals.every((signal) => signal === controller.signal)).toBe(true);
  });

  test("passes no signal along when the caller gave none", async () => {
    const { transport, recorded } = createTransport({ indices: [index("a")] });

    await getSchema(transport);

    expect(recorded.signals).toEqual([undefined, undefined]);
  });

  // The design boundary the fake enforces: the schema comes from the mapping, so a
  // successful read proves no statement was sent (`query()` would have thrown).
  test("describes a cluster without running a statement", async () => {
    const { transport } = createTransport({
      indices: [index("probe_shapes")],
      mappings: { probe_shapes: probeShapesMapping() },
    });

    await expect(getSchema(transport)).resolves.toHaveLength(1);
  });
});
