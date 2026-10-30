/**
 * Live check of the Apache Druid agent read-only execution profile, against a cluster of the operator's choosing.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The profile's boundary is the server's: the native engine, which
 * refuses every write on the SQL endpoint, proven before every statement by an INSERT the server must refuse
 * (`agent-boundary.ts`). The provider suite replays answers its author captured; whether Druid refuses a write for a
 * user who may write, honours a SET before a statement, or stops a statement at a cancel is the server's to say. So
 * this script asks one, through the production path (`createDatabaseProvider` with the agent profile's execution
 * context, then `connect` and `queryReadOnly`), with no admission of Studio's in front:
 *
 *  - the open: a user holding READ on one datasource, one holding WRITE on every datasource and the administrator are
 *    each admitted, since the boundary is the engine and not the user; a wrong password is refused before the check;
 *    the operations profile opens without the probe, so plan mode grounds on any connection;
 *  - the fence: a SET before a statement, INSERT, REPLACE, EXPLAIN PLAN FOR, a second statement, a carriage return
 *    inside a line comment and a dollar run are each refused through `queryReadOnly` before anything is sent;
 *  - the boundary behind the fence: the same writes, sent raw on the SQL endpoint with the native engine pinned, as
 *    the user holding WRITE and as the administrator, are each refused by the engine (INVALID_INPUT), never as a
 *    permission refusal, and so are the writes a SET or the context's own engine would route to MSQ; the datasource
 *    reads the same before and after; the same INSERT through the MSQ task endpoint, which the provider never calls,
 *    writes, the positive control;
 *  - what a SELECT reaches: EXTERN is refused by the server, another datasource is refused to the user who may not read
 *    it, and the composed catalog read lists only the datasources the user may read;
 *  - the budgets: a result past the row budget, one past the byte budget and one past the time budget are refused, a
 *    statement the data servers compute past its deadline is cancelled by its own query id, and one the Broker computes
 *    over inline data is named as no longer held or cancelled while it runs on.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against an Apache Druid 37.0 cluster
 * with druid-basic-security and druid-multi-stage-query loaded (`tests/fixtures/druid/37.0.0/agent-boundary/cluster.yml`
 * started as `run.sh secured` starts it), as the administrator:
 *
 *   LIBREDB_LIVE_DRUID_URL=http://127.0.0.1:18888 LIBREDB_LIVE_DRUID_ADMIN_PASSWORD=<its password> \
 *     bun tests/live/druid-agent-boundary.ts
 *
 * Every user, role and datasource it creates carries the `libredb_lb_` prefix; the users and roles are removed on exit
 * and the datasources are marked unused. Each check prints one line, and the run ends non-zero if any failed.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { randomBytes } from "node:crypto";
import { ExecutionProfileError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { composeCatalogRead } from "@/lib/agent/composed-sql";
import { createDatabaseProvider, executionContextFor } from "@/lib/db/factory";
import type { DatabaseProvider, QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const PREFIX = "libredb_lb_";
const DATA = `${PREFIX}data`;
const OTHER = `${PREFIX}other`;
const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 20_000, maxResultRows: 50, maxResultBytes: 64 * 1024 };
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

const ROUTER = new URL(env("LIBREDB_LIVE_DRUID_URL"));
const ADMIN_PASSWORD = env("LIBREDB_LIVE_DRUID_ADMIN_PASSWORD");
const AUTHN = "/proxy/coordinator/druid-ext/basic-security/authentication/db/basic";
const AUTHZ = "/proxy/coordinator/druid-ext/basic-security/authorization/db/basic";

let failures = 0;
function check(ok: boolean, line: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const admin = basic("admin", ADMIN_PASSWORD);

/**
 * A management request as the administrator; fails the run on any answer but 2xx, or, when `missingIsFine`, the 400 the
 * authorizer answers for a user or role it does not hold and the 404 the Coordinator answers for a datasource.
 */
