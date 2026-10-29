/**
 * Live check of the Apache Cassandra agent read-only execution profile, against a server of the operator's choosing.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The profile's boundary is the server's: a role holding only SELECT
 * on the connection's keyspace, which the server refuses every write as Unauthorized, and a check of that role before
 * every statement (`agent-boundary.ts`). The provider suite replays answers its author captured; whether a server
 * refuses a write, lists a role inherited two levels down or runs a masking function for a SELECT is the server's to
 * say. So this script asks one, through the production path (`createDatabaseProvider` with the agent profile's
 * execution context, then `connect` and `queryReadOnly`), with no admission of Studio's in front:
 *
 *  - the open: a role holding SELECT on the keyspace, and one holding SELECT on a table of it, are admitted; a
 *    superuser, a role granted a superuser role, a role holding MODIFY on a second keyspace, SELECT on every keyspace,
 *    EXECUTE on a function, UNMASK, MODIFY through a role granted to a role granted to it, and nothing at all are each
 *    refused by the step that names them; a keyspace holding a column masked with a user-defined function refuses the
 *    role that reads it; the operations profile opens the superuser unproven, so plan mode grounds on it;
 *  - the positive controls: the MODIFY role writes into the second keyspace through the driver, and the admitted role's
 *    SELECT of the masked column runs the function, which is why each is refused;
 *  - the fence: each write, conditional write, BATCH, TRUNCATE, DDL statement, GRANT, REVOKE and role statement is
 *    sent as the admitted role through `queryReadOnly` and refused before it is sent, as not a SELECT; a call of a
 *    user-defined function and aggregate is a SELECT, reaches the server and is refused there as Unauthorized;
 *  - the boundary behind the fence: the same statements, sent as the admitted role on a driver session of its own, are
 *    each refused by the server as Unauthorized, never a syntax error; the same statements run as the superuser on a
 *    scratch keyspace, the positive control that shows each would work; the keyspace's tables and rows, its functions
 *    and the roles read back the same before and after;
 *  - the check before every statement: a grant of MODIFY, of a superuser role and a user-defined mask added after one
 *    call refuse the next on the same handle, and their removal admits the one after;
 *  - the session: a `USE` is refused before it is sent, and an unqualified table reads the connection's keyspace;
 *  - CQL's grammar: a tagged dollar run, which the fence refuses, is a syntax error on the server too;
 *  - the budgets: a result past the row budget and one past the byte budget are refused;
 *  - the password: the admitted role's change of its own password through `queryReadOnly` is refused before it is sent
 *    and the old password still signs in, while the same statement on a driver session of its own is accepted, the
 *    write no grant stops and the reason the fence exists.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against a Cassandra 5.0 node with
 * PasswordAuthenticator and CassandraAuthorizer, user-defined functions and dynamic data masking on, as a superuser
 * (the recipe is `tests/fixtures/cassandra/5.0.9/agent-boundary/run.sh`):
 *
 *   LIBREDB_LIVE_CASSANDRA_PORT=9042 LIBREDB_LIVE_CASSANDRA_USER=cassandra LIBREDB_LIVE_CASSANDRA_PASSWORD=cassandra \
 *     bun tests/live/cassandra-agent-boundary.ts
 *
 * Optional: `LIBREDB_LIVE_CASSANDRA_ALLOW_ALL_PORT` names a node with AllowAllAuthorizer whose superuser is the same,
 * and `LIBREDB_LIVE_SCYLLA_PORT` a ScyllaDB node with no authenticator; each is then refused at open.
 *
 * Every keyspace and role it creates carries the `libredb_lb_` prefix and is dropped on exit. Each check prints one
 * line, and the run ends non-zero if any failed.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { randomBytes } from "node:crypto";
import { ExecutionProfileError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { createDatabaseProvider, executionContextFor } from "@/lib/db/factory";
import { CassandraDriverTransport } from "@/lib/db/providers/sql/cassandra/driver-transport";
import { CassandraTransportError } from "@/lib/db/providers/sql/cassandra/transport";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const PREFIX = "libredb_lb_";
const KS = `${PREFIX}data`;
const OTHER = `${PREFIX}other`;
const SCRATCH = `${PREFIX}scratch`;
const BUDGET = { statementTimeoutMs: 10_000, maxResultRows: 50, maxResultBytes: 64 * 1024 };
/** One password for every seeded role, made for the run. */
const PASSWORD = randomBytes(12).toString("hex");
/** Cassandra lets a role change its password once per 5000ms from its creation on (code 4097). */
const PASSWORD_INTERVAL_MS = 5_500;

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: this script writes to the server it is pointed at, so it has no default`);
    process.exit(2);
  }
  return value;
}

const HOST = process.env.LIBREDB_LIVE_CASSANDRA_HOST ?? "127.0.0.1";
const PORT = Number(env("LIBREDB_LIVE_CASSANDRA_PORT"));
const ADMIN = { user: env("LIBREDB_LIVE_CASSANDRA_USER"), password: env("LIBREDB_LIVE_CASSANDRA_PASSWORD") };
const DATA_CENTRE = process.env.LIBREDB_LIVE_CASSANDRA_DATA_CENTRE ?? "datacenter1";

function connection(user: string, password: string, port = PORT, database = KS): DatabaseConnection {
  return {
    id: `live-${user}`,
    name: user,
    type: "cassandra",
    host: HOST,
    port,
    user,
    password,
    database,
    localDataCenter: DATA_CENTRE,
    createdAt: new Date(),
  };
}

let adminTransport: CassandraDriverTransport | null = null;

async function admin(cql: string): Promise<{ rows: Record<string, unknown>[] }> {
  if (adminTransport === null) {
    adminTransport = new CassandraDriverTransport(connection(ADMIN.user, ADMIN.password, PORT, ""), 60_000);
    await adminTransport.connect();
  }
  return adminTransport.execute(cql);
}

/** What `cql` sent as `user` through the driver answers: null when it ran, else the server's code and words. */
async function asRole(user: string, cql: string): Promise<{ code: number | null; message: string } | null> {
  const transport = new CassandraDriverTransport(connection(user, PASSWORD), 30_000);
  await transport.connect();
  try {
    await transport.execute(cql);
    return null;
  } catch (error) {
    if (error instanceof CassandraTransportError) return { code: error.code, message: error.message };
    throw error;
  } finally {
    await transport.close();
  }
}

let failures = 0;
function check(ok: boolean, line: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function open(user: string, profile: "agent-read-only" | "agent-operations" = "agent-read-only") {
  const provider = await createDatabaseProvider(
    connection(user, user === ADMIN.user ? ADMIN.password : PASSWORD),
    {},
    executionContextFor(profile),
  );
  await provider.connect();
  return provider;
}

/** The refusal the open of `user` answers, or null when it opened. */
async function openRefusal(user: string, port = PORT): Promise<ExecutionProfileError | null> {
  const password = user === ADMIN.user ? ADMIN.password : PASSWORD;
  const provider = await createDatabaseProvider(
    connection(user, password, port),
    {},
    executionContextFor("agent-read-only"),
  );
  try {
    await provider.connect();
    await provider.disconnect();
    return null;
  } catch (error) {
    if (error instanceof ExecutionProfileError) return error;
    throw error;
  }
}

/** What `queryReadOnly` answers for `cql`: the rows, or the error it raised. */
async function readOnly(provider: DatabaseProvider, cql: string, budget = BUDGET) {
  try {
    return { rows: (await provider.queryReadOnly!(cql, budget)).rows, error: null };
  } catch (error) {
    return { rows: null, error: error as Error };
  }
}

async function seed(): Promise<void> {
  for (const keyspace of [KS, OTHER, SCRATCH]) {
    await admin(
      `CREATE KEYSPACE IF NOT EXISTS ${keyspace} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,
    );
  }
  for (const keyspace of [KS, SCRATCH]) {
    await admin(`CREATE TABLE IF NOT EXISTS ${keyspace}.customers (id int PRIMARY KEY, name text)`);
    await admin(`CREATE TABLE IF NOT EXISTS ${keyspace}.big (id int PRIMARY KEY, body text)`);
    for (const [id, name] of [
      [1, "Ada"],
      [2, "Brian"],
      [3, "Chen"],
    ] as const) {
      await admin(`INSERT INTO ${keyspace}.customers (id, name) VALUES (${id}, '${name}')`);
    }
    await admin(`INSERT INTO ${keyspace}.big (id, body) VALUES (1, '${"x".repeat(4096)}')`);
    await admin(
      `CREATE FUNCTION IF NOT EXISTS ${keyspace}.plus_one(x int) RETURNS NULL ON NULL INPUT RETURNS int LANGUAGE java AS 'return x + 1;'`,
    );
    await admin(
      `CREATE FUNCTION IF NOT EXISTS ${keyspace}.acc(state int, v int) CALLED ON NULL INPUT RETURNS int LANGUAGE java AS 'return state + (v == null ? 0 : v);'`,
    );
    await admin(`CREATE AGGREGATE IF NOT EXISTS ${keyspace}.total(int) SFUNC acc STYPE int INITCOND 0`);
    await admin(
      `CREATE FUNCTION IF NOT EXISTS ${keyspace}.redact(v text) RETURNS NULL ON NULL INPUT RETURNS text LANGUAGE java AS 'return "redacted-by-udf";'`,
    );
  }
  await admin(`CREATE TABLE IF NOT EXISTS ${OTHER}.t (id int PRIMARY KEY, v text)`);
  // A keyspace whose one table has a column masked with a user-defined function, read by a role of its own.
  await admin(`CREATE TABLE IF NOT EXISTS ${SCRATCH}.masked (id int PRIMARY KEY, secret text)`);
  await admin(`INSERT INTO ${SCRATCH}.masked (id, secret) VALUES (1, 'plain-value')`);
  await admin(`ALTER TABLE ${SCRATCH}.masked ALTER secret MASKED WITH ${SCRATCH}.redact()`);

  const role = async (name: string, ...grants: string[]) => {
    await admin(`CREATE ROLE IF NOT EXISTS ${name} WITH LOGIN = true AND PASSWORD = '${PASSWORD}'`);
    for (const grant of grants) await admin(grant);
  };
  await role(`${PREFIX}ro`, `GRANT SELECT ON KEYSPACE ${KS} TO ${PREFIX}ro`);
  await role(`${PREFIX}table`, `GRANT SELECT ON TABLE ${KS}.customers TO ${PREFIX}table`);
  await role(
    `${PREFIX}modify`,
    `GRANT SELECT ON KEYSPACE ${KS} TO ${PREFIX}modify`,
    `GRANT MODIFY ON KEYSPACE ${OTHER} TO ${PREFIX}modify`,
  );
  await admin(
    `CREATE ROLE IF NOT EXISTS ${PREFIX}super WITH LOGIN = true AND SUPERUSER = true AND PASSWORD = '${PASSWORD}'`,
  );
  await role(`${PREFIX}allks`, `GRANT SELECT ON ALL KEYSPACES TO ${PREFIX}allks`);
  await role(
    `${PREFIX}exec`,
    `GRANT SELECT ON KEYSPACE ${KS} TO ${PREFIX}exec`,
    `GRANT EXECUTE ON FUNCTION ${KS}.plus_one(int) TO ${PREFIX}exec`,
  );
  await role(
    `${PREFIX}unmask`,
    `GRANT SELECT ON KEYSPACE ${KS} TO ${PREFIX}unmask`,
    `GRANT UNMASK ON KEYSPACE ${KS} TO ${PREFIX}unmask`,
  );
  await admin(`CREATE ROLE IF NOT EXISTS ${PREFIX}writer_inner`);
  await admin(`GRANT MODIFY ON KEYSPACE ${KS} TO ${PREFIX}writer_inner`);
  await admin(`CREATE ROLE IF NOT EXISTS ${PREFIX}writer_middle`);
  await admin(`GRANT ${PREFIX}writer_inner TO ${PREFIX}writer_middle`);
  await role(
    `${PREFIX}inherit`,
    `GRANT SELECT ON KEYSPACE ${KS} TO ${PREFIX}inherit`,
    `GRANT ${PREFIX}writer_middle TO ${PREFIX}inherit`,
  );
  await admin(`CREATE ROLE IF NOT EXISTS ${PREFIX}super_inner WITH SUPERUSER = true`);
  await role(
    `${PREFIX}inherit_super`,
    `GRANT SELECT ON KEYSPACE ${KS} TO ${PREFIX}inherit_super`,
    `GRANT ${PREFIX}super_inner TO ${PREFIX}inherit_super`,
  );
  await role(`${PREFIX}none`);
  await role(`${PREFIX}masked`, `GRANT SELECT ON KEYSPACE ${SCRATCH} TO ${PREFIX}masked`);
  await role(`${PREFIX}late`, `GRANT SELECT ON KEYSPACE ${KS} TO ${PREFIX}late`);
}

