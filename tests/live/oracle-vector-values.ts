/**
 * Live check of how an Oracle `VECTOR` reaches the product: through the provider's rows, through the SQL INSERT
 * export, and through MCP's `run_read_query`, against a server of the operator's choosing.
 *
 * WHY THIS EXISTS. node-oracledb decodes a vector into a typed array (`Float32Array`, `Float64Array`, `Int8Array`,
 * `Uint8Array` for a binary one) or its own `SparseVector` class, and the provider's `vectorValue` converter turns the
 * numeric and sparse forms into plain JSON numbers, which the editor, the export and MCP's value codec all read.
 * Which form the driver hands for which column is a claim about the engine and the driver together, and a mock answers
 * whatever its author already wrote. So this script holds it against a real server:
 *
 *  - the premise, read without the provider: the driver still hands the four typed arrays and `SparseVector`, a
 *    flexible `VECTOR(*, *)` column per row by its stored format, and `null` for a NULL. The day it does not, the
 *    conversion has stopped being the thing under test, and this script must be rewritten rather than deleted;
 *  - the provider's `query()`: a FLOAT32, FLOAT64 and INT8 vector, and each row of a flexible column, as an array of
 *    numbers; a sparse one as `{ numDimensions, indices, values }` of plain arrays; a binary one as the driver's bytes;
 *  - the export: the SQL INSERT export of the dense columns, put through JSON as `POST /api/db/query` hands it on,
 *    replays into an empty copy, and the server compares source and copy equal for each fixed-format column; a
 *    flexible column's rows replay their numbers as FLOAT32, the format Oracle gives a text literal there, whatever
 *    format the source row had;
 *  - MCP: `run_read_query`, through the tool's own handler and the factory's profiled acquisition as the route makes
 *    them, as a READ ONLY user, answers every vector column with its rows instead of refusing the answer, and the
 *    codec's decoding of those rows is the provider's own read; a binary vector is the codec's `bytes` tag.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 * Run it against a disposable server whose SYS and SYSTEM passwords are the one given and whose pluggable database
 * holds the schema owner APP_OWNER with that same password, which `gvenzl/oracle-free` creates from `APP_USER`:
 *
 *   docker run -d --name oracle-vector --memory 2g -p 127.0.0.1:15299:1521 \
 *     -e ORACLE_PASSWORD="$PROBE_PASSWORD" -e APP_USER=APP_OWNER -e APP_USER_PASSWORD="$PROBE_PASSWORD" \
 *     gvenzl/oracle-free:slim@sha256:6d61d267a3b978c24c5ac1790e62e927416a0aec446bd86e4b3a1527562757bd
 *   LIBREDB_LIVE_ORACLE_PORT=15299 LIBREDB_LIVE_ORACLE_PASSWORD="$PROBE_PASSWORD" bun tests/live/oracle-vector-values.ts
 *
 * The image is the digest `tests/fixtures/oracle/23.26.3-free/agent-boundary/run.sh` pins. The script revokes the
 * PUBLIC grants the MCP check refuses, as `tests/live/oracle-mcp-boundary.ts` does, and does not grant them back.
 * Every user and table it creates carries the `LIBREDB_LV_` prefix and is dropped on exit. Each check prints one
 * line, no credential among them, and any failure ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds.
import oracledb from "oracledb";
import { isDeepStrictEqual } from "node:util";
import { decodeValue } from "@libredb/provider-sdk/values";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import type { OpenWait } from "@/lib/provider-host/core/open-once";
import { installHostCore } from "@/lib/provider-host/instance";
import { OracleProvider } from "@/lib/db/providers/sql/oracle/index";
import { buildResultExport } from "@/lib/export/result-export";
import type { McpConnectionContext } from "@/lib/mcp/context";
import type { ToolResult } from "@/lib/mcp/output";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseConnection } from "@/lib/types";
import { fakeTextScrub } from "../helpers/mcp-fixtures";

// An MCP statement runs through the host core, so this script installs it once, as a test's composition root does.
installHostCore(createHostCore(), "test");

const PREFIX = "LIBREDB_LV_";
const RO = `${PREFIX}RO`;
const OWNER = "APP_OWNER";
const TABLE = `${OWNER}.${PREFIX}VEC`;
const REPLAY = `${OWNER}.${PREFIX}VEC_R`;

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: this script writes to the server it is pointed at, so it has no default`);
    process.exit(2);
  }
  return value;
}

const HOST = process.env.LIBREDB_LIVE_ORACLE_HOST ?? "127.0.0.1";
const PORT = Number(env("LIBREDB_LIVE_ORACLE_PORT"));
const password = env("LIBREDB_LIVE_ORACLE_PASSWORD");
const SERVICE = process.env.LIBREDB_LIVE_ORACLE_SERVICE ?? "FREEPDB1";
const CONNECT_STRING = `${HOST}:${PORT}/${SERVICE}`;

let failures = 0;
let passes = 0;
function check(ok: boolean, line: string): void {
  // A line never carries the password: a check that would print it fails instead.
  const safe = !line.includes(password);
  console.log(`${ok && safe ? "PASS" : "FAIL"} ${safe ? line : "(line withheld: it named a credential)"}`);
  if (ok && safe) passes++;
  else failures++;
}

function signIn(user: string): Promise<oracledb.Connection> {
  return oracledb.getConnection({
    user,
    password,
    connectString: CONNECT_STRING,
    ...(user === "SYS" ? { privilege: oracledb.SYSDBA } : {}),
  });
}

/** Runs `sql` as `user` on a connection of its own, SYS as SYSDBA, answering the rows as the driver decodes them. */
async function as(user: string, sql: string): Promise<Record<string, unknown>[]> {
  const conn = await signIn(user);
  try {
    const result = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: true });
    return (result.rows ?? []) as Record<string, unknown>[];
  } finally {
    await conn.close();
  }
}

