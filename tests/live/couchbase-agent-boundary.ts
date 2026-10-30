/**
 * Live check of the Couchbase agent read-only execution profile, against a cluster of the operator's choosing.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The profile's boundary is the server's: a user whose only role is
 * query_select on the connection's bucket, which the query service refuses every write, and a check of that user
 * before every statement (`agent-boundary.ts`). The provider suite replays answers its author captured; whether the
 * query service refuses a write, lists a group's role in GET /whoami or runs a JavaScript function for a SELECT is the
 * server's to say. So this script asks one, through the production path (`createDatabaseProvider` with the agent
 * profile's execution context, then `connect` and `queryReadOnly`), with no admission of Studio's in front:
 *
 *  - the open: query_select on the bucket, and on its default collection, is admitted; each other role beside it
 *    (query_update, query_insert, query_delete, data_writer, bucket_admin, every query_execute_* function role,
 *    query_system_catalog, query_external_access, query_use_sequences, data_reader), admin, query_select on every
 *    bucket and on a second bucket, and data_writer held through a group are each refused by name; a user holding no
 *    role is refused as unauthenticated before the check, since it cannot read /pools/default; the operations profile opens the administrator unchecked, so plan mode grounds on
 *    it; with a Community Edition node, its bucket_full_access and ro_admin users are refused;
 *  - the fence: each write, DDL, transaction, PREPARE, EXECUTE, UPDATE STATISTICS, ADVISE, INFER, EXPLAIN, GRANT,
 *    second statement and carriage-return text is refused through `queryReadOnly` before it is sent; a call of each
 *    user-defined function, CURL(), NEXTVAL, a read of another bucket and of the system keyspaces that hold other
 *    users' work is a SELECT, reaches the server and is refused there;
 *  - the boundary behind the fence: the same statements, sent as the admitted user on a request of its own with the
 *    readonly flag off, are each refused for a missing role (13014), never a syntax error, except the five the server
 *    runs for such a user, which is why the fence exists: UPDATE STATISTICS, BEGIN WORK, PREPARE, ADVISE and the
 *    EXECUTE of the administrator's prepared statement; the administrator runs each write, the positive control;
 *    the bucket's documents read the same before and after;
 *  - the check before every statement: a role added after one call, held directly or through a group, refuses the
 *    next on the same handle, and taking it away admits the one after;
 *  - the budgets: a result past the row budget, one past the byte budget and one past the time budget are refused;
 *  - the catalog read the agent composes answers the fields of a sample.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against a Couchbase Server 8.0
 * Enterprise node with the query, index and data services, a bucket with a primary index on its default collection
 * and a second bucket (the recipe is `tests/fixtures/couchbase/8.0.2/agent-boundary/run.sh`), as the administrator:
 *
 *   LIBREDB_LIVE_COUCHBASE_HOST=<node> LIBREDB_LIVE_COUCHBASE_USER=Administrator \
 *     LIBREDB_LIVE_COUCHBASE_PASSWORD=<its password> LIBREDB_LIVE_COUCHBASE_BUCKET=probe \
 *     LIBREDB_LIVE_COUCHBASE_OTHER_BUCKET=other bun tests/live/couchbase-agent-boundary.ts
 *
 * Optional: `LIBREDB_LIVE_COUCHBASE_CE_HOST` names a Community Edition node with the same administrator and bucket,
 * whose users are then refused at open.
 *
 * Every user, group, document, function and sequence it creates carries the `libredb_lb_` prefix and is removed on
 * exit. Each check prints one line, and the run ends non-zero if any failed.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { randomBytes } from "node:crypto";
import { AuthenticationError, ExecutionProfileError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { composeCatalogRead } from "@/lib/agent/composed-sql";
import { createDatabaseProvider, executionContextFor } from "@/lib/db/factory";
import type { DatabaseProvider, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const PREFIX = "libredb_lb_";
const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 10_000, maxResultRows: 50, maxResultBytes: 64 * 1024 };
/** One password for every seeded user, made for the run, never printed. */
const PASSWORD = randomBytes(12).toString("hex");

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: this script writes to the cluster it is pointed at, so it has no default`);
    process.exit(2);
  }
  return value;
}

const HOST = env("LIBREDB_LIVE_COUCHBASE_HOST");
const CE_HOST = process.env.LIBREDB_LIVE_COUCHBASE_CE_HOST ?? "";
const ADMIN = { user: env("LIBREDB_LIVE_COUCHBASE_USER"), password: env("LIBREDB_LIVE_COUCHBASE_PASSWORD") };
const BUCKET = env("LIBREDB_LIVE_COUCHBASE_BUCKET");
const OTHER = env("LIBREDB_LIVE_COUCHBASE_OTHER_BUCKET");
const CONTEXT = `default:\`${BUCKET}\``;
const SCOPE = `\`${BUCKET}\`.\`_default\``;