async function cleanup(): Promise<void> {
  for (const keyspace of [KS, OTHER, SCRATCH]) await admin(`DROP KEYSPACE IF EXISTS ${keyspace}`).catch(() => {});
  for (const name of [
    "ro",
    "table",
    "modify",
    "super",
    "allks",
    "exec",
    "unmask",
    "inherit",
    "writer_middle",
    "writer_inner",
    "inherit_super",
    "super_inner",
    "none",
    "masked",
    "late",
  ]) {
    await admin(`DROP ROLE IF EXISTS ${PREFIX}${name}`).catch(() => {});
  }
}

/** The state the boundary must leave as it found: every row of the keyspace's tables, its functions, and the roles. */
async function state(): Promise<string> {
  const customers = await admin(`SELECT id, name FROM ${KS}.customers`);
  const big = await admin(`SELECT id FROM ${KS}.big`);
  const tables = await admin(`SELECT table_name FROM system_schema.tables WHERE keyspace_name = '${KS}'`);
  const functions = await admin(`SELECT function_name FROM system_schema.functions WHERE keyspace_name = '${KS}'`);
  const other = await admin(`SELECT id FROM ${OTHER}.t`);
  const roles = await admin("LIST ROLES");
  return JSON.stringify([
    customers.rows,
    big.rows,
    tables.rows,
    functions.rows,
    other.rows,
    roles.rows.map((row) => row.role).sort(),
  ]);
}

