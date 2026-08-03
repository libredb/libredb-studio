/**
 * Couchbase schema introspection (issue #262, decision 10)
 *
 * Everything is driven through a hand-built CouchbaseTransport, which is the
 * point of the seam: no fetch mocking, no mock.module() (process-wide in bun),
 * and no cluster. The payload shapes below were captured from a live Couchbase
 * Server 8.0.2 node, so the fake speaks exactly what the cluster speaks.
 */
import { describe, test, expect } from "bun:test";
import {
  CATALOG_TIMEOUT_MS,
  COUCHBASE_DOCUMENT_KEY_COLUMN,
  INFER_CONCURRENCY,
  INFER_TIMEOUT_MS,
  getSchemaList,
  getSchemaRelations,
  inferColumns,
  listCollections,
} from "@/lib/db/providers/document/couchbase/introspect";
import {
  CouchbaseError,
  type CouchbaseQueryResult,
  type CouchbaseRow,
  type CouchbaseTransport,
  type Keyspace,
  type QueryOpts,
} from "@/lib/db/providers/document/couchbase/transport";

// ============================================================================
// Fake transport
// ============================================================================

interface RecordedCall {
  statement: string;
  opts: QueryOpts | undefined;
}

interface FakeTransportOptions {
  /** Rows the system:keyspaces catalog query returns. */
  collections?: CouchbaseRow[];
  /** Rows the system:indexes catalog query returns. */
  indexes?: CouchbaseRow[];
  /** INFER responder; throwing simulates a rejected statement. */
  infer?: (statement: string) => Promise<CouchbaseRow[]> | CouchbaseRow[];
  /** Failure raised by the catalog queries instead of returning rows. */
  catalogError?: Error;
}

function queryResult(rows: CouchbaseRow[]): CouchbaseQueryResult {
  return { rows, fieldNames: null, executionTimeMs: 1, mutationCount: 0, warnings: [] };
}

function createTransport(options: FakeTransportOptions = {}) {
  const calls: RecordedCall[] = [];

  const transport: CouchbaseTransport = {
    kind: "http",
    query: async (statement: string, opts?: QueryOpts) => {
      calls.push({ statement, opts });
      if (statement.startsWith("INFER")) {
        const respond = options.infer ?? (() => []);
        return queryResult(await respond(statement));
      }
      if (options.catalogError) throw options.catalogError;
      if (statement.includes("system:indexes")) return queryResult(options.indexes ?? []);
      return queryResult(options.collections ?? []);
    },
    manage: <T>() => Promise.resolve({} as T),
    close: () => Promise.resolve(),
  };

  return { transport, calls };
}

// ============================================================================
// Payload builders (shapes verified against Couchbase Server 8.0.2)
// ============================================================================

function property(type: unknown, percentDocs: unknown = 100): Record<string, unknown> {
  return { type, "%docs": percentDocs, "#docs": 3, nestingDepth: 0, samples: [] };
}

/**
 * INFER reports the document key as a "~meta" pseudo-property whose nested id
 * carries the key type.
 */
const META_PROPERTY: Record<string, unknown> = {
  type: "object",
  "%docs": 100,
  properties: { id: { type: "string", "%docs": 100, samples: ["hotel::1"] } },
};

function flavour(properties: Record<string, unknown>, name = ""): Record<string, unknown> {
  return { "#docs": 3, Flavor: name, type: "object", properties };
}

/** INFER nests its payload: the single row it returns IS the flavour array. */
function inferRows(...flavours: Record<string, unknown>[]): CouchbaseRow[] {
  return [flavours as unknown as CouchbaseRow];
}

function collectionRow(scope: string | undefined, collection: string): CouchbaseRow {
  const row: CouchbaseRow = { bucket_name: "travel", collection_name: collection };
  if (scope !== undefined) row.scope_name = scope;
  return row;
}

const HOTEL: Keyspace = { bucket: "travel", scope: "inventory", collection: "hotel" };

