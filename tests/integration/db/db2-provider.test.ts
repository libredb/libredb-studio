/**
 * The Db2 LUW provider (#786), driven through its driver seam.
 *
 * The fake client below answers each catalog statement the way db2-node 1.0.22 to 1.0.25 answer it against
 * the dev container's fixture (`docker/db2-init/01-object-fixture.sql`): names as the HEX of their
 * UTF-8 bytes, the code page 1208, a definition as two padded hex chunks and its byte length, and
 * the NULL text of an EXTERNAL routine. Every statement is matched by identity against the
 * provider's own constants, so a statement the provider sends and this file does not know fails
 * the test by name.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionError, DatabaseConfigError, DatabaseError, QueryError, TimeoutError } from "@/lib/db/errors";
import {
  callerBoundTruncationReason,
  isSourcePartUnavailable,
  sourceBoundTruncationReason,
} from "@/lib/db/object-kinds";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";
import { generateTableQuery } from "@/lib/query-generators";
import { SQLBaseProvider } from "@/lib/db/providers/sql/sql-base";
import {
  CODE_PAGE_SQL,
  CONTAINERS_SQL,
  COUNTS_SQL,
  LIST_MODULES_SQL,
  LIST_ROUTINES_SQL,
  LIST_SEQUENCES_SQL,
  LIST_TABLES_SQL,
  LIST_TRIGGERS_SQL,
  OBJECT_COLUMNS_SQL,
  OBJECT_FOREIGN_KEYS_SQL,
  OBJECT_INDEXES_SQL,
  ROUTINE_SOURCE,
  SCHEMA_TRIGGER_SOURCE,
  TABLE_TRIGGER_SOURCE,
  VIEW_SOURCE,
  bulkDetailSql,
  bulkTargetSql,
} from "@/lib/db/providers/sql/db2/catalog";
import {
  DB2_CONTAINER_LEVELS,
  DB2_OBJECT_KINDS,
  db2Capabilities,
  db2Labels,
} from "@/lib/db/providers/sql/db2/capabilities";
import type { CaFileSystem } from "@/lib/db/providers/sql/db2/connection";
import type {
  Db2ArrayQueryResult,
  Db2ClientOptions,
  Db2ColumnMeta,
  Db2Driver,
  Db2QueryResult,
} from "@/lib/db/providers/sql/db2/driver";
import { Db2Provider } from "@/lib/db/providers/sql/db2/index";
import { MAINTENANCE_TARGET_TYPE_SQL } from "@/lib/db/providers/sql/db2/maintenance";
import { OBJECT_COUNTS_SQL, TABLE_STATS_SQL, VERSION_SQL } from "@/lib/db/providers/sql/db2/monitoring";
import { SOURCE_TRUNCATION_REASON } from "@/lib/db/providers/sql/db2/objects";
import { DB2_PREVIEW_PROJECTION } from "@/lib/db/providers/sql/db2/values";
import type { DatabaseConnection, ProviderCapabilities } from "@/lib/db/types";
import { TUNNEL_FAR_END } from "@/lib/types";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";

// ============================================================================
// The fixture, as the catalog holds it
// ============================================================================

const hex = (text: string): string => Buffer.from(text, "utf8").toString("hex").toUpperCase();

/** One 16336-byte chunk of a definition as hex, padded with blanks as SUBSTRING pads it. */
function chunkOf(text: string, start: number): string {
  const part = Buffer.from(text, "utf8").subarray(start, start + 16336);
  return part.length === 0 ? "" : Buffer.concat([part, Buffer.alloc(16336 - part.length, 0x20)]).toString("hex");
}

/** The head row of a definition read: its first chunk and its byte length, or two NULLs. */
function definition(text: string | null): Record<string, unknown> {
  if (text === null) return { TEXT_BYTES: null, TEXT_LENGTH: null };
  return { TEXT_BYTES: chunkOf(text, 0), TEXT_LENGTH: Buffer.byteLength(text) };
}

/** The tail row of a definition read: its second chunk. */
function definitionTail(text: string | null): Record<string, unknown> {
  return { TEXT_BYTES: text === null ? null : chunkOf(text, 16336) };
}

/** The head or the tail row, as the statement asked. */
function sourceRow(statements: { head: string }, sql: string, text: string | null): Record<string, unknown> {
  return sql === statements.head ? definition(text) : definitionTail(text);
}

interface FakeColumn {
  name: string;
  type: string;
  length?: number;
  scale?: number;
  nulls?: "Y" | "N";
  keyseq?: number;
  default?: string;
}

interface FakeRelation {
  schema: string;
  name: string;
  type: "T" | "V" | "S" | "A";
  status?: string;
  valid?: string;
  card?: number;
  columns?: FakeColumn[];
  text?: string;
}

const id = (name: string, keyseq?: number): FakeColumn => ({
  name,
  type: "INTEGER",
  length: 4,
  nulls: keyseq ? "N" : "Y",
  keyseq,
});

const RELATIONS: FakeRelation[] = [
  {
    schema: "APP",
    name: "CUSTOMERS",
    type: "T",
    status: "N",
    card: 2,
    columns: [id("ID", 1), { name: "NAME", type: "VARCHAR", length: 100 }],
  },
  {
    schema: "APP",
    name: "ORDERS",
    type: "T",
    status: "N",
    card: 2,
    columns: [
      id("ID", 1),
      id("CUSTOMER_ID"),
      { name: "TOTAL", type: "DECIMAL", length: 12, scale: 2, default: "0" },
      { name: "NOTE", type: "VARCHAR", length: 200 },
    ],
  },
  { schema: "APP", name: "Mixed Case", type: "T", status: "N", card: -1, columns: [id("ID", 1)] },
  {
    schema: "APP",
    name: "ORDER_SUMMARY",
    type: "V",
    status: "N",
    valid: "Y",
    columns: [
      { name: "NAME", type: "VARCHAR", length: 100 },
      { name: "TOTAL", type: "DECIMAL", length: 31, scale: 2 },
    ],
    text: "CREATE VIEW APP.ORDER_SUMMARY AS SELECT C.NAME, SUM(O.TOTAL) AS TOTAL FROM APP.ORDERS O JOIN APP.CUSTOMERS C ON C.ID = O.CUSTOMER_ID GROUP BY C.NAME",
  },
  {
    schema: "APP",
    name: "SCRATCH_VIEW",
    type: "V",
    status: "N",
    valid: "N",
    columns: [id("ID")],
    text: "CREATE VIEW APP.SCRATCH_VIEW AS SELECT ID FROM APP.SCRATCH",
  },
  {
    schema: "APP",
    name: "ORDER_TOTALS",
    type: "S",
    status: "N",
    valid: "Y",
    card: 2,
    columns: [
      id("CUSTOMER_ID"),
      { name: "TOTAL", type: "DECIMAL", length: 31, scale: 2 },
      { name: "N", type: "INTEGER", length: 4 },
    ],
    text: "CREATE TABLE APP.ORDER_TOTALS AS (SELECT CUSTOMER_ID, SUM(TOTAL) AS TOTAL, COUNT(*) AS N FROM APP.ORDERS GROUP BY CUSTOMER_ID) DATA INITIALLY DEFERRED REFRESH DEFERRED",
  },
  { schema: "APP", name: "CLIENTS", type: "A", status: "N" },
  {
    schema: "REPORTING",
    name: "DAILY",
    type: "T",
    status: "N",
    card: 0,
    columns: [{ name: "DAY", type: "DATE", length: 4, nulls: "N", keyseq: 1 }, id("CUSTOMER_ID", 2)],
  },
];

const FOREIGN_KEYS = [
  { schema: "APP", table: "ORDERS", column: "CUSTOMER_ID", refSchema: "APP", refTable: "CUSTOMERS", refColumn: "ID" },
  {
    schema: "REPORTING",
    table: "DAILY",
    column: "CUSTOMER_ID",
    refSchema: "APP",
    refTable: "CUSTOMERS",
    refColumn: "ID",
  },
];