/** The boundary's statements, each with the keyspace it writes to left as `@`. */
const WRITES: readonly string[] = [
  "INSERT INTO @.customers (id, name) VALUES (99, 'x')",
  "UPDATE @.customers SET name = 'x' WHERE id = 1",
  "DELETE FROM @.customers WHERE id = 1",
  "INSERT INTO @.customers (id, name) VALUES (98, 'x') IF NOT EXISTS",
  "BEGIN BATCH INSERT INTO @.customers (id, name) VALUES (97, 'x'); APPLY BATCH",
  "BEGIN UNLOGGED BATCH UPDATE @.customers SET name = 'y' WHERE id = 2; APPLY BATCH",
  "TRUNCATE @.big",
  "CREATE TABLE @.made (id int PRIMARY KEY)",
  "ALTER TABLE @.customers ADD extra text",
  "CREATE INDEX ON @.customers (name)",
  "CREATE MATERIALIZED VIEW @.by_name AS SELECT * FROM @.customers WHERE id IS NOT NULL AND name IS NOT NULL PRIMARY KEY (name, id)",
  "CREATE FUNCTION @.made_f(x int) RETURNS NULL ON NULL INPUT RETURNS int LANGUAGE java AS 'return x;'",
  "CREATE TYPE @.addr (street text)",
  "DROP TABLE @.big",
  "SELECT @.plus_one(id) FROM @.customers WHERE id = 1",
  "SELECT @.total(id) FROM @.customers",
];

