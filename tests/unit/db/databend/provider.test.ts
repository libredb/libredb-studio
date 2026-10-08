/**
 * The Databend provider (design 2.3, 2.4, 3.10, 3.12, 6.4): the composition of the directory's modules, driven end to
 * end over a fake query server that stands where the shared node transport stands.
 *
 * The fake answers each statement POST for the ids the request carries (`wireIds`), as Databend answers our own
 * statement, so every request goes through the real HTTP transport, the real answer reader and the real decoder.
 * Time is injected (`transportDeps`): a deadline fires only when a test fires it, so no test waits on a real timer;
 * the only real wait is a zero-length yield while concurrent calls settle.
 *
 * Every provider a test builds is disconnected after it, so no permit of the process-wide `databend` limiter is
 * left held for the next test.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createErrorResponse } from "@/lib/api/errors";
import { ConnectionError, DatabaseConfigError, QueryCancelledError, QueryError, TimeoutError } from "@/lib/db/errors";
import {
  type NodeRequest,
  type NodeResponse,
  type NodeTransport,
  type NodeTransportOptions,
  TransportError,
} from "@/lib/db/http/node-transport";
import { DATABEND_PROVIDER_SENTENCES, DatabendProvider } from "@/lib/db/providers/sql/databend";
import { DATABEND_ANSWER_SENTENCES } from "@/lib/db/providers/sql/databend/answer";
import { DATABEND_ERROR_SENTENCES } from "@/lib/db/providers/sql/databend/errors";
import {
  DATABEND_DEFAULT_SESSION_LIMIT,
  DATABEND_MONITORING_SENTENCES,
  databendSessionsSql,
  databendSlowQueriesSql,
} from "@/lib/db/providers/sql/databend/introspect";
import { DATABEND_KILL_SPEC, DATABEND_LABELS } from "@/lib/db/providers/sql/databend/labels";
import { DATABEND_OBJECT_SENTENCES, DATABEND_VERSION_SQL } from "@/lib/db/providers/sql/databend/objects";
import {
  globalSettingsChangedWarning,
  ROLE_NOT_CARRIED,
  SETTINGS_NOT_CARRIED,
  TEMP_TABLES_DROPPED,
  TRANSACTION_ENDED,
  TRANSACTION_MAY_STAY_OPEN,
  USE_NOT_CARRIED,
} from "@/lib/db/providers/sql/databend/session";
import { DATABEND_MULTIPLE_STATEMENTS } from "@/lib/db/providers/sql/databend/sql-text";
import { LimiterFullError } from "@/lib/db/utils/bounded-limiter";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { type DatabaseConnection, TUNNEL_FAR_END } from "@/lib/types";
import {
  answerBody,
  scriptedNodeTransport,
  TEST_USER,
  testConnection,
  transportDeps,
  wireIds,
} from "../../../helpers/databend-node-transport";

// ============================================================================
// A fake query server
// ============================================================================

/** What one answer of the fake carries beside the ids, or a reply of its own, or no answer until the abort. */
type Fields = Record<string, unknown>;
type Reply = Fields | { readonly reply: NodeResponse } | "hang";

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly sql?: string;
  readonly queryId: string;
}

/** The shared transport's failure for an aborted signal, as `tests/helpers/databend-node-transport.ts` words it. */
function abortFailure(signal: AbortSignal): TransportError {
  const reason: unknown = signal.reason;
  return reason instanceof DOMException && reason.name === "TimeoutError"
    ? new TransportError("timeout", "The request did not finish within its time limit")
    : new TransportError("aborted", "The request was cancelled");
}

/**
 * The statements the surfaces send for the plain names this file uses, written out: `objects.test.ts` and
 * `introspect.test.ts` hold each surface to its text, and this file holds the provider to sending it.
 */
const DEMO = "FROM `default`.system.tables WHERE catalog = 'default' AND database = 'libredb_demo'";
const BASE_TABLES =
  "FROM default.system.tables WHERE catalog = 'default' AND table_type = 'BASE TABLE' AND database NOT IN ('system', 'information_schema')";
const SQL = {
  authType: `SELECT auth_type FROM default.system.users WHERE name = '${TEST_USER}'`,
  catalogs: "SELECT name AS catalog_name FROM system.catalogs ORDER BY name",
  databases: (catalog: string) =>
    `SELECT name AS database_name FROM \`${catalog}\`.system.databases WHERE catalog = '${catalog}' AND name NOT IN ('system', 'information_schema') ORDER BY name`,
  counts:
    "SELECT kind, count(*) AS object_count FROM (SELECT CASE table_type WHEN 'BASE TABLE' THEN 'table' WHEN 'VIEW' THEN 'view' WHEN 'MATERIALIZED VIEW' THEN 'materialized_view' WHEN 'DYNAMIC TABLE' THEN 'dynamic_table' ELSE concat('unknown:', table_type) END AS kind " +
    `${DEMO}) AS objects GROUP BY kind`,
  views: `SELECT name AS object_name, num_rows, data_compressed_size, comment ${DEMO} AND table_type = 'VIEW' ORDER BY name`,
  columns: (object: string) =>
    `SELECT name AS column_name, data_type, is_nullable, default_kind, default_expression, comment FROM \`default\`.system.columns WHERE database = 'libredb_demo' AND \`table\` = '${object}'`,
  materializedSource: (object: string) => `SHOW CREATE MATERIALIZED VIEW \`default\`.\`libredb_demo\`.\`${object}\``,
  overviewVersion: "SELECT version() AS server_version",
  overviewTables: `SELECT count(*) AS table_count, sum(data_compressed_size) AS compressed_bytes, sum(index_size) AS index_bytes ${BASE_TABLES}`,
  activeQueries:
    "SELECT current_query_id AS query_id, count(*) OVER () AS running FROM default.system.processes WHERE command = 'Query' ORDER BY created_time DESC LIMIT 500",
  indexCount: "SELECT count(*) AS index_count FROM default.system.indexes",
  tableStats: (database: string) =>
    `SELECT database AS schema_name, name AS table_name, num_rows, data_compressed_size, index_size ${BASE_TABLES} AND database = '${database}' ORDER BY data_compressed_size DESC`,
  indexStats:
    "SELECT database AS schema_name, `table` AS table_name, name AS index_name, `type` AS index_type, definition FROM default.system.indexes ORDER BY database, `table`, name",
  storage: `SELECT database AS database_name, sum(data_compressed_size) AS compressed_bytes, sum(index_size) AS index_bytes ${BASE_TABLES} GROUP BY database ORDER BY database`,
  kill: (pid: string) => `KILL QUERY '${pid}'`,
};

const EMPTY_OK: NodeResponse = { status: 200, contentType: "application/json", retryAfter: null, text: "{}" };

const column = (name: string, type = "String") => ({ name, type });

/** The answers a connect reads: the probe, the `auth_type` caution, and the default catalog's databases. */
function connectAnswer(sql: string): Reply | undefined {
  if (sql === DATABEND_VERSION_SQL) return { schema: [column("server_version")], data: [["v1.2.951-nightly"]] };
  if (sql === SQL.authType) return { schema: [column("auth_type")], data: [["sha256_password"]] };
  if (sql === SQL.databases("default")) {
    return { schema: [column("database_name")], data: [["default"], ["libredb_demo"]] };
  }
  return undefined;
}

interface FakeServer {
  readonly factory: (options: NodeTransportOptions) => NodeTransport;
  readonly requests: Seen[];
  /** What happened, in order: every request as `METHOD path`, and every hang an abort ended as `aborted path`. */
  readonly events: string[];
  /** Statement POSTs whose answer has not arrived yet, and the most there ever were at once. */
  inflight: number;
  maxInflight: number;
  built: number;
  sqls(): string[];
}

/**
 * `answer` decides each statement POST by its text (the connect reads answer as above unless it says otherwise);
 * `page` decides each page GET, which hangs by default. A ROLLBACK answers that the transaction ended; a kill, a final
 * and a logout answer 200 unless `close` says otherwise, later when it answers a promise, or never when it hangs.
 */