/** Runs each statement as `user` on one connection, ignoring the ORA- codes named, so a setup step can run twice. */
async function setup(user: string, statements: readonly string[], ignore: readonly string[] = []): Promise<void> {
  const conn = await signIn(user);
  try {
    for (const sql of statements) {
      try {
        await conn.execute(sql, [], { autoCommit: true });
      } catch (error) {
        if (!ignore.some((code) => (error as Error).message.includes(code))) throw error;
      }
    }
  } finally {
    await conn.close();
  }
}

/** PUBLIC's grants the fresh database holds that the MCP check refuses, as `oracle-mcp-boundary.ts` revokes them. */
const REVOKES_AS_SYS: readonly string[] = [
  "SYS.UTL_HTTP",
  "SYS.UTL_TCP",
  "SYS.UTL_SMTP",
  "SYS.UTL_FILE",
  "SYS.UTL_INADDR",
  "SYS.HTTPURITYPE",
  "SYS.DBMS_LDAP",
  "SYS.DBMS_SCHEDULER",
  "XDB.DBMS_XSLPROCESSOR",
  "SYS.SCHEDULER$NTFY_SVC_METRICS",
  "XDB.XMLINDEX",
  "XDB.XMLINDEX_NOOP",
]
  .map((name) => `REVOKE EXECUTE ON ${name} FROM PUBLIC`)
  .concat(
    `BEGIN DBMS_RULE_ADM.REVOKE_OBJECT_PRIVILEGE(DBMS_RULE_ADM.EXECUTE_ON_EVALUATION_CONTEXT, '"SYS"."STREAMS$_EVALUATION_CONTEXT"', 'PUBLIC'); END;`,
  );

const COLUMNS = "ID, F32, F64, I8, FLEX, SP, SP8, BIN";
/** The dense columns of one fixed format, which the export replays into the same values. */
const FIXED = ["F32", "F64", "I8"] as const;

/** The provider's read of each row, by `ID`: what `query()` must answer, and what MCP's rows must decode to. */
const EXPECTED: Record<number, Record<string, unknown>> = {
  1: {
    ID: 1,
    F32: [Math.fround(0.1), 1.5, -2.25],
    F64: [0.1, 1e300, -2],
    I8: [1, -128, 127],
    FLEX: [0.5, 2],
    SP: { numDimensions: 5, indices: [0, 3], values: [1.5, 2.5] },
    SP8: { numDimensions: 4, indices: [1], values: [-7] },
    BIN: Uint8Array.of(255, 1),
  },
  2: { ID: 2, F32: null, F64: null, I8: null, FLEX: [3, -4], SP: null, SP8: null, BIN: null },
  3: { ID: 3, F32: null, F64: null, I8: null, FLEX: [0.25, 8], SP: null, SP8: null, BIN: null },
  4: { ID: 4, F32: null, F64: null, I8: null, FLEX: Uint8Array.of(255, 1), SP: null, SP8: null, BIN: null },
};