async function manage(method: string, path: string, body?: unknown, missingIsFine = false): Promise<string> {
  const response = await fetch(new URL(path, ROUTER), {
    method,
    headers: { authorization: admin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok && !(missingIsFine && (response.status === 400 || response.status === 404))) {
    throw new Error(`${method} ${path} answered ${response.status}`);
  }
  return text;
}

interface Answer {
  status: number;
  category: string | null;
  message: string;
  rows: unknown[];
}

/** `query` on the SQL endpoint as `authorization`, the native engine pinned: no Studio code between. */
async function raw(authorization: string, query: string, context: Record<string, unknown> = { engine: "native" }) {
  const response = await fetch(new URL("/druid/v2/sql", ROUTER), {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ query, context }),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    payload = null;
  }
  const envelope = (payload !== null && !Array.isArray(payload) ? payload : {}) as {
    category?: string;
    errorMessage?: string;
  };
  return {
    status: response.status,
    category: envelope.category ?? null,
    message: envelope.errorMessage ?? (response.ok ? "" : text.slice(0, 200)),
    rows: Array.isArray(payload) ? payload : [],
  } satisfies Answer;
}

const asAdmin = (query: string) => raw(admin, query);

/** How many rows `datasource` holds, as the administrator reads it, or -1 when it is not served. */
async function rowCount(datasource: string): Promise<number> {
  const answer = await asAdmin(`SELECT COUNT(*) AS n FROM "${datasource}"`);
  const row = answer.rows[0] as { n?: number } | undefined;
  return answer.status === 200 ? (row?.n ?? 0) : -1;
}

async function waitFor(what: string, ready: () => Promise<boolean>, seconds = 180): Promise<void> {
  for (let waited = 0; waited < seconds; waited += 3) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`gave up waiting for ${what}`);
}

/**
 * An INSERT into `datasource` through the MSQ task endpoint, as `authorization`: a million rows, or one; the HTTP
 * status.
 */
async function ingest(authorization: string, datasource: string, size: "million" | "one"): Promise<number> {
  const values = Array.from({ length: size === "million" ? 1000 : 1 }, (_unused, index) => index).join(",");
  const response = await fetch(new URL("/druid/v2/sql/task", ROUTER), {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      query:
        `INSERT INTO "${datasource}" SELECT TIMESTAMPADD(SECOND, CAST(a.x AS INTEGER), TIME_PARSE('2026-01-01')) AS __time, ` +
        `a.x AS x, CONCAT(REPEAT('a', 18), CAST(b.y AS VARCHAR)) AS s FROM UNNEST(ARRAY[${values}]) AS a(x) ` +
        `CROSS JOIN UNNEST(ARRAY[${values}]) AS b(y) PARTITIONED BY DAY`,
      context: { maxNumTasks: 2 },
    }),
  });
  await response.text();
  return response.status;
}

const USERS = { ro: `${PREFIX}ro`, rw: `${PREFIX}rw` };

async function setUser(name: string, permissions: unknown[]): Promise<void> {
  await manage("POST", `${AUTHN}/users/${name}`);
  await manage("POST", `${AUTHN}/users/${name}/credentials`, { password: PASSWORD });
  await manage("POST", `${AUTHZ}/users/${name}`);
  await manage("POST", `${AUTHZ}/roles/${name}`);
  await manage("POST", `${AUTHZ}/roles/${name}/permissions`, permissions);
  await manage("POST", `${AUTHZ}/users/${name}/roles/${name}`);
}

async function cleanUp(): Promise<void> {
  for (const name of Object.values(USERS)) {
    await manage("DELETE", `${AUTHZ}/users/${name}`, undefined, true);
    await manage("DELETE", `${AUTHZ}/roles/${name}`, undefined, true);
    await manage("DELETE", `${AUTHN}/users/${name}`, undefined, true);
  }
}

async function seed(): Promise<void> {
  const perm = (name: string, type: string, action: string) => ({ resource: { name, type }, action });
  await setUser(USERS.ro, [perm(`^${DATA}$`, "DATASOURCE", "READ")]);
  await setUser(USERS.rw, [
    perm(".*", "DATASOURCE", "READ"),
    perm(".*", "DATASOURCE", "WRITE"),
    perm(".*", "EXTERNAL", "READ"),
  ]);
  for (const datasource of [DATA, OTHER]) {
    if ((await rowCount(datasource)) >= 1_000_000) continue;
    if ((await ingest(admin, datasource, "million")) !== 202) throw new Error(`the seed of ${datasource} was refused`);
    await waitFor(`${datasource} to be served`, async () => (await rowCount(datasource)) > 0);
  }
  // The authorizer's cache reaches the Broker on its own polling period.
  await waitFor("the seeded users to be known to the Broker", async () => {
    const answer = await raw(basic(USERS.ro, PASSWORD), `SELECT COUNT(*) AS n FROM "${DATA}"`);
    return answer.status === 200;
  });
}

function connection(user: string, password: string): DatabaseConnection {
  return {
    id: `live-${user}`,
    name: user,
    type: "druid",
    host: ROUTER.hostname,
    port: Number(ROUTER.port),
    user,
    password,
    createdAt: new Date(),
  };
}

