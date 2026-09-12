/**
 * ClickHouse schema introspection (issue #264, design spec section 3.6)
 *
 * Driven entirely through a hand-built ClickHouseTransport - the point of the
 * seam: no fetch mocking, no `mock.module()` (process-wide in bun) and no
 * server. Every row shape below was captured from a live ClickHouse
 * 26.7.1.1315 instance, so the fake speaks exactly what the server speaks,
 * including the two encodings that break naive parsing: a `UInt64` arrives as a
 * decimal STRING (spec 2.1 quoting) while a `UInt8` stays a NUMBER, and a
 * `Nullable(UInt64)` arrives as `null` for anything that is not a MergeTree.
 */
import { describe, expect, test } from "bun:test";
import {
  CLICKHOUSE_CATALOG_TIMEOUT_SECONDS,
  CLICKHOUSE_PRIMARY_INDEX_NAME,
  CLICKHOUSE_SORTING_INDEX_NAME,
  CLICKHOUSE_SYSTEM_DATABASES,
} from "@/lib/db/providers/sql/clickhouse/introspect";
import {
  CLICKHOUSE_ERROR_CODES,
  type ClickHouseQueryOptions,
  type ClickHouseQueryResult,
  type ClickHouseRow,
  type ClickHouseTransport,
  ClickHouseTransportError,
} from "@/lib/db/providers/sql/clickhouse/transport";

// ============================================================================
// Fake transport
// ============================================================================

/** Which system table a recorded statement reads. */
type Surface = "tables" | "columns" | "indices";

interface RecordedCall {
  sql: string;
  opts: ClickHouseQueryOptions | undefined;
}

interface FakeOptions {
  tables?: ClickHouseRow[];
  columns?: ClickHouseRow[];
  indices?: ClickHouseRow[];
  /** Raised instead of returning rows, per surface. */
  failures?: Partial<Record<Surface, Error>>;
}

function surfaceOf(sql: string): Surface {
  if (sql.includes("system.data_skipping_indices")) return "indices";
  if (sql.includes("system.columns")) return "columns";
  return "tables";
}

function createTransport(options: FakeOptions = {}) {
  const calls: RecordedCall[] = [];

  const transport: ClickHouseTransport = {
    kind: "http",
    query: async (sql: string, opts?: ClickHouseQueryOptions): Promise<ClickHouseQueryResult> => {
      calls.push({ sql, opts });
      const surface = surfaceOf(sql);
      const failure = options.failures?.[surface];
      if (failure) throw failure;
      return {
        rows: options[surface] ?? [],
        fieldNames: null,
        columnTypes: null,
        executionTimeMs: 1,
        mutationCount: 0,
        rawText: null,
      };
    },
    close: () => Promise.resolve(),
  };

  return { transport, calls };
}

function sqlFor(calls: RecordedCall[], surface: Surface): string {
  const call = calls.find((entry) => surfaceOf(entry.sql) === surface);
  if (!call) throw new Error(`no ${surface} statement was sent`);
  return call.sql;
}

function accessDenied(): ClickHouseTransportError {
  return new ClickHouseTransportError(
    "libredb: Not enough privileges. To execute this query, it's necessary to have the grant SELECT " +
      "for at least one column on system.data_skipping_indices. (ACCESS_DENIED)",
    CLICKHOUSE_ERROR_CODES.ACCESS_DENIED,
    "ACCESS_DENIED",
  );
}

// ============================================================================
// Row builders (shapes captured from ClickHouse 26.7.1.1315)
// ============================================================================

/**
 * A `system.tables` row. `total_rows`/`total_bytes` default to the quoted-string
 * form a MergeTree reports; pass null for the view / non-MergeTree case.
 */
function tableRow(overrides: Partial<ClickHouseRow> = {}): ClickHouseRow {
  return {
    database: "demo",
    name: "users",
    total_rows: "3",
    total_bytes: "1346",
    sorting_key: "id",
    primary_key: "id",
    ...overrides,
  };
}

function columnRow(overrides: Partial<ClickHouseRow> = {}): ClickHouseRow {
  return {
    database: "demo",
    table: "users",
    name: "id",
    type: "UInt32",
    is_in_primary_key: 0,
    default_kind: "",
    default_expression: "",
    ...overrides,
  };
}

function indexRow(overrides: Partial<ClickHouseRow> = {}): ClickHouseRow {
  return {
    database: "demo",
    table: "orders",
    name: "idx_status",
    expr: "status",
    ...overrides,
  };
}

/** The pinned database of the live probe connection. */
const PINNED = "demo";

// ============================================================================
// The system-database filter
// ============================================================================

describe("the system-database filter", () => {
  test("names exactly the three system databases the live server reports", () => {
    expect([...CLICKHOUSE_SYSTEM_DATABASES]).toEqual(["system", "information_schema", "INFORMATION_SCHEMA"]);
  });
});

// ============================================================================
// Row counts and sizes
// ============================================================================

describe("row counts and sizes", () => {});

// ============================================================================
// Columns
// ============================================================================

describe("columns", () => {});

// ============================================================================
// Indexes
// ============================================================================

describe("indexes", () => {});

// ============================================================================
// Foreign keys
// ============================================================================

describe("foreign keys", () => {});

// ============================================================================
// Table naming (spec 3.4)
// ============================================================================

describe("table naming", () => {
  const tables = [
    tableRow({ database: "demo", name: "users" }),
    tableRow({ database: "analytics", name: "events" }),
    tableRow({ database: "default", name: "probe" }),
  ];
});

// ============================================================================
// The split reads
// ============================================================================

describe("getSchemaList", () => {});

describe("getSchemaRelations", () => {});

// ============================================================================
// Degradation
// ============================================================================

describe("degradation", () => {});