const INDEXES = [
  { schema: "APP", table: "ORDERS", indexSchema: "APP", name: "ORDERS_CUSTOMER_IX", rule: "D", column: "CUSTOMER_ID" },
  { schema: "APP", table: "ORDERS", indexSchema: "APP", name: "ORDERS_CUSTOMER_IX", rule: "D", column: "TOTAL" },
  { schema: "APP", table: "ORDERS", indexSchema: "SYSIBM", name: "SQL230101", rule: "P", column: "ID" },
];

const ROUTINES = [
  {
    schema: "APP",
    specific: "SQL231003120000100",
    name: "ADD_ORDER",
    type: "P",
    origin: "Q",
    valid: "Y",
    text: "CREATE PROCEDURE APP.ADD_ORDER (IN P_ID INTEGER) LANGUAGE SQL BEGIN END",
  },
  {
    schema: "APP",
    specific: "ORDER_TOTAL_BY_ID",
    name: "ORDER_TOTAL",
    type: "F",
    origin: "Q",
    valid: "Y",
    text: "CREATE FUNCTION APP.ORDER_TOTAL (P_ID INTEGER) RETURNS DECIMAL(12, 2) SPECIFIC APP.ORDER_TOTAL_BY_ID RETURN 1",
  },
  {
    schema: "APP",
    specific: "SQL231003120000200",
    name: "ORDER_TOTAL",
    type: "F",
    origin: "Q",
    valid: "Y",
    text: "CREATE FUNCTION APP.ORDER_TOTAL (P_ID INTEGER, P_TAX DECIMAL(5, 2)) RETURNS DECIMAL(12, 2) RETURN 1",
  },
  { schema: "APP", specific: "SQL231003120000300", name: "EXT_FN", type: "F", origin: "E", valid: "Y", text: null },
];

const TRIGGERS = [
  {
    schema: "APP",
    tableSchema: "APP",
    table: "ORDERS",
    name: "ORDERS_NOTE_DEFAULT",
    valid: "Y",
    text: "CREATE TRIGGER APP.ORDERS_NOTE_DEFAULT NO CASCADE BEFORE INSERT ON APP.ORDERS REFERENCING NEW AS N FOR EACH ROW WHEN (N.NOTE IS NULL) SET N.NOTE = 'none'",
  },
  {
    schema: "REPORTING",
    tableSchema: "APP",
    table: "ORDERS",
    name: "ORDERS_AUDIT",
    valid: "Y",
    text: "CREATE TRIGGER REPORTING.ORDERS_AUDIT AFTER UPDATE ON APP.ORDERS FOR EACH ROW UPDATE APP.CUSTOMERS SET NAME = NAME WHERE 1 = 0",
  },
];

const SCHEMAS = ["APP", "DB2INST1", "REPORTING"];

// ============================================================================
// The fake catalog
// ============================================================================

const rows = (list: Record<string, unknown>[]): Db2QueryResult => ({
  rows: list,
  rowCount: list.length,
  columns:
    list.length === 0 ? [] : Object.keys(list[0]).map((name) => ({ name, typeName: "VarChar(128)", nullable: true })),
  diagnostics: [],
});

function columnRows(relation: FakeRelation, withName: boolean): Record<string, unknown>[] {
  return (relation.columns ?? []).map((column) => ({
    ...(withName ? { OBJECT_NAME_HEX: hex(relation.name) } : {}),
    COLUMN_NAME_HEX: hex(column.name),
    TYPENAME_HEX: hex(column.type),
    LENGTH: column.length ?? 0,
    SCALE: column.scale ?? 0,
    CODEPAGE: column.type === "VARCHAR" ? 1208 : 0,
    TYPESTRINGUNITS: column.type === "VARCHAR" ? "OCTETS" : null,
    STRINGUNITSLENGTH: column.type === "VARCHAR" ? column.length : null,
    NULLS: column.nulls ?? "Y",
    DEFAULT_BYTES:
      column.default === undefined ? null : `${hex(column.default)}${"20".repeat(254 - column.default.length)}`,
    DEFAULT_LENGTH: column.default === undefined ? null : column.default.length,
    KEYSEQ: column.keyseq ?? null,
  }));
}

function foreignKeyRows(schema: string, table: string, withName: boolean): Record<string, unknown>[] {
  return FOREIGN_KEYS.filter((fk) => fk.schema === schema && fk.table === table).map((fk) => ({
    ...(withName ? { OBJECT_NAME_HEX: hex(fk.table) } : {}),
    COLUMN_NAME_HEX: hex(fk.column),
    REF_SCHEMA_HEX: hex(fk.refSchema),
    REF_TABLE_HEX: hex(fk.refTable),
    REF_COLUMN_HEX: hex(fk.refColumn),
  }));
}

function indexRows(schema: string, table: string, withName: boolean): Record<string, unknown>[] {
  return INDEXES.filter((index) => index.schema === schema && index.table === table).map((index) => ({
    ...(withName ? { OBJECT_NAME_HEX: hex(index.table) } : {}),
    INDEX_SCHEMA_HEX: hex(index.indexSchema),
    INDEX_NAME_HEX: hex(index.name),
    UNIQUERULE: index.rule,
    COLUMN_NAME_HEX: hex(index.column),
  }));
}

function counts(schema: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const type of ["T", "V", "S", "A"]) {
    const n = RELATIONS.filter((relation) => relation.schema === schema && relation.type === type).length;
    if (n > 0) out.push({ KIND: `TABLES:${type}`, N: n });
  }
  out.push({ KIND: "SEQUENCES", N: schema === "APP" ? 1 : 0 });
  out.push({ KIND: "MODULES", N: schema === "APP" ? 1 : 0 });
  for (const type of ["P", "F"]) {
    const n = ROUTINES.filter((routine) => routine.schema === schema && routine.type === type).length;
    if (n > 0) out.push({ KIND: `ROUTINES:${type}`, N: n });
  }
  out.push({ KIND: "TRIGGERS", N: TRIGGERS.filter((trigger) => trigger.schema === schema).length });
  return out;
}

/** The targets of one bulk read, by name order and bounded as the statement bounds them. */
function bulkTargets(params: unknown[]): FakeRelation[] {
  const [schema, type, third] = params as [string, string, unknown];
  // Bounded, the third value is the bound; unbounded, the detail reads' third value is the schema.
  const bound = typeof third === "number" ? third : undefined;
  const all = RELATIONS.filter((relation) => relation.schema === schema && relation.type === type).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  return bound === undefined ? all : all.slice(0, bound);
}