async function agentHandle(user: string, password = PASSWORD): Promise<DatabaseProvider> {
  const provider = await createDatabaseProvider(connection(user, password), {}, executionContextFor("agent-read-only"));
  await provider.connect();
  return provider;
}

async function readOnly(provider: DatabaseProvider, sql: string, budget = BUDGET): Promise<QueryResult | Error> {
  if (provider.queryReadOnly === undefined) throw new Error("no queryReadOnly");
  try {
    return await provider.queryReadOnly(sql, budget);
  } catch (error) {
    return error as Error;
  }
}

async function opens(): Promise<void> {
  for (const [user, password] of [
    [USERS.ro, PASSWORD],
    [USERS.rw, PASSWORD],
    ["admin", ADMIN_PASSWORD],
  ] as const) {
    let admitted = false;
    try {
      const provider = await agentHandle(user, password);
      admitted = true;
      await provider.disconnect();
    } catch (error) {
      console.log(`  ${user}: ${error instanceof Error ? error.message : String(error)}`);
    }
    check(admitted, `open: ${user} is admitted, since the native engine refuses its writes`);
  }
  let wrong: unknown = null;
  try {
    await agentHandle(USERS.ro, "not-the-password");
  } catch (error) {
    wrong = error;
  }
  check(
    wrong instanceof Error && !(wrong instanceof ExecutionProfileError),
    `open: a wrong password is refused by the editor's own probe, before the check (${wrong instanceof Error ? `${wrong.name}: ${wrong.message.slice(0, 80)}` : "admitted"})`,
  );
  const operations = await createDatabaseProvider(
    connection("admin", ADMIN_PASSWORD),
    {},
    executionContextFor("agent-operations"),
  );
  await operations.connect();
  check(operations.isConnected(), "open: the operations profile opens");
  await operations.disconnect();
}

const INSERT = `INSERT INTO "${DATA}" SELECT TIME_PARSE('2026-01-01') AS __time, -1 AS x, 'w' AS s PARTITIONED BY DAY`;
const REPLACE = `REPLACE INTO "${DATA}" OVERWRITE ALL SELECT TIME_PARSE('2026-01-01') AS __time, -1 AS x, 'w' AS s PARTITIONED BY DAY`;
const NATIVE_INSERT = "INSERT operations are not supported by requested SQL engine [native], consider using MSQ.";

async function fenceAndBoundary(): Promise<void> {
  const provider = await agentHandle(USERS.rw);
  for (const sql of [
    `SET engine = 'msq-task'; ${INSERT}`,
    INSERT,
    REPLACE,
    `EXPLAIN PLAN FOR SELECT 1 AS a`,
    "SELECT 1 AS a; SELECT 2 AS b",
    "SELECT 1 AS a -- x\r, 2 AS b",
    "SELECT $$x$$ AS a",
    `SET sqlQueryId = 'chosen'; SELECT 1 AS a`,
  ]) {
    const refused = await readOnly(provider, sql);
    check(
      refused instanceof RefusedBeforeSendError,
      `fence: ${JSON.stringify(sql.slice(0, 60))} refused before sending`,
    );
  }
  await provider.disconnect();

  const before = await rowCount(DATA);
  for (const [who, authorization] of [
    ["the user holding WRITE", basic(USERS.rw, PASSWORD)],
    ["the administrator", admin],
  ] as const) {
    for (const [what, query, context] of [
      ["INSERT", INSERT, { engine: "native" }],
      ["REPLACE", REPLACE, { engine: "native" }],
      ["SET engine before an INSERT", `SET engine = 'msq-task'; ${INSERT}`, { engine: "native" }],
      ["the context's own engine", INSERT, { engine: "msq-task" }],
    ] as const) {
      const answer = await raw(authorization, query, context);
      check(
        answer.status === 400 && answer.category === "INVALID_INPUT",
        `boundary: ${what} as ${who} is refused by the engine (${answer.status} ${answer.message.slice(0, 70)})`,
      );
    }
  }
  check((await rowCount(DATA)) === before, "boundary: the datasource reads the same after every refusal");

  const probe = await raw(
    basic(USERS.ro, PASSWORD),
    `INSERT INTO "${PREFIX}probe_${randomBytes(12).toString("hex")}" SELECT TIME_PARSE('2026-01-01') AS __time PARTITIONED BY ALL`,
  );
  check(
    probe.status === 400 && probe.message === NATIVE_INSERT,
    "boundary: the check's probe, as a user holding no WRITE, gets the native engine's own refusal",
  );

  check(
    (await ingest(basic(USERS.rw, PASSWORD), DATA, "one")) === 202,
    "positive control: MSQ task endpoint takes the INSERT",
  );
  await waitFor("the positive control's row", async () => (await rowCount(DATA)) > before);
  check((await rowCount(DATA)) > before, "positive control: the row the MSQ task endpoint wrote is served");
  check(
    (await ingest(basic(USERS.ro, PASSWORD), DATA, "one")) === 403,
    "positive control: the MSQ task endpoint refuses a user holding only READ",
  );
}