function fakeDatabend({
  answer = () => ({}),
  page = () => "hang",
  close = () => EMPTY_OK,
  rollback = { txn_state: "AutoCommit" },
}: {
  readonly answer?: (sql: string) => Reply | Promise<Reply>;
  readonly page?: (path: string, queryId: string) => Reply | Promise<Reply>;
  readonly close?: (path: string) => NodeResponse | Promise<NodeResponse> | "hang";
  /** The session fields a ROLLBACK answers with. */
  readonly rollback?: Fields;
} = {}): FakeServer {
  const server: FakeServer = {
    factory: (options) => {
      server.built += 1;
      return {
        async request(request: NodeRequest): Promise<NodeResponse> {
          if (request.signal.aborted) throw abortFailure(request.signal);
          const path = new URL(request.url).pathname;
          const headers = { ...options.headers, ...request.headers };
          const sql = request.body === undefined ? undefined : (JSON.parse(request.body) as { sql?: string }).sql;
          const ids = wireIds(headers);
          server.requests.push({
            method: request.method,
            path,
            ...(sql === undefined ? {} : { sql }),
            queryId: ids.queryId,
          });
          server.events.push(`${request.method} ${path}`);
          const queryId = path.split("/")[3] ?? ids.queryId;
          let decided: Reply | Promise<Reply>;
          if (request.method === "POST" && path === "/v1/query" && sql === "ROLLBACK") {
            decided = { session: { ...(answerBody({}).session as Fields), ...rollback } };
          } else if (request.method === "POST" && path === "/v1/query") {
            decided = answer(sql as string);
          } else if (path.includes("/page/")) {
            decided = page(path, queryId);
          } else {
            const closed = close(path);
            decided = closed === "hang" ? closed : Promise.resolve(closed).then((reply) => ({ reply }));
          }
          const statement = request.method === "POST";
          if (statement) {
            server.inflight += 1;
            server.maxInflight = Math.max(server.maxInflight, server.inflight);
          }
          let abort = () => {};
          const aborted = new Promise<never>((_resolve, reject) => {
            abort = () => {
              server.events.push(`aborted ${path}`);
              reject(abortFailure(request.signal));
            };
            request.signal.addEventListener("abort", abort, { once: true });
          });
          // A request that is answered never reads the abort's rejection.
          aborted.catch(() => {});
          try {
            const reply = await Promise.race([Promise.resolve(decided), aborted]);
            if (reply === "hang") return await aborted;
            // `Fields` is any record, so the narrowing cannot tell a reply of its own from fields named `reply`.
            if ("reply" in reply) return (reply as { readonly reply: NodeResponse }).reply;
            const body = answerBody({ id: queryId, session_id: ids.sessionId, ...reply });
            // The placeholders `PAGE` and `FINAL` stand for this statement's own links.
            if (body.next_uri === "PAGE") body.next_uri = `/v1/query/${queryId}/page/1`;
            if (body.next_uri === "FINAL") body.next_uri = `/v1/query/${queryId}/final`;
            return { status: 200, contentType: "application/json", retryAfter: null, text: JSON.stringify(body) };
          } finally {
            request.signal.removeEventListener("abort", abort);
            if (statement) server.inflight -= 1;
          }
        },
        close() {},
      };
    },
    requests: [],
    events: [],
    inflight: 0,
    maxInflight: 0,
    built: 0,
    sqls: () => server.requests.flatMap((request) => (request.sql === undefined ? [] : [request.sql])),
  };
  return server;
}

/** The rows of each page Studio asks for (`max_rows_per_page`), which a page of Databend never exceeds. */
const PAGE_ROWS = 10_000;

/**
 * One statement's rows as Databend sends them: at most a page in each answer, the first in the POST's answer and each
 * next one at the page its link names, the last pointing at the final link. `first` is the POST's answer, `page` the
 * fake's page reply.
 */
function paged(schema: readonly unknown[], rows: readonly unknown[][]) {
  const pages = Math.ceil(rows.length / PAGE_ROWS);
  const slice = (n: number) => rows.slice(n * PAGE_ROWS, (n + 1) * PAGE_ROWS);
  return {
    first: { schema, data: slice(0), next_uri: pages > 1 ? "PAGE" : "FINAL" } as Fields,
    page: (path: string, queryId: string): Reply => {
      const n = Number(path.split("/").at(-1));
      const next = n + 1 < pages ? `/v1/query/${queryId}/page/${n + 1}` : `/v1/query/${queryId}/final`;
      return { schema, data: slice(n), next_uri: next };
    },
  };
}

/** A fake whose statements answer `answers` first and the connect reads otherwise. */
function withConnect(answers: (sql: string) => Reply | Promise<Reply> | undefined = () => undefined) {
  return (sql: string): Reply | Promise<Reply> => answers(sql) ?? connectAnswer(sql) ?? {};
}

const opened: { readonly provider: DatabendProvider; readonly time: ReturnType<typeof transportDeps> }[] = [];

afterEach(async () => {
  await Promise.allSettled(
    opened.splice(0).map(({ provider, time }) => {
      const closing = provider.disconnect();
      // A close a failed test left unanswered ends on its own budget, so the disconnect cannot hang.
      time.fire(5_000);
      return closing;
    }),
  );
});

/** A provider over `fake` with injected time; `overrides` go onto the loopback test connection. */
function build(fake: FakeServer, overrides: Record<string, unknown> = {}, queryTimeout = 60_000) {
  const time = transportDeps(scriptedNodeTransport());
  const provider = new DatabendProvider(
    testConnection(overrides),
    { queryTimeout },
    { ...time.deps, createNodeTransport: fake.factory },
  );
  opened.push({ provider, time });
  return { provider, time };
}

/** Yields to the event loop until `ready()` holds; a real zero-length wait, never a deadline. */
async function until(ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 500 && !ready(); turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each turn yields once, then reads the condition again.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(ready()).toBe(true);
}

/** A promise a test settles later. */
function gate<T = Reply>() {
  let open: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** The 200 answer of an in-body statement error. */
function failed(code: number, message: string): Fields {
  return { state: "Failed", error: { code, message, detail: null }, schema: [], data: [] };
}

// ============================================================================
// Construction and declarations (design 2.3, 2.4)
// ============================================================================

describe("construction and declarations", () => {
  test("the constructor never dials or throws; the connection's refusals come from connect(), before any socket", async () => {
    const fake = fakeDatabend();
    const { provider } = build(fake, { user: undefined, warehouse: "not a warehouse!" });
    expect(provider.isConnected()).toBe(false);
    expect(provider.getCapabilities().defaultPort).toBe(8000);
    const failure = await provider.connect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DatabaseConfigError);
    expect((failure as Error).message).toContain("User is required");
    expect(fake.built).toBe(0);
    expect(fake.requests).toEqual([]);
  });

  test("getCapabilities() is the literal of design 2.4", () => {
    const { provider } = build(fakeDatabend());
    expect(provider.getCapabilities()).toEqual({
      queryLanguage: "sql",
      supportsExplain: true,
      explainFormat: "databend-text",
      supportsExternalQueryLimiting: true,
      supportsResultPagination: true,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      supportsMaintenance: true,
      maintenanceOperations: ["kill"],
      maintenanceOperationSpecs: { kill: DATABEND_KILL_SPEC },
      supportsConnectionString: false,
      defaultPort: 8000,
      identifierQuoting: "backtick-always",
      schemaRefreshPattern: "^\\s*(CREATE|DROP|ALTER|RENAME|UNDROP|TRUNCATE|REPLACE)\\b",
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Database", labelPlural: "Databases" },
      ],
      containerPathShapes: "exact",
      objectKinds: [
        {
          id: "table",
          role: "relation",
          label: "Table",
          labelPlural: "Tables",
          hasSource: true,
          sourceLanguage: "sql",
          hasColumns: true,
        },
        {
          id: "view",
          role: "relation",
          label: "View",
          labelPlural: "Views",
          hasSource: true,
          sourceLanguage: "sql",
          hasColumns: true,
        },
        {
          id: "materialized_view",
          role: "relation",
          label: "Materialized View",
          labelPlural: "Materialized Views",
          hasSource: true,
          sourceLanguage: "sql",
          hasColumns: true,
        },
        {
          id: "dynamic_table",
          role: "relation",
          label: "Dynamic Table",
          labelPlural: "Dynamic Tables",
          hasSource: true,
          sourceLanguage: "sql",
          hasColumns: true,
        },
      ],
    });
    expect(provider.getCapabilities()).not.toHaveProperty("statementTerminator");
    expect(provider.getCapabilities()).not.toHaveProperty("resumesBilledCompute");
  });

  test("the schema refresh pattern matches a leading DDL word only", () => {
    const pattern = new RegExp(build(fakeDatabend()).provider.getCapabilities().schemaRefreshPattern, "i");
    for (const sql of [
      "CREATE TABLE t (a INT)",
      "  undrop table t",
      "RENAME TABLE a TO b",
      "replace into t values (1)",
    ]) {
      expect(pattern.test(sql)).toBe(true);
    }
    for (const sql of ["SELECT 'CREATE'", "INSERT INTO t SELECT * FROM created"]) expect(pattern.test(sql)).toBe(false);
  });

  test("resumesBilledCompute is declared when Warehouse is set, read before any connect", () => {
    expect(build(fakeDatabend(), { warehouse: "" }).provider.getCapabilities().resumesBilledCompute).toBeUndefined();
    expect(build(fakeDatabend(), { warehouse: null }).provider.getCapabilities().resumesBilledCompute).toBeUndefined();
    expect(build(fakeDatabend(), { warehouse: "wh-1" }).provider.getCapabilities().resumesBilledCompute).toBe(true);
  });

  test.each([
    ["the gateway host", "tn3ftqihs.gw.aws-us-east-2.default.databend.com"],
    ["an older host that names its warehouse", "tn3ftqihs--eric.gw.aws-us-east-2.default.databend.com"],
    ["a host in China", "tnf34b0rm--elt-wh-medium.gw.aliyun-cn-beijing.default.databend.cn"],
    ["a host in capitals, with a trailing dot", "TN3FTQIHS.GW.AWS-US-EAST-2.DEFAULT.DATABEND.COM."],
  ])("resumesBilledCompute is declared for a Databend Cloud host with Warehouse empty: %s", (_case, host) => {
    expect(build(fakeDatabend(), { host, warehouse: "" }).provider.getCapabilities().resumesBilledCompute).toBe(true);
  });

  test("a host only named like Databend Cloud's is not one, and a tunnel is judged by its far end", () => {
    for (const host of [
      "databend.com",
      "tn3ftqihs.gw.databend.com.example.net",
      "notdatabend.com",
      "localhost",
      8000,
    ]) {
      expect(build(fakeDatabend(), { host }).provider.getCapabilities().resumesBilledCompute, String(host)).toBe(
        undefined,
      );
    }
    const through = (farEnd: string) =>
      new DatabendProvider({
        ...testConnection({ host: "127.0.0.1", port: 40123 }),
        [TUNNEL_FAR_END]: { host: farEnd, port: 443 },
      } as DatabaseConnection).getCapabilities().resumesBilledCompute;
    expect(through("tn3ftqihs.gw.aws-us-east-2.default.databend.com")).toBe(true);
    expect(through("databend.internal")).toBeUndefined();
  });

  test("getLabels() answers a copy of the Databend labels", () => {
    const labels = build(fakeDatabend()).provider.getLabels();
    expect(labels).toEqual(DATABEND_LABELS);
    expect(labels).not.toBe(DATABEND_LABELS);
  });

  test("every call that needs a connection refuses before connect, sending nothing", async () => {
    const fake = fakeDatabend();
    const { provider } = build(fake);
    await expect(provider.query("SELECT 1")).rejects.toThrow();
    await expect(provider.listContainers()).rejects.toThrow();
    await expect(provider.getPerformanceMetrics()).rejects.toThrow();
    expect(provider.connectWarnings()).toEqual([]);
    expect(await provider.cancelQuery("q-1")).toBe(false);
    await provider.disconnect();
    expect(fake.built).toBe(0);
  });
});

