/**
 * Live check of the libSQL agent read-only execution profile, against servers of the operator's choosing.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The profile's boundary is the server's: a token the server refuses
 * every write for, which the open proves with a write the server must refuse (`agent-boundary.ts`). The provider suite
 * replays answers its author captured; whether a server refuses a write for a token, on which route, and for which
 * statement, is the server's to say. So this script asks real servers, through the production path
 * (`createDatabaseProvider` with the profile's execution context, then `connect` and `queryReadOnly`), and through raw
 * requests for the shapes the provider never sends (a batch, a sequence, a stored statement, the other routes):
 *
 *  - the open's three probes: each is refused the read-only token with the server's authorization refusal, and the
 *    writable token runs the first and is told the table does not exist by the other two, so none changes anything;
 *  - the open: the read-only token is admitted; the writable token, a read-only token whose permission claim widens it
 *    to writes (it writes, measured here), a user name and password on a server started with HTTP Basic, and a server
 *    that checks no credential (with no token and with a token) are each refused; the
 *    operations profile opens the writable token unproven and reads the object surface, which is what plan mode grounds
 *    on; an editor handle refuses `queryReadOnly` before sending anything;
 *  - the boundary, with Studio's client admission bypassed: each write, DDL, writing pragma, attach, vacuum, extension
 *    load, transaction statement and second statement is sent with the read-only token through `queryReadOnly`, and
 *    every write is refused with 403 for the whole request; the statements the server refuses for every token
 *    (`ATTACH`, `VACUUM`, `ANALYZE`, a temporary table, a writing pragma it does not take, `load_extension`,
 *    `CREATE FUNCTION`) are
 *    refused with the server's own statement error for the writable token too; the same writes run with the writable
 *    token on a scratch table, the positive control that shows each one would work; a write inside a batch, a
 *    sequence and a stored statement, and on each other statement route, is refused 403; the tables, rows, indexes,
 *    views, triggers and the database's own `user_version` read back the same before and after;
 *  - a transaction: `BEGIN IMMEDIATE` answers the read-only token, and a write with the writable token right after it
 *    runs, so the lock it took closed with its request;
 *  - what the agent composes: the catalog read, the statistics probe, the estimating plan and the table profile all
 *    answer with the read-only token;
 *  - the budgets: a result past the row budget, one past the byte budget and a statement past its deadline are refused.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against servers you may write to:
 *
 *   LIBREDB_LIVE_LIBSQL_JWT_PORT=18181 LIBREDB_LIVE_LIBSQL_RO_TOKEN=... LIBREDB_LIVE_LIBSQL_RW_TOKEN=... \
 *     LIBREDB_LIVE_LIBSQL_WIDENED_TOKEN=... \
 *     LIBREDB_LIVE_LIBSQL_BASIC_PORT=18182 LIBREDB_LIVE_LIBSQL_BASIC_USER=... LIBREDB_LIVE_LIBSQL_BASIC_PASSWORD=... \
 *     LIBREDB_LIVE_LIBSQL_OPEN_PORT=18183 bun tests/live/libsql-agent-boundary.ts
 *
 * The first server checks JWTs (`SQLD_AUTH_JWT_KEY`), and the three tokens are signed by its key, one carrying
 * `"a": "ro"`, one `"a": "rw"`, and one `"a": "ro"` with `"p": {"rw": {"ns": ["default"]}}`; the second checks HTTP
 * Basic (`SQLD_HTTP_AUTH`); the third checks nothing.
 * `docs/providers/libsql.md` section 3.6 shows how to start the three and mint the tokens.
 *
 * Every table it creates carries the `libredb_lb_` prefix and is dropped on exit. Each check prints one line, and a
 * run with a failing check ends non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { ExecutionProfileError, QueryError } from "@/lib/db/errors";
import { createDatabaseProvider, executionContextFor } from "@/lib/db/factory";
import {
  composeCatalogRead,
  composeEstimatingExplain,
  composeStatisticsAvailabilityProbe,
} from "@/lib/agent/composed-sql";
import { composeTableProfile } from "@/lib/agent/table-profile";
import {
  agentProbeStatements,
  assertReadOnlyClaims,
  probeTableName,
} from "@/lib/db/providers/sql/libsql/agent-boundary";
import { LibSQLHranaTransport } from "@/lib/db/providers/sql/libsql/hrana-transport";
import { LibSQLTransportError } from "@/lib/db/providers/sql/libsql/transport";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const PREFIX = "libredb_lb_";
const DATA = `${PREFIX}data`;
const SCRATCH = `${PREFIX}scratch`;
const BUDGET = { statementTimeoutMs: 5_000, maxResultRows: 50, maxResultBytes: 64 * 1024 };

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: this script writes to the servers it is pointed at, so it has no default`);
    process.exit(2);
  }
  return value;
}

const HOST = process.env.LIBREDB_LIVE_LIBSQL_HOST ?? "127.0.0.1";
const JWT_PORT = Number(env("LIBREDB_LIVE_LIBSQL_JWT_PORT"));
const RO = env("LIBREDB_LIVE_LIBSQL_RO_TOKEN");
const RW = env("LIBREDB_LIVE_LIBSQL_RW_TOKEN");
const WIDENED = env("LIBREDB_LIVE_LIBSQL_WIDENED_TOKEN");
const BASIC_PORT = Number(env("LIBREDB_LIVE_LIBSQL_BASIC_PORT"));
const BASIC = { user: env("LIBREDB_LIVE_LIBSQL_BASIC_USER"), password: env("LIBREDB_LIVE_LIBSQL_BASIC_PASSWORD") };
const OPEN_PORT = Number(env("LIBREDB_LIVE_LIBSQL_OPEN_PORT"));

function connection(port: number, credential: { user?: string; password?: string }): DatabaseConnection {
  return {
    id: `live-libsql-${port}-${credential.user ?? "token"}`,
    name: "libSQL live",
    type: "libsql",
    host: HOST,
    port,
    ...credential,
    createdAt: new Date(),
  };
}

const writable = new LibSQLHranaTransport(connection(JWT_PORT, { password: RW }));

async function write(sql: string): Promise<void> {
  await writable.execute(sql, { timeoutMs: 30_000 });
}

let failures = 0;
function check(ok: boolean, line: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

/** What a request to `route` carrying `body` with `token` answered: its status and the first step's error code. */
async function raw(port: number, token: string | null, route: string, body: unknown): Promise<string> {
  const response = await fetch(`http://${HOST}:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status !== 200) return String(response.status);
  const results = (JSON.parse(text) as { results?: { type: string; error?: { code?: string } }[] }).results ?? [];
  const failed = results.find((step) => step.type === "error");
  return failed === undefined ? "ran" : `200 ${failed.error?.code ?? "error"}`;
}

/** How opening a provider under `profile` ended: `admitted`, or the refusal's reason code or error class. */
async function opening(conn: DatabaseConnection, profile: "agent-read-only" | "agent-operations"): Promise<string> {
  const provider = await createDatabaseProvider(conn, {}, executionContextFor(profile));
  try {
    await provider.connect();
    await provider.disconnect();
    return "admitted";
  } catch (error) {
    return error instanceof ExecutionProfileError ? error.reasonCode : (error as Error).name;
  }
}

/** The server's state as the writable token reads it: every schema object, every row, and `user_version`. */
async function snapshot(): Promise<string> {
  const objects = await writable.execute("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name", {
    timeoutMs: 30_000,
  });
  const rows = await writable.execute(`SELECT * FROM "${DATA}" ORDER BY id`, { timeoutMs: 30_000 });
  const version = await writable.execute("PRAGMA user_version", { timeoutMs: 30_000 });
  return JSON.stringify([objects.rows, rows.rows, version.rows]);
}

/** The read-only token's answer to `sql` through `queryReadOnly`: `ran`, `403`, or the server's statement error. */
async function agentAnswer(provider: DatabaseProvider, sql: string): Promise<string> {
  try {
    await provider.queryReadOnly?.(sql, BUDGET);
    return "ran";
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("Authorization forbidden")) return "403";
    if (error instanceof QueryError) return `refused: ${message.slice(0, 60)}`;
    throw error;
  }
}

/** The writable token's answer to `sql`: `ran`, or the server's statement error. */
async function writableAnswer(sql: string): Promise<string> {
  try {
    await write(sql);
    return "ran";
  } catch (error) {
    if (error instanceof LibSQLTransportError) return `refused: ${error.message.slice(0, 60)}`;
    throw error;
  }
}

/**
 * The writes, each written for a table so the positive control runs it on the scratch copy. `refusedForEvery` marks a
 * statement the server refuses whatever the token, so its control is the same refusal rather than a run.
 */
const WRITES: { sql: (table: string) => string; refusedForEvery?: true }[] = [
  { sql: (t) => `INSERT INTO "${t}" (id, v) VALUES (100, 'x')` },
  { sql: (t) => `INSERT INTO "${t}" (id, v) VALUES (101, 'x') RETURNING id` },
  { sql: (t) => `INSERT INTO "${t}" (id, v) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET v = 'y'` },
  { sql: (t) => `REPLACE INTO "${t}" (id, v) VALUES (1, 'z')` },
  { sql: (t) => `UPDATE "${t}" SET v = 'u' WHERE id = 1` },
  { sql: (t) => `DELETE FROM "${t}" WHERE id = 2` },
  { sql: (t) => `WITH doomed AS (SELECT 3 AS id) DELETE FROM "${t}" WHERE id IN (SELECT id FROM doomed)` },
  { sql: (t) => `CREATE TABLE "${t}_made" (a INTEGER)` },
  { sql: (t) => `CREATE INDEX "${t}_made_idx" ON "${t}" (v)` },
  { sql: (t) => `CREATE VIEW "${t}_made_view" AS SELECT 1 AS a` },
  { sql: (t) => `CREATE TRIGGER "${t}_made_trg" AFTER INSERT ON "${t}" BEGIN SELECT 1; END` },
  { sql: (t) => `ALTER TABLE "${t}" ADD COLUMN extra TEXT` },
  { sql: (t) => `DROP INDEX "${t}_idx"` },
  { sql: (t) => `DROP TABLE "${t}"` },
  { sql: () => "REINDEX" },
  { sql: () => "PRAGMA user_version = 5" },
  { sql: () => "PRAGMA foreign_keys = OFF" },
  { sql: () => "ATTACH DATABASE ':memory:' AS other", refusedForEvery: true },
  { sql: () => `VACUUM INTO '/tmp/${PREFIX}copy.db'`, refusedForEvery: true },
  { sql: () => "VACUUM", refusedForEvery: true },
  { sql: () => "ANALYZE", refusedForEvery: true },
  { sql: (t) => `CREATE TEMP TABLE "${t}_tmp" (a INTEGER)`, refusedForEvery: true },
  { sql: () => "PRAGMA journal_mode = DELETE", refusedForEvery: true },
  { sql: () => "PRAGMA writable_schema = ON", refusedForEvery: true },
  { sql: () => "PRAGMA query_only = 0", refusedForEvery: true },
  { sql: () => "SELECT load_extension('/tmp/libredb_lb_none')", refusedForEvery: true },
  { sql: () => "CREATE FUNCTION libredb_lb_fn LANGUAGE wasm AS X'00'", refusedForEvery: true },
  { sql: (t) => `SELECT 1; DELETE FROM "${t}"`, refusedForEvery: true },
];

async function seed(): Promise<void> {
  for (const table of [DATA, SCRATCH]) {
    await write(`DROP TABLE IF EXISTS "${table}"`);
    await write(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY, v TEXT)`);
    await write(`INSERT INTO "${table}" (id, v) VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
    await write(`CREATE INDEX "${table}_idx" ON "${table}" (v)`);
  }
}

async function cleanup(): Promise<void> {
  const left = await writable.execute(
    `SELECT type, name FROM sqlite_master WHERE name LIKE '${PREFIX}%' AND type IN ('table', 'view', 'trigger') ORDER BY type DESC`,
    { timeoutMs: 30_000 },
  );
  for (const row of left.rows) await write(`DROP ${String(row.type).toUpperCase()} IF EXISTS "${String(row.name)}"`);
}

async function main(): Promise<void> {
  await seed();

  // The open's probes, one by one: each must be the server's authorization refusal for the read-only token, and is
  // a no-op for the writable one, which runs the first and is told the table does not exist by the other two.
  const reader = new LibSQLHranaTransport(connection(JWT_PORT, { password: RO }));
  const probes = agentProbeStatements(probeTableName());
  for (const sql of probes) {
    let answer = "ran";
    try {
      await reader.execute(sql, { timeoutMs: 30_000 });
    } catch (error) {
      answer = error instanceof LibSQLTransportError ? `${error.status} ${error.message}` : String(error);
    }
    check(
      answer.startsWith("403 libSQL request failed: Authorization forbidden: "),
      `probe, read-only token: ${sql} -> ${answer.slice(0, 60)}`,
    );
  }
  const control: string[] = [];
  for (const sql of probes) control.push(await writableAnswer(sql));
  check(
    control[0] === "ran" && control.slice(1).every((answer) => answer.includes("no such table")),
    `probe, writable token: ${control.join(" / ")}`,
  );

  // The open.
  check(
    (await opening(connection(JWT_PORT, { password: RO }), "agent-read-only")) === "admitted",
    "open: the read-only token is admitted",
  );
  check(
    (await opening(connection(JWT_PORT, { password: RW }), "agent-read-only")) === "PROFILE_SERVER_UNENFORCED",
    "open: the writable token is refused (PROFILE_SERVER_UNENFORCED)",
  );
  // A read-only token whose permission claim grants writes on the namespace: the server runs its writes, the open's
  // probes refuse it, and its claims alone are refused too.
  const widened = new LibSQLHranaTransport(connection(JWT_PORT, { password: WIDENED }));
  const widenedAnswers: string[] = [];
  for (const sql of [
    `INSERT INTO "${SCRATCH}" (id, v) VALUES (200, 'w')`,
    `DELETE FROM "${SCRATCH}" WHERE 0`,
    `DROP TABLE IF EXISTS "${PREFIX}widened"`,
  ]) {
    try {
      await widened.execute(sql, { timeoutMs: 30_000 });
      widenedAnswers.push("ran");
    } catch (error) {
      widenedAnswers.push(error instanceof LibSQLTransportError ? String(error.status) : String(error));
    }
  }
  check(
    widenedAnswers.every((answer) => answer === "ran"),
    `widened token: INSERT / DELETE ... WHERE 0 / DROP TABLE IF EXISTS -> ${widenedAnswers.join(" / ")}`,
  );
  check(
    (await opening(connection(JWT_PORT, { password: WIDENED }), "agent-read-only")) === "PROFILE_SERVER_UNENFORCED",
    "open: the widened token is refused, since the probe ran (PROFILE_SERVER_UNENFORCED)",
  );
  const claimAnswer = (token: string): string => {
    try {
      assertReadOnlyClaims(token);
      return "admitted";
    } catch (error) {
      return error instanceof ExecutionProfileError ? error.reasonCode : String(error);
    }
  };
  check(claimAnswer(RO) === "admitted", "claims: the read-only token's claims are admitted");
  check(
    claimAnswer(WIDENED) === "PROFILE_PRIVILEGES_TOO_BROAD",
    "claims: the widened token's claims are refused (PROFILE_PRIVILEGES_TOO_BROAD)",
  );
  check(
    (await opening(connection(BASIC_PORT, BASIC), "agent-read-only")) === "PROFILE_PRIVILEGES_TOO_BROAD",
    "open: a user name and password on the Basic server are refused (PROFILE_PRIVILEGES_TOO_BROAD)",
  );
  check(
    (await opening(connection(BASIC_PORT, { password: RO }), "agent-read-only")) === "AuthenticationError",
    "open: the read-only token on the Basic server fails its connect probe (401)",
  );
  check(
    (await opening(connection(OPEN_PORT, {}), "agent-read-only")) === "PROFILE_SERVER_UNENFORCED",
    "open: no token on the server that checks none is refused (PROFILE_SERVER_UNENFORCED)",
  );
  check(
    (await opening(connection(OPEN_PORT, { password: RO }), "agent-read-only")) === "PROFILE_SERVER_UNENFORCED",
    "open: a token on the server that checks none is refused, since the probe ran (PROFILE_SERVER_UNENFORCED)",
  );
  check(
    (await opening(connection(JWT_PORT, { password: RW }), "agent-operations")) === "admitted",
    "open: the operations profile opens the writable token unproven",
  );
  const grounding = await createDatabaseProvider(
    connection(JWT_PORT, { password: RW }),
    {},
    executionContextFor("agent-operations"),
  );
  await grounding.connect();
  const listed = await grounding.listObjects([], "table");
  check(
    listed.some((object) => object.path[0] === DATA),
    "open: the writable token, unproven, reads the object surface plan mode grounds on",
  );
  await grounding.disconnect();

  const editor = await createDatabaseProvider(connection(JWT_PORT, { password: RO }));
  await editor.connect();
  try {
    await editor.queryReadOnly?.("SELECT 1", BUDGET);
    check(false, "an editor handle refuses queryReadOnly");
  } catch (error) {
    check(
      (error as Error).message === "Read-only execution requires a provider opened under the agent read-only profile",
      "an editor handle refuses queryReadOnly",
    );
  }
  await editor.disconnect();

  // The boundary.
  const agent = await createDatabaseProvider(
    connection(JWT_PORT, { password: RO }),
    {},
    executionContextFor("agent-read-only"),
  );
  await agent.connect();
  const before = await snapshot();
  for (const statement of WRITES) {
    const answer = await agentAnswer(agent, statement.sql(DATA));
    const expected = statement.refusedForEvery === true ? answer.startsWith("refused: ") : answer === "403";
    check(expected, `read-only token: ${statement.sql(DATA)} -> ${answer}`);
  }
  for (const [label, route, body] of [
    [
      "a batch",
      "/v2/pipeline",
      {
        requests: [
          {
            type: "batch",
            batch: { steps: [{ stmt: { sql: "SELECT 1" } }, { stmt: { sql: `DELETE FROM "${DATA}"` } }] },
          },
          { type: "close" },
        ],
      },
    ],
    [
      "a sequence",
      "/v2/pipeline",
      { requests: [{ type: "sequence", sql: `SELECT 1; DELETE FROM "${DATA}"` }, { type: "close" }] },
    ],
    [
      "a stored statement",
      "/v2/pipeline",
      {
        requests: [
          { type: "store_sql", sql_id: 1, sql: `DELETE FROM "${DATA}"` },
          { type: "execute", stmt: { sql_id: 1 } },
          { type: "close" },
        ],
      },
    ],
    [
      "the v3 pipeline",
      "/v3/pipeline",
      { requests: [{ type: "execute", stmt: { sql: `DELETE FROM "${DATA}"` } }, { type: "close" }] },
    ],
    ["the v1 execute route", "/v1/execute", { stmt: { sql: `DELETE FROM "${DATA}"` } }],
    ["the v1 batch route", "/v1/batch", { batch: { steps: [{ stmt: { sql: `DELETE FROM "${DATA}"` } }] } }],
    ["the legacy root route", "/", { statements: [`DELETE FROM "${DATA}"`] }],
  ] as const) {
    const answer = await raw(JWT_PORT, RO, route, body);
    check(answer === "403", `read-only token: a write in ${label} -> ${answer}`);
  }
  const after = await snapshot();
  check(before === after, "the tables, rows, indexes, views, triggers and user_version read back the same");

  // The positive control, on the scratch table.
  for (const statement of WRITES) {
    const answer = await writableAnswer(statement.sql(SCRATCH));
    const expected = statement.refusedForEvery === true ? answer.startsWith("refused: ") : answer === "ran";
    check(expected, `writable token: ${statement.sql(SCRATCH)} -> ${answer}`);
  }
  await write("PRAGMA user_version = 0");

  // A transaction statement is not a write: it answers, and the stream it opened closes with its own request, so the
  // write lock BEGIN IMMEDIATE takes is gone before the next request.
  check((await agentAnswer(agent, "BEGIN IMMEDIATE")) === "ran", "read-only token: BEGIN IMMEDIATE answers");
  check(
    (await writableAnswer(`CREATE TABLE "${PREFIX}after_begin" (a INTEGER)`)) === "ran",
    "writable token: a write right after it runs, so the lock closed with the request",
  );

  // What the agent composes.
  for (const kind of ["columns", "relations", "indexes"] as const) {
    const sql = composeCatalogRead("libsql", { kind });
    check((await agentAnswer(agent, sql)) === "ran", `read-only token: the ${kind} catalog read answers`);
  }
  const probe = composeStatisticsAvailabilityProbe("libsql");
  check(probe !== null && (await agentAnswer(agent, probe)) === "ran", "read-only token: the statistics probe answers");
  check(
    (await agentAnswer(agent, composeEstimatingExplain("libsql", `SELECT * FROM "${DATA}" WHERE v = 'a'`).sql)) ===
      "ran",
    "read-only token: the estimating plan answers",
  );
  const profile = composeTableProfile("libsql", { segments: [DATA], depth: "pattern" }, [
    { name: "id", type: "INTEGER", nullable: false, isPrimary: true },
    { name: "v", type: "TEXT", nullable: true, isPrimary: false },
  ]);
  check((await agentAnswer(agent, profile)) === "ran", "read-only token: the pattern table profile answers");

  // The budgets.
  const many = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 51) SELECT x FROM c";
  check(
    (await agentAnswer(agent, many)).startsWith("refused: Read-only execution exceeded the row budget: 51 rows > 50"),
    "budget: 51 rows under a budget of 50 are refused",
  );
  check(
    (await agentAnswer(agent, "SELECT hex(randomblob(50000)) AS big")).startsWith(
      "refused: Read-only execution exceeded the byte budget",
    ),
    "budget: 100,000 bytes of hex under 65,536 are refused",
  );
  try {
    await agent.queryReadOnly?.(
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 3000000000) SELECT count(*) FROM c",
      { ...BUDGET, statementTimeoutMs: 1_000 },
    );
    check(false, "budget: a statement past a one-second deadline is refused");
  } catch (error) {
    check(
      (error as Error).message === "Read-only execution exceeded the time budget: no answer within 1000ms",
      "budget: a statement past a one-second deadline is refused",
    );
  }
  check((await agentAnswer(agent, "SELECT 1")) === "ran", "the server answers the next statement after the deadline");
  await agent.disconnect();
}

try {
  await main();
} finally {
  await cleanup();
}
console.log(failures === 0 ? "every check passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
