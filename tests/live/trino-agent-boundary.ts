/**
 * Live check of the Trino agent read-only execution profile, against coordinators of the operator's choosing.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The profile's boundary is the operator's access control: it must
 * refuse the connection's user every catalog's table functions and catalog management, proven at the open and before
 * every statement (`agent-boundary.ts`), and every statement runs in a read-only transaction Studio rolls back. The
 * provider suite replays answers its author captured; whether Trino refuses a pass-through write, a CALL or a catalog
 * removal under a given access control is the server's to say. So this script asks four, through the production path
 * (`createDatabaseProvider` with the agent profile's execution context, then `connect` and `queryReadOnly`), and sends
 * the same writes raw with no admission of Studio's in front:
 *
 *  - the open: the read-only access control and file rules granting no function are admitted; the default access
 *    control and file rules granting the query function are refused with the operator settings named, and nothing is
 *    written; the operations profile opens on the default, so plan mode grounds on any connection; an editor handle's
 *    queryReadOnly is refused;
 *  - the fence: CALL, INSERT, CREATE TABLE AS, catalog creation and removal, COMMIT, ROLLBACK, START TRANSACTION, SET
 *    SESSION, USE, EXECUTE, PREPARE and a second statement are each refused through `queryReadOnly` before anything
 *    is sent;
 *  - the boundary behind the fence: the pass-through dblink write through `queryReadOnly` is refused by the server, and
 *    the same write, INSERT, CREATE TABLE AS, CALL in a transaction and in autocommit, and catalog creation and removal,
 *    sent raw, are each refused as an authorization, read-only or transaction refusal, never a syntax error; the
 *    PostgreSQL table reads the same before and after;
 *  - reads: a SELECT answers its rows, the composed column read lists the table's columns, and no transaction is left
 *    open on the coordinator;
 *  - the budgets: a result past the row budget and one past the byte budget are refused, and a statement past the time
 *    budget is refused and cancelled on the cluster.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Start the coordinators with
 * `tests/fixtures/trino/476/agent-boundary/run.sh up`, which prints each one's access control and URL, then:
 *
 *   LIBREDB_LIVE_TRINO_READONLY_URL=<read-only> LIBREDB_LIVE_TRINO_FILE_URL=<file-nofn> \
 *   LIBREDB_LIVE_TRINO_DEFAULT_URL=<allow-all> LIBREDB_LIVE_TRINO_GRANT_URL=<file-fn-query> \
 *     bun tests/live/trino-agent-boundary.ts
 *
 * and `run.sh down` afterwards. The coordinators run with no authentication, so no credential is sent or printed. Each
 * check prints one line, and the run ends non-zero if any failed.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { composeCatalogRead } from "@/lib/agent/composed-sql";
import { ExecutionProfileError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { createDatabaseProvider, executionContextFor } from "@/lib/db/factory";
import type { DatabaseProvider, QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 30_000, maxResultRows: 50, maxResultBytes: 64 * 1024 };
const USER = "studio";

function env(name: string): URL {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: run tests/fixtures/trino/476/agent-boundary/run.sh up and pass the URL it prints`);
    process.exit(2);
  }
  return new URL(value);
}

const SERVERS = {
  "read-only": env("LIBREDB_LIVE_TRINO_READONLY_URL"),
  "file-nofn": env("LIBREDB_LIVE_TRINO_FILE_URL"),
  "allow-all": env("LIBREDB_LIVE_TRINO_DEFAULT_URL"),
  "file-fn-query": env("LIBREDB_LIVE_TRINO_GRANT_URL"),
} as const;
type Access = keyof typeof SERVERS;
const ENFORCING: readonly Access[] = ["read-only", "file-nofn"];

let failures = 0;
function check(ok: boolean, line: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

/** One statement sent raw over the client protocol, in a read-only transaction or in autocommit: no admission of Studio's. */
async function raw(access: Access, sql: string, transaction: "read-only" | "none"): Promise<string> {
  const origin = SERVERS[access];
  const send = async (statement: string, id: string) => {
    let response = await fetch(new URL("/v1/statement", origin), {
      method: "POST",
      headers: { "X-Trino-User": USER, "X-Trino-Transaction-Id": id },
      body: statement,
    });
    let started: string | null = null;
    const rows: unknown[] = [];
    for (;;) {
      started ??= response.headers.get("x-trino-started-transaction-id");
      const page = (await response.json()) as {
        nextUri?: string;
        data?: unknown[];
        error?: { errorName: string; message: string };
      };
      rows.push(...(page.data ?? []));
      if (page.error !== undefined) return { started, answer: `${page.error.errorName}: ${page.error.message}` };
      if (page.nextUri === undefined) return { started, answer: `OK ${JSON.stringify(rows)}` };
      response = await fetch(page.nextUri, { headers: { "X-Trino-User": USER } });
    }
  };
  if (transaction === "none") return (await send(sql, "NONE")).answer;
  const opened = await send("START TRANSACTION READ ONLY", "NONE");
  if (opened.started === null) throw new Error(`no transaction started: ${opened.answer}`);
  try {
    return (await send(sql, opened.started)).answer;
  } finally {
    await send("ROLLBACK", opened.started);
  }
}