// ============================================================================
// connect() (design 5.4, 6.4) [X07] [X12]
// ============================================================================

describe("connect", () => {
  test("runs the version probe, then the best-effort cautions, each under the surface deadline", async () => {
    const fake = fakeDatabend({ answer: withConnect() });
    const { provider, time } = build(fake, { database: "libredb_demo" });
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expect(fake.sqls()).toEqual([DATABEND_VERSION_SQL, SQL.databases("default"), SQL.authType]);
    expect(time.deadlines.filter((deadline) => deadline.ms === 10_000)).toHaveLength(3);
    expect(provider.connectWarnings()).toEqual([]);
  });

  test("names a database missing from the default catalog, never one of the two it generates", async () => {
    const missing = build(fakeDatabend({ answer: withConnect() }), { database: "nope" }).provider;
    await missing.connect();
    expect(missing.connectWarnings()).toEqual([{ message: DATABEND_PROVIDER_SENTENCES.databaseMissing("nope") }]);

    const generated = build(fakeDatabend({ answer: withConnect() }), { database: "system" }).provider;
    await generated.connect();
    expect(generated.connectWarnings()).toEqual([]);
  });

  test("a database read that fails is no caution and no failed connect", async () => {
    const answers = withConnect((sql) => (sql === SQL.databases("default") ? failed(1063, "denied") : undefined));
    const { provider } = build(fakeDatabend({ answer: answers }), { database: "libredb_demo" });
    await provider.connect();
    expect(provider.connectWarnings()).toEqual([]);
  });

  test("names a no_password user from the auth_type read, and omits it when that read fails [X12]", async () => {
    const noPassword = withConnect((sql) =>
      sql === SQL.authType ? { schema: [column("auth_type")], data: [["no_password"]] } : undefined,
    );
    const named = build(fakeDatabend({ answer: noPassword })).provider;
    await named.connect();
    expect(named.connectWarnings()).toEqual([{ message: DATABEND_OBJECT_SENTENCES.noPassword(TEST_USER) }]);

    const refused = withConnect((sql) => (sql === SQL.authType ? failed(1063, "Permission denied") : undefined));
    const quiet = build(fakeDatabend({ answer: refused })).provider;
    await quiet.connect();
    expect(quiet.isConnected()).toBe(true);
    expect(quiet.connectWarnings()).toEqual([]);
  });

  test("an unverified TLS certificate with a password is a caution; without a password it is none", async () => {
    const withPassword = build(fakeDatabend({ answer: withConnect() }), { ssl: { mode: "require" } }).provider;
    await withPassword.connect();
    expect(withPassword.connectWarnings()).toEqual([{ message: DATABEND_PROVIDER_SENTENCES.unverifiedTls }]);

    const without = build(fakeDatabend({ answer: withConnect() }), {
      ssl: { mode: "require" },
      password: undefined,
    }).provider;
    await without.connect();
    expect(without.connectWarnings()).toEqual([]);
  });

  test("a refused probe is the house class, and the provider stays unconnected", async () => {
    const refusal: NodeResponse = {
      status: 401,
      contentType: "application/json",
      retryAfter: null,
      text: JSON.stringify({ error: { code: 5100, message: "wrong password" } }),
    };
    const fake = fakeDatabend({ answer: () => ({ reply: refusal }) });
    const { provider } = build(fake);
    const failure = await provider.connect().catch((error: unknown) => error);
    expect((failure as Error).name).toBe("AuthenticationError");
    expect((failure as Error).message).toContain(DATABEND_ERROR_SENTENCES.signInRefused);
    expect(provider.isConnected()).toBe(false);
    expect(fake.sqls()).toEqual([DATABEND_VERSION_SQL]);
  });

  test("with Warehouse set, a probe outlasting Test Connection's 10 s gives the resuming sentence [X07]", async () => {
    const fake = fakeDatabend({ answer: () => "hang" });
    const { provider, time } = build(fake, { warehouse: "wh-1" }, 10_000);
    const connecting = provider.connect().catch((error: unknown) => error);
    await until(() => fake.requests.length === 1);
    time.fire(10_000);
    const failure = await connecting;
    // A ConnectionError, so Test Connection shows the sentence itself (GAP-CL-1).
    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as Error).message).toBe(DATABEND_ERROR_SENTENCES.resuming("wh-1", "10"));
    expect(provider.isConnected()).toBe(false);
  });

  test("an older Cloud host names its warehouse in the resuming sentence, and only Warehouse is sent as the header", async () => {
    const cloud = {
      host: "tn3ftqihs--eric.gw.aws-us-east-2.default.databend.com",
      port: 443,
      ssl: { mode: "verify-system" },
    };
    const probe = async (overrides: Record<string, unknown>) => {
      const fake = fakeDatabend({ answer: () => "hang" });
      const headers: Partial<Record<string, string>>[] = [];
      const watched: FakeServer = {
        ...fake,
        factory: (options) => {
          headers.push({ ...options.headers });
          return fake.factory(options);
        },
      };
      const { provider, time } = build(watched, { ...cloud, ...overrides }, 10_000);
      const connecting = provider.connect().catch((error: unknown) => error);
      await until(() => fake.requests.length === 1);
      time.fire(10_000);
      const failure = await connecting;
      expect(headers).toHaveLength(1);
      return {
        name: (failure as Error).name,
        message: (failure as Error).message,
        header: headers[0]["x-databend-warehouse"],
      };
    };
    expect(await probe({})).toEqual({
      name: "ConnectionError",
      message: DATABEND_ERROR_SENTENCES.resuming("eric", "10"),
      header: undefined,
    });
    expect(await probe({ warehouse: "wh-1" })).toEqual({
      name: "ConnectionError",
      message: DATABEND_ERROR_SENTENCES.resuming("wh-1", "10"),
      header: "wh-1",
    });
    // The gateway host carries no warehouse, so nothing is named: its own refusal asks for Warehouse (section 4.4).
    expect(await probe({ host: "tn3ftqihs.gw.aws-us-east-2.default.databend.com" })).toEqual({
      name: "TimeoutError",
      message: DATABEND_ERROR_SENTENCES.deadline("10"),
      header: undefined,
    });
  });

  test("a second connect replaces the first session and closes it", async () => {
    const fake = fakeDatabend({ answer: withConnect() });
    const { provider } = build(fake);
    await provider.connect();
    await provider.connect();
    expect(fake.built).toBe(2);
    expect(provider.isConnected()).toBe(true);
  });
});

// ============================================================================
// query() (design 2.3, 3.7, section 4)
// ============================================================================