/** The class the driver handed, by name, for the premise lines. */
function formOf(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof oracledb.SparseVector) {
    return `SparseVector(${value.indices.constructor.name}, ${value.values.constructor.name})`;
  }
  return (value as object).constructor.name;
}

async function cleanup(): Promise<void> {
  await clearProviderCache();
  await setup("SYS", [`DROP USER ${RO} CASCADE`, `DROP TABLE ${REPLAY} PURGE`, `DROP TABLE ${TABLE} PURGE`], ["ORA-"]);
}

async function seedServer(): Promise<void> {
  await cleanup();
  await setup("SYS", REVOKES_AS_SYS, ["ORA-01927"]);
  await setup(OWNER, [
    `CREATE TABLE ${TABLE} (ID NUMBER PRIMARY KEY, F32 VECTOR(3, FLOAT32), F64 VECTOR(3, FLOAT64), ` +
      "I8 VECTOR(3, INT8), FLEX VECTOR(*, *), SP VECTOR(5, FLOAT32, SPARSE), SP8 VECTOR(4, INT8, SPARSE), " +
      "BIN VECTOR(16, BINARY))",
    `INSERT INTO ${TABLE} VALUES (1, '[0.1, 1.5, -2.25]', '[0.1, 1e300, -2]', '[1, -128, 127]', ` +
      "TO_VECTOR('[0.5, 2]', 2, FLOAT32), '[5, [0, 3], [1.5, 2.5]]', '[4, [1], [-7]]', TO_VECTOR('[255, 1]', 16, BINARY))",
    `INSERT INTO ${TABLE} (ID, FLEX) VALUES (2, TO_VECTOR('[3, -4]', 2, INT8))`,
    `INSERT INTO ${TABLE} (ID, FLEX) VALUES (3, TO_VECTOR('[0.25, 8]', 2, FLOAT64))`,
    `INSERT INTO ${TABLE} (ID, FLEX) VALUES (4, TO_VECTOR('[255, 1]', 16, BINARY))`,
    `CREATE TABLE ${REPLAY} AS SELECT ID, F32, F64, I8, FLEX FROM ${TABLE} WHERE 1 = 0`,
  ]);
  await setup("SYSTEM", [
    `CREATE USER ${RO} IDENTIFIED BY "${password}"`,
    `GRANT CREATE SESSION TO ${RO}`,
    `GRANT SELECT ON ${TABLE} TO ${RO}`,
  ]);
  await setup("SYS", [`GRANT SELECT ON SYS.DBA_POLICIES TO ${RO}`, `GRANT SELECT ON SYS.DBA_AUDIT_POLICIES TO ${RO}`]);
  await setup("SYSTEM", [`ALTER USER ${RO} READ ONLY`]);
}

/** One `run_read_query` call as the READ ONLY user, through the factory's own profiled acquisition, as the route makes it. */
async function mcp(sql: string): Promise<{ readonly result: ToolResult; readonly acquired: ExecutionProfile[] }> {
  const connection = {
    id: "seed:live-vector",
    name: RO,
    seedId: "live-vector",
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "oracle",
    host: HOST,
    port: PORT,
    serviceName: SERVICE,
    user: RO,
    password,
    createdAt: new Date(),
  } as ManagedConnection;
  const acquired: ExecutionProfile[] = [];
  const context = {
    caller: { username: "live", role: "admin" },
    visibleConnections: async () => [connection],
    resolve: async () => connection,
    textScrub: fakeTextScrub,
    acquire: (target: ManagedConnection, profile: ExecutionProfile, wait: OpenWait) => {
      acquired.push(profile);
      return acquireExecutionProfileProvider(target, profile, {}, {}, wait);
    },
  } as unknown as McpConnectionContext;
  const arm = mcpStatementArm("run_read_query");
  const input = arm.inputSchema.parse({ connection_id: connection.id, sql }) as McpStatementInput;
  const result = await runStatement(arm, input, { context, signal: new AbortController().signal });
  return { result, acquired };
}

const textOf = (result: ToolResult): string => {
  const last = result.content.at(-1);
  return last !== undefined && "text" in last ? last.text : "";
};

