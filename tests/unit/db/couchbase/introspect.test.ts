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
  inferColumns,
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

// ============================================================================
// getSchemaRelations
// ============================================================================