describe("query", () => {
  async function connected(
    answers?: (sql: string) => Reply | Promise<Reply> | undefined,
    overrides = {},
    page?: (path: string, queryId: string) => Reply | Promise<Reply>,
  ) {
    const fake = fakeDatabend({ answer: withConnect(answers), ...(page === undefined ? {} : { page }) });
    const built = build(fake, overrides);
    await built.provider.connect();
    return { fake, ...built, sent: () => fake.requests.length };
  }

  test("the statement guard refuses before any socket", async () => {
    const { provider, sent } = await connected();
    const before = sent();
    const failure = await provider.query("SELECT 1; SELECT 2").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as Error).message).toBe(DATABEND_MULTIPLE_STATEMENTS);
    expect(sent()).toBe(before);
  });

  test("bound parameters are refused before any socket; an empty list binds nothing", async () => {
    const { provider, sent } = await connected();
    const before = sent();
    await expect(provider.query("SELECT ?", [1])).rejects.toThrow(DATABEND_PROVIDER_SENTENCES.params);
    expect(sent()).toBe(before);
    expect((await provider.query("SELECT 1", [])).rowCount).toBe(0);
  });

  test("decodes rows by the declared types, keeping them in columnTypes", async () => {
    const { provider } = await connected((sql) =>
      sql === "SELECT n, b FROM t"
        ? {
            schema: [column("n", "Nullable(Int32)"), column("b", "Boolean")],
            data: [
              ["1", "1"],
              [null, "0"],
            ],
          }
        : undefined,
    );
    const result = await provider.query("SELECT n, b FROM t");
    expect(result.fields).toEqual(["n", "b"]);
    expect(result.rows).toEqual([
      { n: 1, b: true },
      { n: null, b: false },
    ]);
    expect(result.rowCount).toBe(2);
    expect(result.columnTypes).toEqual({ n: "Nullable(Int32)", b: "Boolean" });
    expect(result).not.toHaveProperty("warnings");
    expect(result).not.toHaveProperty("pagination");
    expect(typeof result.executionTime).toBe("number");
  });

  test("a DML count row is kept and its count is the rowCount, as trino/index.ts reports it", async () => {
    const { provider } = await connected(() => ({
      schema: [column("number of rows inserted", "UInt64")],
      data: [["3"]],
    }));
    const result = await provider.query("INSERT INTO t VALUES (1), (2), (3)");
    expect(result.rows).toEqual([{ "number of rows inserted": 3 }]);
    expect(result.rowCount).toBe(3);
  });

  test("a statement with no result set answers no field, no row and no column type", async () => {
    const { provider } = await connected(() => ({ has_result_set: false }));
    const result = await provider.query("CREATE TABLE t (a INT)");
    expect(result.fields).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result).not.toHaveProperty("columnTypes");
  });

  const session = (fields: Fields) => ({ session: { ...(answerBody({}).session as Fields), ...fields } });

  test.each([
    ["USE", { affect: { type: "UseDB", name: "other" } }, [USE_NOT_CARRIED]],
    [
      "SET and SET GLOBAL",
      { affect: { type: "ChangeSettings", keys: ["a", "b"], values: ["1", "2"], is_globals: [false, true] } },
      [SETTINGS_NOT_CARRIED, globalSettingsChangedWarning(["b"])],
    ],
    ["SET ROLE", session({ role: "public" }), [ROLE_NOT_CARRIED]],
    ["BEGIN, rolled back", session({ txn_state: "Active" }), [TRANSACTION_ENDED]],
    ["a temporary table", session({ need_keep_alive: true }), [TEMP_TABLES_DROPPED]],
    ["a server warning", { warnings: ["setting x is ignored"] }, ["setting x is ignored"]],
    [
      "another result mode",
      session({ settings: { http_json_result_mode: "json" } }),
      [DATABEND_ANSWER_SENTENCES.resultMode("json")],
    ],
  ])("%s becomes the session.ts or answer.ts sentence as a warning", async (_name, fields, messages) => {
    const { provider } = await connected((sql) => (sql === "SELECT 1" ? fields : undefined));
    const result = await provider.query("SELECT 1");
    expect(result.warnings).toEqual(messages.map((message) => ({ message })));
  });

  test("a ROLLBACK that does not end the transaction, and a logout that fails, are warnings too", async () => {
    const fake = fakeDatabend({
      answer: withConnect((sql) =>
        sql === "SELECT 1" ? session({ txn_state: "Active", need_keep_alive: true }) : undefined,
      ),
      rollback: { txn_state: "Active", need_keep_alive: true },
      close: (path) => (path === "/v1/session/logout" ? { ...EMPTY_OK, status: 404 } : EMPTY_OK),
    });
    const { provider } = build(fake);
    await provider.connect();
    const result = await provider.query("SELECT 1");
    expect(result.warnings).toEqual([
      { message: TRANSACTION_MAY_STAY_OPEN },
      { message: DATABEND_PROVIDER_SENTENCES.closeRefused("logout") },
    ]);
  });

  test("warnings past the first 100 different ones are one warning that counts them (F4)", async () => {
    const warnings = Array.from({ length: 103 }, (_, n) => `w${n}`);
    const { provider } = await connected((sql) => (sql === "SELECT 1" ? { warnings } : undefined));
    const result = await provider.query("SELECT 1");
    expect(result.warnings).toEqual([
      ...warnings.slice(0, 100).map((message) => ({ message })),
      { message: DATABEND_PROVIDER_SENTENCES.warningsLeftOut(3) },
    ]);
    expect(DATABEND_PROVIDER_SENTENCES.warningsLeftOut(3)).toBe(
      "Studio shows the first 100 different warnings of this statement and left out the 3 more that Databend sent past them, repeats included.",
    );
  });

  test("a sign-in refused on the final leaves the logout unsent, and says so rather than that it went unanswered", async () => {
    const refused: NodeResponse = {
      status: 401,
      contentType: "application/json",
      retryAfter: null,
      text: JSON.stringify({ error: { code: 5100, message: "Authentication failed: incorrect password" } }),
    };
    const fake = fakeDatabend({
      answer: withConnect((sql) =>
        sql === "SELECT 1" ? { ...session({ need_keep_alive: true }), next_uri: "FINAL" } : undefined,
      ),
      close: (path) => (path.endsWith("/final") ? refused : EMPTY_OK),
    });
    const { provider } = build(fake);
    await provider.connect();
    const result = await provider.query("SELECT 1");
    expect(result.warnings).toEqual([
      { message: DATABEND_PROVIDER_SENTENCES.closeRefused("final") },
      { message: DATABEND_PROVIDER_SENTENCES.closeSkipped("logout") },
    ]);
    expect(DATABEND_PROVIDER_SENTENCES.closeRefused("final")).toBe(
      "The statement finished, but Studio's request to close the finished statement (final) was answered with an error.",
    );
    expect(fake.events.filter((event) => event.endsWith("/v1/session/logout"))).toEqual([]);
    expect(DATABEND_PROVIDER_SENTENCES.closeSkipped("logout")).toBe(
      "The statement finished, but Databend then refused the sign-in, so Studio did not send its request to end its session (logout), or any further request for this statement.",
    );
  });

  test("a result cut at the statement budget is marked on pagination and warned about", async () => {
    const width = 5;
    const rows = Array.from({ length: 50_001 }, () => Array.from({ length: width }, () => "1"));
    const wide = paged(
      Array.from({ length: width }, (_, index) => column(`c${index}`, "Int32")),
      rows,
    );
    const { provider } = await connected(
      (sql) => (sql === "SELECT * FROM wide" ? wide.first : undefined),
      {},
      wide.page,
    );
    const result = await provider.query("SELECT * FROM wide");
    expect(result.rows).toHaveLength(50_000);
    expect(result.pagination).toEqual({
      limit: MAX_UNLIMITED_ROWS,
      offset: 0,
      hasMore: false,
      totalReturned: 50_000,
      wasLimited: true,
    });
    expect(result.warnings).toEqual([
      { message: DATABEND_PROVIDER_SENTENCES.resultCut({ bound: "cells", limit: 250_000 }) },
    ]);
  });

  test("an in-body statement error is a QueryError carrying the statement", async () => {
    const { provider } = await connected((sql) =>
      sql === "SELECT nope" ? failed(1065, "error: no column nope\n--> SQL:1:8") : undefined,
    );
    const failure = (await provider.query("SELECT nope").catch((error: unknown) => error)) as QueryError;
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure.message).toContain("no column nope");
    expect(failure.query).toBe("SELECT nope");
    expect(failure.position).toBe(8);
  });

  test("cancelQuery answers false for an unknown id and sends nothing", async () => {
    const { provider, sent } = await connected();
    const before = sent();
    expect(await provider.cancelQuery("q-unknown")).toBe(false);
    expect(sent()).toBe(before);
  });

  test("cancelQuery stops a running statement: its kill is sent and the run is cancelled", async () => {
    const { provider, fake } = await connected((sql) =>
      sql === "SELECT sleep(9)" ? { state: "Running", next_uri: "PAGE" } : undefined,
    );
    const running = provider.query("SELECT sleep(9)", undefined, "q-1").catch((error: unknown) => error);
    await until(() => pagesOpened(fake) === 1);
    expect(await provider.cancelQuery("q-1")).toBe(true);
    expect(await running).toBeInstanceOf(QueryCancelledError);
    expect(fake.events.some((event) => /^GET \/v1\/query\/\w+\/kill$/.test(event))).toBe(true);
  });
});