/** Statements on no keyspace's data: each refused the role, never run by the control. */
const ROLE_WRITES: readonly string[] = [
  `CREATE KEYSPACE ${PREFIX}made WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,
  `GRANT MODIFY ON KEYSPACE ${KS} TO ${PREFIX}ro`,
  `REVOKE SELECT ON KEYSPACE ${KS} FROM ${PREFIX}ro`,
  `CREATE ROLE ${PREFIX}made`,
  `ALTER ROLE ${PREFIX}ro WITH SUPERUSER = true`,
];

async function main(): Promise<void> {
  await cleanup();
  await seed();

  // The open.
  for (const user of [`${PREFIX}ro`, `${PREFIX}table`]) {
    check((await openRefusal(user)) === null, `open admits ${user}`);
  }
  const refusals: readonly [string, string, string][] = [
    [`${PREFIX}super`, "PROFILE_PRIVILEGES_TOO_BROAD", "it is a superuser"],
    [`${PREFIX}inherit_super`, "PROFILE_PRIVILEGES_TOO_BROAD", `it is a superuser (${PREFIX}super_inner)`],
    [`${PREFIX}modify`, "PROFILE_PRIVILEGES_TOO_BROAD", `it holds MODIFY on <keyspace ${OTHER}>`],
    [`${PREFIX}allks`, "PROFILE_PRIVILEGES_TOO_BROAD", "it holds SELECT on <all keyspaces>"],
    [`${PREFIX}exec`, "PROFILE_PRIVILEGES_TOO_BROAD", `it holds EXECUTE on <function ${KS}.plus_one(int)>`],
    [`${PREFIX}unmask`, "PROFILE_PRIVILEGES_TOO_BROAD", `it holds UNMASK on <keyspace ${KS}>`],
    [
      `${PREFIX}inherit`,
      "PROFILE_PRIVILEGES_TOO_BROAD",
      `it holds MODIFY on <keyspace ${KS}> (granted to ${PREFIX}writer_inner)`,
    ],
    [`${PREFIX}none`, "PROFILE_PRIVILEGES_TOO_NARROW", "holds none"],
  ];
  for (const [user, code, words] of refusals) {
    const refused = await openRefusal(user);
    check(
      refused?.reasonCode === code && refused.message.includes(words),
      `open refuses ${user}: ${refused?.message ?? "admitted"}`,
    );
  }
  const maskedOpen = await createDatabaseProvider(
    connection(`${PREFIX}masked`, PASSWORD, PORT, SCRATCH),
    {},
    executionContextFor("agent-read-only"),
  );
  const masked = await maskedOpen.connect().then(
    () => null,
    (error: unknown) => error as Error,
  );
  check(
    masked instanceof ExecutionProfileError &&
      masked.message.includes(
        `the column ${SCRATCH}.masked.secret is masked with the user-defined function ${SCRATCH}.redact`,
      ),
    `open refuses a keyspace with a column masked by a user-defined function: ${masked?.message ?? "admitted"}`,
  );
  const operations = await open(ADMIN.user, "agent-operations");
  check(operations.isConnected(), "the operations profile opens the superuser unproven, so plan mode grounds on it");
  await operations.disconnect();

  // The positive controls behind two refusals.
  check(
    (await asRole(`${PREFIX}modify`, `INSERT INTO ${OTHER}.t (id, v) VALUES (1, 'written')`)) === null,
    "control: the MODIFY role writes into the second keyspace",
  );
  check(
    (await admin(`SELECT v FROM ${OTHER}.t WHERE id = 1`)).rows[0]?.v === "written",
    "control: the row it wrote is there",
  );
  const maskTransport = new CassandraDriverTransport(connection(`${PREFIX}masked`, PASSWORD, PORT, SCRATCH), 30_000);
  await maskTransport.connect();
  const maskRead = await maskTransport.execute(`SELECT secret FROM ${SCRATCH}.masked WHERE id = 1`);
  await maskTransport.close();
  check(
    maskRead.rows[0]?.secret === "redacted-by-udf",
    "control: a SELECT-only role's read of the masked column runs the user-defined function",
  );
  await admin(`DELETE FROM ${OTHER}.t WHERE id = 1`);

  // The boundary, with no admission in front, and its positive control on the scratch keyspace.
  const before = await state();
  const reader = await open(`${PREFIX}ro`);
  const editor = await createDatabaseProvider(connection(`${PREFIX}ro`, PASSWORD), {}, {});
  await editor.connect();
  const unprofiled = await readOnly(editor, `SELECT id FROM ${KS}.customers`);
  check(
    unprofiled.error?.message === "Read-only execution requires a provider opened under the agent read-only profile",
    "queryReadOnly refuses a handle opened for the editor",
  );
  await editor.disconnect();
  const UNAUTHORIZED =
    /^User libredb_lb_ro has no \w+ permission|does not have sufficient privileges|You aren't allowed/;
  for (const template of [...WRITES, ...ROLE_WRITES]) {
    const cql = template.replaceAll("@", KS);
    const { error } = await readOnly(reader, cql);
    if (cql.startsWith("SELECT ")) {
      const unauthorized =
        error instanceof QueryError &&
        !(error instanceof ExecutionProfileError) &&
        !(error instanceof RefusedBeforeSendError) &&
        UNAUTHORIZED.test(error.message);
      check(unauthorized, `the fence admits a SELECT, the server refuses it: ${cql} -> ${error?.message ?? "ran"}`);
    } else {
      const fenced =
        error instanceof RefusedBeforeSendError &&
        error.message.includes("does not begin with SELECT, so it was not sent");
      check(fenced, `the fence refuses before sending: ${cql} -> ${error?.message ?? "ran"}`);
    }
    const raw = await asRole(`${PREFIX}ro`, cql);
    check(
      raw !== null && raw.code === 8448 && UNAUTHORIZED.test(raw.message),
      `behind the fence, refused as Unauthorized: ${cql} -> ${raw === null ? "ran" : raw.message}`,
    );
  }
  for (const template of WRITES) {
    const cql = template.replaceAll("@", SCRATCH);
    const ran = await admin(cql).then(
      () => true,
      (error: unknown) => (error as Error).message,
    );
    check(ran === true, `control: the superuser runs ${cql}${ran === true ? "" : ` -> ${ran}`}`);
  }
  check(
    (await state()) === before,
    "the keyspace's rows, tables and functions and the roles read the same after the boundary",
  );

  // The session: a USE is refused before it is sent, and an unqualified table reads the connection's keyspace.
  const use = await readOnly(reader, `USE ${OTHER}`);
  check(
    use.error instanceof RefusedBeforeSendError,
    `a USE is refused before it is sent: ${use.error?.message ?? "ran"}`,
  );
  const unqualified = await readOnly(reader, "SELECT id FROM customers");
  check(
    unqualified.rows?.length === 3,
    `an unqualified table reads the connection's keyspace: ${unqualified.error?.message ?? `${unqualified.rows?.length} rows`}`,
  );
  // Leading comments of all three forms, one holding a semicolon, and a lowercase keyword pass the fence and answer.
  const commented = await readOnly(
    reader,
    `/* note; */ -- a\n// b\nselect id from ${KS}.customers where id = 1 ; -- done\n`,
  );
  check(
    commented.rows?.length === 1,
    `a SELECT behind comments, in lowercase, with a semicolon in a comment, is admitted: ${commented.error?.message ?? `${commented.rows?.length} rows`}`,
  );
  // CQL's grammar: the tagged dollar run the fence refuses is a syntax error on the server too.
  const tagged = await admin("SELECT $t$x$t$ FROM system.local").then(
    () => "ran",
    (error: unknown) => (error as CassandraTransportError).category,
  );
  check(tagged === "syntax", `a tagged dollar run is a syntax error on the server: ${tagged}`);

  // The budgets.
  const rows = await readOnly(reader, `SELECT id FROM ${KS}.customers`, { ...BUDGET, maxResultRows: 2 });
  check(
    rows.error?.message === "Read-only execution exceeded the row budget: 3 rows > 2 allowed",
    `the row budget refuses: ${rows.error?.message}`,
  );
  const bytes = await readOnly(reader, `SELECT body FROM ${KS}.big`, { ...BUDGET, maxResultBytes: 1024 });
  check(
    bytes.error?.message.startsWith("Read-only execution exceeded the byte budget:") === true,
    `the byte budget refuses: ${bytes.error?.message}`,
  );
  const fits = await readOnly(reader, `SELECT id, name FROM ${KS}.customers`);
  check(fits.rows?.length === 3, "a read inside both budgets answers");
  await reader.disconnect();

  // The check before every statement, on a handle that stays open.
  const late = await open(`${PREFIX}late`);
  const read = () => readOnly(late, `SELECT id FROM ${KS}.customers`);
  const changes: readonly [string, string, string][] = [
    [
      `GRANT MODIFY ON KEYSPACE ${OTHER} TO ${PREFIX}late`,
      `REVOKE MODIFY ON KEYSPACE ${OTHER} FROM ${PREFIX}late`,
      "a grant of MODIFY",
    ],
    [
      `GRANT ${PREFIX}super_inner TO ${PREFIX}late`,
      `REVOKE ${PREFIX}super_inner FROM ${PREFIX}late`,
      "a superuser role granted",
    ],
    [
      `ALTER TABLE ${KS}.customers ALTER name MASKED WITH ${KS}.redact()`,
      `ALTER TABLE ${KS}.customers ALTER name DROP MASKED`,
      "a user-defined mask",
    ],
  ];
  check((await read()).rows?.length === 3, "the handle's first call answers");
  for (const [add, remove, what] of changes) {
    await admin(add);
    const refused = await read();
    check(
      refused.error instanceof ExecutionProfileError,
      `${what} after one call refuses the next: ${refused.error?.message ?? "admitted"}`,
    );
    await admin(remove);
    const admitted = await read();
    check(admitted.rows?.length === 3, `its removal admits the one after: ${admitted.error?.message ?? "admitted"}`);
  }
  await late.disconnect();

  // The engine gates.
  const allowPort = process.env.LIBREDB_LIVE_CASSANDRA_ALLOW_ALL_PORT;
  if (allowPort !== undefined && allowPort !== "") {
    const allowAdmin = new CassandraDriverTransport(
      connection(ADMIN.user, ADMIN.password, Number(allowPort), ""),
      60_000,
    );
    await allowAdmin.connect();
    await allowAdmin.execute(
      `CREATE KEYSPACE IF NOT EXISTS ${KS} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,
    );
    await allowAdmin.execute(`CREATE ROLE IF NOT EXISTS ${PREFIX}ro WITH LOGIN = true AND PASSWORD = '${PASSWORD}'`);
    const refused = await openRefusal(`${PREFIX}ro`, Number(allowPort));
    check(
      refused?.reasonCode === "PROFILE_SERVER_UNENFORCED",
      `AllowAllAuthorizer is refused at open: ${refused?.message ?? "admitted"}`,
    );
    await allowAdmin.execute(`DROP KEYSPACE IF EXISTS ${KS}`);
    await allowAdmin.execute(`DROP ROLE IF EXISTS ${PREFIX}ro`);
    await allowAdmin.close();
  }
  const scyllaPort = process.env.LIBREDB_LIVE_SCYLLA_PORT;
  if (scyllaPort !== undefined && scyllaPort !== "") {
    const scylla = await createDatabaseProvider(
      {
        ...connection("not-a-real-role", "not-a-real-password", Number(scyllaPort), "system"),
        user: "not-a-real-role",
      },
      {},
      executionContextFor("agent-read-only"),
    );
    const refused = await scylla.connect().then(
      () => null,
      (error: unknown) => error as Error,
    );
    check(
      refused instanceof ExecutionProfileError && refused.reasonCode === "PROFILE_UNSUPPORTED_TARGET",
      `ScyllaDB 2026.2.4 is refused at open: ${refused?.message ?? "admitted"}`,
    );
  }

  // The password: a role can change its own password, which no grant stops, so the fence refuses it before sending.
  await sleep(PASSWORD_INTERVAL_MS);
  const passwordReader = await open(`${PREFIX}ro`);
  const fenced = await readOnly(passwordReader, `ALTER ROLE ${PREFIX}ro WITH PASSWORD = 'not-a-real-password'`);
  await passwordReader.disconnect();
  check(
    fenced.error instanceof RefusedBeforeSendError,
    `the role's own password change is refused before it is sent: ${fenced.error?.message ?? "ran"}`,
  );
  check(
    (await asRole(`${PREFIX}ro`, `SELECT id FROM ${KS}.customers WHERE id = 1`)) === null,
    "the old password still signs in after the refused change",
  );
  const own = await asRole(`${PREFIX}ro`, `ALTER ROLE ${PREFIX}ro WITH PASSWORD = '${PASSWORD}'`);
  check(
    own === null,
    `control: on a driver session of its own the server accepts the change: ${own === null ? "accepted" : own.message}`,
  );
}

try {
  await main();
} finally {
  await cleanup();
  // Assigned inside `admin()`, which the compiler does not follow from here.
  await (adminTransport as CassandraDriverTransport | null)?.close();
}
console.log(failures === 0 ? "every check passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
