/**
 * Live check of the ClickHouse agent read-only execution profile, against a server of the operator's choosing.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The profile's boundary is the server's: `readonly = 1` on every
 * request, and a principal the open proves holds nothing that setting leaves usable (`agent-boundary.ts`). The
 * provider suite replays answers its author captured; whether a server refuses a write, a lower `readonly`, a grant
 * inherited through a role or a URL-engine table is the server's to say. So this script asks one, through the
 * production path (`createDatabaseProvider` with the agent profile's execution context, then `connect` and
 * `queryReadOnly`), and through the transport alone where the provider's own fence would stop a statement first:
 *
 *  - the open: a least-privilege user is admitted; a user whose settings profile marks `readonly` changeable, and one
 *    user per refused grant (REMOTE, URL, BACKUP, NAMED COLLECTION, ALTER DATABASE SETTINGS, UNDROP TABLE, INSERT,
 *    SELECT on `system.query_log`, a grant option, BACKUP and REMOTE held only through a role, default or not), and
 *    users who can see a URL-engine table, a dictionary and a definer view over the URL table, are each refused by the
 *    step that names them; the operations profile opens the writable admin unproven;
 *  - an executable user-defined function: the script writes one (an echo) into the directory the server reads its
 *    function configuration and scripts from, and reloads the functions; the least-privilege user, admitted before,
 *    can call it under `readonly = 1`, and is refused at open naming it; with the function removed it is admitted
 *    again;
 *  - a user whose only SELECT comes through a role that is not a default role is admitted (`SHOW GRANTS FINAL` lists
 *    the role's grant), and its read is refused with 497, since the role is not active;
 *  - the boundary, with Studio's client admission bypassed: each write, DDL, SYSTEM statement, grant, temporary table,
 *    source table function (url, remote, file, s3, mysql), trailing `SETTINGS readonly = 0` and second statement is sent as the least-privilege user
 *    through `queryReadOnly` and through the transport, and as the writable admin under `readonly = 1`, and each is
 *    refused with a read-only (164) or authorization (497) code, never a syntax error but for the second statement,
 *    which the server refuses as such; the same statements run as the writable admin without `readonly` on a scratch
 *    copy, the positive control that shows each one would work (a source function's control is that it fails on the
 *    unreachable source, past every check); a BACKUP and an ON CLUSTER KILL, which `readonly = 1` leaves usable, are
 *    refused the least-privilege user (497) by its grants; the engine's tables, rows, users, roles and named
 *    collections read back the same before and after;
 *  - the budgets: a result past the row budget, one past the byte budget and a statement past its deadline are
 *    refused, and a result in a format the statement chose is refused.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against a server you may write to,
 * as a user with access management and `named_collection_control` (the compose service's user needs a `users.d`
 * snippet granting the latter, `docs/providers/clickhouse.md` section 5.6 shows it):
 *
 *   LIBREDB_LIVE_CLICKHOUSE_PORT=8123 LIBREDB_LIVE_CLICKHOUSE_USER=... LIBREDB_LIVE_CLICKHOUSE_PASSWORD=... \
 *     LIBREDB_LIVE_CLICKHOUSE_FUNCTIONS_DIR=... bun tests/live/clickhouse-agent-boundary.ts
 *
 * `LIBREDB_LIVE_CLICKHOUSE_FUNCTIONS_DIR` is this machine's path of a directory the server reads as both
 * `user_defined_executable_functions_config` (`<dir>/*_function.xml`) and `user_scripts_path`, writable here and
 * readable by the server; the provider doc shows the `config.d` snippet.
 *
 * Every user, role, profile, collection and database it creates carries the `libredb_lb_` prefix and is dropped on
 * exit. Each check prints one line, and the first that fails ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExecutionProfileError } from "@/lib/db/errors";
import { createDatabaseProvider, executionContextFor } from "@/lib/db/factory";
import { agentRequestSettings } from "@/lib/db/providers/sql/clickhouse/agent-read";
import { ClickHouseHttpTransport } from "@/lib/db/providers/sql/clickhouse/http-transport";
import { ClickHouseTransportError } from "@/lib/db/providers/sql/clickhouse/transport";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const PREFIX = "libredb_lb_";
const DB = `${PREFIX}data`;
const CTL = `${PREFIX}control`;
const BUDGET = { statementTimeoutMs: 5_000, maxResultRows: 50, maxResultBytes: 64 * 1024 };

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: this script writes to the server it is pointed at, so it has no default`);
    process.exit(2);
  }
  return value;
}

const HOST = process.env.LIBREDB_LIVE_CLICKHOUSE_HOST ?? "127.0.0.1";
const PORT = Number(env("LIBREDB_LIVE_CLICKHOUSE_PORT"));
const ADMIN = { user: env("LIBREDB_LIVE_CLICKHOUSE_USER"), password: env("LIBREDB_LIVE_CLICKHOUSE_PASSWORD") };
/** The server's function configuration and scripts directory, as this machine reaches it. */
const FUNCTIONS_DIR = env("LIBREDB_LIVE_CLICKHOUSE_FUNCTIONS_DIR");
const UDF = `${PREFIX}udf_echo`;
const UDF_FILES = [join(FUNCTIONS_DIR, `${UDF}_function.xml`), join(FUNCTIONS_DIR, `${UDF}.sh`)];
/** One password for every seeded user, made for the run. */
const SEEDED_PASSWORD = randomBytes(12).toString("hex");
/** A name for the run's in-memory backups, which the server keeps until it restarts. */
const RUN = randomBytes(4).toString("hex");