// ============================================================================
// cancelQuery() answers what Databend did with the kill (design 3.10) [X02]
// ============================================================================

describe("cancelQuery answers true only for a run that ended cancelled", () => {
  const KILL = /^GET \/v1\/query\/\w+\/kill$/;

  /** A connected provider running `SELECT sleep(9)` under `q-1`, its first answer read and its page held open. */
  async function running(close: (path: string) => NodeResponse | Promise<NodeResponse> | "hang" = () => EMPTY_OK) {
    const fake = fakeDatabend({
      answer: withConnect((sql) => (sql === "SELECT sleep(9)" ? { state: "Running", next_uri: "PAGE" } : undefined)),
      close,
    });
    const built = build(fake);
    await built.provider.connect();
    const run = built.provider.query("SELECT sleep(9)", undefined, "q-1").catch((error: unknown) => error);
    await until(() => pagesOpened(fake) === 1);
    return { fake, ...built, run };
  }

  /** The cancel's answer as it settles, read without waiting for it. */
  function watch(cancel: Promise<boolean>): { answer(): boolean | undefined } {
    let answered: boolean | undefined;
    void cancel.then((value) => {
      answered = value;
    });
    return { answer: () => answered };
  }

  test("a kill Databend acknowledges answers true, and only once the run has ended cancelled", async () => {
    const kill = gate<NodeResponse>();
    const { provider, fake, run } = await running((path) => (path.endsWith("/kill") ? kill.promise : EMPTY_OK));
    const cancelling = provider.cancelQuery("q-1");
    const cancel = watch(cancelling);
    await until(() => fake.events.some((event) => KILL.test(event)));
    await settle();
    expect(cancel.answer()).toBeUndefined();
    kill.open(EMPTY_OK);
    expect(await cancelling).toBe(true);
    expect(await run).toBeInstanceOf(QueryCancelledError);
  });

  test("a kill that gets no answer within its 5 s answers false: the statement may still finish", async () => {
    const { provider, fake, time, run } = await running((path) => (path.endsWith("/kill") ? "hang" : EMPTY_OK));
    const cancelling = provider.cancelQuery("q-1");
    const cancel = watch(cancelling);
    await until(() => fake.events.some((event) => KILL.test(event)));
    await settle();
    expect(cancel.answer()).toBeUndefined();
    time.fire(5_000);
    expect(await cancelling).toBe(false);
    const outcome = (await run) as Error;
    expect(outcome).toBeInstanceOf(ConnectionError);
    expect(outcome.message).toBe(DATABEND_ERROR_SENTENCES.cancelUnanswered);
  });

  const REFUSALS: readonly (readonly [string, NodeResponse])[] = [
    [
      "an HTTP 404 for a query id the node does not know",
      { status: 404, contentType: "text/plain", retryAfter: null, text: "Query ID q not found on node n" },
    ],
    [
      "a gateway's refusal over HTTP 200",
      {
        status: 200,
        contentType: "application/json",
        retryAfter: null,
        text: JSON.stringify({ error: { kind: "ForbiddenAccessUser", message: "Permission denied" } }),
      },
    ],
  ];

  test.each(REFUSALS)("a kill Databend refuses answers false: %s", async (_case, refusal) => {
    const { provider, run } = await running((path) => (path.endsWith("/kill") ? refusal : EMPTY_OK));
    expect(await provider.cancelQuery("q-1")).toBe(false);
    const outcome = (await run) as Error;
    expect(outcome).toBeInstanceOf(ConnectionError);
    expect(outcome.message).toBe(DATABEND_ERROR_SENTENCES.cancelUnanswered);
  });

  test("a run that ended before the cancel answers false and sends nothing", async () => {
    const fake = fakeDatabend({ answer: withConnect() });
    const { provider } = build(fake);
    await provider.connect();
    await provider.query("SELECT 1", undefined, "q-1");
    const before = fake.requests.length;
    expect(await provider.cancelQuery("q-1")).toBe(false);
    expect(fake.requests).toHaveLength(before);
  });

  test("a run whose statement finished while its final is still out answers false once it ends", async () => {
    const final = gate<NodeResponse>();
    const fake = fakeDatabend({
      answer: withConnect((sql) =>
        sql === "SELECT 2" ? { schema: [column("n", "UInt8")], data: [["2"]], next_uri: "FINAL" } : undefined,
      ),
      close: (path) => (path.endsWith("/final") ? final.promise : EMPTY_OK),
    });
    const { provider } = build(fake);
    await provider.connect();
    const run = provider.query("SELECT 2", undefined, "q-1");
    await until(() => fake.requests.some((request) => request.path.endsWith("/final")));
    const cancelling = provider.cancelQuery("q-1");
    const cancel = watch(cancelling);
    await settle();
    expect(cancel.answer()).toBeUndefined();
    final.open(EMPTY_OK);
    expect(await cancelling).toBe(false);
    expect((await run).rows).toEqual([{ n: 2 }]);
    expect(fake.events.some((event) => KILL.test(event))).toBe(false);
  });

  test("a run still closing past its kill, ROLLBACK and logout budgets answers false at 15 s", async () => {
    const { provider, fake, time, run } = await running((path) => (path.endsWith("/kill") ? "hang" : EMPTY_OK));
    const cancelling = provider.cancelQuery("q-1");
    await until(() => fake.events.some((event) => KILL.test(event)));
    expect(time.deadlines.filter((deadline) => deadline.ms === 15_000)).toHaveLength(1);
    time.fire(15_000);
    expect(await cancelling).toBe(false);
    // The run itself still ends on its own kill's budget.
    time.fire(5_000);
    expect(await run).toBeInstanceOf(ConnectionError);
  });

  test("a run stopped while it waits for a permit answers true: nothing was sent", async () => {
    const fake = fakeDatabend({ answer: withConnect((sql) => (sql === SQL.catalogs ? "hang" : undefined)) });
    const { provider } = build(fake);
    await provider.connect();
    const holding = [provider.listContainers(), provider.listContainers()].map((call) =>
      call.catch((error: unknown) => error),
    );
    await until(() => fake.inflight === 2);
    const queued = provider.query("SELECT 3", undefined, "q-3").catch((error: unknown) => error);
    await settle();
    expect(await provider.cancelQuery("q-3")).toBe(true);
    expect(await queued).toBeInstanceOf(QueryCancelledError);
    expect(fake.sqls()).not.toContain("SELECT 3");
    await provider.disconnect();
    await Promise.all(holding);
  });
});

/** The page GETs the fake has received. */
function pagesOpened(fake: FakeServer): number {
  return fake.requests.filter((request) => request.path.includes("/page/")).length;
}

/** The index in `fake.requests` of the first request `matches` accepts, or -1. */
function requestAt(fake: FakeServer, matches: (request: Seen) => boolean): number {
  return fake.requests.findIndex(matches);
}