/**
 * The MCP read of the vector columns, called again every two seconds for up to a minute while the server answers
 * ORA-01466, with how many such answers came first and how long they took.
 *
 * MCP reads inside `SET TRANSACTION READ ONLY`, and a read-only transaction refuses a table whose definition is
 * newer than its snapshot with ORA-01466 (`unable to read data - table definition has changed`). Measured on
 * 2026-11-23 on this container: the first MCP read, seconds after the table was created and granted, was refused that
 * way in nine runs of twelve, and the next call, two seconds later, answered, while a read-only transaction opened
 * directly just before it read the table. That is the engine settling fresh DDL, not the reading under test, so the
 * script waits it out and prints the wait, rather than accepting the error; any other answer is returned at once.
 */
async function settledMcp(sql: string): Promise<{
  readonly result: ToolResult;
  readonly acquired: ExecutionProfile[];
  readonly refusals: number;
  readonly waited: number;
}> {
  const started = Date.now();
  let refusals = 0;
  for (;;) {
    const { result, acquired } = await mcp(sql);
    const waited = Date.now() - started;
    if (result.isError !== true || !textOf(result).includes("ORA-01466") || waited > 60_000) {
      return { result, acquired, refusals, waited };
    }
    refusals++;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function main(): Promise<void> {
  await seedServer();

  // The premise, read without the provider.
  const raw = await as(OWNER, `SELECT ${COLUMNS} FROM ${TABLE} ORDER BY ID`);
  const first = raw[0];
  const premise = [
    ["F32", first.F32 instanceof Float32Array],
    ["F64", first.F64 instanceof Float64Array],
    ["I8", first.I8 instanceof Int8Array],
    ["SP", first.SP instanceof oracledb.SparseVector && first.SP.indices instanceof Uint32Array],
    ["SP8", first.SP8 instanceof oracledb.SparseVector && first.SP8.values instanceof Int8Array],
    ["BIN", first.BIN instanceof Uint8Array],
  ] as const;
  for (const [column, ok] of premise) {
    check(ok, `premise: the driver hands ${column} as ${formOf(first[column])}`);
  }
  const flexForms = raw.map((row) => formOf(row.FLEX)).join(", ");
  check(
    flexForms === "Float32Array, Int8Array, Float64Array, Uint8Array",
    `premise: the driver hands a flexible column per row by its stored format -> ${flexForms}`,
  );
  check(raw[1].F32 === null && raw[1].SP === null, "premise: the driver hands a NULL vector as null");

  // The provider's rows.
  const connection: DatabaseConnection = {
    id: "live-vector",
    name: "live vector values",
    type: "oracle",
    host: HOST,
    port: PORT,
    serviceName: SERVICE,
    user: OWNER,
    password,
    createdAt: new Date(),
  };
  const provider = new OracleProvider(connection);
  await provider.connect();
  try {
    const read = await provider.query(`SELECT ${COLUMNS} FROM ${TABLE} ORDER BY ID`);
    for (const row of read.rows as Record<string, unknown>[]) {
      const want = EXPECTED[Number(row.ID)];
      for (const column of Object.keys(want)) {
        const got = row[column];
        const shown = got instanceof Uint8Array ? `Uint8Array [${[...got].join(", ")}]` : JSON.stringify(got);
        check(isDeepStrictEqual(got, want[column]), `query(): row ${row.ID} ${column} -> ${shown}`);
      }
    }
    check(
      isDeepStrictEqual(read.columnTypes, {
        ID: "NUMBER",
        F32: "VECTOR",
        F64: "VECTOR",
        I8: "VECTOR",
        FLEX: "VECTOR",
        SP: "VECTOR",
        SP8: "VECTOR",
        BIN: "VECTOR",
      }),
      `query(): the declared column types still name VECTOR -> ${JSON.stringify(read.columnTypes)}`,
    );

    // The export of the dense columns, over JSON as the HTTP route hands it on, replayed into the empty copy.
    const dense = await provider.query(`SELECT ID, F32, F64, I8, FLEX FROM ${TABLE} WHERE ID <= 3 ORDER BY ID`);
    const file = buildResultExport("sql-insert", {
      rows: JSON.parse(JSON.stringify(dense.rows)) as Record<string, unknown>[],
      fields: dense.fields,
      tabName: REPLAY,
      dialect: "oracle",
      columnTypes: dense.columnTypes,
    });
    let replayed = "replayed";
    try {
      await setup(
        OWNER,
        file.content.split("\n").map((statement) => statement.replace(/;$/, "")),
      );
    } catch (error) {
      replayed = /ORA-\d{5}/.exec((error as Error).message)?.[0] ?? "error";
    }
    check(replayed === "replayed", `export: the SQL INSERT export of the dense columns replays -> ${replayed}`);
    const same = (column: string) =>
      `CASE WHEN (s.${column} IS NULL AND r.${column} IS NULL) OR ` +
      `FROM_VECTOR(s.${column} RETURNING VARCHAR2(4000)) = FROM_VECTOR(r.${column} RETURNING VARCHAR2(4000)) ` +
      `THEN 'EQUAL' ELSE 'DIFF' END AS ${column}_EQ`;
    const compared = await as(
      OWNER,
      `SELECT s.ID, ${FIXED.map(same).join(", ")}, VECTOR_DIMENSION_FORMAT(s.FLEX) AS FLEX_SOURCE, ` +
        "VECTOR_DIMENSION_FORMAT(r.FLEX) AS FLEX_COPY, " +
        "FROM_VECTOR(TO_VECTOR(s.FLEX, *, FLOAT32) RETURNING VARCHAR2(4000)) AS FLEX_SOURCE_F32, " +
        "FROM_VECTOR(r.FLEX RETURNING VARCHAR2(4000)) AS FLEX_COPY_TEXT " +
        `FROM ${TABLE} s LEFT JOIN ${REPLAY} r ON r.ID = s.ID WHERE s.ID <= 3 ORDER BY s.ID`,
    );
    for (const row of compared) {
      const found = FIXED.map((column) => `${column} ${String(row[`${column}_EQ`])}`).join(", ");
      check(!found.includes("DIFF"), `export: the server compares replayed row ${row.ID} with its source -> ${found}`);
    }
    // The export writes a vector as its numbers alone, and Oracle stores a text literal in a flexible column as
    // FLOAT32, so a flexible column's row replays its numbers in FLOAT32 whatever format its source row had.
    const formats = compared.map((row) => `${String(row.FLEX_SOURCE)} -> ${String(row.FLEX_COPY)}`).join(", ");
    check(
      formats === "FLOAT32 -> FLOAT32, INT8 -> FLOAT32, FLOAT64 -> FLOAT32" &&
        compared.every((row) => row.FLEX_SOURCE_F32 === row.FLEX_COPY_TEXT),
      `export: a flexible column's rows replay their numbers as FLOAT32, whatever their source format -> ${formats}`,
    );
  } finally {
    await provider.disconnect();
  }

  // MCP, last: see `settledMcp` for the wait on fresh DDL.
  const { result, acquired, refusals, waited } = await settledMcp(`SELECT ${COLUMNS} FROM ${TABLE} ORDER BY ID`);
  console.log(`MCP: answered after ${refusals} ORA-01466 refusal(s) of fresh DDL, ${waited} ms`);
  const wire = result.structuredContent?.rows as unknown[] | undefined;
  check(
    result.isError === undefined && acquired.join() === "agent-read-only" && Array.isArray(wire),
    `MCP: run_read_query as ${RO} under agent-read-only answers the vector columns with rows -> ${result.isError === true ? textOf(result) : `${wire?.length} rows`}`,
  );
  const decoded = (wire ?? []).map((row) => decodeValue(row)) as Record<string, unknown>[];
  for (const row of decoded) {
    const want = EXPECTED[Number(row.ID)];
    check(isDeepStrictEqual(row, want), `MCP: row ${row.ID} decodes to the provider's read`);
  }
  const bin = (wire?.[0] as Record<string, unknown> | undefined)?.BIN;
  check(
    JSON.stringify(bin) === '{"$":"bytes","v":"/wE="}',
    `MCP: a binary vector is the codec's bytes tag -> ${JSON.stringify(bin)}`,
  );
}

try {
  await main();
} finally {
  await cleanup();
}
console.log(failures === 0 ? `ALL PASS (${passes})` : `${failures} FAILED, ${passes} passed`);
process.exit(failures === 0 ? 0 : 1);