/** Every statement the provider's catalog side sends, answered from the fixture above. */
function catalogAnswer(sql: string, params: unknown[] = []): Db2QueryResult | undefined {
  const [schema, second, third] = params as string[];
  switch (sql) {
    case CODE_PAGE_SQL:
      return rows([{ CODEPAGE: 1208 }]);
    case CONTAINERS_SQL:
      return rows(SCHEMAS.map((name) => ({ NAME_HEX: hex(name), IS_SESSION_DEFAULT: name === "DB2INST1" ? 1 : 0 })));
    case COUNTS_SQL:
      expect(params).toEqual([schema, schema, schema, schema, schema]);
      return rows(counts(schema));
    case LIST_TABLES_SQL:
      return rows(
        RELATIONS.filter((relation) => relation.schema === schema && relation.type === second).map((relation) => ({
          NAME_HEX: hex(relation.name),
          STATUS: relation.status ?? "N",
          CARD: relation.card ?? -1,
          VALID: relation.valid ?? null,
        })),
      );
    case LIST_SEQUENCES_SQL:
      return rows(schema === "APP" ? [{ NAME_HEX: hex("ORDER_SEQ") }] : []);
    case LIST_MODULES_SQL:
      return rows(schema === "APP" ? [{ NAME_HEX: hex("ORDER_MOD") }] : []);
    case LIST_ROUTINES_SQL:
      return rows(
        ROUTINES.filter((routine) => routine.schema === schema && routine.type === second).map((routine) => ({
          SEGMENT_HEX: hex(routine.specific),
          NAME_HEX: hex(routine.name),
          VALID: routine.valid,
        })),
      );
    case LIST_TRIGGERS_SQL:
      return rows(
        TRIGGERS.filter((trigger) => trigger.schema === schema).map((trigger) => ({
          NAME_HEX: hex(trigger.name),
          PARENT_HEX: trigger.tableSchema === trigger.schema ? hex(trigger.table) : null,
          VALID: trigger.valid,
        })),
      );
    case OBJECT_COLUMNS_SQL: {
      const relation = RELATIONS.find((candidate) => candidate.schema === schema && candidate.name === second);
      return rows(relation === undefined ? [] : columnRows(relation, false));
    }
    case OBJECT_FOREIGN_KEYS_SQL:
      return rows(foreignKeyRows(schema, second, false));
    case OBJECT_INDEXES_SQL:
      return rows(indexRows(schema, second, false));
    case bulkTargetSql(false):
    case bulkTargetSql(true):
      return rows(bulkTargets(params).map((relation) => ({ OBJECT_NAME_HEX: hex(relation.name) })));
    case bulkDetailSql(false).columns:
    case bulkDetailSql(true).columns:
      return rows(bulkTargets(params).flatMap((relation) => columnRows(relation, true)));
    case bulkDetailSql(false).foreignKeys:
    case bulkDetailSql(true).foreignKeys:
      return rows(bulkTargets(params).flatMap((relation) => foreignKeyRows(relation.schema, relation.name, true)));
    case bulkDetailSql(false).indexes:
    case bulkDetailSql(true).indexes:
      return rows(bulkTargets(params).flatMap((relation) => indexRows(relation.schema, relation.name, true)));
    case VIEW_SOURCE.head:
    case VIEW_SOURCE.tail: {
      const relation = RELATIONS.find(
        (candidate) => candidate.schema === schema && candidate.name === second && candidate.type === third,
      );
      return rows(relation === undefined ? [] : [sourceRow(VIEW_SOURCE, sql, relation.text ?? null)]);
    }
    case ROUTINE_SOURCE.head:
    case ROUTINE_SOURCE.tail: {
      const routine = ROUTINES.find(
        (candidate) => candidate.schema === schema && candidate.specific === second && candidate.type === third,
      );
      return rows(
        routine === undefined
          ? []
          : [
              {
                ...sourceRow(ROUTINE_SOURCE, sql, routine.text),
                ...(sql === ROUTINE_SOURCE.head ? { ORIGIN: routine.origin } : {}),
              },
            ],
      );
    }
    case TABLE_TRIGGER_SOURCE.head:
    case TABLE_TRIGGER_SOURCE.tail: {
      const trigger = TRIGGERS.find(
        (candidate) =>
          candidate.schema === schema &&
          candidate.tableSchema === schema &&
          candidate.table === second &&
          candidate.name === third,
      );
      return rows(trigger === undefined ? [] : [sourceRow(TABLE_TRIGGER_SOURCE, sql, trigger.text)]);
    }
    case SCHEMA_TRIGGER_SOURCE.head:
    case SCHEMA_TRIGGER_SOURCE.tail: {
      const trigger = TRIGGERS.find(
        (candidate) => candidate.schema === schema && candidate.name === second && candidate.tableSchema !== schema,
      );
      return rows(trigger === undefined ? [] : [sourceRow(SCHEMA_TRIGGER_SOURCE, sql, trigger.text)]);
    }
    case MAINTENANCE_TARGET_TYPE_SQL: {
      const relation = RELATIONS.find((candidate) => candidate.schema === schema && candidate.name === second);
      return rows(relation === undefined ? [] : [{ TYPE: relation.type }]);
    }
    case VERSION_SQL:
      return rows([{ SERVICE_LEVEL: "DB2 v12.1.0.0" }]);
    case OBJECT_COUNTS_SQL:
      return rows([{ TABLE_COUNT: 5, INDEX_COUNT: 9 }]);
    case TABLE_STATS_SQL:
      return rows(
        RELATIONS.filter((relation) => relation.type === "T" || relation.type === "S")
          .sort((a, b) => (a.schema === b.schema ? (a.name < b.name ? -1 : 1) : a.schema < b.schema ? -1 : 1))
          .map((relation) => ({
            SCHEMA_HEX: hex(relation.schema),
            NAME_HEX: hex(relation.name),
            CARD: relation.card ?? -1,
          })),
      );
    default:
      return undefined;
  }
}

// ============================================================================
// The fake driver
// ============================================================================

interface Sent {
  sql: string;
  params: unknown[] | undefined;
  options?: { rowMode: "array" };
}

let sent: Sent[] = [];
let built: Db2ClientOptions[] = [];
let closed = 0;
/** What a statement the catalog does not know answers; a test replaces it. */
let userQuery: (sql: string, params?: unknown[]) => Promise<Db2QueryResult | Db2ArrayQueryResult> = async (sql) => {
  throw new Error(`the fake catalog does not know this statement: ${sql}`);
};
/** Catalog statements a test makes the server refuse. */
let refused = new Map<string, Error>();
let connectError: unknown;
let closeError: unknown;

type EitherRows = Db2QueryResult & Db2ArrayQueryResult;

const driver: Db2Driver = {
  Client: class {
    constructor(options: Db2ClientOptions) {
      built.push(options);
    }
    async connect() {
      if (connectError !== undefined) throw connectError;
    }
    // Under `rowMode: "array"` an object row is handed back as its values in column order, as
    // db2-node 1.0.25 does; a test that needs what an object row cannot hold answers arrays itself.
    // The one return type both overloads of `Db2Client.query` accept.
    async query(sql: string, params?: unknown[], options?: { rowMode: "array" }): Promise<EitherRows> {
      sent.push(options === undefined ? { sql, params } : { sql, params, options });
      const refusal = refused.get(sql);
      if (refusal !== undefined) throw refusal;
      const answer = catalogAnswer(sql, params ?? []) ?? (await userQuery(sql, params));
      if (options?.rowMode !== "array") return answer as EitherRows;
      const rows = answer.rows.map((row) =>
        Array.isArray(row) ? row : answer.columns.map((column) => (row as Record<string, unknown>)[column.name]),
      );
      return { ...answer, rows } as EitherRows;
    }
    async close() {
      closed += 1;
      if (closeError !== undefined) throw closeError;
    }
  },
};

const removed: string[] = [];
const caFileSystem: CaFileSystem = {
  mkdtemp: async (prefix) => `${prefix}test`,
  writeFile: async () => {},
  rm: async (path) => {
    removed.push(path);
  },
};