let failures = 0;
function check(ok: boolean, line: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

/** A management request as the administrator; fails the run on any answer but 2xx. */
async function manage(host: string, method: string, path: string, form?: Record<string, string>): Promise<unknown> {
  const response = await fetch(`http://${host}:8091${path}`, {
    method,
    headers: {
      authorization: basic(ADMIN.user, ADMIN.password),
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}`);
  return text === "" ? null : (JSON.parse(text) as unknown);
}

interface Answer {
  status: number;
  code: number | null;
  message: string;
  /** The role the server names as missing, read from the error or from its cause: a function call's refusal is 5010. */
  missingRole: string | null;
  rows: unknown[];
  mutations: number;
}

/** `statement` on the query service as `user`, on a request of its own, with readonly off: no Studio code between. */
async function raw(user: string, password: string, statement: string, host = HOST): Promise<Answer> {
  const response = await fetch(`http://${host}:8093/query/service`, {
    method: "POST",
    headers: { authorization: basic(user, password), "content-type": "application/json" },
    body: JSON.stringify({ statement, query_context: CONTEXT, scan_consistency: "request_plus", readonly: false }),
  });
  const payload = (await response.json()) as {
    results?: unknown[];
    errors?: { code: number; msg: string; reason?: { missing_role?: string; cause?: { missing_role?: string } } }[];
    metrics?: { mutationCount?: number };
  };
  const error = payload.errors?.[0];
  return {
    status: response.status,
    code: error?.code ?? null,
    message: error?.msg ?? "",
    missingRole: error?.reason?.missing_role ?? error?.reason?.cause?.missing_role ?? null,
    rows: payload.results ?? [],
    mutations: payload.metrics?.mutationCount ?? 0,
  };
}

const asAdmin = (statement: string) => raw(ADMIN.user, ADMIN.password, statement);

async function setUser(name: string, roles: string, groups = ""): Promise<void> {
  await manage(HOST, "PUT", `/settings/rbac/users/local/${name}`, {
    password: PASSWORD,
    roles,
    ...(groups === "" ? {} : { groups }),
  });
}

function connection(user: string, password: string, host = HOST): DatabaseConnection {
  return {
    id: `live-${user}`,
    name: user,
    type: "couchbase",
    host,
    port: 8091,
    user,
    password,
    database: BUCKET,
    createdAt: new Date(),
  };
}

async function agentHandle(user: string, password = PASSWORD, host = HOST): Promise<DatabaseProvider> {
  const provider = await createDatabaseProvider(
    connection(user, password, host),
    {},
    executionContextFor("agent-read-only"),
  );
  await provider.connect();
  return provider;
}

/** The open as `user`: null when admitted, else the refusal's code and words. */
async function openRefusal(user: string, host = HOST): Promise<ExecutionProfileError | null> {
  try {
    const provider = await agentHandle(user, PASSWORD, host);
    await provider.disconnect();
    return null;
  } catch (error) {
    if (error instanceof ExecutionProfileError) return error;
    throw error;
  }
}

async function readOnly(provider: DatabaseProvider, sql: string, budget = BUDGET): Promise<unknown> {
  if (provider.queryReadOnly === undefined) throw new Error("no queryReadOnly");
  try {
    return await provider.queryReadOnly(sql, budget);
  } catch (error) {
    return error;
  }
}

/** The bucket's default collection as the administrator reads it: every document's key and body. */
async function snapshot(): Promise<string> {
  return JSON.stringify(
    (await asAdmin("SELECT META(d).id AS k, d AS v FROM `_default` AS d ORDER BY META(d).id")).rows,
  );
}

const USERS = {
  ro: `${PREFIX}ro`,
  coll: `${PREFIX}coll`,
  none: `${PREFIX}none`,
  moving: `${PREFIX}moving`,
};

/** Each user refused at open, with the role it holds beside query_select and the name the refusal must carry. */
const REFUSED: readonly (readonly [string, string, string])[] = [
  ["update", `query_select[${BUCKET}],query_update[${BUCKET}]`, `query_update[${BUCKET}:*:*]`],
  ["insert", `query_select[${BUCKET}],query_insert[${BUCKET}]`, `query_insert[${BUCKET}:*:*]`],
  ["delete", `query_select[${BUCKET}],query_delete[${BUCKET}]`, `query_delete[${BUCKET}:*:*]`],
  ["writer", `query_select[${BUCKET}],data_writer[${BUCKET}]`, `data_writer[${BUCKET}:*:*]`],
  ["badmin", `query_select[${BUCKET}],bucket_admin[${BUCKET}]`, `bucket_admin[${BUCKET}]`],
  ["admin", "admin", "admin"],
  ["all", "query_select[*]", "query_select[*:*:*]"],
  ["two", `query_select[${BUCKET}],query_select[${OTHER}]`, `query_select[${OTHER}:*:*]`],
  ["funcs", `query_select[${BUCKET}],query_execute_functions[${BUCKET}:_default]`, "query_execute_functions"],
  [
    "xfuncs",
    `query_select[${BUCKET}],query_execute_external_functions[${BUCKET}:_default]`,
    "query_execute_external_functions",
  ],
  ["gfuncs", `query_select[${BUCKET}],query_execute_global_functions`, "query_execute_global_functions"],
  ["catalog", `query_select[${BUCKET}],query_system_catalog`, "query_system_catalog"],
  ["curl", `query_select[${BUCKET}],query_external_access`, "query_external_access"],
  ["seq", `query_select[${BUCKET}],query_use_sequences[${BUCKET}:_default]`, "query_use_sequences"],
  ["reader", `data_reader[${BUCKET}]`, `data_reader[${BUCKET}:*:*]`],
];

/** Statements the fence refuses before sending, and what the server answers the admitted user for each. */
const FENCED: readonly (readonly [string, "refused" | "runs"])[] = [
  [`INSERT INTO \`_default\` (KEY, VALUE) VALUES ("${PREFIX}w", {"by": "agent"})`, "refused"],
  [`UPSERT INTO \`_default\` (KEY, VALUE) VALUES ("${PREFIX}seed", {"n": -1})`, "refused"],
  [`UPDATE \`_default\` SET n = -1 WHERE META().id = "${PREFIX}seed"`, "refused"],
  [`DELETE FROM \`_default\` WHERE META().id = "${PREFIX}seed"`, "refused"],
  [
    `MERGE INTO \`_default\` AS t USING [{"id": "${PREFIX}seed"}] AS s ON META(t).id = s.id WHEN MATCHED THEN UPDATE SET t.n = -1`,
    "refused",
  ],
  [`CREATE INDEX ${PREFIX}ix ON \`_default\`(n)`, "refused"],
  [`BUILD INDEX ON \`_default\`(\`#primary\`)`, "refused"],
  [`CREATE SCOPE \`${BUCKET}\`.\`${PREFIX}scope\``, "refused"],
  [`CREATE SEQUENCE ${SCOPE}.${PREFIX}seq2`, "refused"],
  [`EXECUTE FUNCTION default:${SCOPE}.${PREFIX}jsw()`, "refused"],
  [`GRANT query_update ON \`_default\` TO ${USERS.ro}`, "refused"],
  ["UPDATE STATISTICS FOR `_default` INDEX ALL", "runs"],
  ["BEGIN WORK", "runs"],
  [`PREPARE ${PREFIX}p FROM SELECT 1 AS a`, "runs"],
  [`EXECUTE ${PREFIX}admin_p`, "runs"],
  ["ADVISE SELECT * FROM `_default` WHERE n = 1", "runs"],
];

/** SELECTs that pass the fence and reach code or data the role does not hold: the server refuses each. */
const SERVER_REFUSED: readonly string[] = [
  `SELECT default:${SCOPE}.${PREFIX}inline(1) AS v`,
  `SELECT default:${SCOPE}.${PREFIX}js(1) AS v`,
  `SELECT default:${SCOPE}.${PREFIX}jsw() AS v`,
  `SELECT default:${PREFIX}global(1) AS v`,
  'SELECT CURL("http://127.0.0.1:8091/pools") AS v',
  `SELECT NEXTVAL FOR ${SCOPE}.${PREFIX}seq AS v`,
  "SELECT m.statement FROM system:completed_requests AS m",
  "SELECT a.statement FROM system:active_requests AS a",
  "SELECT p.statement FROM system:prepareds AS p",
  "SELECT * FROM system:user_info",
  "SELECT * FROM system:applicable_roles",
  'SELECT ADVISOR({"action": "start", "duration": "1m"}) AS v',
  `SELECT d.n FROM default:\`${OTHER}\` AS d`,
];

async function seed(): Promise<void> {
  await manage(HOST, "PUT", `/settings/rbac/groups/${PREFIX}writers`, { roles: `data_writer[${BUCKET}]` });
  await setUser(USERS.ro, `query_select[${BUCKET}]`);
  await setUser(USERS.coll, `query_select[${BUCKET}:_default:_default]`);
  await setUser(USERS.moving, `query_select[${BUCKET}]`);
  await setUser(`${PREFIX}grouped`, `query_select[${BUCKET}]`, `${PREFIX}writers`);
  for (const [name, roles] of REFUSED) await setUser(`${PREFIX}${name}`, roles);
  await asAdmin(`UPSERT INTO \`_default\` (KEY, VALUE) VALUES ("${PREFIX}seed", {"n": 1}), ("${PREFIX}cr", {"n": 2})`);
  await asAdmin(`CREATE OR REPLACE FUNCTION default:${SCOPE}.${PREFIX}inline(x) { x + 1 }`);
  await asAdmin(`CREATE OR REPLACE FUNCTION default:${PREFIX}global(x) { x * 2 }`);
  await asAdmin(
    `CREATE OR REPLACE FUNCTION default:${SCOPE}.${PREFIX}js(x) LANGUAGE JAVASCRIPT AS "function ${PREFIX}js(x) { return x + 1; }"`,
  );
  await asAdmin(
    `CREATE OR REPLACE FUNCTION default:${SCOPE}.${PREFIX}jsw() LANGUAGE JAVASCRIPT AS "function ${PREFIX}jsw() { var r = INSERT INTO \`_default\` (KEY, VALUE) VALUES ('${PREFIX}js', {}); r.close(); return 1; }"`,
  );
  await asAdmin(`CREATE SEQUENCE IF NOT EXISTS ${SCOPE}.${PREFIX}seq`);
  await asAdmin(`PREPARE ${PREFIX}admin_p FROM SELECT "${PREFIX}admin-prepared" AS m`);
  // The query service takes a moment to see a new user.
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

async function cleanUp(): Promise<void> {
  const quiet = async (work: () => Promise<unknown>) => {
    await work().catch(() => {});
  };
  const users = [...Object.values(USERS), `${PREFIX}grouped`, ...REFUSED.map(([name]) => `${PREFIX}${name}`)];
  for (const user of users) await quiet(() => manage(HOST, "DELETE", `/settings/rbac/users/local/${user}`));
  await quiet(() => manage(HOST, "DELETE", `/settings/rbac/groups/${PREFIX}writers`));
  await quiet(() => asAdmin(`DELETE FROM \`_default\` WHERE META().id LIKE "${PREFIX}%"`));
  for (const fn of ["inline", "js", "jsw"])
    await quiet(() => asAdmin(`DROP FUNCTION default:${SCOPE}.${PREFIX}${fn} IF EXISTS`));
  await quiet(() => asAdmin(`DROP FUNCTION default:${PREFIX}global IF EXISTS`));
  await quiet(() => asAdmin(`DROP SEQUENCE ${SCOPE}.${PREFIX}seq IF EXISTS`));
  await quiet(() => asAdmin(`DROP SEQUENCE ${SCOPE}.${PREFIX}seq2 IF EXISTS`));
  await quiet(() => asAdmin(`DROP INDEX ${PREFIX}ix IF EXISTS ON \`_default\``));
  await quiet(() => asAdmin(`DROP SCOPE \`${BUCKET}\`.\`${PREFIX}scope\` IF EXISTS`));
  await quiet(() => asAdmin(`DELETE FROM system:prepareds WHERE name LIKE "%${PREFIX}%"`));
}

async function opens(): Promise<void> {
  check((await openRefusal(USERS.ro)) === null, "open: query_select on the bucket is admitted");
  check((await openRefusal(USERS.coll)) === null, "open: query_select on the bucket's default collection is admitted");
  for (const [name, , named] of REFUSED) {
    const refusal = await openRefusal(`${PREFIX}${name}`);
    check(
      refusal?.reasonCode === "PROFILE_PRIVILEGES_TOO_BROAD" && refusal.message.includes(named),
      `open: ${name} is refused, naming ${named}`,
    );
  }
  const grouped = await openRefusal(`${PREFIX}grouped`);
  check(
    grouped?.reasonCode === "PROFILE_PRIVILEGES_TOO_BROAD" && grouped.message.includes("data_writer"),
    "open: data_writer held through a group is refused",
  );
  await setUser(USERS.none, "");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  // A user holding no role cannot read /pools/default, so the open refuses it before the check (HTTP 401).
  const none = await openRefusal(USERS.none).catch((error: unknown) => error);
  check(
    none instanceof AuthenticationError,
    "open: a user holding no role is refused before the check, as unauthenticated",
  );

  const operations = await createDatabaseProvider(
    connection(ADMIN.user, ADMIN.password),
    {},
    executionContextFor("agent-operations"),
  );
  await operations.connect();
  check(operations.isConnected(), "open: the operations profile opens the administrator unchecked");
  await operations.disconnect();

  if (CE_HOST !== "") {
    for (const [name, roles, named] of [
      ["full", `bucket_full_access[${BUCKET}]`, `bucket_full_access[${BUCKET}]`],
      ["roadmin", "ro_admin", "ro_admin"],
    ] as const) {
      await manage(CE_HOST, "PUT", `/settings/rbac/users/local/${PREFIX}${name}`, { password: PASSWORD, roles });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const refusal = await openRefusal(`${PREFIX}${name}`, CE_HOST);
      check(
        refusal?.reasonCode === "PROFILE_PRIVILEGES_TOO_BROAD" && refusal.message.includes(named),
        `open: Community Edition's ${roles} user is refused`,
      );
      await manage(CE_HOST, "DELETE", `/settings/rbac/users/local/${PREFIX}${name}`).catch(() => {});
    }
  }
}

async function fenceAndBoundary(): Promise<void> {
  const provider = await agentHandle(USERS.ro);
  const before = await snapshot();
  const rows = (await readOnly(
    provider,
    `SELECT META(d).id AS k FROM \`_default\` AS d WHERE META(d).id = "${PREFIX}seed"`,
  )) as {
    rows?: unknown[];
  };
  check(rows.rows?.length === 1, "statement: the admitted user reads the bucket");
  const lowered = (await readOnly(provider, "-- a comment\n/* and a block */ select 1 AS a")) as { rows?: unknown[] };
  check(lowered.rows?.length === 1, "statement: a lowercase select behind both comment forms answers");

  for (const [statement, server] of FENCED) {
    const answer = await readOnly(provider, statement);
    check(answer instanceof RefusedBeforeSendError, `fence: refused before it is sent: ${statement}`);
    const behind = await raw(USERS.ro, PASSWORD, statement);
    if (server === "refused") {
      check(
        behind.code === 13014,
        `behind the fence: the server refuses it for a missing role (${behind.code}): ${statement}`,
      );
    } else {
      check(
        behind.code === null,
        `behind the fence: the server runs it for the user, so the fence is load-bearing: ${statement}`,
      );
    }
  }
  for (const text of [
    "SELECT 1 AS a; DELETE FROM `_default`",
    `-- x\rDELETE FROM \`_default\` USE KEYS "${PREFIX}cr"`,
  ]) {
    check(
      (await readOnly(provider, text)) instanceof RefusedBeforeSendError,
      `fence: refused before it is sent: ${JSON.stringify(text)}`,
    );
  }
  for (const statement of SERVER_REFUSED) {
    const answer = await readOnly(provider, statement);
    const behind = await raw(USERS.ro, PASSWORD, statement);
    check(
      answer instanceof QueryError && !(answer instanceof RefusedBeforeSendError) && behind.missingRole !== null,
      `server: a SELECT reaching what the role does not hold passes the fence and is refused for ${behind.missingRole} (${behind.code}): ${statement}`,
    );
  }
  check((await snapshot()) === before, "state: the bucket's documents read the same after");

  // The positive controls: the administrator runs the writes the user is refused, on scratch keys.
  const write = await asAdmin(`INSERT INTO \`_default\` (KEY, VALUE) VALUES ("${PREFIX}admin", {"n": 1})`);
  check(write.mutations === 1, "control: the administrator's INSERT writes");
  const jsWrite = await asAdmin(`EXECUTE FUNCTION default:${SCOPE}.${PREFIX}jsw()`);
  check(jsWrite.code === null, "control: the administrator's EXECUTE FUNCTION of the JavaScript function writes");
  const carriage = await asAdmin(`-- x\rDELETE FROM \`_default\` USE KEYS "${PREFIX}cr"`);
  check(
    carriage.mutations === 1,
    "control: the server ends a -- comment at a lone carriage return and runs the DELETE after it",
  );
  await provider.disconnect();
}

async function checkEveryCall(): Promise<void> {
  const provider = await agentHandle(USERS.moving);
  const first = await readOnly(provider, "SELECT RAW 1");
  check(!(first instanceof Error), "per call: the first call is admitted");
  await setUser(USERS.moving, `query_select[${BUCKET}],query_external_access`);
  const added = await readOnly(provider, "SELECT RAW 1");
  check(added instanceof ExecutionProfileError, "per call: a role added after one call refuses the next");
  await setUser(USERS.moving, `query_select[${BUCKET}]`);
  const removed = await readOnly(provider, "SELECT RAW 1");
  check(!(removed instanceof Error), "per call: taking the role away admits the one after");
  await setUser(USERS.moving, `query_select[${BUCKET}]`, `${PREFIX}writers`);
  const grouped = await readOnly(provider, "SELECT RAW 1");
  check(grouped instanceof ExecutionProfileError, "per call: a group joined after one call refuses the next");
  await setUser(USERS.moving, `query_select[${BUCKET}]`);
  const left = await readOnly(provider, "SELECT RAW 1");
  check(!(left instanceof Error), "per call: leaving the group admits the one after");

  // What the query service itself enforces once a role is taken away: measured, not assumed. GET /whoami lists the
  // change at once, while the query service may honour the old role for some milliseconds more (capture 08), the
  // residual the provider document names; this times it.
  await setUser(USERS.moving, `query_select[${BUCKET}],query_execute_global_functions`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const held = await raw(USERS.moving, PASSWORD, `SELECT default:${PREFIX}global(1) AS v`);
  await setUser(USERS.moving, `query_select[${BUCKET}]`);
  const revokedAt = Date.now();
  let ran = 0;
  let revoked = await raw(USERS.moving, PASSWORD, `SELECT default:${PREFIX}global(1) AS v`);
  while (revoked.code === null && Date.now() - revokedAt < 5000) {
    ran++;
    revoked = await raw(USERS.moving, PASSWORD, `SELECT default:${PREFIX}global(1) AS v`);
  }
  const window = Date.now() - revokedAt;
  check(
    held.code === null && revoked.missingRole === "query_execute_global_functions" && window < 1000,
    `revoke: the server runs a global function while the role is held, and after it is taken away ran it ${ran} more time(s), refusing it ${window} ms after`,
  );
  await provider.disconnect();
}

async function budgetsAndCatalog(): Promise<void> {
  const provider = await agentHandle(USERS.ro);
  const rows = await readOnly(provider, "SELECT RAW x FROM ARRAY_RANGE(0, 10) AS x", { ...BUDGET, maxResultRows: 5 });
  check(
    rows instanceof QueryError && rows.message.startsWith("Read-only execution exceeded the row budget"),
    "budget: rows",
  );
  const bytes = await readOnly(provider, "SELECT REPEAT('x', 5000) AS t", { ...BUDGET, maxResultBytes: 1024 });
  check(
    bytes instanceof QueryError && bytes.message.startsWith("Read-only execution exceeded the byte budget"),
    "budget: bytes",
  );
  const cut = await readOnly(provider, "SELECT RAW REPEAT('x', 100) FROM ARRAY_RANGE(0, 2000) AS x", {
    ...BUDGET,
    maxResultRows: 5000,
    maxResultBytes: 1024,
  });
  check(
    cut instanceof QueryError && cut.message.startsWith("Read-only execution exceeded the byte budget"),
    "budget: an answer past the byte cap",
  );
  const slow = await readOnly(
    provider,
    "SELECT COUNT(*) AS n FROM ARRAY_RANGE(0, 4000) AS a, ARRAY_RANGE(0, 4000) AS b",
    { ...BUDGET, statementTimeoutMs: 200 },
  );
  check(
    slow instanceof QueryError && slow.message.startsWith("Read-only execution exceeded the time budget"),
    "budget: time",
  );
  const catalog = (await readOnly(
    provider,
    composeCatalogRead("couchbase", { kind: "columns", schema: "_default", table: "_default" }),
  )) as {
    rows?: { column_name?: unknown }[];
  };
  check(
    catalog.rows?.some((row) => row.column_name === "n") === true,
    "catalog: the composed column read answers the sample's fields",
  );
  await provider.disconnect();
}

try {
  await cleanUp();
  await seed();
  await opens();
  await fenceAndBoundary();
  await checkEveryCall();
  await budgetsAndCatalog();
} finally {
  await cleanUp();
}
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