function createGate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Let every pending microtask and timer callback run. */
function flushPending(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function columnNames(columns: { name: string }[]): string[] {
  return columns.map((column) => column.name);
}

// ============================================================================
// Collection listing
// ============================================================================

describe("listCollections", () => {
  test("restricts the catalog query to the pinned bucket and quotes the reserved words", async () => {
    const { transport, calls } = createTransport();

    await listCollections(transport, "travel");

    expect(calls).toHaveLength(1);
    expect(calls[0].statement).toContain("system:keyspaces");
    expect(calls[0].statement).toContain("system:scopes");
    // Verified on Server 8.0.2: unquoted bucket/scope fail with error 3000.
    expect(calls[0].statement).toContain("k.`bucket`");
    expect(calls[0].statement).toContain("k.`scope`");
    // The bucket travels as a positional argument, never concatenated in.
    expect(calls[0].statement).not.toContain("travel");
    expect(calls[0].opts?.args).toEqual(["travel"]);
    expect(calls[0].opts?.timeoutMs).toBe(CATALOG_TIMEOUT_MS);
  });

  test("renders a _default scope collection bare and any other scope qualified", async () => {
    const { transport } = createTransport({
      collections: [collectionRow("_default", "airline"), collectionRow("inventory", "hotel")],
    });

    const collections = await listCollections(transport, "travel");

    expect(collections).toEqual([
      { keyspace: { bucket: "travel", scope: "_default", collection: "airline" }, displayName: "airline" },
      { keyspace: HOTEL, displayName: "inventory.hotel" },
    ]);
  });

  test("maps the bucket-level catalog row onto the default collection", async () => {
    // Verified on Server 8.0.2: the pre-collections default collection is
    // represented by a row carrying the bucket name and no bucket/scope field.
    // Dropping it would hide every document written before scopes existed.
    const { transport } = createTransport({ collections: [{ collection_name: "travel" }] });

    const collections = await listCollections(transport, "travel");

    expect(collections).toEqual([
      { keyspace: { bucket: "travel", scope: "_default", collection: "_default" }, displayName: "_default" },
    ]);
  });

  test("defaults a collection row with no scope to the default scope", async () => {
    const { transport } = createTransport({ collections: [collectionRow(undefined, "airline")] });

    const collections = await listCollections(transport, "travel");

    expect(collections[0].keyspace.scope).toBe("_default");
    expect(collections[0].displayName).toBe("airline");
  });

  test("skips a catalog row whose collection name is not a string", async () => {
    const { transport } = createTransport({
      collections: [
        { bucket_name: "travel", scope_name: "inventory", collection_name: 42 },
        collectionRow("inventory", "hotel"),
      ],
    });

    const collections = await listCollections(transport, "travel");

    expect(collections).toEqual([{ keyspace: HOTEL, displayName: "inventory.hotel" }]);
  });
});

// ============================================================================
// Column inference
// ============================================================================

describe("inferColumns", () => {
  test("samples 100 documents from the quoted keyspace path under a per-query timeout", async () => {
    const { transport, calls } = createTransport({ infer: () => inferRows(flavour({ "~meta": META_PROPERTY })) });

    await inferColumns(transport, HOTEL);

    expect(calls[0].statement).toBe('INFER `travel`.`inventory`.`hotel` WITH {"sample_size": 100}');
    expect(calls[0].opts?.timeoutMs).toBe(INFER_TIMEOUT_MS);
  });

  test("flattens a flavour into columns, document key first then alphabetical", async () => {
    const { transport } = createTransport({
      infer: () =>
        inferRows(
          flavour({
            rooms: property("number"),
            city: property("string"),
            "~meta": META_PROPERTY,
          }),
        ),
    });

    const columns = await inferColumns(transport, HOTEL);

    expect(columns).toEqual([
      { name: COUCHBASE_DOCUMENT_KEY_COLUMN, type: "string", nullable: false, isPrimary: true },
      { name: "city", type: "string", nullable: false, isPrimary: false },
      { name: "rooms", type: "number", nullable: false, isPrimary: false },
    ]);
  });

  test("unions divergent flavours instead of keeping only the first", async () => {
    // Verified on Server 8.0.2: two document shapes in one collection produce
    // two flavours, each reporting %docs relative to its own document count.
    const { transport } = createTransport({
      infer: () =>
        inferRows(
          flavour({ n: property("string"), other: property("boolean"), "~meta": META_PROPERTY }, '`n` = "x"'),
          flavour({ n: property("number"), note: property("string"), "~meta": META_PROPERTY }),
        ),
    });

    const columns = await inferColumns(transport, HOTEL);

    expect(columnNames(columns)).toEqual([COUCHBASE_DOCUMENT_KEY_COLUMN, "n", "note", "other"]);
    expect(columns[1]).toEqual({ name: "n", type: "mixed(number|string)", nullable: false, isPrimary: false });
    // Present in one flavour only, so absent from part of the collection.
    expect(columns[2].nullable).toBe(true);
    expect(columns[3].nullable).toBe(true);
  });

  test("marks a field only some sampled documents carry as nullable", async () => {
    const { transport } = createTransport({
      infer: () => inferRows(flavour({ city: property("string", 60), "~meta": META_PROPERTY })),
    });

    const columns = await inferColumns(transport, HOTEL);

    expect(columns[1]).toEqual({ name: "city", type: "string", nullable: true, isPrimary: false });
  });

  test("treats a property with no %docs as present in every sampled document", async () => {
    const { transport } = createTransport({
      infer: () => inferRows(flavour({ city: property("string", undefined) })),
    });

    const columns = await inferColumns(transport, HOTEL);

    expect(columns).toEqual([{ name: "city", type: "string", nullable: false, isPrimary: false }]);
  });

  test("unions a JSON-schema type array and treats a null member as nullable", async () => {
    const { transport } = createTransport({
      infer: () => inferRows(flavour({ city: property(["string", "null"]) })),
    });

    const columns = await inferColumns(transport, HOTEL);

    expect(columns[0]).toEqual({ name: "city", type: "mixed(null|string)", nullable: true, isPrimary: false });
  });

  test("falls back to an unknown type for a missing type and for a nameless type array", async () => {
    const { transport } = createTransport({
      infer: () => inferRows(flavour({ city: { "%docs": 100 }, zone: property([7]) })),
    });

    const columns = await inferColumns(transport, HOTEL);

    expect(columns).toEqual([
      { name: "city", type: "unknown", nullable: false, isPrimary: false },
      { name: "zone", type: "unknown", nullable: false, isPrimary: false },
    ]);
  });

  test("ignores a flavour that is not an object and one that carries no properties", async () => {
    const { transport } = createTransport({
      infer: () =>
        inferRows("not-a-flavour" as unknown as Record<string, unknown>, flavour({ city: property("string") })),
    });

    const columns = await inferColumns(transport, HOTEL);

    // The unusable flavour must not count towards the flavour total either, or
    // every real field would be reported as nullable.
    expect(columns).toEqual([{ name: "city", type: "string", nullable: false, isPrimary: false }]);
  });

  test("ignores a flavour whose properties map is missing", async () => {
    const { transport } = createTransport({
      infer: () => inferRows({ "#docs": 1, Flavor: "" }, flavour({ city: property("string") })),
    });

    const columns = await inferColumns(transport, HOTEL);

    expect(columns).toEqual([{ name: "city", type: "string", nullable: false, isPrimary: false }]);
  });

  test("ignores a property entry that is not an object", async () => {
    const { transport } = createTransport({
      infer: () => inferRows(flavour({ city: property("string"), broken: "not-a-property" })),
    });

    const columns = await inferColumns(transport, HOTEL);

    expect(columnNames(columns)).toEqual(["city"]);
  });

  test("emits no document key column when the sample carries no ~meta", async () => {
    const { transport } = createTransport({ infer: () => inferRows(flavour({ city: property("string") })) });

    const columns = await inferColumns(transport, HOTEL);

    expect(columnNames(columns)).toEqual(["city"]);
  });

  test("defaults the document key type to string when ~meta carries no id", async () => {
    const { transport } = createTransport({
      infer: () => inferRows(flavour({ "~meta": { type: "object", "%docs": 100 } })),
    });

    const columns = await inferColumns(transport, HOTEL);

    expect(columns).toEqual([
      { name: COUCHBASE_DOCUMENT_KEY_COLUMN, type: "string", nullable: false, isPrimary: true },
    ]);
  });

  test("returns no columns when the payload is not a flavour array", async () => {
    const { transport } = createTransport({ infer: () => [] });

    expect(await inferColumns(transport, HOTEL)).toEqual([]);
  });

  test("returns no columns when the collection is empty (error 7014)", async () => {
    // Verified on Server 8.0.2: INFER against an empty collection fails with
    // "No documents found, unable to infer schema", which is an ordinary state
    // for a freshly created collection, not a broken connection.
    const { transport } = createTransport({
      infer: () => {
        throw new CouchbaseError("No documents found, unable to infer schema.", 7014);
      },
    });

    expect(await inferColumns(transport, HOTEL)).toEqual([]);
  });

  test("returns no columns when the user may not read the collection", async () => {
    const { transport } = createTransport({
      infer: () => {
        throw new CouchbaseError("User does not have credentials to run SELECT queries", 13014);
      },
    });

    expect(await inferColumns(transport, HOTEL)).toEqual([]);
  });
});

// ============================================================================
// getSchemaList
// ============================================================================

describe("getSchemaList", () => {
  test("returns one entry per collection with inferred columns, no indexes and no foreign keys", async () => {
    const { transport } = createTransport({
      collections: [collectionRow("inventory", "hotel")],
      infer: () => inferRows(flavour({ city: property("string"), "~meta": META_PROPERTY })),
    });

    const schemas = await getSchemaList(transport, "travel");

    expect(schemas).toEqual([
      {
        name: "inventory.hotel",
        columns: [
          { name: COUCHBASE_DOCUMENT_KEY_COLUMN, type: "string", nullable: false, isPrimary: true },
          { name: "city", type: "string", nullable: false, isPrimary: false },
        ],
        indexes: [],
        foreignKeys: [],
      },
    ]);
  });

  test("keeps a collection whose INFER fails, with empty columns", async () => {
    const { transport } = createTransport({
      collections: [collectionRow("inventory", "hotel"), collectionRow("inventory", "secret")],
      infer: (statement) => {
        if (statement.includes("secret")) throw new CouchbaseError("no privilege", 13014);
        return inferRows(flavour({ city: property("string") }));
      },
    });

    const schemas = await getSchemaList(transport, "travel");

    expect(schemas.map((schema) => schema.name)).toEqual(["inventory.hotel", "inventory.secret"]);
    expect(columnNames(schemas[0].columns)).toEqual(["city"]);
    expect(schemas[1].columns).toEqual([]);
  });

  test("runs INFER at a bounded concurrency and still lists every collection", async () => {
    const collections = Array.from({ length: 10 }, (_, index) => collectionRow("inventory", `c${index}`));
    const gate = createGate();
    let inFlight = 0;
    let peakInFlight = 0;

    const { transport } = createTransport({
      collections,
      infer: async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await gate.opened;
        inFlight -= 1;
        return inferRows(flavour({ city: property("string") }));
      },
    });

    const pending = getSchemaList(transport, "travel");
    await flushPending();

    // The bound holds while work is outstanding, not just on average.
    expect(inFlight).toBe(INFER_CONCURRENCY);

    gate.open();
    const schemas = await pending;

    expect(peakInFlight).toBe(INFER_CONCURRENCY);
    // The concurrency limit bounds cost; it must never truncate the tree.
    expect(schemas.map((schema) => schema.name)).toEqual(
      Array.from({ length: 10 }, (_, index) => `inventory.c${index}`),
    );
  });

  test("runs no INFER at all for a bucket with no collections", async () => {
    const { transport, calls } = createTransport({ collections: [] });

    expect(await getSchemaList(transport, "travel")).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

// ============================================================================
// getSchemaRelations
// ============================================================================

describe("getSchemaRelations", () => {
  test("queries system:indexes for the pinned bucket only", async () => {
    const { transport, calls } = createTransport({ indexes: [] });

    await getSchemaRelations(transport, "travel");

    expect(calls[0].statement).toContain("system:indexes");
    expect(calls[0].statement).not.toContain("travel");
    expect(calls[0].opts?.args).toEqual(["travel"]);
    expect(calls[0].opts?.timeoutMs).toBe(CATALOG_TIMEOUT_MS);
  });

  test("groups indexes by display name, unquotes index keys and invents no foreign keys", async () => {
    const { transport } = createTransport({
      indexes: [
        {
          index_name: "idx_hotel_city",
          bucket_name: "travel",
          scope_name: "inventory",
          collection_name: "hotel",
          index_key: ["`city`", "`geo``x`"],
        },
        {
          index_name: "idx_hotel_stars",
          bucket_name: "travel",
          scope_name: "inventory",
          collection_name: "hotel",
          index_key: ["`stars`"],
        },
        {
          index_name: "#primary",
          bucket_name: "travel",
          scope_name: "_default",
          collection_name: "airline",
          index_key: [],
          is_primary: true,
        },
      ],
    });

    const relations = await getSchemaRelations(transport, "travel");

    expect(relations).toEqual([
      {
        name: "inventory.hotel",
        foreignKeys: [],
        indexes: [
          { name: "idx_hotel_city", columns: ["city", "geo`x"], unique: false },
          { name: "idx_hotel_stars", columns: ["stars"], unique: false },
        ],
      },
      {
        name: "airline",
        foreignKeys: [],
        // A primary index carries no index_key: it keys the document key, which
        // the KV layer guarantees unique.
        indexes: [{ name: "#primary", columns: ["META().id"], unique: true }],
      },
    ]);
  });

  test("keeps an index key that is not a plain quoted identifier verbatim", async () => {
    const { transport } = createTransport({
      indexes: [
        {
          index_name: "idx_expr",
          bucket_name: "travel",
          scope_name: "inventory",
          collection_name: "hotel",
          index_key: ["(`geo`.`lat`)", 7],
        },
      ],
    });

    const relations = await getSchemaRelations(transport, "travel");

    expect(relations[0].indexes[0].columns).toEqual(["(`geo`.`lat`)"]);
  });

  test("maps a bucket-level index row onto the default collection", async () => {
    const { transport } = createTransport({
      indexes: [{ index_name: "#primary", collection_name: "travel", index_key: [], is_primary: true }],
    });

    const relations = await getSchemaRelations(transport, "travel");

    expect(relations[0].name).toBe("_default");
  });

  test("names an index with no name and tolerates a non-array index key", async () => {
    const { transport } = createTransport({
      indexes: [{ bucket_name: "travel", scope_name: "inventory", collection_name: "hotel", index_key: null }],
    });

    const relations = await getSchemaRelations(transport, "travel");

    expect(relations[0].indexes).toEqual([{ name: "unknown", columns: [], unique: false }]);
  });

  test("skips an index row whose collection name is not a string", async () => {
    const { transport } = createTransport({
      indexes: [{ index_name: "#primary", bucket_name: "travel", scope_name: "inventory", collection_name: null }],
    });

    expect(await getSchemaRelations(transport, "travel")).toEqual([]);
  });

  test("returns nothing for a bucket with no indexes", async () => {
    const { transport } = createTransport({ indexes: [] });

    expect(await getSchemaRelations(transport, "travel")).toEqual([]);
  });

  test("propagates a catalog failure rather than reporting an empty index list", async () => {
    // An empty index list is the un-indexed-collection signal (decision 6), so
    // swallowing a failure here would fabricate that signal for every
    // collection in the bucket.
    const { transport } = createTransport({ catalogError: new CouchbaseError("no privilege", 13014) });

    const error = (await getSchemaRelations(transport, "travel").catch((e: unknown) => e)) as CouchbaseError;

    expect(error).toBeInstanceOf(CouchbaseError);
    expect(error.code).toBe(13014);
  });
});