async function reaches(): Promise<void> {
  const rw = await agentHandle(USERS.rw);
  const extern = await readOnly(
    rw,
    `SELECT * FROM TABLE(EXTERN('{"type":"inline","data":"a"}', '{"type":"csv","columns":["v"]}', '[{"name":"v","type":"string"}]'))`,
  );
  check(
    extern instanceof QueryError && !(extern instanceof RefusedBeforeSendError) && extern.message.includes("EXTERN"),
    `reach: EXTERN passes the fence and the server refuses it (${extern instanceof Error ? extern.message.slice(0, 80) : "answered"})`,
  );
  await rw.disconnect();

  const ro = await agentHandle(USERS.ro);
  const other = await readOnly(ro, `SELECT COUNT(*) AS n FROM "${OTHER}"`);
  check(
    other instanceof QueryError && !(other instanceof RefusedBeforeSendError),
    `reach: another datasource is refused by the server (${other instanceof Error ? `${other.name}: ${other.message.slice(0, 80)}` : "answered"})`,
  );
  const columns = await readOnly(ro, composeCatalogRead("druid", { kind: "columns" }));
  const tables = new Set(
    columns instanceof Error ? [] : columns.rows.map((row) => (row as { table_name?: unknown }).table_name),
  );
  check(
    tables.has(DATA) && !tables.has(OTHER),
    `catalog: the composed column read lists the datasource the user may read, and not another (${[...tables].join(", ")})`,
  );
  const relations = await readOnly(ro, composeCatalogRead("druid", { kind: "relations", schema: "druid" }));
  check(!(relations instanceof Error) && relations.rows.length === 0, "catalog: the relation read answers no rows");
  await ro.disconnect();
}

async function budgets(): Promise<void> {
  const provider = await agentHandle(USERS.ro);
  const rows = await readOnly(provider, `SELECT x FROM "${DATA}" LIMIT 51`);
  check(
    rows instanceof QueryError && rows.message.startsWith("Read-only execution exceeded the row budget"),
    "budget: rows",
  );
  const bytes = await readOnly(provider, `SELECT REPEAT(s, 100) AS s FROM "${DATA}" LIMIT 40`);
  check(
    bytes instanceof QueryError && bytes.message.startsWith("Read-only execution exceeded the byte budget"),
    `budget: bytes (${bytes instanceof Error ? bytes.message.slice(0, 90) : "answered"})`,
  );
  const heavy = await readOnly(
    provider,
    `SELECT SUM(STRLEN(REPEAT(CONCAT(s, CAST(x AS VARCHAR)), 10000))) AS n FROM "${DATA}"`,
    { ...BUDGET, statementTimeoutMs: 1500 },
  );
  check(
    heavy instanceof QueryError && heavy.message.startsWith("Read-only execution exceeded the time budget"),
    `budget: time, on the data servers (${heavy instanceof Error ? heavy.message : "answered"})`,
  );
  const values = Array.from({ length: 600 }, (_unused, index) => index).join(",");
  const inline = await readOnly(
    provider,
    `WITH a AS (SELECT x FROM UNNEST(ARRAY[${values}]) AS t(x)) SELECT SUM(a.x * b.x + c.x) AS n FROM a CROSS JOIN a AS b CROSS JOIN a AS c`,
    { ...BUDGET, statementTimeoutMs: 1500 },
  );
  check(
    inline instanceof QueryError && inline.message.startsWith("Read-only execution exceeded the time budget"),
    `budget: time, on the Broker over inline data (${inline instanceof Error ? inline.message : "answered"})`,
  );
  await provider.disconnect();
}

try {
  await cleanUp();
  await seed();
  await opens();
  await fenceAndBoundary();
  await reaches();
  await budgets();
} catch (error) {
  check(false, `the run stopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await cleanUp();
  for (const datasource of [DATA, OTHER]) {
    await manage("DELETE", `/druid/coordinator/v1/datasources/${datasource}`, undefined, true);
  }
}
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