/** A few turns of the event loop, for a call that must NOT have sent anything yet. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- the turns run one after another, which is the point.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ============================================================================
// The limiter (design 2.3, 3.12) [X04] [X16]
// ============================================================================

describe("the limiter over every statement", () => {
  test("eight concurrent surface calls on two instances never have more than two statements in flight [X04]", async () => {
    const held: Array<() => void> = [];
    const answers = withConnect((sql) => {
      if (sql !== SQL.catalogs) return undefined;
      const wait = gate();
      held.push(() => wait.open({ schema: [column("catalog_name")], data: [["default"]] }));
      return wait.promise;
    });
    const fake = fakeDatabend({ answer: answers });
    const first = build(fake).provider;
    const second = build(fake).provider;
    await first.connect();
    await second.connect();
    fake.maxInflight = 0;

    const calls = [first, second].flatMap((provider) => [1, 2, 3, 4].map(() => provider.listContainers()));
    for (let released = 0; released < 8; released += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one statement is released at a time, after the bound is read.
      await until(() => held.length > 0);
      expect(fake.inflight).toBeLessThanOrEqual(2);
      (held.shift() as () => void)();
    }
    const answered = await Promise.all(calls);
    expect(answered.every((containers) => containers[0].name === "default")).toBe(true);
    expect(fake.maxInflight).toBe(2);
  });

  test("a final, a ROLLBACK, a logout and a kill take no permit while both are held and calls wait [X04]", async () => {
    const open = { ...(answerBody({}).session as Fields), txn_state: "Active", need_keep_alive: true };
    const pages = new Map<string, (reply: Reply) => void>();
    const fake = fakeDatabend({
      answer: withConnect((sql) =>
        sql.startsWith("SELECT sleep") ? { state: "Running", next_uri: "PAGE", session: open } : undefined,
      ),
      page: (_path, queryId) => {
        const wait = gate();
        pages.set(queryId, wait.open);
        return wait.promise;
      },
      rollback: { txn_state: "AutoCommit", need_keep_alive: true },
    });
    const { provider } = build(fake);
    await provider.connect();
    const one = provider.query("SELECT sleep(1)", undefined, "q-1").catch((error: unknown) => error);
    const two = provider.query("SELECT sleep(2)", undefined, "q-2").catch((error: unknown) => error);
    await until(() => pages.size === 2);
    const three = provider.query("SELECT sleep(3)", undefined, "q-3").catch((error: unknown) => error);
    await settle();
    expect(fake.sqls()).not.toContain("SELECT sleep(3)");

    // The first statement fails on its page: the server ended it, so its final, ROLLBACK and logout go out before
    // the waiting statement gets the permit it frees.
    const [firstId, secondId] = [...pages.keys()];
    (pages.get(firstId) as (reply: Reply) => void)({
      ...failed(1006, "division by zero"),
      next_uri: "FINAL",
      session: open,
    });
    expect(await one).toBeInstanceOf(QueryError);
    await until(() => fake.sqls().includes("SELECT sleep(3)"));
    const third = requestAt(fake, (request) => request.sql === "SELECT sleep(3)");
    const final = requestAt(fake, (request) => request.path === `/v1/query/${firstId}/final`);
    const rollback = requestAt(fake, (request) => request.sql === "ROLLBACK");
    const logout = requestAt(fake, (request) => request.path === "/v1/session/logout");
    expect(final).toBeGreaterThan(-1);
    expect(rollback).toBeGreaterThan(final);
    expect(logout).toBeGreaterThan(rollback);
    expect(third).toBeGreaterThan(logout);

    // Two and three hold the permits and four waits: the cancel's kill still goes out before four is sent.
    const four = provider.query("SELECT sleep(4)", undefined, "q-4").catch((error: unknown) => error);
    await settle();
    expect(await provider.cancelQuery("q-2")).toBe(true);
    expect(await two).toBeInstanceOf(QueryCancelledError);
    await until(() => fake.sqls().includes("SELECT sleep(4)"));
    const kill = requestAt(fake, (request) => request.path === `/v1/query/${secondId}/kill`);
    expect(kill).toBeGreaterThan(third);
    expect(requestAt(fake, (request) => request.sql === "SELECT sleep(4)")).toBeGreaterThan(kill);
    await provider.disconnect();
    expect(await three).toBeInstanceOf(QueryCancelledError);
    expect(await four).toBeInstanceOf(QueryCancelledError);
  });

  test("a full queue refuses at once and sends nothing [X04]", async () => {
    const fake = fakeDatabend({ answer: withConnect((sql) => (sql === "SELECT 1" ? "hang" : undefined)) });
    const { provider } = build(fake);
    await provider.connect();
    const holding = [provider.query("SELECT 1"), provider.query("SELECT 1")].map((run) =>
      run.catch((error: unknown) => error),
    );
    await until(() => fake.inflight === 2);
    const queued = Array.from({ length: 64 }, () => provider.query("SELECT 2").catch((error: unknown) => error));
    const before = fake.requests.length;
    const refused = await provider.query("SELECT 3").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(LimiterFullError);
    expect((refused as Error).message).toContain("64 calls waiting for its 2 in-flight slots");
    expect(fake.requests.length).toBe(before);

    await provider.disconnect();
    for (const outcome of await Promise.all(queued)) expect(outcome).toBeInstanceOf(QueryCancelledError);
    await Promise.all(holding);
    expect(fake.sqls()).not.toContain("SELECT 2");
  });

  test("a statement queued behind two permits expires on the injected deadline, unsent [X16]", async () => {
    const fake = fakeDatabend({
      answer: withConnect((sql) => (sql === SQL.catalogs ? "hang" : undefined)),
    });
    const { provider, time } = build(fake);
    await provider.connect();
    const holding = [provider.listContainers(), provider.listContainers()].map((call) =>
      call.catch((error: unknown) => error),
    );
    await until(() => fake.inflight === 2);
    const queued = provider.query("SELECT 1").catch((error: unknown) => error);
    await until(() => time.deadlines.some((deadline) => deadline.ms === 60_000));
    time.fire(60_000);
    const failure = await queued;
    // Nothing was sent, so this is no statement's timeout: a ConnectionError, whose sentence a route shows (GAP-CL-1).
    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as Error).message).toBe(DATABEND_PROVIDER_SENTENCES.slotsBusy("60"));
    expect(fake.sqls()).not.toContain("SELECT 1");
    await provider.disconnect();
    await Promise.all(holding);
  });

  test("with Warehouse set, a surface read queued past its deadline is not the resuming sentence [X07] [X16]", async () => {
    const fake = fakeDatabend({
      answer: withConnect((sql) => (sql === SQL.catalogs ? "hang" : undefined)),
    });
    const { provider, time } = build(fake, { warehouse: "wh-1" });
    await provider.connect();
    const holding = [provider.listContainers(), provider.listContainers()].map((call) =>
      call.catch((error: unknown) => error),
    );
    await until(() => fake.inflight === 2);
    const budgets = time.deadlines.length;
    const queued = provider.listContainers().catch((error: unknown) => error);
    await until(() => time.deadlines.length === budgets + 1);
    // The holding reads were sent, so theirs is the resuming sentence; the queued one sent nothing.
    time.fire(10_000);
    const failure = await queued;
    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as Error).message).toBe(DATABEND_PROVIDER_SENTENCES.slotsBusy("10"));
    // The two sent reads are killed; the queued third never posts.
    expect(fake.sqls().filter((sql) => sql === SQL.catalogs)).toHaveLength(2);
    for (const held of await Promise.all(holding)) {
      expect(held).toBeInstanceOf(ConnectionError);
      expect((held as Error).message).toBe(DATABEND_ERROR_SENTENCES.resuming("wh-1", "10"));
    }
  });
});

// ============================================================================
// What a route answers for a read that ran out of time (GAP-CL-1) [X07]
// ============================================================================

describe("a route shows the resuming and slot-wait sentences as they are", () => {
  let quiet: { mockRestore(): void }[] = [];

  beforeEach(() => {
    quiet = (["info", "warn", "error"] as const).map((level) => spyOn(console, level).mockImplementation(() => {}));
  });

  afterEach(() => {
    for (const spy of quiet) spy.mockRestore();
  });

  /** What `createErrorResponse`, the answer every Studio route gives a failure, makes of one. */
  async function routeAnswer(failure: unknown): Promise<{ readonly status: number; readonly error: string }> {
    const response = createErrorResponse(failure);
    const body = (await response.json()) as { readonly error: string };
    return { status: response.status, error: body.error };
  }

  test("a tree read past its budget on a named warehouse answers HTTP 503 with the resuming sentence", async () => {
    const fake = fakeDatabend({ answer: withConnect((sql) => (sql === SQL.catalogs ? "hang" : undefined)) });
    const { provider, time } = build(fake, { warehouse: "wh-1" });
    await provider.connect();
    const reading = provider.listContainers().catch((error: unknown) => error);
    await until(() => fake.sqls().includes(SQL.catalogs));
    time.fire(10_000);
    expect(await routeAnswer(await reading)).toEqual({
      status: 503,
      error: DATABEND_ERROR_SENTENCES.resuming("wh-1", "10"),
    });
  });

  test("a statement that waited for a permit past its deadline answers HTTP 503 with the slot sentence", async () => {
    const fake = fakeDatabend({ answer: withConnect((sql) => (sql === SQL.catalogs ? "hang" : undefined)) });
    const { provider, time } = build(fake, { warehouse: "wh-1" });
    await provider.connect();
    const holding = [provider.listContainers(), provider.listContainers()].map((call) =>
      call.catch((error: unknown) => error),
    );
    await until(() => fake.inflight === 2);
    const queued = provider.query("SELECT 1").catch((error: unknown) => error);
    await until(() => time.deadlines.some((deadline) => deadline.ms === 60_000));
    time.fire(60_000);
    expect(await routeAnswer(await queued)).toEqual({
      status: 503,
      error: DATABEND_PROVIDER_SENTENCES.slotsBusy("60"),
    });
    await provider.disconnect();
    await Promise.all(holding);
  });

  test("a user statement's own deadline on a named warehouse stays the route's timeout, HTTP 408 (X27)", async () => {
    const fake = fakeDatabend({
      answer: withConnect((sql) => (sql === "SELECT sleep(9)" ? { state: "Running", next_uri: "PAGE" } : undefined)),
    });
    const { provider, time } = build(fake, { warehouse: "wh-1" });
    await provider.connect();
    const running = provider.query("SELECT sleep(9)").catch((error: unknown) => error);
    await until(() => pagesOpened(fake) === 1);
    time.fire(60_000);
    const failure = await running;
    expect(failure).toBeInstanceOf(TimeoutError);
    expect((failure as Error).message).toBe(DATABEND_ERROR_SENTENCES.deadline("60"));
    expect((await routeAnswer(failure)).status).toBe(408);
  });
});