function connection(user: string, password: string, database = DB): DatabaseConnection {
  return {
    id: `live-${user}`,
    name: user,
    type: "clickhouse",
    host: HOST,
    port: PORT,
    user,
    password,
    database,
    createdAt: new Date(),
  };
}

const adminTransport = new ClickHouseHttpTransport(connection(ADMIN.user, ADMIN.password, "default"));

async function admin(sql: string): Promise<void> {
  await adminTransport.query(sql, { timeoutMs: 30_000 });
}

/** The server's code for `sql` sent as `user` with `settings`, or null when it answered. */
async function codeOf(user: string, password: string, sql: string, settings: Record<string, string | number>) {
  try {
    await new ClickHouseHttpTransport(connection(user, password)).query(sql, { settings, timeoutMs: 30_000 });
    return null;
  } catch (error) {
    if (error instanceof ClickHouseTransportError) return error.code;
    throw error;
  }
}

let failures = 0;
function check(ok: boolean, line: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

/** The users the open must refuse, each with the grants that make it so and the words its refusal must carry. */
const REFUSED_USERS: readonly { name: string; grants: string[]; reason: string; says: string }[] = [
  { name: "changeable", grants: [], reason: "PROFILE_SERVER_UNENFORCED", says: "lower readonly" },
  { name: "remote", grants: ["GRANT REMOTE ON *.* TO {u}"], reason: "PROFILE_PRIVILEGES_TOO_BROAD", says: "REMOTE" },
  { name: "url", grants: ["GRANT READ ON URL TO {u}"], reason: "PROFILE_PRIVILEGES_TOO_BROAD", says: "URL ON" },
  {
    name: "backup",
    grants: [`GRANT BACKUP ON ${DB}.* TO {u}`],
    reason: "PROFILE_PRIVILEGES_TOO_BROAD",
    says: "BACKUP",
  },
  {
    name: "named",
    grants: [`GRANT NAMED COLLECTION ON ${PREFIX}nc TO {u}`],
    reason: "PROFILE_PRIVILEGES_TOO_BROAD",
    says: "NAMED COLLECTION",
  },
  {
    name: "alterdb",
    grants: [`GRANT ALTER DATABASE SETTINGS ON ${DB}.* TO {u}`],
    reason: "PROFILE_PRIVILEGES_TOO_BROAD",
    says: "ALTER DATABASE SETTINGS",
  },
  {
    name: "undrop",
    grants: [`GRANT UNDROP TABLE ON ${DB}.* TO {u}`],
    reason: "PROFILE_PRIVILEGES_TOO_BROAD",
    says: "UNDROP TABLE",
  },
  {
    name: "insert",
    grants: [`GRANT INSERT ON ${DB}.* TO {u}`],
    reason: "PROFILE_PRIVILEGES_TOO_BROAD",
    says: "INSERT",
  },
  {
    name: "querylog",
    grants: ["GRANT SELECT ON system.query_log TO {u}"],
    reason: "PROFILE_PRIVILEGES_TOO_BROAD",
    says: "system.query_log",
  },
  {
    name: "option",
    grants: [`GRANT SELECT ON ${DB}.t TO {u} WITH GRANT OPTION`],
    reason: "PROFILE_PRIVILEGES_TOO_BROAD",
    says: "GRANT OPTION",
  },
  {
    name: "rolebackup",
    grants: [`GRANT ${PREFIX}r_backup TO {u}`],
    reason: "PROFILE_PRIVILEGES_TOO_BROAD",
    says: "BACKUP",
  },
  {
    name: "roleremote",
    grants: [`GRANT ${PREFIX}r_remote TO {u}`, "SET DEFAULT ROLE NONE TO {u}"],
    reason: "PROFILE_PRIVILEGES_TOO_BROAD",
    says: "REMOTE",
  },
  {
    name: "urltable",
    grants: [`GRANT SELECT ON ${DB}.url_t TO {u}`],
    reason: "PROFILE_PRIVILEGES_TOO_BROAD",
    says: "url_t (URL)",
  },
  {
    name: "dictionary",
    grants: [`GRANT SELECT ON ${DB}.dict TO {u}`],
    reason: "PROFILE_PRIVILEGES_TOO_BROAD",
    says: "dict (Dictionary)",
  },
  {
    name: "definer",
    grants: [`GRANT SELECT ON ${DB}.v_url TO {u}`],
    reason: "PROFILE_PRIVILEGES_TOO_BROAD",
    says: "v_url (View)",
  },
];

/**
 * `{db}` is the database a statement targets: the agent's, or the control copy. A statement the positive control
 * cannot run to the end, because it reads a source the test server does not have, is marked `source`: its control is
 * that the writable admin gets past every read-only and authorization check and fails on the source itself.
 */
const BOUNDARY_STATEMENTS: readonly (string | { source: string })[] = [
  "INSERT INTO {db}.t VALUES (99, 99)",
  "ALTER TABLE {db}.t UPDATE x = 0 WHERE 1",
  "ALTER TABLE {db}.t DELETE WHERE k = 1",
  "DELETE FROM {db}.t WHERE k = 2",
  "OPTIMIZE TABLE {db}.t FINAL",
  "TRUNCATE TABLE {db}.t",
  "CREATE TABLE {db}.t2 (x Int8) ENGINE = Memory",
  "RENAME TABLE {db}.r TO {db}.r2",
  "DROP TABLE {db}.d",
  "CREATE TEMPORARY TABLE tmp (x Int8) ENGINE = Memory",
  "INSERT INTO FUNCTION null('x Int8') VALUES (1)",
  "SYSTEM FLUSH LOGS",
  `GRANT SELECT ON {db}.* TO ${PREFIX}ro`,
  "CREATE FUNCTION libredb_lb_f AS x -> x",
  "SELECT count() FROM url('http://127.0.0.1:8123/ping', LineAsString)",
  "SELECT count() FROM remote('127.0.0.1', system.one)",
  { source: "SELECT count() FROM file('libredb_lb_missing.csv', CSV, 'x Int8')" },
  { source: "SELECT count() FROM s3('http://127.0.0.1:1/libredb-lb/k.csv', NOSIGN, 'CSV', 'x Int8')" },
  { source: "SELECT count() FROM mysql('127.0.0.1:1', 'd', 't', 'u', 'not-a-real-password')" },
];

function boundaryText(statement: string | { source: string }, database: string): string {
  return (typeof statement === "string" ? statement : statement.source).replaceAll("{db}", database);
}

/**
 * Statements `readonly = 1` leaves usable, so the agent user is held off them by its grants alone, and the open
 * refuses a user that holds the grant: a backup, and a KILL sent to every node of a cluster.
 */
const READONLY_EXEMPT_STATEMENTS: readonly string[] = [
  `BACKUP TABLE {db}.t TO Memory('${PREFIX}b_${RUN}')`,
  "KILL QUERY ON CLUSTER default WHERE query_id = 'libredb-lb-none' SYNC",
];

async function tableState(): Promise<string> {
  const reads = [
    `SELECT database, name, engine, total_rows FROM system.tables WHERE database LIKE '${PREFIX}%' ORDER BY 1, 2`,
    `SELECT sum(k), sum(x), count() FROM ${DB}.t`,
    `SELECT name FROM system.users WHERE name LIKE '${PREFIX}%' ORDER BY 1`,
    `SELECT name FROM system.roles WHERE name LIKE '${PREFIX}%' ORDER BY 1`,
    `SELECT name FROM system.named_collections WHERE name LIKE '${PREFIX}%' ORDER BY 1`,
    `SELECT name FROM system.functions WHERE name LIKE '${PREFIX}%' ORDER BY 1`,
  ];
  const parts: string[] = [];
  for (const sql of reads) parts.push(JSON.stringify((await adminTransport.query(sql)).rows));
  return parts.join("\n");
}

async function seed(): Promise<void> {
  await cleanup();
  for (const database of [DB, CTL]) {
    await admin(`CREATE DATABASE ${database}`);
    await admin(`CREATE TABLE ${database}.t (k Int64, x Int64) ENGINE = MergeTree ORDER BY k`);
    await admin(`INSERT INTO ${database}.t VALUES (1, 10), (2, 20), (3, 30)`);
    await admin(`CREATE TABLE ${database}.r (x Int8) ENGINE = Memory`);
    await admin(`CREATE TABLE ${database}.d (x Int8) ENGINE = Memory`);
  }
  await admin(`CREATE TABLE ${DB}.url_t (line String) ENGINE = URL('http://127.0.0.1:8123/ping', LineAsString)`);
  await admin(`CREATE VIEW ${DB}.v_url DEFINER = ${ADMIN.user} SQL SECURITY DEFINER AS SELECT * FROM ${DB}.url_t`);
  await admin(`CREATE DICTIONARY ${DB}.dict (x Int64) PRIMARY KEY x SOURCE(NULL()) LAYOUT(FLAT()) LIFETIME(0)`);
  await admin(`CREATE NAMED COLLECTION ${PREFIX}nc AS url = 'http://127.0.0.1:8123/'`);
  await admin(`CREATE ROLE ${PREFIX}r_backup`);
  await admin(`GRANT BACKUP ON ${DB}.* TO ${PREFIX}r_backup`);
  await admin(`CREATE ROLE ${PREFIX}r_remote`);
  await admin(`GRANT REMOTE ON *.* TO ${PREFIX}r_remote`);
  await admin(`CREATE ROLE ${PREFIX}r_select`);
  await admin(`GRANT SELECT ON ${DB}.t TO ${PREFIX}r_select`);
  await admin(`CREATE USER ${PREFIX}nondefault IDENTIFIED WITH sha256_password BY '${SEEDED_PASSWORD}'`);
  await admin(`GRANT ${PREFIX}r_select TO ${PREFIX}nondefault`);
  await admin(`SET DEFAULT ROLE NONE TO ${PREFIX}nondefault`);
  await admin(`CREATE SETTINGS PROFILE ${PREFIX}p_changeable SETTINGS readonly = 0 CHANGEABLE_IN_READONLY`);
  const users = ["ro", ...REFUSED_USERS.map((user) => user.name)];
  for (const name of users) {
    const profile = name === "changeable" ? ` SETTINGS PROFILE '${PREFIX}p_changeable'` : "";
    await admin(`CREATE USER ${PREFIX}${name} IDENTIFIED WITH sha256_password BY '${SEEDED_PASSWORD}'${profile}`);
    await admin(`GRANT SELECT ON ${DB}.t TO ${PREFIX}${name}`);
  }
  for (const user of REFUSED_USERS) {
    for (const grant of user.grants) await admin(grant.replaceAll("{u}", `${PREFIX}${user.name}`));
  }
}

/** Writes the echo function and its script, or removes them, and has the server read its function files again. */
async function executableFunction(present: boolean): Promise<void> {
  for (const file of UDF_FILES) rmSync(file, { force: true });
  if (present) {
    writeFileSync(
      UDF_FILES[0],
      `<functions><function><type>executable</type><name>${UDF}</name><return_type>String</return_type><argument><type>String</type></argument><format>TabSeparated</format><command>${UDF}.sh</command></function></functions>\n`,
      { mode: 0o644 },
    );
    writeFileSync(UDF_FILES[1], "#!/bin/sh\ncat\n", { mode: 0o755 });
  }
  await admin("SYSTEM RELOAD FUNCTIONS");
}

async function cleanup(): Promise<void> {
  await executableFunction(false);
  const drops = [
    `DROP DATABASE IF EXISTS ${DB} SYNC`,
    `DROP DATABASE IF EXISTS ${CTL} SYNC`,
    `DROP NAMED COLLECTION IF EXISTS ${PREFIX}nc`,
    `DROP FUNCTION IF EXISTS ${PREFIX}f`,
    `DROP SETTINGS PROFILE IF EXISTS ${PREFIX}p_changeable`,
    `DROP ROLE IF EXISTS ${PREFIX}r_backup, ${PREFIX}r_remote, ${PREFIX}r_select`,
    `DROP USER IF EXISTS ${["ro", "nondefault", ...REFUSED_USERS.map((user) => user.name)].map((name) => PREFIX + name).join(", ")}`,
  ];
  for (const sql of drops) await admin(sql);
}

async function open(user: string, password: string, profile: "agent-read-only" | "agent-operations") {
  const provider = await createDatabaseProvider(connection(user, password), {}, executionContextFor(profile));
  await provider.connect();
  return provider;
}

async function refusalOf(run: () => Promise<unknown>): Promise<Error | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error as Error;
  }
}