/** What PostgreSQL holds, read through the read-only coordinator's pg catalog. */
async function pgRows(): Promise<string> {
  return await raw("read-only", "SELECT a FROM pg.public.rp_t ORDER BY a", "none");
}

function connection(access: Access): DatabaseConnection {
  const url = SERVERS[access];
  return {
    id: `trino-live-${access}`,
    name: `Trino ${access}`,
    type: "trino",
    host: url.hostname,
    port: Number(url.port),
    user: USER,
    database: "pg",
    schema: "public",
    createdAt: new Date(),
  };
}

async function agentHandle(access: Access): Promise<DatabaseProvider> {
  const provider = await createDatabaseProvider(connection(access), {}, executionContextFor("agent-read-only"));
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

const dblinkWrite = (catalog: string, marker: number) =>
  `SELECT * FROM TABLE(${catalog}.system.query(query => 'SELECT * FROM dblink_exec(''dbname=postgres user=postgres'', ''INSERT INTO public.rp_t VALUES (${marker})'') AS r'))`;

async function opens(): Promise<void> {
  const before = await pgRows();
  for (const access of ENFORCING) {
    const provider = await agentHandle(access).catch((error: unknown) => error as Error);
    check(!(provider instanceof Error), `${access}: the agent read-only profile opens`);
    if (!(provider instanceof Error)) await provider.disconnect();
  }
  for (const access of ["allow-all", "file-fn-query"] as const) {
    const error = await agentHandle(access).then(
      () => null,
      (caught: unknown) => caught,
    );
    check(
      error instanceof ExecutionProfileError &&
        error.reasonCode === "PROFILE_SERVER_UNENFORCED" &&
        error.message.includes(
          "set access-control.name=read-only, or file-based access control that grants no function",
        ) &&
        error.message.endsWith("The check ran nothing."),
      `${access}: the open is refused with the operator settings named (${error instanceof Error ? error.message.slice(-160) : "opened"})`,
    );
  }
  const operations = await createDatabaseProvider(connection("allow-all"), {}, executionContextFor("agent-operations"));
  const grounded = await operations.connect().then(
    () => true,
    () => false,
  );
  check(grounded, "allow-all: the operations profile opens with no check, so plan mode grounds");
  await operations.disconnect();
  const editor = await createDatabaseProvider(connection("read-only"));
  await editor.connect();
  const refused = await readOnly(editor, "SELECT 1");
  check(
    refused instanceof RefusedBeforeSendError &&
      refused.message === "Read-only execution requires a provider opened under the agent read-only profile",
    "read-only: an editor handle's queryReadOnly is refused",
  );
  await editor.disconnect();
  check((await pgRows()) === before, `the opens wrote nothing (${before})`);
}

async function fenceAndBoundary(): Promise<void> {
  for (const access of ENFORCING) {
    const provider = await agentHandle(access);
    const before = await pgRows();
    for (const sql of [
      "CALL pg.system.execute(query => 'INSERT INTO public.rp_t VALUES (201)')",
      "INSERT INTO pg.public.rp_t VALUES (202)",
      "CREATE TABLE memory.default.libredb_lb AS SELECT 1 AS a",
      "DROP CATALOG pg2",
      "CREATE CATALOG libredb_lb USING memory",
      "COMMIT",
      "ROLLBACK",
      "START TRANSACTION",
      "SET SESSION query_max_run_time = '1s'",
      "USE pg.public",
      "EXECUTE p",
      "PREPARE p FROM SELECT 1",
      "SELECT 1 AS a; COMMIT",
    ]) {
      const error = await readOnly(provider, sql);
      check(error instanceof RefusedBeforeSendError, `${access}: refused before anything is sent: ${sql}`);
    }
    const passThrough = await readOnly(provider, dblinkWrite("pg", 203));
    check(
      passThrough instanceof QueryError &&
        !(passThrough instanceof RefusedBeforeSendError) &&
        passThrough.message === "Access Denied: Cannot execute function pg.system.query",
      `${access}: the pass-through dblink write through queryReadOnly is refused by the server (${passThrough instanceof Error ? passThrough.message : "answered"})`,
    );
    for (const [sql, transaction] of [
      [dblinkWrite("pg", 204), "read-only"],
      [dblinkWrite("pg2", 205), "none"],
      ["INSERT INTO pg.public.rp_t VALUES (206)", "read-only"],
      ["CREATE TABLE memory.default.libredb_lb AS SELECT 1 AS a", "read-only"],
      ["CALL pg.system.execute(query => 'INSERT INTO public.rp_t VALUES (207)')", "read-only"],
      ["CALL pg.system.execute(query => 'INSERT INTO public.rp_t VALUES (208)')", "none"],
      ["DROP CATALOG pg2", "read-only"],
      ["CREATE CATALOG libredb_lb USING memory", "none"],
    ] as const) {
      const answer = await raw(access, sql, transaction);
      check(
        /^(?:PERMISSION_DENIED|READ_ONLY_VIOLATION|NOT_SUPPORTED): /.test(answer),
        `${access}: raw, ${transaction === "none" ? "autocommit" : "read-only transaction"}: ${sql.slice(0, 70)} -> ${answer.slice(0, 90)}`,
      );
    }
    check((await pgRows()) === before, `${access}: PostgreSQL holds what it held before (${before})`);
    await provider.disconnect();
  }
}

async function reads(): Promise<void> {
  const provider = await agentHandle("read-only");
  const transactions = await raw("read-only", "SELECT count(*) FROM system.runtime.transactions", "none");
  const rows = await readOnly(provider, "SELECT a FROM pg.public.rp_t ORDER BY a");
  check(
    !(rows instanceof Error) && rows.rows.length > 0 && "a" in (rows.rows[0] ?? {}),
    "read-only: a SELECT answers its rows",
  );
  const columns = await readOnly(
    provider,
    composeCatalogRead("trino", { kind: "columns", schema: "public", table: "rp_t" }),
  );
  check(
    !(columns instanceof Error) && columns.rows.some((row) => row.column_name === "a"),
    "read-only: the composed column read lists the table's columns",
  );
  await readOnly(provider, dblinkWrite("pg", 209));
  check(
    (await raw("read-only", "SELECT count(*) FROM system.runtime.transactions", "none")) === transactions,
    `read-only: no transaction is left open after a read and a refusal (${transactions})`,
  );
  await provider.disconnect();
}

async function budgets(): Promise<void> {
  const provider = await agentHandle("read-only");
  const rows = await readOnly(provider, "SELECT x FROM UNNEST(sequence(1, 100)) AS t(x)");
  check(
    // The rows that had arrived when reading stopped: one page here, so all hundred.
    rows instanceof QueryError &&
      /^Read-only execution exceeded the row budget: \d+ rows > 50 allowed; /.test(rows.message),
    `the row budget refuses (${rows instanceof Error ? rows.message : "answered"})`,
  );
  const bytes = await readOnly(provider, "SELECT rpad('x', 2000, 'x') AS v FROM UNNEST(sequence(1, 40)) AS t(x)");
  check(
    bytes instanceof QueryError && bytes.message.startsWith("Read-only execution exceeded the byte budget"),
    `the byte budget refuses (${bytes instanceof Error ? bytes.message : "answered"})`,
  );
  const marker = `libredb_lb_${Date.now()}`;
  const slow = await readOnly(
    provider,
    `SELECT count(*) AS ${marker} FROM UNNEST(sequence(1, 10000)) a(x) CROSS JOIN UNNEST(sequence(1, 10000)) b(y) CROSS JOIN UNNEST(sequence(1, 1000)) c(z)`,
    { ...BUDGET, statementTimeoutMs: 3000 },
  );
  check(
    slow instanceof QueryError &&
      slow.message.startsWith("Read-only execution exceeded the time budget: no answer within 3000ms"),
    `the time budget refuses (${slow instanceof Error ? slow.message : "answered"})`,
  );
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const state = await raw(
    "read-only",
    `SELECT state, error_code FROM system.runtime.queries WHERE query LIKE '%AS ${marker} FROM%' AND query NOT LIKE '%system.runtime%'`,
    "none",
  );
  check(
    state.includes('"FAILED"') && state.includes("USER_CANCELED"),
    `the statement past its deadline was cancelled on the cluster (${state})`,
  );
  await provider.disconnect();
}

await opens();
await fenceAndBoundary();
await reads();
await budgets();
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