// ============================================================================
// Statement budgets on the object surface, end to end [X05]
// ============================================================================

describe("a statement budget cut on the object surface [X05]", () => {
  const COLUMN_SCHEMA = [
    "object_name",
    "column_name",
    "data_type",
    "is_nullable",
    "default_kind",
    "default_expression",
  ];
  const CUT = { bound: "cells" as const, limit: 250_000 };

  test("a cut inside a table drops that table and says so", async () => {
    const container = { catalog: "default", database: "libredb_demo" };
    const columns = paged(
      COLUMN_SCHEMA.map((name) => column(name)),
      [
        ["t1", "a", "Int32", "NO", "", ""],
        ["t1", "b", "String", "YES", "", ""],
        ...Array.from({ length: 41_665 }, (_, index) => ["t2", `c${index}`, "Int32", "NO", "", ""]),
      ],
    );
    const fake = fakeDatabend({
      answer: withConnect((sql) => {
        if (sql.startsWith("SELECT name AS object_name")) {
          return { schema: [column("object_name")], data: [["t1"], ["t2"]] };
        }
        return sql.startsWith("SELECT `table` AS object_name") ? columns.first : undefined;
      }),
      page: columns.page,
    });
    const { provider } = build(fake);
    await provider.connect();
    const batch = await provider.describeObjects([container.catalog, container.database], "table");
    expect(batch.details.map((detail) => detail.path)).toEqual([["default", "libredb_demo", "t1"]]);
    expect(batch.details[0].columns.map((columnOf) => columnOf.name)).toEqual(["a", "b"]);
    expect(batch.truncated).toEqual({ limit: 1, reason: DATABEND_OBJECT_SENTENCES.bulkCut(CUT) });
  });

  test("an over-budget describe refuses, naming the bound", async () => {
    const sql = SQL.columns("wide");
    const columns = paged(
      COLUMN_SCHEMA.slice(1)
        .concat("comment")
        .map((name) => column(name)),
      Array.from({ length: 41_667 }, (_, index) => [`c${index}`, "Int32", "NO", "", "", ""]),
    );
    const fake = fakeDatabend({
      answer: withConnect((sent) => (sent === sql ? columns.first : undefined)),
      page: columns.page,
    });
    const { provider } = build(fake);
    await provider.connect();
    const failure = await provider
      .describeObject(["default", "libredb_demo", "wide"], "table")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as Error).message).toBe(DATABEND_OBJECT_SENTENCES.incomplete("column list", CUT));
  });
});

// ============================================================================
// close() [X31]
// ============================================================================

describe("disconnect", () => {
  test("aborts both open long polls, then sends each kill under its own 5 s [X31]", async () => {
    const fake = fakeDatabend({
      answer: withConnect((sql) =>
        sql.startsWith("SELECT sleep") ? { state: "Running", next_uri: "PAGE" } : undefined,
      ),
    });
    const { provider, time } = build(fake);
    await provider.connect();
    const runs = [
      provider.query("SELECT sleep(1)").catch((error: unknown) => error),
      provider.query("SELECT sleep(2)").catch((error: unknown) => error),
    ];
    await until(() => pagesOpened(fake) === 2);
    const closesBefore = time.deadlines.filter((deadline) => deadline.ms === 5_000).length;
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
    for (const outcome of await Promise.all(runs)) expect(outcome).toBeInstanceOf(QueryCancelledError);

    const aborts = fake.events.flatMap((event, index) => (event.startsWith("aborted ") ? [index] : []));
    const kills = fake.events.flatMap((event, index) => (/^GET \/v1\/query\/\w+\/kill$/.test(event) ? [index] : []));
    expect(aborts).toHaveLength(2);
    expect(kills).toHaveLength(2);
    expect(Math.max(...aborts)).toBeLessThan(Math.min(...kills));
    const closeBudgets = time.deadlines.filter((deadline) => deadline.ms === 5_000);
    expect(closeBudgets.length - closesBefore).toBe(2);
    expect(closeBudgets.every((deadline) => !deadline.signal.aborted)).toBe(true);
  });
});

// ============================================================================
// Delegation: the object surface and monitoring (design 5.4, 5.5)
// ============================================================================

describe("the object surface and monitoring delegate to objects.ts and introspect.ts", () => {
  async function connected(answers?: (sql: string) => Reply | Promise<Reply> | undefined, overrides = {}) {
    const fake = fakeDatabend({ answer: withConnect(answers) });
    const { provider } = build(fake, overrides);
    await provider.connect();
    const before = fake.sqls().length;
    return { provider, fake, sent: () => fake.sqls().slice(before) };
  }

  test.each([
    ["listContainers()", (p: DatabendProvider) => p.listContainers(), [SQL.catalogs]],
    ["listContainers([catalog])", (p: DatabendProvider) => p.listContainers(["default"]), [SQL.databases("default")]],
    ["listContainers([catalog, database])", (p: DatabendProvider) => p.listContainers(["default", "x"]), []],
    ["countObjects", (p: DatabendProvider) => p.countObjects(["default", "libredb_demo"]), [SQL.counts]],
    ["listObjects", (p: DatabendProvider) => p.listObjects(["default", "libredb_demo"], "view"), [SQL.views]],
    [
      "readObjectSource",
      (p: DatabendProvider) => p.readObjectSource(["default", "libredb_demo", "t"], "materialized_view"),
      [SQL.materializedSource("t")],
    ],
    [
      "getOverview",
      (p: DatabendProvider) => p.getOverview(),
      [SQL.overviewVersion, SQL.overviewTables, SQL.activeQueries, SQL.indexCount],
    ],
    ["getSlowQueries", (p: DatabendProvider) => p.getSlowQueries({ limit: 5 }), [databendSlowQueriesSql(5)]],
    [
      "getActiveSessions",
      (p: DatabendProvider) => p.getActiveSessions(),
      [databendSessionsSql(DATABEND_DEFAULT_SESSION_LIMIT)],
    ],
    ["getTableStats", (p: DatabendProvider) => p.getTableStats({ schema: "x" }), [SQL.tableStats("x")]],
    ["getIndexStats", (p: DatabendProvider) => p.getIndexStats(), [SQL.indexStats]],
    ["getStorageStats", (p: DatabendProvider) => p.getStorageStats(), [SQL.storage]],
  ])("%s sends exactly its module's statements", async (_name, call, expected) => {
    // A definition read raises on an answer with no definition text, so the source statement answers one.
    const ddl = { schema: [column("Table"), column("Create Table")], data: [["t", "CREATE MATERIALIZED VIEW t"]] };
    const { provider, sent } = await connected((sql) => (sql === SQL.materializedSource("t") ? ddl : undefined));
    await call(provider);
    expect(sent()).toEqual(expected);
  });

  test("getHealth reads the overview, then slow queries and sessions", async () => {
    const { provider, sent } = await connected();
    const health = await provider.getHealth();
    expect(health.cacheHitRatio).toBe("N/A");
    expect(sent().slice(0, 4)).toEqual([SQL.overviewVersion, SQL.overviewTables, SQL.activeQueries, SQL.indexCount]);
    expect(sent()).toHaveLength(6);
  });

  test("getPerformanceMetrics measures nothing and sends nothing", async () => {
    const { provider, sent } = await connected();
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(sent()).toEqual([]);
  });

  test("the session database is marked in the default catalog only", async () => {
    const answers = (sql: string): Reply | undefined =>
      sql === SQL.databases("other")
        ? { schema: [column("database_name")], data: [["default"], ["libredb_demo"]] }
        : undefined;
    const pinned = await connected(answers, { database: "libredb_demo" });
    const marked = (containers: { name: string; isSessionDefault?: boolean }[]) =>
      containers.filter((container) => container.isSessionDefault).map((container) => container.name);
    expect(marked(await pinned.provider.listContainers(["default"]))).toEqual(["libredb_demo"]);
    expect(marked(await pinned.provider.listContainers(["other"]))).toEqual([]);
    const unpinned = await connected(answers);
    expect(marked(await unpinned.provider.listContainers(["default"]))).toEqual(["default"]);
  });

  test("describeObject reads its columns, and its indexes in the default catalog", async () => {
    const sql = SQL.columns("t");
    const { provider, sent } = await connected((sent) =>
      sent === sql
        ? {
            schema: ["column_name", "data_type", "is_nullable", "default_kind", "default_expression", "comment"].map(
              (name) => column(name),
            ),
            data: [["a", "Int32", "NO", "", "", ""]],
          }
        : undefined,
    );
    const detail = await provider.describeObject(["default", "libredb_demo", "t"], "table");
    expect(detail.columns.map((columnOf) => columnOf.name)).toEqual(["a"]);
    expect(sent()[0]).toBe(sql);
    expect(sent()).toHaveLength(2);
  });

  test("a path of the wrong shape or an undeclared kind is refused before any statement", async () => {
    const { provider, sent } = await connected();
    await expect(provider.countObjects(["default"])).rejects.toThrow('received ["default"]');
    await expect(provider.describeObject(["default", "t"], "table")).rejects.toThrow('received ["default","t"]');
    await expect(provider.describeObject(["default", "d", "t"], "index")).rejects.toThrow(
      DATABEND_OBJECT_SENTENCES.unknownKind("index"),
    );
    await expect(provider.readObjectSource(["default", "d", "t"], "index")).rejects.toThrow(QueryError);
    expect(sent()).toEqual([]);
  });

  test("a definition Databend refuses with 1063 is the part's refusal in Databend's own words", async () => {
    const denied =
      "Permission denied: privilege [Select] is required on 'default'.'libredb_demo'.'every_type' for user 'analyst'@'%' with roles [public,analyst]";
    const { provider } = await connected((sql) =>
      sql === SQL.materializedSource("t") ? failed(1063, denied) : undefined,
    );
    expect(await provider.readObjectSource(["default", "libredb_demo", "t"], "materialized_view")).toEqual({
      path: ["default", "libredb_demo", "t"],
      kind: "materialized_view",
      parts: [{ id: "definition", label: DATABEND_OBJECT_SENTENCES.sourceLabel, unavailable: denied }],
    });
  });

  // Both answers as the pinned image gave them, with the connection's Database left at `default`, which exists.
  test("an unknown database is hinted at Database on a user statement, never on a tree read that named a full path", async () => {
    const source = "SHOW CREATE TABLE `default`.`no_such_db`.`t` WITH QUOTED_IDENTIFIERS";
    const typed = "SELECT * FROM no_such_db.t";
    const unknown = `error: \n  --> SQL:1:15\n  |\n1 | ${typed}\n  |               ^^^^^^^^^^ Unknown database "default"."no_such_db" .\n\n`;
    const { provider } = await connected((sql) => {
      if (sql === source) return failed(1003, "Unknown database 'no_such_db'");
      return sql === typed ? failed(1003, unknown) : undefined;
    });
    const tree = await provider
      .readObjectSource(["default", "no_such_db", "t"], "table")
      .catch((error: unknown) => error);
    expect(tree).toBeInstanceOf(QueryError);
    expect((tree as QueryError).message).toBe("Unknown database 'no_such_db'");
    const user = await provider.query(typed).catch((error: unknown) => error);
    expect(user).toBeInstanceOf(QueryError);
    expect((user as QueryError).message).toBe(`${unknown.trimEnd()} ${DATABEND_ERROR_SENTENCES.currentDatabase}`);
    expect((user as QueryError).position).toBe(15);
  });

  test("a surface statement's failure is mapped to the house class, naming its statement", async () => {
    const { provider } = await connected((sql) =>
      sql === SQL.catalogs ? failed(1006, "catalogs unreadable") : undefined,
    );
    const failure = (await provider.listContainers().catch((error: unknown) => error)) as QueryError;
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure.message).toContain("catalogs unreadable");
    expect(failure.query).toBe(SQL.catalogs);
  });

  test("runMaintenance sends the kill of one session, and refuses every other operation unsent", async () => {
    const { provider, sent } = await connected();
    const result = await provider.runMaintenance("kill", "abc-1");
    expect(result.success).toBe(true);
    expect(result.message).toBe(DATABEND_MONITORING_SENTENCES.killAsked("abc-1"));
    expect(sent()).toEqual([SQL.kill("abc-1")]);
    await expect(provider.runMaintenance("kill")).rejects.toThrow(DATABEND_MONITORING_SENTENCES.killNeedsId);
    await expect(provider.runMaintenance("vacuum", "t")).rejects.toThrow(
      DATABEND_PROVIDER_SENTENCES.maintenanceRefused("vacuum"),
    );
    expect(sent()).toHaveLength(1);
  });
});