const baseConfig: DatabaseConnection = {
  id: "db2-test",
  name: "Db2",
  type: "db2",
  host: "db2.example.com",
  port: 50001,
  user: "db2inst1",
  password: "Db2Passw0rd",
  database: "TESTDB",
  createdAt: new Date(0),
  ssl: { mode: "verify-full", caCert: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" },
};

function makeProvider(overrides: Partial<DatabaseConnection> = {}): Db2Provider {
  return new Db2Provider({ ...baseConfig, ...overrides }, {}, { loadDriver: async () => driver, caFileSystem });
}

async function connected(overrides: Partial<DatabaseConnection> = {}): Promise<Db2Provider> {
  const provider = makeProvider(overrides);
  await provider.connect();
  return provider;
}

afterEach(() => {
  sent = [];
  built = [];
  closed = 0;
  removed.length = 0;
  refused = new Map();
  connectError = undefined;
  closeError = undefined;
  userQuery = async (sql) => {
    throw new Error(`the fake catalog does not know this statement: ${sql}`);
  };
});

const column = (name: string, typeName: string): Db2ColumnMeta => ({ name, typeName, nullable: true });

// ============================================================================
// Construction, declaration, connection
// ============================================================================

describe("Db2Provider: declaration", () => {
  test("is an SQL provider whose capabilities are the frozen declaration, read whole", () => {
    const provider = makeProvider();
    const base = Object.getPrototypeOf(SQLBaseProvider.prototype).getCapabilities.call(
      provider,
    ) as ProviderCapabilities;
    const declared = db2Capabilities(base);
    const capabilities = provider.getCapabilities();

    expect(provider).toBeInstanceOf(SQLBaseProvider);
    expect(capabilities).toEqual(declared);
    // The two facts the shared surfaces read are in the declaration itself, so a census sees them.
    expect(declared.previewProjection).toBe(DB2_PREVIEW_PROJECTION);
    expect(declared.maintenanceOperationSpecs).toEqual({
      analyze: {
        label: "Run Statistics",
        perEntity: true,
        global: false,
        kinds: ["table", "materialized_query_table"],
      },
      optimize: {
        label: "Reorganize Table",
        perEntity: true,
        global: false,
        kinds: ["table", "materialized_query_table"],
      },
    });
    expect(capabilities.objectKinds).toBe(DB2_OBJECT_KINDS);
    expect(capabilities.containerLevels).toBe(DB2_CONTAINER_LEVELS);
    expect(provider.getLabels()).toEqual(
      db2Labels(Object.getPrototypeOf(SQLBaseProvider.prototype).getLabels.call(provider)),
    );
  });

  // db2-node 1.0.24 reads non-ASCII text back as written (K1) and refuses a DECIMAL that does not
  // fit (K22), measured on 12.1.0.0 and 11.5.9.0 with an edit and an import read back as HEX, so a
  // table takes row writes again. Create Table stays off: it needs a Db2 row of column types.
  test("only the table kind takes row writes, inline edit is on, and Create Table is off", () => {
    const capabilities = makeProvider().getCapabilities();

    expect(capabilities.supportsInlineRowEdit).toBe(true);
    expect(capabilities.supportsCreateTable).toBe(false);
    expect(capabilities.objectKinds?.filter((kind) => kind.acceptsRowWrites === true).map((kind) => kind.id)).toEqual([
      "table",
    ]);
    expect(capabilities.objectKinds?.some((kind) => kind.acceptsSourceEdits === true)).toBe(false);
  });

  // K24, measured on 12.1.0.0 and 11.5.9.0 through 1.0.24 and 1.0.25: a value bound to a CLOB,
  // DBCLOB or BLOB column declared 32768 bytes or longer is not written and no error is raised. A
  // result declares those columns without their length (`CLOB(1K)` and `CLOB(1M)` both read
  // `CLOB`), so the grid's editor refuses every one of them, and only them.
  test("the inline editor refuses a CLOB, DBCLOB or BLOB column, and no other (K24)", () => {
    const refused = makeProvider().getCapabilities().inlineEditRefusedColumns;
    expect(refused).toBeDefined();
    const pattern = new RegExp(refused!.type);

    for (const type of ["CLOB", "DBCLOB", "BLOB"]) expect(pattern.test(type)).toBe(true);
    for (const type of ["VARCHAR(20)", "XML", "VARBINARY(10)", "GRAPHIC(4)", "CLOBBER"]) {
      expect(pattern.test(type)).toBe(false);
    }
    expect(refused!.reason).toContain("K24");
  });

  test("declares none of the methods this version leaves out", () => {
    const provider = makeProvider() as unknown as Record<string, unknown>;
    for (const method of [
      "queryReadOnly",
      "endOpenQueryTransaction",
      "cancelQuery",
      "beginTransaction",
      "commitTransaction",
      "rollbackTransaction",
      "buildObjectEdit",
      "applyObjectEdit",
      "scanKeysPage",
    ]) {
      expect(provider[method]).toBeUndefined();
    }
  });

  test("validates the connection at construction", () => {
    expect(() => makeProvider({ host: undefined })).toThrow(new DatabaseConfigError("Host is required for Db2", "db2"));
    expect(() => makeProvider({ connectionString: "postgres://x" })).toThrow("must start with db2://");
  });

  test("the default seams are the real driver loader and file system", () => {
    expect(() => new Db2Provider(baseConfig)).not.toThrow();
  });
});

describe("Db2Provider: connect and disconnect", () => {
  test("connects with the TLS options and the CA file, then closes and removes the file", async () => {
    const provider = await connected();

    expect(provider.isConnected()).toBe(true);
    expect(built[0]).toEqual({
      host: "db2.example.com",
      port: 50001,
      database: "TESTDB",
      user: "db2inst1",
      password: "Db2Passw0rd",
      ssl: true,
      rejectUnauthorized: true,
      sslClientHostnameValidation: "Basic",
      caCert: join(tmpdir(), "libredb-db2-test", "ca.pem"),
    });

    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
    expect(closed).toBe(1);
    expect(removed).toEqual([join(tmpdir(), "libredb-db2-test")]);
  });

  test("a connection with no TLS and no consent is refused before the driver is reached", async () => {
    const provider = makeProvider({ ssl: undefined });
    await expect(provider.connect()).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(built).toEqual([]);
    expect(provider.isConnected()).toBe(false);
  });

  // 1.0.25 sends these characters as typed over TLS and without it, under either mechanism,
  // measured on 12.1.0.0 and 11.5.9.0 (K23, fixed), so the provider no longer refuses them.
  test.each([
    ["over TLS", {}],
    ["without TLS behind the insecure opt-in", { ssl: undefined, allowInsecureAuth: true }],
  ] as const)("a password holding ! ^ [ ] and | connects, %s (K23)", async (_, overrides) => {
    const provider = await connected({ ...overrides, password: "Pw!a^b[c]d|9" });

    expect(built[0].password).toBe("Pw!a^b[c]d|9");
    expect(provider.isConnected()).toBe(true);
    await provider.disconnect();
  });

  test("no TLS without the opt-in is refused for the transport first, whatever the password holds", async () => {
    const provider = makeProvider({ ssl: undefined, password: "Password123!" });
    const error = await provider.connect().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect((error as Error).message).toContain("has no TLS");
    expect(built).toEqual([]);
  });

  test("a connection with no TLS and the consent connects without TLS", async () => {
    const provider = await connected({ ssl: undefined, allowInsecureAuth: true });
    expect(built[0].ssl).toBe(false);
    await provider.disconnect();
    expect(removed).toEqual([]);
  });

  test("through a tunnel it dials the tunnel's local end, never the string's host", async () => {
    const provider = makeProvider({
      host: "127.0.0.1",
      port: 41234,
      connectionString: "db2://u:p@db2.remote.example:50001/TESTDB",
      ssl: { mode: "verify-ca", caCert: "PEM" },
      sshTunnel: { enabled: true, host: "bastion", port: 22, username: "u", authMethod: "password" },
      [TUNNEL_FAR_END]: { host: "db2.remote.example", port: 50001 },
    } as Partial<DatabaseConnection>);
    await provider.connect();

    expect(built[0].host).toBe("127.0.0.1");
    expect(built[0].port).toBe(41234);
    expect(built[0].sslClientHostnameValidation).toBe("OFF");
    await provider.disconnect();
  });

  test("a failed connect is a ConnectionError and leaves the provider disconnected", async () => {
    connectError = new Error("ECONNRESET");
    const provider = makeProvider();
    const error = await provider.connect().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toBe("Failed to connect to Db2: ECONNRESET");
    expect(provider.isConnected()).toBe(false);
    expect(removed).toHaveLength(1);
  });

  test("a failed close is mapped, and the CA file is removed all the same", async () => {
    const provider = await connected();
    closeError = new Error("socket closed");

    await expect(provider.disconnect()).rejects.toThrow("socket closed");
    expect(removed).toHaveLength(1);
    expect(provider.isConnected()).toBe(false);
  });

  test("disconnecting a provider that never connected does nothing", async () => {
    await makeProvider().disconnect();
    expect(closed).toBe(0);
  });

  test("every read refuses before connect", async () => {
    const provider = makeProvider();
    await expect(provider.query("SELECT 1 FROM SYSIBM.SYSDUMMY1")).rejects.toThrow("not connected");
    await expect(provider.listContainers()).rejects.toThrow("not connected");
    await expect(provider.getHealth()).rejects.toThrow("not connected");
  });
});

// ============================================================================
// Queries
// ============================================================================

describe("Db2Provider: query", () => {
  test("reads the driver's result, declares its types and sends no parameters as undefined", async () => {
    userQuery = async () => ({
      rows: [{ ID: 1, NAME: "Ada" }],
      rowCount: 1,
      columns: [column("ID", "Integer"), column("NAME", "VarChar(100)")],
      diagnostics: [],
    });
    const provider = await connected();
    const result = await provider.query("SELECT ID, NAME FROM APP.CUSTOMERS");

    expect(result.rows).toEqual([{ ID: 1, NAME: "Ada" }]);
    expect(result.fields).toEqual(["ID", "NAME"]);
    expect(result.rowCount).toBe(1);
    expect(result.columnTypes).toEqual({ ID: "INTEGER", NAME: "VARCHAR(100)" });
    expect(result).not.toHaveProperty("warnings");
    expect(typeof result.executionTime).toBe("number");
    expect(sent.at(-1)).toEqual({
      sql: "SELECT ID, NAME FROM APP.CUSTOMERS",
      params: undefined,
      options: { rowMode: "array" },
    });
  });

  // K15, fixed in 1.0.25: measured on 12.1.0.0 and 11.5.9.0, `SELECT 1 AS A, 2 AS A` answers the
  // array row [1, 2], where an object row keeps only {A: 2}.
  test("a duplicated column keeps both values, the repeat under a numbered name", async () => {
    userQuery = async () => ({
      rows: [[1, 2]],
      rowCount: 1,
      columns: [column("A", "Integer"), column("A", "Integer")],
      diagnostics: [],
    });
    const provider = await connected();
    const result = await provider.query("SELECT 1 AS A, 2 AS A FROM SYSIBM.SYSDUMMY1");

    expect(result.fields).toEqual(["A", "A (2)"]);
    expect(result.rows).toEqual([{ A: 1, "A (2)": 2 }]);
    expect(result).not.toHaveProperty("warnings");
  });

  // K24, measured on 12.1.0.0 and 11.5.9.0 through 1.0.24 and 1.0.25: a value bound to a CLOB(1M)
  // answers 0 changed rows and is not written, so a result holding one says the grid does not edit it.
  test("a result holding a CLOB says the grid does not edit it (K24)", async () => {
    userQuery = async () => ({
      rows: [{ ID: 1, C_CLOB: "clob text" }],
      rowCount: 1,
      columns: [column("ID", "Integer"), column("C_CLOB", "VarChar(32777)")],
      diagnostics: [],
    });
    const provider = await connected();
    const result = await provider.query("SELECT ID, C_CLOB FROM APP.ALLTYPES");

    expect(result.rows).toEqual([{ ID: 1, C_CLOB: "clob text" }]);
    expect(result.warnings?.[0]?.message).toContain("does not edit C_CLOB (CLOB) inline");
  });

  // K16, fixed in 1.0.25: measured on 12.1.0.0 and 11.5.9.0, a BOOLEAN bound as the text "true" or
  // "false", which is what the grid's inline editor sends, is stored as that boolean.
  test("a BOOLEAN edit reaches the driver as the text the grid sends", async () => {
    userQuery = async () => ({ rows: [], rowCount: 1, columns: [], diagnostics: [] });
    const provider = await connected();
    const result = await provider.query('UPDATE "APP"."FLAGS" SET "FLAG" = ? WHERE "ID" = ?', ["false", 1]);

    expect(sent.at(-1)?.params).toEqual(["false", 1]);
    expect(result.rowCount).toBe(1);
  });

  // db2-node 1.0.24 classifies a statement past its leading comments (K18) and binds a bigint
  // losslessly (K10, K6), so both reach it exactly as the caller wrote them.
  test("sends a leading comment and a bigint as written", async () => {
    userQuery = async () => ({ rows: [], rowCount: 0, columns: [column("A", "BigInt")], diagnostics: [] });
    const provider = await connected();
    const huge = BigInt(2) ** BigInt(63) - BigInt(1);
    await provider.query("-- note\n/* more */ SELECT A FROM T WHERE A = ?", [huge]);

    expect(sent.at(-1)).toEqual({
      sql: "-- note\n/* more */ SELECT A FROM T WHERE A = ?",
      params: [huge],
      options: { rowMode: "array" },
    });
  });

  test("refuses an array parameter before anything is sent (M3)", async () => {
    const provider = await connected();
    const before = sent.length;

    await expect(provider.query("SELECT ?", [[1, 2]])).rejects.toBeInstanceOf(QueryError);
    expect(sent.length).toBe(before);
  });

  // K17, fixed in 1.0.25: measured on 12.1.0.0 and 11.5.9.0, a failure the driver raises itself
  // carries a driverCode and no SQLSTATE, and its words alone used to decide its class.
  test.each([
    ["DB2_PARAMETER_TYPE", "Protocol error: DECIMAL parameter out of range for DECIMAL(5,2)", QueryError],
    [
      "DB2_PARAMETER_COUNT",
      "Protocol error: parameter descriptor count 1 does not match parameter count 2",
      QueryError,
    ],
  ] as const)("a %s failure is a QueryError carrying the driver's words and the statement", async (code, words) => {
    userQuery = async () => {
      throw Object.assign(new Error(words), { driverCode: code, code: "GenericFailure" });
    };
    const provider = await connected();
    const error = (await provider
      .query("VALUES CAST(? AS DECIMAL(5,2))", ["12345.67"])
      .catch((e: unknown) => e)) as QueryError;

    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(words);
    expect(error.query).toBe("VALUES CAST(? AS DECIMAL(5,2))");
  });

  test.each(["DB2_PROTOCOL", "DB2_INVALID_OPTION"])(
    "a %s failure is the driver's own, a plain DatabaseError whatever its words say",
    async (code) => {
      // "column" and "timeout" would each send the shared keyword mapping the wrong way.
      userQuery = async () => {
        throw Object.assign(new Error("Protocol error: column 3 reply timeout"), { driverCode: code });
      };
      const provider = await connected();
      const error = (await provider.query("SELECT 1 FROM SYSIBM.SYSDUMMY1").catch((e: unknown) => e)) as Error;

      expect(error.constructor).toBe(DatabaseError);
      expect(error.message).toBe("Protocol error: column 3 reply timeout");
    },
  );

  test("a driverCode this provider does not know falls to the shared mapping", async () => {
    userQuery = async () => {
      throw Object.assign(new Error("Query timeout after 5s"), { driverCode: "DB2_SOMETHING_NEW" });
    };
    const provider = await connected();
    await expect(provider.query("SELECT 1 FROM SYSIBM.SYSDUMMY1")).rejects.toBeInstanceOf(TimeoutError);
  });

  test("a driver error is mapped with the statement", async () => {
    userQuery = async () => {
      throw Object.assign(new Error('SQL Error [SQLSTATE=42704, SQLCODE=-204]: "APP.NOPE" is an undefined name.'), {
        sqlstate: "42704",
      });
    };
    const provider = await connected();
    await expect(provider.query("SELECT * FROM APP.NOPE")).rejects.toThrow("APP.NOPE");
  });
});

describe("Db2Provider: prepareQuery", () => {
  const provider = makeProvider();

  test("the first page is FETCH FIRST, before a trailing semicolon or comment", () => {
    expect(provider.prepareQuery("SELECT * FROM T;", { limit: 50 })).toEqual({
      query: "SELECT * FROM T FETCH FIRST 50 ROWS ONLY;",
      wasLimited: true,
      limit: 50,
      offset: 0,
    });
    expect(provider.prepareQuery("SELECT * FROM T -- note", { limit: 50 }).query).toBe(
      "SELECT * FROM T FETCH FIRST 50 ROWS ONLY -- note",
    );
  });

  test("a later page is OFFSET m ROWS FETCH NEXT n ROWS ONLY", () => {
    expect(provider.prepareQuery("SELECT * FROM T", { limit: 50, offset: 100 }).query).toBe(
      "SELECT * FROM T OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY",
    );
  });

  test("a statement that bounds itself is left alone, FETCH FIRST and LIMIT both", () => {
    expect(provider.prepareQuery("SELECT * FROM T FETCH FIRST 5 ROWS ONLY").wasLimited).toBe(false);
    // Measured on 12.1.0.0: Db2 accepts LIMIT, and the limiter reads it as a bound for db2 too.
    expect(provider.prepareQuery("SELECT * FROM T LIMIT 5")).toMatchObject({
      query: "SELECT * FROM T LIMIT 5",
      wasLimited: false,
    });
  });

  test("a statement that is not a SELECT, or whose end cannot be found, is left alone", () => {
    expect(provider.prepareQuery("DELETE FROM T").wasLimited).toBe(false);
    expect(provider.prepareQuery("SELECT 'unterminated FROM T").wasLimited).toBe(false);
  });

  test("an unlimited run uses the unlimited ceiling", () => {
    expect(provider.prepareQuery("SELECT * FROM T", { unlimited: true }).query).toMatch(/FETCH FIRST \d+ ROWS ONLY$/);
  });

  test("the preview the object browser generates reads each column through the projection", () => {
    const preview = generateTableQuery(["APP", "ALLTYPES"], provider.getCapabilities(), [
      { name: "ID", type: "INTEGER", nullable: false, isPrimary: true },
      { name: "C_BIG", type: "BIGINT", nullable: true, isPrimary: false },
      { name: "C_VCHAR", type: "VARCHAR(50)", nullable: true, isPrimary: false },
      { name: "C_BOOL", type: "BOOLEAN", nullable: true, isPrimary: false },
      { name: "C_TS0", type: "TIMESTAMP(0)", nullable: true, isPrimary: false },
      { name: "C_CLOB", type: "CLOB(1048576)", nullable: true, isPrimary: false },
      { name: "C_DBCLOB", type: "DBCLOB(1024)", nullable: true, isPrimary: false },
      { name: "C_BLOB", type: "BLOB(1048576)", nullable: true, isPrimary: false },
      { name: "C_XML", type: "XML", nullable: true, isPrimary: false },
    ]);

    // K4 is fixed in 1.0.25, so XML is read beside the rest; a CLOB, DBCLOB or BLOB stays out,
    // because db2-node writes nothing for a value bound to one (K24).
    expect(preview).toBe(
      '-- Not read by this preview: "C_CLOB" CLOB(1048576), "C_DBCLOB" DBCLOB(1024), "C_BLOB" BLOB(1048576). db2-node writes nothing, and reports no error, for an inline edit of a CLOB, DBCLOB or BLOB column, so this preview does not offer one; select such a column in a query of your own to read it (docs/providers/db2.md, K24).\n' +
        'SELECT "ID", "C_BIG", "C_VCHAR", "C_BOOL", "C_TS0", "C_XML" FROM "APP"."ALLTYPES";',
    );
    // The bound lands after the statement, and the leading comment goes to the driver as written.
    expect(provider.prepareQuery(preview, { limit: 50 }).query).toEndWith(
      'FROM "APP"."ALLTYPES" FETCH FIRST 50 ROWS ONLY;',
    );
  });
});

// ============================================================================
// Object surface
// ============================================================================

describe("Db2Provider: object surface", () => {
  test("the schemas, sorted, with the session's own marked", async () => {
    const provider = await connected();
    expect(await provider.listContainers()).toEqual([
      { path: ["APP"], name: "APP", level: 0, isSessionDefault: false },
      { path: ["DB2INST1"], name: "DB2INST1", level: 0, isSessionDefault: true },
      { path: ["REPORTING"], name: "REPORTING", level: 0, isSessionDefault: false },
    ]);
    expect(await provider.listContainers(["APP"])).toEqual([]);
  });

  test("the code page is read once per connection", async () => {
    const provider = await connected();
    await provider.listContainers();
    await provider.listContainers();
    expect(sent.filter((statement) => statement.sql === CODE_PAGE_SQL)).toHaveLength(1);
  });

  test("a code page the catalog does not answer as a number is refused", async () => {
    const provider = await connected();
    const original = driver.Client.prototype.query;
    driver.Client.prototype.query = async function (sql: string, params?: unknown[]) {
      if (sql === CODE_PAGE_SQL) return rows([]);
      return original.call(this, sql, params);
    };
    try {
      await expect(provider.listContainers()).rejects.toThrow(
        "Db2 answered no code page for this database (undefined)",
      );
    } finally {
      driver.Client.prototype.query = original;
    }
  });

  test("counts every kind, a refused read naming the server's sentence on each", async () => {
    const provider = await connected();
    expect(await provider.countObjects(["REPORTING"])).toEqual({
      table: { count: 1 },
      view: { count: 0 },
      materialized_query_table: { count: 0 },
      alias: { count: 0 },
      sequence: { count: 0 },
      module: { count: 0 },
      procedure: { count: 0 },
      function: { count: 0 },
      trigger: { count: 1 },
    });

    refused.set(
      COUNTS_SQL,
      new Error("SQL0551N  The statement failed because the authorization ID does not have the privilege"),
    );
    const unavailable = await provider.countObjects(["APP"]);
    expect(Object.keys(unavailable)).toHaveLength(9);
    for (const value of Object.values(unavailable)) {
      expect(value).toEqual({
        unavailable: "SQL0551N  The statement failed because the authorization ID does not have the privilege",
      });
    }
  });

  test("a refusal that is not an Error still reaches the count", async () => {
    const provider = await connected();
    refused.set(COUNTS_SQL, "plain refusal" as unknown as Error);
    const unavailable = await provider.countObjects(["APP"]);
    expect(unavailable.table).toEqual({ unavailable: "plain refusal" });
  });

  test("a container path of another depth is refused by the declared shape", async () => {
    const provider = await connected();
    await expect(provider.countObjects(["TESTDB", "APP"])).rejects.toThrow(
      'A Db2 container path is [schema], received ["TESTDB","APP"]',
    );
  });

  test("listings carry status, row counts and the routine's specific name", async () => {
    const provider = await connected();

    expect(await provider.listObjects(["APP"], "table")).toEqual([
      { path: ["APP", "CUSTOMERS"], name: "CUSTOMERS", kind: "table", rowCount: 2 },
      { path: ["APP", "Mixed Case"], name: "Mixed Case", kind: "table" },
      { path: ["APP", "ORDERS"], name: "ORDERS", kind: "table", rowCount: 2 },
    ]);
    expect(await provider.listObjects(["APP"], "view")).toEqual([
      { path: ["APP", "ORDER_SUMMARY"], name: "ORDER_SUMMARY", kind: "view" },
      { path: ["APP", "SCRATCH_VIEW"], name: "SCRATCH_VIEW", kind: "view", status: "INVALID" },
    ]);
    expect(await provider.listObjects(["APP"], "function")).toEqual([
      { path: ["APP", "ORDER_TOTAL_BY_ID"], name: "ORDER_TOTAL", kind: "function" },
      { path: ["APP", "SQL231003120000200"], name: "ORDER_TOTAL", kind: "function" },
      { path: ["APP", "SQL231003120000300"], name: "EXT_FN", kind: "function" },
    ]);
    expect(await provider.listObjects(["APP"], "trigger")).toEqual([
      { path: ["APP", "ORDERS", "ORDERS_NOTE_DEFAULT"], name: "ORDERS_NOTE_DEFAULT", kind: "trigger" },
    ]);
    expect(await provider.listObjects(["REPORTING"], "trigger")).toEqual([
      { path: ["REPORTING", "ORDERS_AUDIT"], name: "ORDERS_AUDIT", kind: "trigger" },
    ]);
    expect(await provider.listObjects(["APP"], "alias")).toEqual([
      { path: ["APP", "CLIENTS"], name: "CLIENTS", kind: "alias" },
    ]);
  });

  test("a kind the declaration does not name is refused, and so is a declared kind with no listing", async () => {
    const provider = await connected();
    await expect(provider.listObjects(["APP"], "package")).rejects.toThrow('Db2 declares no object kind "package"');

    const odd = makeProvider();
    const capabilities = odd.getCapabilities();
    odd.getCapabilities = () => ({
      ...capabilities,
      objectKinds: [
        ...DB2_OBJECT_KINDS,
        { id: "nickname", role: "config", label: "Nickname", labelPlural: "Nicknames" },
      ],
    });
    await odd.connect();
    await expect(odd.listObjects(["APP"], "nickname")).rejects.toThrow(
      'Db2 declares the kind "nickname" but has no statement that lists it',
    );
  });

  test("a declaration without a schema level is refused rather than bound positionally", async () => {
    const odd = makeProvider();
    const capabilities = odd.getCapabilities();
    odd.getCapabilities = () => ({
      ...capabilities,
      containerLevels: [{ id: "catalog", label: "Catalog", labelPlural: "Catalogs" }],
    });
    await odd.connect();
    await expect(odd.listObjects(["APP"], "table")).rejects.toThrow('A Db2 path needs a "schema" container level');
  });

  test("describes a table: columns, key, default, references and indexes", async () => {
    const provider = await connected();
    expect(await provider.describeObject(["APP", "ORDERS"], "table")).toEqual({
      path: ["APP", "ORDERS"],
      columns: [
        { name: "ID", type: "INTEGER", nullable: false, isPrimary: true },
        { name: "CUSTOMER_ID", type: "INTEGER", nullable: true, isPrimary: false },
        { name: "TOTAL", type: "DECIMAL(12,2)", nullable: true, isPrimary: false, defaultValue: "0" },
        { name: "NOTE", type: "VARCHAR(200)", nullable: true, isPrimary: false },
      ],
      indexes: [
        { name: "ORDERS_CUSTOMER_IX", columns: ["CUSTOMER_ID", "TOTAL"], unique: false },
        { name: "SYSIBM.SQL230101", columns: ["ID"], unique: true },
      ],
      foreignKeys: [{ columnName: "CUSTOMER_ID", referencedTable: "CUSTOMERS", referencedColumn: "ID" }],
    });
    const daily = await provider.describeObject(["REPORTING", "DAILY"], "table");
    expect(daily.foreignKeys).toEqual([
      { columnName: "CUSTOMER_ID", referencedTable: "APP.CUSTOMERS", referencedColumn: "ID" },
    ]);
  });

  test("a kind with no columns answers empty with no round trip", async () => {
    const provider = await connected();
    const before = sent.length;
    expect(await provider.describeObject(["APP", "CLIENTS"], "alias")).toEqual({
      path: ["APP", "CLIENTS"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect(sent.length).toBe(before);
    await expect(provider.describeObject(["APP", "X"], "nope")).rejects.toThrow('Db2 declares no object kind "nope"');
    await expect(provider.describeObject(["APP"], "table")).rejects.toThrow("A Db2");
  });

  test("describes a kind in four round trips, bounded and truncated by the caller's limit", async () => {
    const provider = await connected();
    // The code page is read once per connection, by the first catalog read; it is not one of the four.
    await provider.listContainers();
    const before = sent.length;
    const all = await provider.describeObjects(["APP"], "table");
    expect(sent.length - before).toBe(4);
    expect(all.details.map((detail) => detail.path)).toEqual([
      ["APP", "CUSTOMERS"],
      ["APP", "Mixed Case"],
      ["APP", "ORDERS"],
    ]);
    expect(all).not.toHaveProperty("truncated");
    expect(all.details[2].foreignKeys).toHaveLength(1);

    const bounded = await provider.describeObjects(["APP"], "table", 2);
    expect(bounded.details).toHaveLength(2);
    expect(bounded.truncated).toEqual({ limit: 2, reason: callerBoundTruncationReason(2) });
    expect(sent.find((statement) => statement.sql === bulkTargetSql(true))?.params).toEqual(["APP", "T", 3]);
    expect(sent.find((statement) => statement.sql === bulkDetailSql(true).columns)?.params).toEqual([
      "APP",
      "T",
      3,
      "APP",
    ]);

    expect((await provider.describeObjects(["APP"], "table", 3)).truncated).toBeUndefined();
  });

  test("a bulk read of a kind with no columns or no objects costs at most the target read", async () => {
    const provider = await connected();
    expect(await provider.describeObjects(["APP"], "trigger")).toEqual({ details: [] });
    expect(await provider.describeObjects(["DB2INST1"], "table")).toEqual({ details: [] });
    for (const limit of [0, -1, 1.5]) {
      await expect(provider.describeObjects(["APP"], "table", limit)).rejects.toThrow(
        `A Db2 bulk column read limit must be a positive whole number, received ${limit}`,
      );
    }
    await expect(provider.describeObjects(["APP"], "nope")).rejects.toThrow('Db2 declares no object kind "nope"');
  });
});

describe("Db2Provider: source", () => {
  test("a view's stored definition, complete", async () => {
    const provider = await connected();
    expect(await provider.readObjectSource(["APP", "ORDER_SUMMARY"], "view")).toEqual({
      path: ["APP", "ORDER_SUMMARY"],
      kind: "view",
      parts: [
        {
          id: "definition",
          label: "Definition",
          text: RELATIONS[3].text as string,
          language: "sql",
          form: "complete",
          origin: "stored",
        },
      ],
    });
  });

  test("a routine by its specific name, a trigger by either address", async () => {
    const provider = await connected();
    const fn = await provider.readObjectSource(["APP", "ORDER_TOTAL_BY_ID"], "function");
    expect(fn.parts[0]).toMatchObject({ text: ROUTINES[1].text });
    expect(sent.at(-1)?.params).toEqual(["APP", "ORDER_TOTAL_BY_ID", "F"]);

    const onTable = await provider.readObjectSource(["APP", "ORDERS", "ORDERS_NOTE_DEFAULT"], "trigger");
    expect(onTable.parts[0]).toMatchObject({ text: TRIGGERS[0].text });
    const crossSchema = await provider.readObjectSource(["REPORTING", "ORDERS_AUDIT"], "trigger");
    expect(crossSchema.parts[0]).toMatchObject({ text: TRIGGERS[1].text });
    const mqt = await provider.readObjectSource(["APP", "ORDER_TOTALS"], "materialized_query_table");
    expect(mqt.parts[0]).toMatchObject({ text: RELATIONS[5].text });
  });

  test("an EXTERNAL routine is a refusal that says why", async () => {
    const provider = await connected();
    const document = await provider.readObjectSource(["APP", "SQL231003120000300"], "function");
    expect(document.parts).toEqual([
      {
        id: "definition",
        label: "Definition",
        unavailable: "EXTERNAL routine: its body is compiled code outside the database.",
      },
    ]);
  });

  test("a missing object raises, naming it", async () => {
    const provider = await connected();
    await expect(provider.readObjectSource(["APP", "NO_SUCH_VIEW"], "view")).rejects.toThrow(
      'Db2 holds no view called "NO_SUCH_VIEW" in APP',
    );
    await expect(provider.readObjectSource(["APP", "CLIENTS"], "alias")).rejects.toThrow(
      'Db2 publishes no definition text for the kind "alias"',
    );
  });

  test("other refusals: a sourced and a federated routine, an unknown origin, no origin, empty text", async () => {
    const provider = await connected();
    const answers: Record<string, unknown>[] = [
      { ...definition(null), ORIGIN: "U" },
      { ...definition(null), ORIGIN: "F" },
      { ...definition(null), ORIGIN: "Z" },
      definition(null),
      definition("   "),
    ];
    const sentences: string[] = [];
    for (const answer of answers) {
      refused = new Map();
      const original = driver.Client.prototype.query;
      driver.Client.prototype.query = async function (sql: string, params?: unknown[]) {
        if (sql === ROUTINE_SOURCE.head || sql === VIEW_SOURCE.head) return rows([answer]);
        return original.call(this, sql, params);
      };
      try {
        const kind = "ORIGIN" in answer ? "function" : "view";
        const part = (await provider.readObjectSource(["APP", "X"], kind)).parts[0];
        expect(isSourcePartUnavailable(part)).toBe(true);
        sentences.push((part as { unavailable: string }).unavailable);
      } finally {
        driver.Client.prototype.query = original;
      }
    }
    expect(sentences).toEqual([
      "SOURCED routine: it is defined as another function, with no body of its own.",
      "FEDERATED procedure: its body lives on the remote data source.",
      "SYSCAT answered no definition text for this routine (ORIGIN Z).",
      "SYSCAT answered no definition text for APP.X.",
      "SYSCAT answered an empty definition.",
    ]);
  });

  test("a definition longer than the byte bound is read in two statements, is partial and says why", async () => {
    const provider = await connected();
    const long = `CREATE VIEW APP.BIG AS SELECT ${"1 AS C, ".repeat(6000)}1 AS Z FROM SYSIBM.SYSDUMMY1`;
    const original = driver.Client.prototype.query;
    const reads: string[] = [];
    driver.Client.prototype.query = async function (sql: string, params?: unknown[]) {
      if (sql === VIEW_SOURCE.head || sql === VIEW_SOURCE.tail) {
        reads.push(sql);
        return rows([sourceRow(VIEW_SOURCE, sql, long)]);
      }
      return original.call(this, sql, params);
    };
    try {
      const cut = (await provider.readObjectSource(["APP", "BIG"], "view")).parts[0] as Record<string, unknown>;
      expect(reads).toEqual([VIEW_SOURCE.head, VIEW_SOURCE.tail]);
      expect((cut.text as string).startsWith("CREATE VIEW APP.BIG AS SELECT 1 AS C, ")).toBe(true);
      expect(cut.form).toBe("partial");
      expect(cut.truncated).toEqual({ limit: 32672, reason: SOURCE_TRUNCATION_REASON });
      expect((cut.text as string).length).toBe(32672);

      const bounded = (await provider.readObjectSource(["APP", "BIG"], "view", 100)).parts[0] as Record<
        string,
        unknown
      >;
      expect(bounded.truncated).toEqual({ limit: 100, reason: sourceBoundTruncationReason(100) });
      expect(bounded.form).toBe("partial");
    } finally {
      driver.Client.prototype.query = original;
    }
  });
});

describe("Db2Provider: source between one and two chunks", () => {
  test("is read whole from two statements and is complete", async () => {
    const provider = await connected();
    const medium = `CREATE VIEW APP.MID AS SELECT 'Grüße' AS G, ${"1 AS C, ".repeat(2500)}1 AS Z FROM SYSIBM.SYSDUMMY1`;
    const original = driver.Client.prototype.query;
    driver.Client.prototype.query = async function (sql: string, params?: unknown[]) {
      if (sql === VIEW_SOURCE.head || sql === VIEW_SOURCE.tail) return rows([sourceRow(VIEW_SOURCE, sql, medium)]);
      return original.call(this, sql, params);
    };
    try {
      const part = (await provider.readObjectSource(["APP", "MID"], "view")).parts[0] as Record<string, unknown>;
      expect(part.text).toBe(medium);
      expect(part.form).toBe("complete");
      expect(part).not.toHaveProperty("truncated");
    } finally {
      driver.Client.prototype.query = original;
    }
  });

  test("an object dropped between the two reads raises as missing", async () => {
    const provider = await connected();
    const medium = `CREATE VIEW APP.MID AS SELECT ${"1 AS C, ".repeat(2500)}1 AS Z FROM SYSIBM.SYSDUMMY1`;
    const original = driver.Client.prototype.query;
    driver.Client.prototype.query = async function (sql: string, params?: unknown[]) {
      if (sql === VIEW_SOURCE.head) return rows([definition(medium)]);
      if (sql === VIEW_SOURCE.tail) return rows([]);
      return original.call(this, sql, params);
    };
    try {
      await expect(provider.readObjectSource(["APP", "MID"], "view")).rejects.toThrow(
        'Db2 holds no view called "MID" in APP',
      );
    } finally {
      driver.Client.prototype.query = original;
    }
  });
});

describe("Db2Provider: the shared object-surface contract", () => {
  test("assertObjectSurface", async () => {
    const provider = await connected();
    await assertObjectSurface(provider, {
      containers: [["APP"], ["DB2INST1"], ["REPORTING"]],
      kinds: {
        table: 3,
        view: 2,
        materialized_query_table: 1,
        alias: 1,
        sequence: 1,
        module: 1,
        procedure: 1,
        function: 3,
        trigger: 1,
      },
      sampleObject: { path: ["APP", "ORDERS"], kind: "table" },
      absentSource: { path: ["APP", "NO_SUCH_VIEW"], kind: "view" },
    });
    await provider.disconnect();
  });
});

// ============================================================================
// Maintenance and monitoring
// ============================================================================

describe("Db2Provider: maintenance", () => {
  test("RUNSTATS and REORG run in a compound block on a table and an MQT", async () => {
    const provider = await connected();
    const executed: string[] = [];
    userQuery = async (sql) => {
      executed.push(sql);
      return { rows: [], rowCount: 0, columns: [], diagnostics: [] };
    };

    const analyze = await provider.runMaintenance("analyze", "Mixed Case", "APP");
    expect(analyze).toMatchObject({ success: true, message: "RUNSTATS completed on APP.Mixed Case" });
    const optimize = await provider.runMaintenance("optimize", "ORDER_TOTALS", "APP");
    expect(optimize.message).toBe("REORG completed on APP.ORDER_TOTALS");
    expect(executed).toEqual([
      `CALL SYSPROC.ADMIN_CMD('RUNSTATS ON TABLE "APP"."Mixed Case" WITH DISTRIBUTION AND DETAILED INDEXES ALL')`,
      `CALL SYSPROC.ADMIN_CMD('REORG TABLE "APP"."ORDER_TOTALS"')`,
    ]);
  });

  test("a view, a missing table and a missing schema are refused before the command is sent", async () => {
    const provider = await connected();
    let executed = 0;
    userQuery = async () => {
      executed += 1;
      return { rows: [], rowCount: 0, columns: [], diagnostics: [] };
    };

    await expect(provider.runMaintenance("analyze", "ORDER_SUMMARY", "APP")).rejects.toThrow(
      "RUNSTATS runs on a table or a materialized query table, and APP.ORDER_SUMMARY is neither (SYSCAT.TABLES.TYPE V).",
    );
    await expect(provider.runMaintenance("optimize", "NOPE", "APP")).rejects.toThrow(
      'Db2 holds no table called "NOPE" in APP',
    );
    await expect(provider.runMaintenance("analyze", "ORDERS")).rejects.toThrow(
      "A schema is required for RUNSTATS on Db2",
    );
    await expect(provider.runMaintenance("vacuum", "ORDERS", "APP")).rejects.toThrow(
      "Unsupported maintenance operation for Db2: vacuum",
    );
    expect(executed).toBe(0);
  });

  test("a refused command is mapped", async () => {
    const provider = await connected();
    userQuery = async () => {
      throw new Error("SQL2306N  The table or index does not exist.");
    };
    await expect(provider.runMaintenance("optimize", "ORDERS", "APP")).rejects.toThrow("SQL2306N");
  });
});

describe("Db2Provider: monitoring", () => {
  test("neutral readings: version and counts, nothing else measured", async () => {
    const provider = await connected();

    expect(await provider.getOverview()).toEqual({
      version: "DB2 v12.1.0.0",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 5,
      indexCount: 9,
    });
    expect(await provider.getHealth()).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: CACHE_HIT_RATIO_UNAVAILABLE,
      slowQueries: [],
      activeSessions: [],
    });
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
  });

  test("table statistics list every user table and materialized query table, the rows maintenance runs from", async () => {
    const provider = await connected();
    const row = (schemaName: string, tableName: string, rowCount: number) => ({
      schemaName,
      tableName,
      rowCount,
      totalSize: "N/A",
      totalSizeBytes: 0,
    });

    expect(await provider.getTableStats()).toEqual([
      row("APP", "CUSTOMERS", 2),
      // CARD is -1 until RUNSTATS has run on the table.
      row("APP", "Mixed Case", 0),
      row("APP", "ORDERS", 2),
      row("APP", "ORDER_TOTALS", 2),
      row("REPORTING", "DAILY", 0),
    ]);
  });

  test("a refused table statistics read is mapped and thrown, not answered as an empty list", async () => {
    const provider = await connected();
    refused.set(
      TABLE_STATS_SQL,
      new Error("SQL0551N  The statement failed because the authorization ID does not have the privilege"),
    );
    await expect(provider.getTableStats()).rejects.toThrow("SQL0551N");
  });
});