async function main(): Promise<void> {
  await seed();
  const ro = `${PREFIX}ro`;

  // The open.
  const agent = await open(ro, SEEDED_PASSWORD, "agent-read-only");
  check(agent.isConnected(), `open: ${ro}, holding SELECT on ${DB}.t alone, is admitted`);
  for (const user of REFUSED_USERS) {
    const error = await refusalOf(() => open(`${PREFIX}${user.name}`, SEEDED_PASSWORD, "agent-read-only"));
    const ok =
      error instanceof ExecutionProfileError && error.reasonCode === user.reason && error.message.includes(user.says);
    check(ok, `open: ${PREFIX}${user.name} is refused ${user.reason} naming "${user.says}" (${error?.message})`);
  }
  const nondefault = await open(`${PREFIX}nondefault`, SEEDED_PASSWORD, "agent-read-only");
  check(nondefault.isConnected(), `open: ${PREFIX}nondefault, whose SELECT is a non-default role's, is admitted`);
  const inactive = await refusalOf(() => nondefault.queryReadOnly!(`SELECT count() FROM ${DB}.t`, BUDGET));
  check(
    inactive?.message.includes("Code: 497") === true,
    `read: ${PREFIX}nondefault's read is refused, the role not being active (${inactive?.message.slice(0, 90)})`,
  );
  await nondefault.disconnect();
  await executableFunction(true);
  const called = await new ClickHouseHttpTransport(connection(ro, SEEDED_PASSWORD))
    .query(`SELECT ${UDF}('agent') AS echoed`, { settings: agentRequestSettings(BUDGET), timeoutMs: 30_000 })
    .then((answer) => JSON.stringify(answer.rows))
    .catch((error: Error) => error.message.slice(0, 120));
  check(
    called === '[{"echoed":"agent"}]',
    `function: ${ro} calls the executable ${UDF} under readonly = 1 with no grant -> ${called}`,
  );
  const udfRefusal = await refusalOf(() => open(ro, SEEDED_PASSWORD, "agent-read-only"));
  check(
    udfRefusal instanceof ExecutionProfileError &&
      udfRefusal.reasonCode === "PROFILE_PRIVILEGES_TOO_BROAD" &&
      udfRefusal.message.includes(`can call ${UDF} (ExecutableUserDefined)`),
    `open: ${ro} is refused while the server holds ${UDF} (${udfRefusal?.message})`,
  );
  await executableFunction(false);
  const readmitted = await open(ro, SEEDED_PASSWORD, "agent-read-only");
  check(readmitted.isConnected(), `open: ${ro} is admitted again once ${UDF} is removed`);
  await readmitted.disconnect();
  const operations = await open(ADMIN.user, ADMIN.password, "agent-operations");
  check(operations.isConnected(), "open: the operations profile opens the writable admin unproven");
  await operations.disconnect();

  // The boundary, admission bypassed, with the state compared before and after.
  const before = await tableState();
  const readonly = agentRequestSettings(BUDGET);
  const refusedCodes = new Set([164, 497]);
  for (const statement of BOUNDARY_STATEMENTS) {
    const sql = boundaryText(statement, DB);
    const viaProvider = await refusalOf(() => (agent as DatabaseProvider).queryReadOnly!(sql, BUDGET));
    check(viaProvider !== null, `boundary: queryReadOnly refuses ${sql} (${viaProvider?.message.slice(0, 90)})`);
    const agentCode = await codeOf(ro, SEEDED_PASSWORD, sql, readonly);
    check(refusedCodes.has(agentCode ?? 0), `boundary: the agent user over the transport: ${sql} -> ${agentCode}`);
    const adminCode = await codeOf(ADMIN.user, ADMIN.password, sql, readonly);
    check(adminCode === 164, `boundary: the writable admin under readonly = 1: ${sql} -> ${adminCode}`);
  }
  const lowered = await codeOf(ro, SEEDED_PASSWORD, `SELECT count() FROM ${DB}.t SETTINGS readonly = 0`, readonly);
  check(lowered === 164, `boundary: a trailing SETTINGS readonly = 0 -> ${lowered}`);
  const second = await codeOf(ro, SEEDED_PASSWORD, `SELECT 1; INSERT INTO ${DB}.t VALUES (98)`, readonly);
  check(second === 62, `boundary: a second statement is refused by the server as one -> ${second}`);
  const clusterAdmin = await codeOf(
    ADMIN.user,
    ADMIN.password,
    "SELECT * FROM cluster('default', system.one)",
    readonly,
  );
  const clusterAgent = await codeOf(ro, SEEDED_PASSWORD, "SELECT * FROM cluster('default', system.one)", readonly);
  check(
    clusterAdmin === null && clusterAgent === 497,
    `boundary: cluster() answers the admin under readonly = 1 (${clusterAdmin}) and is refused the agent user (${clusterAgent}); the provider fence stops it first`,
  );
  const killOwn = await codeOf(ro, SEEDED_PASSWORD, "KILL QUERY WHERE query_id = 'libredb-lb-none' SYNC", readonly);
  check(
    killOwn === 497,
    `boundary: KILL QUERY needs SELECT on system.processes, which the agent user lacks -> ${killOwn}`,
  );
  for (const template of READONLY_EXEMPT_STATEMENTS) {
    const sql = template.replaceAll("{db}", DB);
    const viaProvider = await refusalOf(() => (agent as DatabaseProvider).queryReadOnly!(sql, BUDGET));
    check(viaProvider !== null, `boundary: queryReadOnly refuses ${sql} (${viaProvider?.message.slice(0, 90)})`);
    const agentCode = await codeOf(ro, SEEDED_PASSWORD, sql, readonly);
    check(agentCode === 497, `boundary: the agent user over the transport: ${sql} -> ${agentCode}`);
    const adminCode = await codeOf(ADMIN.user, ADMIN.password, sql, readonly);
    check(
      adminCode !== 164,
      `boundary: readonly = 1 does not refuse the writable admin: ${sql} -> ${adminCode ?? "answered"}`,
    );
  }
  const after = await tableState();
  check(before === after, "boundary: tables, rows, users, roles, collections and functions read back the same");

  // The positive control: the same statements, as the writable admin without readonly, on the control copy.
  for (const statement of BOUNDARY_STATEMENTS) {
    const sql = boundaryText(statement, CTL);
    if (typeof statement === "string") {
      const code = await codeOf(ADMIN.user, ADMIN.password, sql, {});
      check(code === null, `control: the writable admin runs ${sql} -> ${code ?? "answered"}`);
    } else {
      const code = await codeOf(ADMIN.user, ADMIN.password, sql, { max_execution_time: 5 });
      check(
        code !== null && ![62, 164, 497].includes(code),
        `control: the writable admin reaches the source of ${sql} -> ${code ?? "answered"}`,
      );
    }
  }

  // The budgets.
  const rows = await refusalOf(() => agent.queryReadOnly!("SELECT number FROM numbers(51)", BUDGET));
  check(
    rows?.message.startsWith("Read-only execution exceeded the row budget") === true,
    `budget: rows -> ${rows?.message}`,
  );
  const bytes = await refusalOf(() => agent.queryReadOnly!("SELECT repeat('x', 100000) AS s", BUDGET));
  check(
    bytes?.message.startsWith("Read-only execution exceeded the byte budget") === true,
    `budget: bytes -> ${bytes?.message}`,
  );
  const body = await refusalOf(() =>
    agent.queryReadOnly!("SELECT repeat('x', 1000000) AS a, repeat('y', 1000000) AS b", BUDGET),
  );
  check(
    body?.message.startsWith("Read-only execution exceeded the byte budget") === true,
    `budget: an answer past the body cap -> ${body?.message}`,
  );
  const slow = await refusalOf(() =>
    agent.queryReadOnly!("SELECT count() FROM numbers(100000000000)", { ...BUDGET, statementTimeoutMs: 1_000 }),
  );
  check(slow?.name === "TimeoutError", `budget: the deadline -> ${slow?.name}: ${slow?.message.slice(0, 80)}`);
  const raw = await refusalOf(() => agent.queryReadOnly!(`SELECT k FROM ${DB}.t FORMAT TSV`, BUDGET));
  check(raw?.message.includes("remove the FORMAT clause") === true, `budget: a chosen format -> ${raw?.message}`);
  const read = await agent.queryReadOnly!(`SELECT k, x FROM ${DB}.t ORDER BY k`, BUDGET);
  check(read.rowCount === 3, `read: the agent reads its table -> ${JSON.stringify(read.rows)}`);
  await agent.disconnect();
}

try {
  await main();
} finally {
  await cleanup();
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