// ============================================================================
// Studio's own statements in the Sessions panel and the active count (design 5.5, CL-OPS-1)
// ============================================================================

describe("Studio's own statements are left out of the Sessions panel and the active count by query id", () => {
  /** One running statement as `system.processes` lists it: its session id, the query id it was sent under, its text. */
  interface Listed {
    readonly session: string;
    readonly queryId: string;
    readonly text: string;
  }

  const SESSIONS_SQL = databendSessionsSql(DATABEND_DEFAULT_SESSION_LIMIT);
  const SESSION_COLUMNS = [
    column("session_id"),
    column("query_id"),
    column("user_name"),
    column("host", "Nullable(String)"),
    column("database_name"),
    column("command"),
    column("query_text"),
    column("created_time", "Timestamp"),
    column("elapsed_seconds", "UInt64"),
  ];
  /** A user's statement of another client, which no text tells from Studio's: only its query id is not Studio's. */
  const USER: Listed = { session: "user-session", queryId: "0f".repeat(16), text: "SELECT sleep(2) AS user_statement" };
  /** A user's statement led by a literal, which no text rule may take for Studio's. */
  const LITERAL_LED: Listed = {
    session: "literal-session",
    queryId: "1e".repeat(16),
    text: "SELECT 'studio' AS marker, sleep(2) AS listed",
  };

  /**
   * A fake whose `system.processes` lists `running()` and, last, the reading statement itself under the query id its
   * request carried, as Databend lists a running read: both reads answer from it as the pinned image does.
   */
  function processesServer(running: (fake: FakeServer) => Listed[], held: Record<string, Promise<Reply>> = {}) {
    const fake: FakeServer = fakeDatabend({
      answer: withConnect((sql) => {
        if (held[sql] !== undefined) return held[sql];
        if (sql !== SESSIONS_SQL && sql !== SQL.activeQueries) return undefined;
        const reading = fake.requests.at(-1) as Seen;
        const listed = [...running(fake), { session: "reading-session", queryId: reading.queryId, text: sql }];
        if (sql === SQL.activeQueries) {
          return {
            schema: [column("query_id"), column("running", "UInt64")],
            data: listed.map((row) => [row.queryId, String(listed.length)]),
          };
        }
        return {
          schema: SESSION_COLUMNS,
          data: listed.map((row) => [
            row.session,
            row.queryId,
            TEST_USER,
            "172.20.0.1",
            "default",
            "Query",
            row.text,
            "2026-10-08 13:00:00.000000",
            "1",
          ]),
        };
      }),
    });
    return fake;
  }

  /** The query id the fake saw `sql` sent under. */
  const queryIdOf = (fake: FakeServer, sql: string) => fake.requests.find((request) => request.sql === sql)?.queryId;

  test("an idle server lists no session and counts no active statement: the reads themselves are Studio's own", async () => {
    const fake = processesServer(() => []);
    const { provider } = build(fake);
    await provider.connect();
    expect(await provider.getActiveSessions()).toEqual([]);
    expect((await provider.getOverview()).activeConnections).toBe(0);
  });

  test("the tree's read in flight beside the panel is left out; a user's statements stay, one led by a literal included", async () => {
    const tree = gate();
    const fake = processesServer(
      (server) => [
        USER,
        { session: "tree-session", queryId: queryIdOf(server, SQL.catalogs) ?? "", text: SQL.catalogs },
        LITERAL_LED,
      ],
      { [SQL.catalogs]: tree.promise },
    );
    const { provider } = build(fake);
    await provider.connect();
    const listing = provider.listContainers();
    // Settled by the disconnect after the test when an assertion fails first.
    listing.catch(() => {});
    await until(() => fake.sqls().includes(SQL.catalogs));
    expect((await provider.getActiveSessions()).map((session) => session.pid)).toEqual([
      USER.session,
      LITERAL_LED.session,
    ]);
    expect((await provider.getOverview()).activeConnections).toBe(2);
    tree.open({ schema: [column("catalog_name")], data: [["default"]] });
    expect((await listing).map((container) => container.name)).toEqual(["default"]);
  });

  test("the editor's statement is a user's: listed and counted while it runs", async () => {
    const editor = "SELECT sleep(2) AS editor_statement";
    const answer = gate();
    const fake = processesServer(
      (server) => [{ session: "editor-session", queryId: queryIdOf(server, editor) ?? "", text: editor }],
      { [editor]: answer.promise },
    );
    const { provider } = build(fake);
    await provider.connect();
    const running = provider.query(editor, undefined, "q-editor");
    running.catch(() => {});
    await until(() => fake.sqls().includes(editor));
    expect((await provider.getActiveSessions()).map((session) => session.query)).toEqual([editor]);
    expect((await provider.getOverview()).activeConnections).toBe(1);
    answer.open({ schema: [column("editor_statement", "UInt8")], data: [["0"]] });
    expect((await running).rowCount).toBe(1);
  });
});
