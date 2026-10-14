/**
 * The Apache Spark provider through its public surface. Two seams reach the wire through the constructor's third
 * argument: the real adapter over the fake Spark Connect server, for wire behaviour, and a scripted channel, for the
 * edges a fake cannot hold open (a Config call that waits on the test, a ReleaseSession that answers UNIMPLEMENTED, an
 * ExecutePlan held until the test lets it answer). The scripted channel answers in the shapes the descriptor decodes:
 * field names as the protos spell them, and bytes as a Buffer.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { ConnectionError, DatabaseConfigError, QueryCancelledError, QueryError } from "@/lib/db/errors";
import { buildSparkConnectionOptions } from "@/lib/db/providers/sql/spark/connection-options";
import {
  SPARK_CONTROL_DEADLINE_MS,
  SPARK_HEARTBEAT_DEADLINE_MS,
  SPARK_HEARTBEAT_INTERVAL_MS,
  SPARK_INTROSPECT_IN_FLIGHT_MAX,
  SPARK_REFUSED_SESSION_MAP_MAX,
  SPARK_VERSION_TEXT_MAX_CHARS,
} from "@/lib/db/providers/sql/spark/constants";
import { SPARK_ERROR_SENTENCES, SparkError } from "@/lib/db/providers/sql/spark/errors";
import {
  grpcWireTransport,
  type SparkPlanStream,
  type SparkWireCall,
  type SparkWireChannel,
  type SparkWireTransport,
} from "@/lib/db/providers/sql/spark/grpc-client";
import { SPARK_OBJECT_KINDS, SPARK_PROVIDER_SENTENCES, SparkProvider } from "@/lib/db/providers/sql/spark/index";
import { SPARK_INTROSPECT_SENTENCES } from "@/lib/db/providers/sql/spark/introspect";
import { SPARK_MONITORING_LABELS } from "@/lib/db/providers/sql/spark/monitoring";
import { releaseSessionRequest } from "@/lib/db/providers/sql/spark/requests";
import { SPARK_CUT_WARNINGS } from "@/lib/db/providers/sql/spark/result-stream";
import { SPARK_STATEMENT_SENTENCES } from "@/lib/db/providers/sql/spark/statement-shape";
import { type DatabaseProvider, DEFAULT_QUERY_TIMEOUT, type ProviderOptions } from "@/lib/db/types";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { logger } from "@/lib/logger";
import { type DatabaseConnection, TUNNEL_FAR_END, type TunnelFarEnd, type WithTunnelFarEnd } from "@/lib/types";
import { type SparkFakeAnswer, type SparkFakeServer, startSparkFake } from "../../../helpers/spark-connect-server";
import { columnsStream, int64Batch } from "../../../helpers/spark-ipc";

const CURRENT = columnsStream([
  { name: "catalog", kind: "utf8", values: ["spark_catalog"] },
  { name: "namespace", kind: "utf8", values: ["default"] },
]);
const ONE = columnsStream([{ name: "1", kind: "int32", values: [1] }]);
/** What a SET CATALOG or a USE NAMESPACE answers here; a setup statement's answer is read past, never decoded. */
const SET_ANSWER = columnsStream([{ name: "key", kind: "utf8", values: [] }]);
const DEFAULT = "`spark_catalog`.`default`";
/** The fixture token, built from words so no secret scanner reads a credential here, as the RabbitMQ fixtures do. */
const TOKEN = ["stand", "in", "token"].join("-");
const CATALOGS = columnsStream([{ name: "catalog", kind: "utf8", values: ["spark_catalog"] }]);
const T_DDL = "CREATE TABLE spark_catalog.default.t (\n  id BIGINT,\n  `#tag` STRING)\nUSING parquet\n";
const T_COLUMNS = [
  { name: "id", type: "bigint", nullable: true, isPrimary: false },
  { name: "#tag", type: "string", nullable: true, isPrimary: false },
];
/** DESCRIBE TABLE's answer for a table of one column. */
const DESCRIBED = columnsStream([
  { name: "col_name", kind: "utf8", values: ["id"] },
  { name: "data_type", kind: "utf8", values: ["int"] },
  { name: "comment", kind: "utf8", values: [null] },
]);
/** The detail DESCRIBED reads for the table `name` in `spark_catalog`.`default`. */
const detailOf = (name: string) => ({
  path: ["spark_catalog", "default", name],
  columns: [{ name: "id", type: "int", nullable: true, isPrimary: false }],
  indexes: [],
  foreignKeys: [],
});
const NO_FUNCTIONS = columnsStream([{ name: "function", kind: "utf8", values: [] }]);

/** SHOW TABLES or SHOW VIEWS in `spark_catalog`.`default`: every name in `default`, none temporary. */
const listing = (column: "tableName" | "viewName", names: readonly string[]) =>
  columnsStream([
    { name: "namespace", kind: "utf8", values: names.map(() => "default") },
    { name: column, kind: "utf8", values: [...names] },
    { name: "isTemporary", kind: "bool", values: names.map(() => false) },
  ]);

const FAKE_STATEMENTS: Record<string, SparkFakeAnswer> = {
  "SHOW CURRENT NAMESPACE": { kind: "command", ipc: CURRENT },
  "SELECT 1": { kind: "command", ipc: ONE },
  "CREATE TABLE x (id INT)": { kind: "command", ipc: new Uint8Array(0) },
  "BIG INLINE": { kind: "command", ipc: int64Batch(0, MAX_UNLIMITED_ROWS + 1) },
  "SHOW CATALOGS": { kind: "command", ipc: CATALOGS },
  "SHOW NAMESPACES IN `spark_catalog`": {
    kind: "command",
    ipc: columnsStream([{ name: "namespace", kind: "utf8", values: ["default", "studio"] }]),
  },
  [`SHOW VIEWS IN ${DEFAULT}`]: { kind: "command", ipc: listing("viewName", ["v"]) },
  // On the session catalog SHOW TABLES lists persistent views with the tables.
  [`SHOW TABLES IN ${DEFAULT}`]: { kind: "command", ipc: listing("tableName", ["t", "v"]) },
  [`SHOW USER FUNCTIONS IN ${DEFAULT}`]: {
    kind: "command",
    ipc: columnsStream([{ name: "function", kind: "utf8", values: ["spark_catalog.default.f1"] }]),
  },
  [`DESCRIBE TABLE ${DEFAULT}.\`t\``]: {
    kind: "command",
    ipc: columnsStream([
      { name: "col_name", kind: "utf8", values: ["id", "#tag", "", "# Detailed Table Information"] },
      { name: "data_type", kind: "utf8", values: ["bigint", "string", "", ""] },
      { name: "comment", kind: "utf8", values: [null, null, "", ""] },
    ]),
  },
  [`SHOW CREATE TABLE ${DEFAULT}.\`t\``]: {
    kind: "command",
    ipc: columnsStream([{ name: "createtab_stmt", kind: "utf8", values: [T_DDL] }]),
  },
  "SET CATALOG 'spark_catalog'": { kind: "command", ipc: SET_ANSWER },
  "USE NAMESPACE `default`": { kind: "command", ipc: SET_ANSWER },
  "USE NAMESPACE `missing`": {
    kind: "error",
    code: 13,
    message: "[SCHEMA_NOT_FOUND] The schema `missing` cannot be found.",
    errorInfo: { errorClass: "SCHEMA_NOT_FOUND", sqlState: "42704" },
  },
};

function connection(port: number, extra: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return { id: `spark-${port}`, name: "spark", type: "spark", host: "127.0.0.1", port, ...extra } as DatabaseConnection;
}

/** A connection as the factory hands it over through an SSH tunnel: Host and Port name the tunnel's local forward. */
function tunnelled(id: string, localPort: number, farEnd: TunnelFarEnd): DatabaseConnection & WithTunnelFarEnd {
  const sshTunnel = { enabled: true, host: "bastion", port: 22, username: "u", authMethod: "password" } as const;
  return { ...connection(localPort, { id, sshTunnel }), [TUNNEL_FAR_END]: farEnd };
}

/** The SQL text of an ExecutePlan request: plan.command.sql_command.input.sql.query. */
const statementOf = (request: object): string | undefined =>
  (request as { plan?: { command?: { sql_command?: { input?: { sql?: { query?: string } } } } } }).plan?.command
    ?.sql_command?.input?.sql?.query;

/** Whether a Config request sets values; a decoded request carries every unset oneof member as null. */
const setsConfig = (request: object): boolean => {
  const set = (request as { operation?: { set?: unknown } }).operation?.set;
  return set !== null && set !== undefined;
};

const sessionOf = (request: object): string => String((request as { session_id?: unknown }).session_id);

interface ScriptedCall {
  readonly rpc: string;
  readonly request: object;
  readonly sessionId: string;
  readonly metadata: Readonly<Record<string, string>>;
  /** Date.now() when the channel received the call. */
  readonly at: number;
  /** The call's deadline, in epoch milliseconds. */
  readonly deadline: number;
}

interface Scripted {
  readonly transport: SparkWireTransport;
  readonly calls: readonly ScriptedCall[];
  readonly closed: () => number;
}

interface ScriptOptions {
  readonly version?: string;
  /** An answer or a failure for one unary call; undefined takes the default answer. */
  readonly unary?: (rpc: string, request: object, call: SparkWireCall) => Promise<object> | undefined;
  /** The stream of one ExecutePlan; undefined answers from `commands`, and a statement with no command ends empty. */
  readonly stream?: (sql: string, request: object, call: SparkWireCall) => SparkPlanStream | undefined;
  readonly commands?: Readonly<Record<string, Uint8Array>>;
  /** Run when the transport is asked for a channel, before it answers one. */
  readonly opening?: () => void;
}

/** A command's inline answer, as Spark sends it. */
const commandAnswer = (request: object, ipc: Uint8Array) => ({
  session_id: sessionOf(request),
  server_side_session_id: "server-1",
  sql_command_result: { relation: { local_relation: { data: Buffer.from(ipc) } } },
});

function streamOf(responses: readonly object[]): SparkPlanStream {
  let next = 0;
  return {
    read: async () => responses[next++],
    receivedBytes: 0,
    truncated: false,
    cancel: () => undefined,
  };
}

const failingStream = (error: unknown): SparkPlanStream => ({
  read: () => Promise.reject(error),
  receivedBytes: 0,
  truncated: false,
  cancel: () => undefined,
});

/** grpc-js's own failure for a call on a channel its client closed: no gRPC code, and nothing reached the server. */
const shutDown = () => new Error("Channel has been shut down");

/**
 * A channel that answers each unary RPC from `unary` (default: an empty answer) and each command from `commands`. Each
 * open is a channel of its own, as grpc-js opens one per connection: once closed, it refuses every call as grpc-js
 * does, ExecutePlan by throwing at once and a unary call by rejecting, and records none, so no test passes on a call
 * the real channel would drop.
 */
function scripted(options: ScriptOptions = {}): Scripted {
  const calls: ScriptedCall[] = [];
  let closed = 0;
  const record = (rpc: string, request: object, call: SparkWireCall) => {
    calls.push({
      rpc,
      request,
      sessionId: sessionOf(request),
      metadata: call.metadata,
      at: Date.now(),
      deadline: call.deadline.getTime(),
    });
  };
  const channel = (): SparkWireChannel => {
    let open = true;
    return {
      unary: async (rpc, request, call) => {
        if (!open) throw shutDown();
        record(rpc, request, call);
        const scriptedAnswer = options.unary?.(rpc, request, call);
        if (scriptedAnswer !== undefined) return scriptedAnswer;
        const base = { session_id: sessionOf(request), server_side_session_id: "server-1" };
        if (rpc === "AnalyzePlan") return { ...base, spark_version: { version: options.version ?? "4.2.0" } };
        if (rpc === "Config") return { ...base, pairs: [], warnings: [] };
        if (rpc === "Interrupt") return { ...base, interrupted_ids: [] };
        return base;
      },
      executePlan: (request, call) => {
        if (!open) throw shutDown();
        record("ExecutePlan", request, call);
        const sql = statementOf(request) ?? "";
        const stream = options.stream?.(sql, request, call);
        if (stream !== undefined) return stream;
        const answer = options.commands?.[sql];
        return streamOf(answer === undefined ? [] : [commandAnswer(request, answer)]);
      },
      close: () => {
        open = false;
        closed += 1;
      },
    };
  };
  return {
    transport: () => {
      options.opening?.();
      return channel();
    },
    calls,
    closed: () => closed,
  };
}

/**
 * Unary answers for a server that sets up the first session at once and answers the Config set of every later one only
 * once `setup` settles; `first()` names the first session.
 */
function laterSetupsHeld(setup: Promise<void>) {
  let first: string | undefined;
  return {
    first: () => first,
    unary: (rpc: string, request: object): Promise<object> | undefined => {
      if (rpc !== "Config" || !setsConfig(request)) return undefined;
      if (first === undefined) {
        first = sessionOf(request);
        return undefined;
      }
      const answer = { session_id: sessionOf(request), server_side_session_id: "server-1", pairs: [], warnings: [] };
      return setup.then(() => answer);
    },
  };
}

/** The scripted transport with the channels it opens told apart: `closed()` answers, per open in order, whether it closed. */
function channelsOf(script: Scripted): { readonly transport: SparkWireTransport; readonly closed: () => boolean[] } {
  const opens: { closed: boolean }[] = [];
  return {
    transport: (options) => {
      const channel = script.transport(options);
      const open = { closed: false };
      opens.push(open);
      return {
        ...channel,
        close: () => {
          open.closed = true;
          channel.close();
        },
      };
    },
    closed: () => opens.map((open) => open.closed),
  };
}

/** A promise the test settles. */
function gate() {
  let open: () => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  promise.catch(() => undefined);
  return { promise, open: () => open(), fail: (error: unknown) => fail(error) };
}

/** grpc-js's own failure for a call its client cancelled. */
const clientCancel = () =>
  Object.assign(new Error("1 CANCELLED: Cancelled on client"), { code: 1, details: "Cancelled on client" });
const deadlineStatus = () =>
  Object.assign(new Error("4 DEADLINE_EXCEEDED: Deadline exceeded"), { code: 4, details: "Deadline exceeded" });
const unavailable = () =>
  Object.assign(new Error("14 UNAVAILABLE: No connection established"), {
    code: 14,
    details: "No connection established",
  });
const unimplemented = () =>
  Object.assign(new Error("12 UNIMPLEMENTED: Method not found"), { code: 12, details: "Method not found" });

/** A command answer held until `until` settles; the call's signal ends it as grpc-js ends a cancelled call. */
function heldStream(request: object, call: SparkWireCall, ipc: Uint8Array, until: Promise<void>): SparkPlanStream {
  const aborted = new Promise<never>((_, reject) => {
    if (call.signal.aborted) reject(clientCancel());
    else call.signal.addEventListener("abort", () => reject(clientCancel()), { once: true });
  });
  aborted.catch(() => undefined);
  let reads = 0;
  return {
    read: async () => {
      reads += 1;
      if (reads > 1) return undefined;
      await Promise.race([until, aborted]);
      return commandAnswer(request, ipc);
    },
    receivedBytes: 0,
    truncated: false,
    cancel: () => undefined,
  };
}

/** Waits, one macrotask at a time, until `check` holds. */
async function eventually(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 500; turn += 1) {
    if (check()) return;
    // oxlint-disable-next-line no-await-in-loop -- one macrotask per turn lets the calls the test waits for arrive.
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the condition the test waited for never held");
}

const failureOf = (pending: Promise<unknown>): Promise<unknown> =>
  pending.then(
    () => undefined,
    (error: unknown) => error,
  );

/** The error the provider recorded as its last one, which only its protected state holds. */
const lastErrorOf = (provider: SparkProvider): Error | undefined =>
  (provider as unknown as { state: { lastError?: Error } }).state.lastError;

/** Settles once `ms` milliseconds of real time have passed, whatever Date.now() answers. */
const later = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

let fake: SparkFakeServer;
let port: number;
beforeAll(async () => {
  fake = await startSparkFake({ progressEveryMs: 0, statements: FAKE_STATEMENTS });
  port = Number(fake.target.split(":").at(-1));
});
afterAll(() => fake.close());

describe("SparkProvider: construction and declarations", () => {
  test("the constructor validates nothing and opens nothing", () => {
    const script = scripted();
    const provider = new SparkProvider({ id: "x", name: "x", type: "spark" } as DatabaseConnection, {}, script);
    expect(script.calls).toStrictEqual([]);
    expect(provider.isConnected()).toBe(false);
    expect(provider.hasRunsInFlight()).toBe(false);
    expect(provider.connectWarnings()).toStrictEqual([]);
  });

  test("the capabilities literal, field by field", () => {
    const capabilities = new SparkProvider(connection(1)).getCapabilities();
    expect(capabilities).toStrictEqual({
      queryLanguage: "sql",
      supportsExplain: true,
      explainFormat: "spark-text",
      supportsExternalQueryLimiting: true,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsColumnProfiling: false,
      supportsTransactions: false,
      supportsSqlFormat: false,
      declaresForeignKeys: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 15002,
      identifierQuoting: "backtick-always",
      containerNameSpelling: "engine",
      schemaRefreshPattern: "^\\s*(CREATE|DROP|ALTER|REPLACE|REPAIR|MSCK)\\b",
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Namespace", labelPlural: "Namespaces" },
      ],
      containerPathShapes: "exact",
      objectKinds: SPARK_OBJECT_KINDS,
      agentWalkScope: { mode: "session-default", whenNoDefault: { walk: "parent-default-children" } },
    });
    expect(SPARK_OBJECT_KINDS).toStrictEqual([
      {
        id: "table",
        role: "relation",
        label: "Table",
        labelPlural: "Tables",
        hasColumns: true,
        hasSource: true,
        sourceLanguage: "sql",
      },
      {
        id: "view",
        role: "relation",
        label: "View",
        labelPlural: "Views",
        hasColumns: true,
        hasSource: true,
        sourceLanguage: "sql",
      },
      {
        id: "function",
        role: "routine",
        label: "Function",
        labelPlural: "Functions",
        hasColumns: false,
        hasSource: false,
      },
    ]);
  });

  test("the labels: Spark SQL, the two cards worded true, the monitoring empty states", () => {
    const labels = new SparkProvider(connection(1)).getLabels();
    // Every other label is the base wording for tables and rows.
    expect(labels).toMatchObject({
      entityName: "Table",
      rowName: "row",
      statementLanguage: "Spark SQL",
      analyzeGlobalTitle: "Not Run from Studio",
      vacuumGlobalTitle: "Not Run from Studio",
      analyzeGlobalDesc: SPARK_PROVIDER_SENTENCES.analyzeGlobalDesc,
      vacuumGlobalDesc: SPARK_PROVIDER_SENTENCES.vacuumGlobalDesc,
      slowQueriesEmptyState: SPARK_MONITORING_LABELS.slowQueriesEmptyState,
      sessionsEmptyState: SPARK_MONITORING_LABELS.sessionsEmptyState,
    });
    expect(SPARK_PROVIDER_SENTENCES).toStrictEqual({
      maintenanceRefused: "Apache Spark has no maintenance operations in Studio.",
      analyzeGlobalDesc:
        "Spark computes table statistics with ANALYZE TABLE, which runs a job on the cluster; Studio does not run it in this version.",
      vacuumGlobalDesc:
        "Spark has no VACUUM of its own; table formats such as Delta and Iceberg run their own maintenance.",
    });
  });
});

describe("SparkProvider: connect, disconnect and warnings over the fake", () => {
  test("connect reads the version on a probe session it releases, then sets up the metadata session and reads the current namespace", async () => {
    fake.log.clear();
    const provider = new SparkProvider(connection(port));
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expect(provider.connectWarnings()).toStrictEqual([
      { message: SPARK_ERROR_SENTENCES.tokenlessCaution("127.0.0.1", port) },
    ]);
    await provider.disconnect();
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
    expect(provider.hasRunsInFlight()).toBe(false);
    expect(provider.connectWarnings()).toStrictEqual([]);
    const entries = fake.log.entries;
    const [probe, metadata] = [entries[0]?.sessionId, entries[2]?.sessionId];
    expect(entries.map((entry) => [entry.rpc, entry.sessionId])).toStrictEqual([
      ["AnalyzePlan", probe],
      ["ReleaseSession", probe],
      ["Config", metadata],
      ["ExecutePlan", metadata],
      ["ReleaseSession", metadata],
    ]);
    expect(probe).not.toBe(metadata);
    expect(statementOf(entries[3]?.request ?? {})).toBe("SHOW CURRENT NAMESPACE");
  });

  test("Catalog and Namespace set every session to them before its first use, the metadata session included", async () => {
    fake.log.clear();
    const provider = new SparkProvider(connection(port, { database: "spark_catalog", schema: "default" }));
    try {
      await provider.connect();
      expect((await provider.query("SELECT 1", undefined, "q-place", "scope-place")).rows).toStrictEqual([{ "1": 1 }]);
      await provider.endOpenQueryTransaction("scope-place");
    } finally {
      await provider.disconnect();
    }
    const sent = fake.log.entries
      .filter((entry) => entry.rpc === "Config" || entry.rpc === "ExecutePlan")
      .map((entry) => [entry.sessionId, entry.rpc === "Config" ? "Config" : statementOf(entry.request)]);
    const metadata = sent[0]?.[0];
    const scope = sent[4]?.[0];
    expect(sent).toStrictEqual([
      [metadata, "Config"],
      [metadata, "SET CATALOG 'spark_catalog'"],
      [metadata, "USE NAMESPACE `default`"],
      [metadata, "SHOW CURRENT NAMESPACE"],
      [scope, "Config"],
      [scope, "SET CATALOG 'spark_catalog'"],
      [scope, "USE NAMESPACE `default`"],
      [scope, "SELECT 1"],
    ]);
    expect(scope).not.toBe(metadata);
  });

  test("a setup answer from another server-side session fails connect as a restarted server", async () => {
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      stream: (sql, request) =>
        sql === "SET CATALOG 'spark_catalog'"
          ? streamOf([{ ...commandAnswer(request, SET_ANSWER), server_side_session_id: "server-2" }])
          : undefined,
    });
    const provider = new SparkProvider(connection(1, { database: "spark_catalog" }), {}, script);
    const failure = await failureOf(provider.connect());
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.sessionChanged);
    expect(script.calls.some((call) => statementOf(call.request) === "SHOW CURRENT NAMESPACE")).toBe(false);
  });

  test("a setup statement Spark refuses fails connect with Spark's text and releases the session it opened", async () => {
    fake.log.clear();
    const provider = new SparkProvider(connection(port, { schema: "missing" }));
    const failure = await failureOf(provider.connect());
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as Error).message).toBe("[SCHEMA_NOT_FOUND] The schema `missing` cannot be found.");
    expect(provider.isConnected()).toBe(false);
    const metadata = fake.log.entries.find((entry) => entry.rpc === "Config")?.sessionId;
    expect(
      fake.log.entries.filter((entry) => entry.rpc === "ReleaseSession").map((entry) => entry.sessionId),
    ).toContain(metadata as string);
  });

  test("a query runs in its scope's session, and endOpenQueryTransaction releases that session and answers none", async () => {
    const provider = new SparkProvider(connection(port));
    await provider.connect();
    try {
      fake.log.clear();
      const result = await provider.query("SELECT 1", undefined, "q1", "scope-1");
      expect(result.rows).toStrictEqual([{ "1": 1 }]);
      expect(result.fields).toStrictEqual(["1"]);
      expect(result.rowCount).toBe(1);
      expect(result.columnTypes).toStrictEqual({ "1": "int" });
      expect(result.pagination).toBeUndefined();
      expect(result.warnings).toBeUndefined();
      const scope = fake.log.entries.find((entry) => entry.rpc === "ExecutePlan")?.sessionId;
      expect(await provider.endOpenQueryTransaction("scope-1")).toBe("none");
      expect(
        fake.log.entries.filter((entry) => entry.rpc === "ReleaseSession").map((entry) => entry.sessionId),
      ).toStrictEqual([scope as string]);
      expect(await provider.endOpenQueryTransaction(undefined)).toBe("none");
      expect(await provider.endOpenQueryTransaction("scope-never-used")).toBe("none");
      expect(fake.log.entries.filter((entry) => entry.rpc === "ReleaseSession")).toHaveLength(1);
    } finally {
      await provider.disconnect();
    }
    expect(await provider.endOpenQueryTransaction("scope-1")).toBe("none");
  });

  test("a statement that answers no column carries no column types", async () => {
    const provider = new SparkProvider(connection(port));
    await provider.connect();
    try {
      const result = await provider.query("CREATE TABLE x (id INT)");
      expect({ ...result, executionTime: 0 }).toStrictEqual({ fields: [], rows: [], rowCount: 0, executionTime: 0 });
    } finally {
      await provider.disconnect();
    }
  });

  test("a cut result carries its warning and pagination.wasLimited, with the rows before the cut", async () => {
    const provider = new SparkProvider(connection(port));
    await provider.connect();
    try {
      fake.log.clear();
      const result = await provider.query("BIG INLINE", undefined, "q-cut");
      expect(result.rowCount).toBe(MAX_UNLIMITED_ROWS);
      expect(result.rows).toHaveLength(MAX_UNLIMITED_ROWS);
      expect(result.rows[MAX_UNLIMITED_ROWS - 1]).toStrictEqual({ id: MAX_UNLIMITED_ROWS - 1 });
      expect(result.columnTypes).toStrictEqual({ id: "bigint" });
      expect(result.warnings).toStrictEqual([{ message: SPARK_CUT_WARNINGS.rows }]);
      expect(result.pagination).toStrictEqual({
        limit: MAX_UNLIMITED_ROWS,
        offset: 0,
        hasMore: false,
        totalReturned: MAX_UNLIMITED_ROWS,
        wasLimited: true,
      });
      // A cut asks Spark to stop the statement, once, by the run's tag.
      const [execute] = fake.log.entries.filter((entry) => entry.rpc === "ExecutePlan");
      const interrupts = fake.log.entries.filter((entry) => entry.rpc === "Interrupt");
      expect(interrupts.map((entry) => (entry.request as { operation_tag?: string }).operation_tag)).toStrictEqual(
        execute?.tags as string[],
      );
    } finally {
      await provider.disconnect();
    }
  });

  test("testConnectionWarnings: nothing sent without a token; with one, an unchecked call on a fresh session, released", async () => {
    const plain = new SparkProvider(connection(port));
    await plain.connect();
    fake.log.clear();
    expect(await plain.testConnectionWarnings()).toStrictEqual([]);
    expect(fake.log.entries).toStrictEqual([]);
    await plain.disconnect();

    const tokened = new SparkProvider(connection(port, { password: TOKEN }));
    await tokened.connect();
    try {
      expect(tokened.connectWarnings()).toStrictEqual([]);
      fake.log.clear();
      expect(await tokened.testConnectionWarnings()).toStrictEqual([
        { message: SPARK_ERROR_SENTENCES.tokenUnchecked("127.0.0.1", port) },
      ]);
      const sent = fake.log.entries.map((entry) => ({
        rpc: entry.rpc,
        sessionId: entry.sessionId,
        authorized: "authorization" in entry.metadata,
      }));
      const probe = sent[0]?.sessionId as string;
      expect(sent).toStrictEqual([
        { rpc: "AnalyzePlan", sessionId: probe, authorized: false },
        { rpc: "ReleaseSession", sessionId: probe, authorized: false },
      ]);
      // The connection's own calls carry the token, on its metadata session, never the unchecked call's.
      fake.log.clear();
      await tokened.getHealth();
      expect(fake.log.entries).toHaveLength(1);
      const [pulse] = fake.log.entries;
      expect(pulse?.metadata.authorization).toBe(`Bearer ${TOKEN}`);
      expect(pulse?.sessionId).not.toBe(probe);
    } finally {
      await tokened.disconnect();
    }
  });

  test("testConnectionWarnings answers [] when the server refuses a call without the token", async () => {
    const guarded = await startSparkFake({
      token: TOKEN,
      progressEveryMs: 0,
      statements: { "SHOW CURRENT NAMESPACE": { kind: "command", ipc: CURRENT } },
    });
    try {
      const provider = new SparkProvider(connection(Number(guarded.target.split(":").at(-1)), { password: TOKEN }));
      await provider.connect();
      expect(await provider.testConnectionWarnings()).toStrictEqual([]);
      await provider.disconnect();
    } finally {
      guarded.close();
    }
  });

  test("testConnectionWarnings keeps its caution when the release of the unchecked call's session fails", async () => {
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      unary: (rpc, _request, call) =>
        rpc === "ReleaseSession" && call.metadata.authorization === undefined
          ? Promise.reject(unavailable())
          : undefined,
    });
    const provider = new SparkProvider(connection(1, { password: TOKEN }), {}, script);
    await provider.connect();
    expect(await provider.testConnectionWarnings()).toStrictEqual([
      { message: SPARK_ERROR_SENTENCES.tokenUnchecked("127.0.0.1", 1) },
    ]);
    await provider.disconnect();
  });
});

describe("SparkProvider: a session setup statement on a slow catalog", () => {
  /** grpc-js's text for a deadline that passed once the call had left: it names the server's address. */
  const SENT_DEADLINE = "Deadline exceeded after 10.002s,LB pick: 0.001s,remote_addr=127.0.0.1:15002";
  const SET_HIVE = "SET CATALOG 'hive_prod'";
  const TIMEOUT = 300_000;
  /** This fake's answers, which a test may change between its calls: the fake reads them as each call arrives. */
  const answers: Record<string, SparkFakeAnswer> = {
    "SHOW CURRENT NAMESPACE": { kind: "command", ipc: CURRENT },
    "SELECT 1": { kind: "command", ipc: ONE },
  };
  let slow: SparkFakeServer;
  let slowPort: number;
  beforeAll(async () => {
    slow = await startSparkFake({ progressEveryMs: 0, statements: answers });
    slowPort = Number(slow.target.split(":").at(-1));
  });
  afterAll(() => slow.close());
  /** Every call the fake received, in order: its RPC, an ExecutePlan with its statement, and its session. */
  const received = () =>
    slow.log.entries.map((entry) => [
      entry.rpc === "ExecutePlan" ? `ExecutePlan:${statementOf(entry.request)}` : entry.rpc,
      entry.sessionId,
    ]);

  test("a session's two setup statements share the connection's query timeout from the setup's start, and its Config set keeps the control deadline", async () => {
    let clock = 1_000_000;
    const script = scripted({
      commands: {
        "SHOW CURRENT NAMESPACE": CURRENT,
        "SELECT 1": ONE,
        "SET CATALOG 'spark_catalog'": SET_ANSWER,
        "USE NAMESPACE `default`": SET_ANSWER,
      },
      // The Config set takes 2 s of the clock and SET CATALOG 3 s, so each later step leaves after the setup began.
      unary: (rpc, request) => {
        if (rpc === "Config" && setsConfig(request)) clock += 2_000;
        return undefined;
      },
      stream: (sql) => {
        if (sql === "SET CATALOG 'spark_catalog'") clock += 3_000;
        return undefined;
      },
    });
    const now = spyOn(Date, "now").mockImplementation(() => clock);
    const provider = new SparkProvider(
      connection(1, { database: "spark_catalog", schema: "default" }),
      { queryTimeout: TIMEOUT },
      script,
    );
    try {
      await provider.connect();
      await provider.query("SELECT 1", undefined, "q-setup-deadlines", "scope-setup-deadlines");
      const steps = script.calls
        .filter((call) =>
          call.rpc === "Config"
            ? setsConfig(call.request)
            : /^(?:SET CATALOG|USE NAMESPACE) /.test(statementOf(call.request) ?? ""),
        )
        .map((call) => [
          call.sessionId,
          call.rpc === "Config" ? "Config set" : statementOf(call.request),
          call.at,
          call.deadline,
        ]);
      const [metadata, scope] = [steps[0]?.[0], steps[3]?.[0]];
      expect(steps).toStrictEqual([
        [metadata, "Config set", 1_000_000, 1_000_000 + SPARK_CONTROL_DEADLINE_MS],
        [metadata, "SET CATALOG 'spark_catalog'", 1_002_000, 1_000_000 + TIMEOUT],
        [metadata, "USE NAMESPACE `default`", 1_005_000, 1_000_000 + TIMEOUT],
        [scope, "Config set", 1_005_000, 1_005_000 + SPARK_CONTROL_DEADLINE_MS],
        [scope, "SET CATALOG 'spark_catalog'", 1_007_000, 1_005_000 + TIMEOUT],
        [scope, "USE NAMESPACE `default`", 1_010_000, 1_005_000 + TIMEOUT],
      ]);
      expect(scope).not.toBe(metadata);
      await provider.endOpenQueryTransaction("scope-setup-deadlines");
    } finally {
      now.mockRestore();
      await provider.disconnect();
    }
  });

  test("a SET CATALOG past its deadline fails connect with the setup's sentence, a QueryError, and the metadata session it opened is released", async () => {
    answers[SET_HIVE] = { kind: "error", code: 4, message: SENT_DEADLINE };
    slow.log.clear();
    const provider = new SparkProvider(connection(slowPort, { database: "hive_prod" }), { queryTimeout: TIMEOUT });
    const failure = await failureOf(provider.connect());
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.setupDeadline(SET_HIVE, TIMEOUT));
    expect(lastErrorOf(provider)).toBe(failure as Error);
    expect(provider.isConnected()).toBe(false);
    const sent = received();
    const [probe, metadata] = [sent[0]?.[1], sent[2]?.[1]];
    expect(sent).toStrictEqual([
      ["AnalyzePlan", probe],
      ["ReleaseSession", probe],
      ["Config", metadata],
      [`ExecutePlan:${SET_HIVE}`, metadata],
      ["ReleaseSession", metadata],
    ]);
  });

  test("a SET CATALOG past its deadline fails a request's statement with the setup's sentence, sends neither the statement nor an Interrupt, and leaves the connection up", async () => {
    answers[SET_HIVE] = { kind: "command", ipc: SET_ANSWER };
    const provider = new SparkProvider(connection(slowPort, { database: "hive_prod" }), { queryTimeout: TIMEOUT });
    await provider.connect();
    try {
      answers[SET_HIVE] = { kind: "error", code: 4, message: SENT_DEADLINE };
      slow.log.clear();
      const failure = await failureOf(provider.query("SELECT 1", undefined, "q-slow-catalog", "scope-slow-catalog"));
      expect(failure).toBeInstanceOf(QueryError);
      expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.setupDeadline(SET_HIVE, TIMEOUT));
      expect(provider.isConnected()).toBe(true);
      const scope = slow.log.entries[0]?.sessionId;
      expect(received()).toStrictEqual([
        ["Config", scope],
        [`ExecutePlan:${SET_HIVE}`, scope],
        ["ReleaseSession", scope],
      ]);
      expect(await provider.endOpenQueryTransaction("scope-slow-catalog")).toBe("none");
      expect(slow.log.entries).toHaveLength(3);
    } finally {
      await provider.disconnect();
    }
  });

  test("an UNAVAILABLE on USE NAMESPACE fails connect as the setup's failed connection, never as a server that did not answer", async () => {
    const text = "upstream connect error or disconnect/reset before headers. reset reason: connection termination";
    answers["USE NAMESPACE `analytics`"] = { kind: "error", code: 14, message: text };
    const provider = new SparkProvider(connection(slowPort, { schema: "analytics" }));
    const failure = await failureOf(provider.connect());
    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.setupFailed("USE NAMESPACE `analytics`", text));
    expect(provider.isConnected()).toBe(false);
  });
});

describe("SparkProvider: the object surface on the metadata session", () => {
  test("every object method reads through statements sent on the metadata session only", async () => {
    const provider = new SparkProvider(connection(port));
    fake.log.clear();
    await provider.connect();
    const metadata = fake.log.entries.find((entry) => entry.rpc === "Config")?.sessionId;
    try {
      expect(await provider.listContainers()).toStrictEqual([
        { path: ["spark_catalog"], name: "spark_catalog", level: 0, isSessionDefault: true },
      ]);
      expect(await provider.listContainers(["spark_catalog"])).toStrictEqual([
        { path: ["spark_catalog", "default"], name: "default", level: 1, isSessionDefault: true },
        { path: ["spark_catalog", "studio"], name: "studio", level: 1 },
      ]);
      expect(await provider.listContainers(["spark_catalog", "default"])).toStrictEqual([]);
      expect(await provider.countObjects(["spark_catalog", "default"])).toStrictEqual({
        table: { count: 1 },
        view: { count: 1 },
        function: { count: 1 },
      });
      expect(await provider.listObjects(["spark_catalog", "default"], "table")).toStrictEqual([
        { path: ["spark_catalog", "default", "t"], name: "t", kind: "table" },
      ]);
      const detail = { path: ["spark_catalog", "default", "t"], columns: T_COLUMNS, indexes: [], foreignKeys: [] };
      expect(await provider.describeObject(["spark_catalog", "default", "t"], "table")).toStrictEqual(detail);
      expect(await provider.describeObjects(["spark_catalog", "default"], "table", 5)).toStrictEqual({
        details: [detail],
      });
      expect(await provider.readObjectSource(["spark_catalog", "default", "t"], "table")).toStrictEqual({
        path: ["spark_catalog", "default", "t"],
        kind: "table",
        parts: [
          { id: "ddl", label: "Definition", text: T_DDL, language: "sql", form: "complete", origin: "regenerated" },
        ],
      });
      expect(await provider.getOverview()).toStrictEqual({
        version: "4.2.0",
        uptime: "N/A",
        maxConnections: 0,
        databaseSize: "N/A",
        tableCount: 1,
        tableCountSampledFrom: "the tables of spark_catalog.default, the connection's current namespace",
        indexCount: 0,
      });
    } finally {
      await provider.disconnect();
    }
    const reads = fake.log.entries.filter(
      (entry) => entry.rpc === "ExecutePlan" || entry.rpc === "Config" || entry.rpc === "AnalyzePlan",
    );
    // The probe's version read is the one call before the metadata session exists.
    expect(reads.slice(1).every((entry) => entry.sessionId === metadata)).toBe(true);
  });
});

describe("SparkProvider: one deadline for a bulk column read", () => {
  const TIMEOUT = 1_000;
  const START = 1_000_000;

  /**
   * A connected provider on a test clock, over a channel whose namespace `default` lists `tables`. Each listing answers
   * `listingCost` ms after it was sent, at once unless given, and each DESCRIBE TABLE `cost` ms after it was sent; one
   * whose answer would come past its call's deadline fails at that deadline, as grpc-js fails a call past its deadline.
   * The clock starts at START once connected.
   */
  async function timed(tables: readonly string[], cost: number, listingCost = 0) {
    let now = Date.now();
    const listings: Readonly<Record<string, Uint8Array>> = {
      [`SHOW VIEWS IN ${DEFAULT}`]: listing("viewName", []),
      [`SHOW TABLES IN ${DEFAULT}`]: listing("tableName", tables),
      [`SHOW USER FUNCTIONS IN ${DEFAULT}`]: NO_FUNCTIONS,
    };
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      stream: (sql, request, call) => {
        const answer = sql.startsWith("DESCRIBE TABLE ") ? DESCRIBED : listings[sql];
        if (answer === undefined) return undefined;
        const took = answer === DESCRIBED ? cost : listingCost;
        let reads = 0;
        return {
          read: async () => {
            reads += 1;
            if (reads > 1) return undefined;
            if (now + took > call.deadline.getTime()) {
              now = call.deadline.getTime();
              throw deadlineStatus();
            }
            now += took;
            return commandAnswer(request, answer);
          },
          receivedBytes: 0,
          truncated: false,
          cancel: () => undefined,
        };
      },
    });
    const provider = new SparkProvider(connection(1), { queryTimeout: TIMEOUT }, script);
    await provider.connect();
    now = START;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const sentAt = script.calls.length;
    return {
      provider,
      /** The statements the read sent, each with the time it was sent and its deadline. */
      statements: () =>
        script.calls
          .slice(sentAt)
          .filter((call) => call.rpc === "ExecutePlan")
          .map((call) => ({ sql: statementOf(call.request), at: call.at, deadline: call.deadline })),
      interrupts: () => script.calls.slice(sentAt).filter((call) => call.rpc === "Interrupt").length,
      end: async () => {
        clock.mockRestore();
        await provider.disconnect();
      },
    };
  }

  test("a read whose statements are each fast enough alone but pass the timeout together fails when its time is up between two of them, and sends nothing after", async () => {
    const read = await timed(["a", "b", "c", "d"], TIMEOUT / 2);
    try {
      const failure = await failureOf(read.provider.describeObjects(["spark_catalog", "default"], "table"));
      expect(failure).toBeInstanceOf(QueryError);
      expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.deadlineBeforeSend(TIMEOUT));
      expect(read.statements()).toStrictEqual([
        { sql: `SHOW VIEWS IN ${DEFAULT}`, at: START, deadline: START + TIMEOUT },
        { sql: `SHOW TABLES IN ${DEFAULT}`, at: START, deadline: START + TIMEOUT },
        { sql: `DESCRIBE TABLE ${DEFAULT}.\`a\``, at: START, deadline: START + TIMEOUT },
        { sql: `DESCRIBE TABLE ${DEFAULT}.\`b\``, at: START + TIMEOUT / 2, deadline: START + TIMEOUT },
      ]);
      expect(read.provider.hasRunsInFlight()).toBe(false);
    } finally {
      await read.end();
    }
  });

  test("a read whose time is up during a statement fails with the deadline's sentence, stops that statement, and sends nothing after", async () => {
    const cost = (TIMEOUT * 9) / 20;
    const read = await timed(["a", "b", "c", "d"], cost);
    try {
      const failure = await failureOf(read.provider.describeObjects(["spark_catalog", "default"], "table"));
      expect(failure).toBeInstanceOf(QueryError);
      expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.deadline(TIMEOUT));
      expect(read.statements()).toStrictEqual([
        { sql: `SHOW VIEWS IN ${DEFAULT}`, at: START, deadline: START + TIMEOUT },
        { sql: `SHOW TABLES IN ${DEFAULT}`, at: START, deadline: START + TIMEOUT },
        { sql: `DESCRIBE TABLE ${DEFAULT}.\`a\``, at: START, deadline: START + TIMEOUT },
        { sql: `DESCRIBE TABLE ${DEFAULT}.\`b\``, at: START + cost, deadline: START + TIMEOUT },
        { sql: `DESCRIBE TABLE ${DEFAULT}.\`c\``, at: START + 2 * cost, deadline: START + TIMEOUT },
      ]);
      // The statement that met the deadline is asked to stop; nothing else is.
      expect(read.interrupts()).toBe(1);
      expect(read.provider.hasRunsInFlight()).toBe(false);
    } finally {
      await read.end();
    }
  });

  test("a read well inside its time answers every object, each statement under the read's one deadline", async () => {
    const cost = TIMEOUT / 10;
    const read = await timed(["a", "b", "c"], cost);
    try {
      expect(await read.provider.describeObjects(["spark_catalog", "default"], "table")).toStrictEqual({
        details: [detailOf("a"), detailOf("b"), detailOf("c")],
      });
      expect(read.statements()).toStrictEqual([
        { sql: `SHOW VIEWS IN ${DEFAULT}`, at: START, deadline: START + TIMEOUT },
        { sql: `SHOW TABLES IN ${DEFAULT}`, at: START, deadline: START + TIMEOUT },
        { sql: `DESCRIBE TABLE ${DEFAULT}.\`a\``, at: START, deadline: START + TIMEOUT },
        { sql: `DESCRIBE TABLE ${DEFAULT}.\`b\``, at: START + cost, deadline: START + TIMEOUT },
        { sql: `DESCRIBE TABLE ${DEFAULT}.\`c\``, at: START + 2 * cost, deadline: START + TIMEOUT },
      ]);
      expect(read.interrupts()).toBe(0);
    } finally {
      await read.end();
    }
  });

  test("every other read gives each of its statements the whole timeout, a read of one statement or of several", async () => {
    const cost = TIMEOUT / 2;
    const read = await timed(["a"], cost, cost);
    try {
      expect(await read.provider.describeObject(["spark_catalog", "default", "a"], "table")).toStrictEqual(
        detailOf("a"),
      );
      expect(await read.provider.describeObject(["spark_catalog", "default", "a"], "table")).toStrictEqual(
        detailOf("a"),
      );
      // A count sends three statements, each once the one before answered: under one deadline for the whole count, its
      // last statement would have no time left.
      expect(await read.provider.countObjects(["spark_catalog", "default"])).toStrictEqual({
        table: { count: 1 },
        view: { count: 0 },
        function: { count: 0 },
      });
      expect(read.statements()).toStrictEqual([
        { sql: `DESCRIBE TABLE ${DEFAULT}.\`a\``, at: START, deadline: START + TIMEOUT },
        { sql: `DESCRIBE TABLE ${DEFAULT}.\`a\``, at: START + cost, deadline: START + cost + TIMEOUT },
        { sql: `SHOW VIEWS IN ${DEFAULT}`, at: START + 2 * cost, deadline: START + 2 * cost + TIMEOUT },
        { sql: `SHOW TABLES IN ${DEFAULT}`, at: START + 3 * cost, deadline: START + 3 * cost + TIMEOUT },
        { sql: `SHOW USER FUNCTIONS IN ${DEFAULT}`, at: START + 4 * cost, deadline: START + 4 * cost + TIMEOUT },
      ]);
    } finally {
      await read.end();
    }
  });

  test("a read whose metadata session the server closed under a sent statement is refused at the read's own deadline as a lost metadata session, while the new session's setup goes on", async () => {
    const timeout = 10_000;
    const left = 100;
    const setup = gate();
    const server = laterSetupsHeld(setup.promise);
    let now = Date.now();
    const script = scripted({
      commands: {
        "SHOW CURRENT NAMESPACE": CURRENT,
        [`SHOW VIEWS IN ${DEFAULT}`]: listing("viewName", []),
        [`SHOW TABLES IN ${DEFAULT}`]: listing("tableName", ["a", "b"]),
      },
      unary: server.unary,
      // The server closed the metadata session once all but `left` ms of the read's time had passed.
      stream: (sql) => {
        if (sql !== `DESCRIBE TABLE ${DEFAULT}.\`a\``) return undefined;
        now = START + timeout - left;
        return failingStream(new SparkError("session-closed", SPARK_ERROR_SENTENCES.sessionClosed));
      },
    });
    const provider = new SparkProvider(connection(1), { queryTimeout: timeout }, script);
    await provider.connect();
    now = START;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const sentAt = script.calls.length;
      const from = performance.now();
      const failure = await Promise.race([
        failureOf(provider.describeObjects(["spark_catalog", "default"], "table")),
        later(timeout / 4).then(() => "still waiting at a quarter of the timeout"),
      ]);
      const waited = performance.now() - from;
      expect(failure).toBeInstanceOf(QueryError);
      // DESCRIBE TABLE a was sent once, so the refusal never says that it was not sent.
      expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.metadataSessionLost);
      // Refused once the read's time was up, `left` ms on, not a whole timeout after the new setup began.
      expect(waited).toBeGreaterThanOrEqual(left / 2);
      expect(
        script.calls
          .slice(sentAt)
          .filter((call) => call.rpc === "ExecutePlan")
          .map((call) => statementOf(call.request)),
      ).toStrictEqual([`SHOW VIEWS IN ${DEFAULT}`, `SHOW TABLES IN ${DEFAULT}`, `DESCRIBE TABLE ${DEFAULT}.\`a\``]);
    } finally {
      setup.open();
      clock.mockRestore();
      await provider.disconnect();
    }
  });
});

describe("SparkProvider: the metadata statements in flight on one connection", () => {
  const MAX = SPARK_INTROSPECT_IN_FLIGHT_MAX;
  /** Fails as grpc-js fails a call its client cancelled, once the call's signal aborts. */
  const aborted = (call: SparkWireCall) =>
    new Promise<never>((_, reject) => {
      call.signal.addEventListener("abort", () => reject(clientCancel()), { once: true });
    });
  const NO_NAMESPACES = columnsStream([{ name: "namespace", kind: "utf8", values: [] }]);
  const DEFAULT_COUNTS = { table: { count: 1 }, view: { count: 0 }, function: { count: 0 } };
  const START = 1_000_000;
  const describing = (name: string) => `DESCRIBE TABLE ${DEFAULT}.\`${name}\``;

  /**
   * A connected provider over a channel that counts the statements open on it at once, each from its ExecutePlan until
   * its stream ended or failed. Catalog `lake<n>` lists the namespaces n0 to n<n-1>, and each of those answers that it
   * holds none once `child` settles, or fails as `child` fails. The listings of `default` answer at once, its tables
   * being `tables`, and a DESCRIBE TABLE of a table in it answers once `describe` settles for the table's name.
   */
  async function counted(options: ProviderOptions = {}) {
    let open = 0;
    let most = 0;
    const sent: string[] = [];
    const control: {
      child: (call: SparkWireCall) => Promise<void>;
      describe: (name: string) => Promise<void>;
      tables: readonly string[];
    } = { child: () => later(2), describe: async () => undefined, tables: ["t"] };
    const fixed: Readonly<Record<string, Uint8Array>> = {
      "SHOW CURRENT NAMESPACE": CURRENT,
      [`SHOW VIEWS IN ${DEFAULT}`]: listing("viewName", []),
      [`SHOW USER FUNCTIONS IN ${DEFAULT}`]: NO_FUNCTIONS,
    };
    const answer = async (sql: string, call: SparkWireCall): Promise<Uint8Array> => {
      const top = /^SHOW NAMESPACES IN `lake(\d+)`$/.exec(sql);
      if (top !== null) {
        const names = Array.from({ length: Number(top[1]) }, (_, i) => `n${i}`);
        return columnsStream([{ name: "namespace", kind: "utf8", values: names }]);
      }
      if (/^SHOW NAMESPACES IN `lake\d+`\.`n\d+`$/.test(sql)) {
        await control.child(call);
        return NO_NAMESPACES;
      }
      if (sql === `SHOW TABLES IN ${DEFAULT}`) return listing("tableName", control.tables);
      const described = /^DESCRIBE TABLE `spark_catalog`\.`default`\.`(\w+)`$/.exec(sql);
      if (described !== null) {
        await control.describe(described[1]);
        return DESCRIBED;
      }
      const known = fixed[sql];
      if (known === undefined) throw new Error(`unexpected statement: ${sql}`);
      return known;
    };
    const script = scripted({
      stream: (sql, request, call) => {
        sent.push(sql);
        open += 1;
        most = Math.max(most, open);
        let reads = 0;
        return {
          read: async () => {
            reads += 1;
            if (reads > 1) {
              open -= 1;
              return undefined;
            }
            try {
              return commandAnswer(request, await answer(sql, call));
            } catch (error) {
              open -= 1;
              throw error;
            }
          },
          receivedBytes: 0,
          truncated: false,
          cancel: () => undefined,
        };
      },
    });
    const provider = new SparkProvider(connection(1), options, script);
    await provider.connect();
    return { provider, control, sent, open: () => open, most: () => most };
  }

  /** Two expansions whose namespaces wait on the test take every slot, and no more, then answer whole. */
  async function expectEverySlotFree(read: Awaited<ReturnType<typeof counted>>): Promise<void> {
    const held = gate();
    read.control.child = () => held.promise;
    const both = Promise.all([read.provider.listContainers(["lake9"]), read.provider.listContainers(["lake10"])]);
    await eventually(() => read.open() === MAX);
    await later(5);
    expect(read.open()).toBe(MAX);
    held.open();
    expect((await both).map((containers) => containers.length)).toStrictEqual([9, 10]);
    expect(read.open()).toBe(0);
  }

  test(`two tree expansions and a count at once keep at most ${SPARK_INTROSPECT_IN_FLIGHT_MAX} metadata statements in flight`, async () => {
    const read = await counted();
    try {
      const [lake, other, counts] = await Promise.all([
        read.provider.listContainers(["lake10"]),
        read.provider.listContainers(["lake11"]),
        read.provider.countObjects(["spark_catalog", "default"]),
      ]);
      expect(lake.map((container) => container.path)).toStrictEqual(
        Array.from({ length: 10 }, (_, i) => ["lake10", `n${i}`]),
      );
      expect(other).toHaveLength(11);
      expect(counts).toStrictEqual(DEFAULT_COUNTS);
      expect(read.most()).toBe(MAX);
      expect(read.open()).toBe(0);
    } finally {
      await read.provider.disconnect();
    }
  });

  test.each<[string, () => Error, string]>([
    [
      "failed",
      () =>
        Object.assign(new Error("13 INTERNAL: [SCHEMA_NOT_FOUND] gone"), {
          code: 13,
          details: "[SCHEMA_NOT_FOUND] gone",
        }),
      "[SCHEMA_NOT_FOUND] gone",
    ],
    ["were cancelled", clientCancel, SPARK_ERROR_SENTENCES.cancelled],
  ])("every slot comes back once the statements that held them %s", async (_label, ending, message) => {
    const read = await counted();
    try {
      const release = gate();
      read.control.child = async () => {
        await release.promise;
        throw ending();
      };
      const first = failureOf(read.provider.listContainers([`lake${MAX}`]));
      await eventually(() => read.open() === MAX);
      release.open();
      expect(((await first) as Error).message).toBe(message);
      expect(read.open()).toBe(0);
      await expectEverySlotFree(read);
      expect(read.most()).toBe(MAX);
    } finally {
      await read.provider.disconnect();
    }
  });

  test("a disconnect refuses the statements still waiting for a slot, unsent, and leaves nothing in flight", async () => {
    const read = await counted();
    read.control.child = (call) => aborted(call);
    const walk = failureOf(read.provider.listContainers([`lake${MAX}`]));
    await eventually(() => read.open() === MAX);
    const waiting = [
      failureOf(read.provider.countObjects(["spark_catalog", "default"])),
      failureOf(read.provider.listObjects(["spark_catalog", "default"], "view")),
    ];
    const theirs = () => read.sent.filter((sql) => sql.includes(DEFAULT));
    await later(5);
    expect(theirs()).toStrictEqual([]);
    await read.provider.disconnect();
    for (const refusal of await Promise.all(waiting)) {
      expect(refusal).toBeInstanceOf(QueryCancelledError);
      expect((refusal as Error).message).toBe(SPARK_ERROR_SENTENCES.cancelled);
    }
    expect(await walk).toBeInstanceOf(QueryCancelledError);
    expect(theirs()).toStrictEqual([]);
    expect(read.open()).toBe(0);
    expect(read.provider.hasRunsInFlight()).toBe(false);
  });

  test("a read that goes on once a disconnect began sends no further statement", async () => {
    const read = await counted();
    const held = gate();
    read.control.child = () => held.promise;
    // Nine namespaces: the walk's first batch takes every slot, and its second asks for the ninth one's children.
    const walk = failureOf(read.provider.listContainers([`lake${MAX + 1}`]));
    await eventually(() => read.open() === MAX);
    const closing = read.provider.disconnect();
    // The first batch answers before the disconnect stops it, so the walk goes on to its second batch.
    held.open();
    await closing;
    const failure = await walk;
    expect(failure).toBeInstanceOf(QueryCancelledError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.cancelled);
    expect(read.sent).not.toContain(`SHOW NAMESPACES IN \`lake${MAX + 1}\`.\`n${MAX}\``);
    expect(read.open()).toBe(0);
  });

  test.each<[string, (provider: SparkProvider) => Promise<unknown>]>([
    ["a count", (provider) => provider.countObjects(["spark_catalog", "default"])],
    ["a bulk column read", (provider) => provider.describeObjects(["spark_catalog", "default"], "table")],
  ])(
    "%s still waiting for a slot at its deadline is refused unsent, and every slot stays whole",
    async (_label, start) => {
      const timeout = 100;
      const read = await counted({ queryTimeout: timeout });
      try {
        const held = gate();
        read.control.child = () => held.promise;
        const walk = read.provider.listContainers([`lake${MAX}`]);
        await eventually(() => read.open() === MAX);
        const failure = await failureOf(start(read.provider));
        expect(failure).toBeInstanceOf(QueryError);
        expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.deadlineBeforeSend(timeout));
        expect(read.sent.filter((sql) => sql.includes(DEFAULT))).toStrictEqual([]);
        expect(read.open()).toBe(MAX);
        held.open();
        expect(await walk).toHaveLength(MAX);
        // The refused statement was given no slot: a count runs at once, and one expansion takes every slot again.
        expect(await read.provider.countObjects(["spark_catalog", "default"])).toStrictEqual(DEFAULT_COUNTS);
        const again = gate();
        read.control.child = () => again.promise;
        const expansion = read.provider.listContainers([`lake${MAX}`]);
        await eventually(() => read.open() === MAX);
        again.open();
        expect(await expansion).toHaveLength(MAX);
      } finally {
        await read.provider.disconnect();
      }
    },
  );

  test("a bulk column read's later statement still waiting for a slot is refused unsent at the read's own deadline", async () => {
    const timeout = 10_000;
    const left = 100;
    const read = await counted({ queryTimeout: timeout });
    let now = START;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const children = gate();
    try {
      read.control.tables = ["a", "b"];
      const first = gate();
      read.control.describe = (name) => (name === "a" ? first.promise : Promise.resolve());
      read.control.child = () => children.promise;
      const bulk = failureOf(read.provider.describeObjects(["spark_catalog", "default"], "table"));
      await eventually(() => read.sent.includes(describing("a")));
      // A walk takes every other slot, and its last namespace waits for one.
      const walk = read.provider.listContainers([`lake${MAX}`]);
      await eventually(() => read.open() === MAX);
      // DESCRIBE a answers with `left` ms of the read's time left. Its slot goes to the namespace, which asked first, so
      // DESCRIBE b waits for a slot from then on.
      now = START + timeout - left;
      const from = performance.now();
      first.open();
      const failure = await Promise.race([
        bulk,
        later(timeout / 4).then(() => "still waiting at a quarter of the timeout"),
      ]);
      const waited = performance.now() - from;
      expect(failure).toBeInstanceOf(QueryError);
      expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.deadlineBeforeSend(timeout));
      expect(read.sent).not.toContain(describing("b"));
      // Refused once the read's time was up, `left` ms on, not a whole timeout after its wait began.
      expect(waited).toBeGreaterThanOrEqual(left / 2);
      children.open();
      expect(await walk).toHaveLength(MAX);
    } finally {
      children.open();
      clock.mockRestore();
      await read.provider.disconnect();
    }
  });

  test("statements waiting for a slot are given one in the order they asked for it", async () => {
    const read = await counted();
    const children: ReturnType<typeof gate>[] = [];
    try {
      read.control.child = () => {
        const held = gate();
        children.push(held);
        return held.promise;
      };
      const first = gate();
      read.control.describe = (name) => (name === "a" ? first.promise : Promise.resolve());
      const walk = read.provider.listContainers([`lake${MAX}`]);
      await eventually(() => read.open() === MAX);
      expect(children).toHaveLength(MAX);
      const a = read.provider.describeObject(["spark_catalog", "default", "a"], "table");
      const b = read.provider.describeObject(["spark_catalog", "default", "b"], "table");
      const described = () => read.sent.filter((sql) => sql.startsWith("DESCRIBE TABLE "));
      await later(5);
      expect(described()).toStrictEqual([]);
      // One namespace answers: its slot goes to DESCRIBE a, which asked first, and DESCRIBE b waits on.
      children[0].open();
      await eventually(() => described().length > 0);
      await later(5);
      expect(described()).toStrictEqual([describing("a")]);
      // DESCRIBE a answers, and its slot goes to DESCRIBE b.
      first.open();
      expect(await a).toStrictEqual(detailOf("a"));
      expect(await b).toStrictEqual(detailOf("b"));
      expect(described()).toStrictEqual([describing("a"), describing("b")]);
      for (const held of children) held.open();
      expect(await walk).toHaveLength(MAX);
    } finally {
      for (const held of children) held.open();
      await read.provider.disconnect();
    }
  });

  test("a statement given a slot before its deadline leaves the statements still waiting alone once that deadline passes", async () => {
    const timeout = 10_000;
    const left = 500;
    const read = await counted({ queryTimeout: timeout });
    let now = START;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const children: ReturnType<typeof gate>[] = [];
    const first = gate();
    const second = gate();
    try {
      read.control.tables = ["a", "b"];
      read.control.describe = (name) =>
        name === "a" ? first.promise : name === "b" ? second.promise : Promise.resolve();
      read.control.child = () => {
        const child = gate();
        children.push(child);
        return child.promise;
      };
      // A bulk column read holds a slot with DESCRIBE a while a walk takes every other one.
      const bulk = read.provider.describeObjects(["spark_catalog", "default"], "table");
      await eventually(() => read.sent.includes(describing("a")));
      const walk = read.provider.listContainers([`lake${MAX}`]);
      await eventually(() => read.open() === MAX);
      // DESCRIBE a answers with `left` ms of the read's time left: its slot goes to the walk's last namespace, and
      // DESCRIBE b waits for one until the read's deadline.
      now = START + timeout - left;
      first.open();
      await later(5);
      // A namespace answers well before that deadline: its slot goes to DESCRIBE b, which keeps it.
      children[0].open();
      await eventually(() => read.sent.includes(describing("b")));
      // A statement of another read waits behind DESCRIBE b until past the deadline DESCRIBE b waited under.
      const other = read.provider.describeObject(["spark_catalog", "default", "t"], "table");
      await later(left + 250);
      // Another namespace answers, and its slot goes to the statement still waiting.
      children[1].open();
      expect(
        await Promise.race([other, later(timeout / 4).then(() => "still waiting at a quarter of the timeout")]),
      ).toStrictEqual(detailOf("t"));
      second.open();
      expect(await bulk).toStrictEqual({ details: [detailOf("a"), detailOf("b")] });
      for (const child of children) child.open();
      expect(await walk).toHaveLength(MAX);
    } finally {
      for (const child of children) child.open();
      first.open();
      second.open();
      clock.mockRestore();
      await read.provider.disconnect();
    }
  });
});

describe("SparkProvider: refusals before any call", () => {
  test("bound parameters, a script block, a Unicode space and an address Studio reads differently are refused, and nothing is sent", async () => {
    const script = scripted({ commands: { "SHOW CURRENT NAMESPACE": CURRENT, "SELECT 1": ONE } });
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    const sent = script.calls.length;
    await expect(provider.query("SELECT ?", [1])).rejects.toThrow(SPARK_STATEMENT_SENTENCES.boundParameters);
    await expect(provider.query("BEGIN SELECT 1; END")).rejects.toThrow(SPARK_STATEMENT_SENTENCES.scriptBlock);
    await expect(provider.query("SELECT 1")).rejects.toThrow(SPARK_STATEMENT_SENTENCES.unicodeSpace);
    await expect(provider.query("ADD JAR hdfs://nn/a--b.jar")).rejects.toThrow(SPARK_STATEMENT_SENTENCES.uriForm);
    const bound = await failureOf(provider.query("SELECT ?", [1]));
    expect(bound).toBeInstanceOf(QueryError);
    expect([(bound as QueryError).provider, (bound as QueryError).query]).toStrictEqual(["spark", "SELECT ?"]);
    const block = await failureOf(provider.query("BEGIN SELECT 1; END"));
    expect(block).toBeInstanceOf(QueryError);
    expect([(block as QueryError).provider, (block as QueryError).query]).toStrictEqual([
      "spark",
      "BEGIN SELECT 1; END",
    ]);
    expect(script.calls.length).toBe(sent);
    // An empty parameter list carries no bound parameter, so the statement runs.
    expect((await provider.query("SELECT 1", [])).rows).toStrictEqual([{ "1": 1 }]);
    await provider.disconnect();
  });

  test("runMaintenance is refused, and each object method refuses a wrong-depth path or an unknown kind before any statement", async () => {
    const script = scripted({ commands: { "SHOW CURRENT NAMESPACE": CURRENT } });
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    const sent = script.calls.length;
    // Called as the maintenance route calls any provider, with an operation.
    await expect((provider as DatabaseProvider).runMaintenance("analyze")).rejects.toThrow(
      SPARK_PROVIDER_SENTENCES.maintenanceRefused,
    );
    const containerShape = "An Apache Spark container path is [catalog, namespace]";
    await expect(provider.listObjects(["spark_catalog"], "table")).rejects.toThrow(containerShape);
    await expect(provider.countObjects(["spark_catalog", "default", "x"])).rejects.toThrow(containerShape);
    await expect(provider.describeObjects(["spark_catalog"], "table")).rejects.toThrow(containerShape);
    const objectShape = 'An Apache Spark "table" path is [catalog, namespace, name]';
    await expect(provider.describeObject(["spark_catalog", "t"], "table")).rejects.toThrow(objectShape);
    await expect(provider.readObjectSource(["spark_catalog", "default"], "view")).rejects.toThrow(
      'An Apache Spark "view" path is [catalog, namespace, name]',
    );
    await expect(provider.describeObject(["spark_catalog", "default", "t"], "index")).rejects.toThrow(
      SPARK_INTROSPECT_SENTENCES.noKind("index"),
    );
    await expect(provider.readObjectSource(["spark_catalog", "default", "t"], "index")).rejects.toBeInstanceOf(
      QueryError,
    );
    expect(script.calls.length).toBe(sent);
    expect(await provider.listContainers(["spark_catalog", "default"])).toStrictEqual([]);
    await provider.disconnect();
  });

  test("a config the option checks refuse fails connect as a DatabaseConfigError with nothing dialled", async () => {
    let dialled = 0;
    const script = scripted({
      opening: () => {
        dialled += 1;
      },
    });
    const provider = new SparkProvider(connection(1, { user: "alice" }), {}, script);
    await expect(provider.connect()).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(dialled).toBe(0);
    expect(script.calls).toStrictEqual([]);
    expect(provider.isConnected()).toBe(false);
  });

  test("a transport that cannot open fails connect with the client's sentence and repeats nothing of its error", async () => {
    const script = scripted({
      opening: () => {
        throw new Error(`the channel could not open with authorization Bearer ${TOKEN}`);
      },
    });
    const provider = new SparkProvider(connection(1, { password: TOKEN }), {}, script);
    const failure = await failureOf(provider.connect());
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.localClientError);
    expect(script.calls).toStrictEqual([]);
    expect(provider.isConnected()).toBe(false);
  });
});

describe("SparkProvider: the version floor and the probe session", () => {
  test("two refused connects of two instances for one connection send one probe session id to a server without ReleaseSession", async () => {
    const script = scripted({
      version: "3.5.9",
      unary: (rpc) => (rpc === "ReleaseSession" ? Promise.reject(unimplemented()) : undefined),
    });
    const config = connection(1, { id: "probe-35" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const provider = new SparkProvider(config, {}, script);
      // oxlint-disable-next-line no-await-in-loop -- the connects are sequential on purpose.
      await expect(provider.connect()).rejects.toThrow(SPARK_ERROR_SENTENCES.versionTooOld("3.5.9"));
      // oxlint-disable-next-line no-await-in-loop -- the connects are sequential on purpose.
      await expect(provider.connect()).rejects.toBeInstanceOf(ConnectionError);
      expect(provider.isConnected()).toBe(false);
    }
    const probes = new Set(script.calls.filter((call) => call.rpc === "AnalyzePlan").map((call) => call.sessionId));
    expect(probes.size).toBe(1);
    expect(script.calls.filter((call) => call.rpc === "AnalyzePlan")).toHaveLength(4);
    expect(script.calls.some((call) => call.rpc === "Config" || call.rpc === "ExecutePlan")).toBe(false);
    expect(script.closed()).toBe(4);
  });

  test("a refused connect against a server that offers ReleaseSession releases its probe session", async () => {
    const script = scripted({ version: "4.0.4" });
    const provider = new SparkProvider(connection(1, { id: "probe-40" }), {}, script);
    await expect(provider.connect()).rejects.toThrow(SPARK_ERROR_SENTENCES.versionTooOld("4.0.4"));
    await expect(provider.connect()).rejects.toThrow(SPARK_ERROR_SENTENCES.versionTooOld("4.0.4"));
    const probes = script.calls.filter((call) => call.rpc === "AnalyzePlan").map((call) => call.sessionId);
    expect(probes).toHaveLength(2);
    // A released id is closed on the server, so the next connect reads the version on a new one.
    expect(probes[1]).not.toBe(probes[0]);
    expect(script.calls.filter((call) => call.rpc === "ReleaseSession").map((call) => call.sessionId)).toStrictEqual(
      probes,
    );
  });

  test("a remembered probe that a later refused connect releases is forgotten, so no connect reads on a released id", async () => {
    let offersRelease = false;
    let version = "3.5.9";
    const script = scripted({
      unary: (rpc) => {
        if (rpc === "AnalyzePlan") return Promise.resolve({ spark_version: { version } });
        return rpc === "ReleaseSession" && !offersRelease ? Promise.reject(unimplemented()) : undefined;
      },
    });
    const config = connection(1, { id: "probe-upgraded" });
    await expect(new SparkProvider(config, {}, script).connect()).rejects.toThrow(
      SPARK_ERROR_SENTENCES.versionTooOld("3.5.9"),
    );
    // The server now runs 4.0.4, which offers ReleaseSession and is still below the floor.
    offersRelease = true;
    version = "4.0.4";
    await expect(new SparkProvider(config, {}, script).connect()).rejects.toThrow(
      SPARK_ERROR_SENTENCES.versionTooOld("4.0.4"),
    );
    await expect(new SparkProvider(config, {}, script).connect()).rejects.toThrow(
      SPARK_ERROR_SENTENCES.versionTooOld("4.0.4"),
    );
    const probes = script.calls.filter((call) => call.rpc === "AnalyzePlan").map((call) => call.sessionId);
    expect(probes).toHaveLength(3);
    expect(probes[1]).toBe(probes[0] as string);
    expect(probes[2]).not.toBe(probes[0] as string);
  });

  test("a connect that meets the floor forgets the remembered probe, even when the probe's release fails", async () => {
    let version = "3.5.9";
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      unary: (rpc, request) => {
        if (rpc === "AnalyzePlan") return Promise.resolve({ spark_version: { version } });
        if (rpc !== "ReleaseSession") return undefined;
        if (version === "3.5.9") return Promise.reject(unimplemented());
        // On the upgraded server only the probe's release fails.
        return sessionOf(request) === firstProbe() ? Promise.reject(unavailable()) : undefined;
      },
    });
    const probes = () => script.calls.filter((call) => call.rpc === "AnalyzePlan").map((call) => call.sessionId);
    const firstProbe = () => probes()[0];
    const config = connection(1, { id: "probe-floor-met" });
    await expect(new SparkProvider(config, {}, script).connect()).rejects.toBeInstanceOf(ConnectionError);
    version = "4.2.0";
    const upgraded = new SparkProvider(config, {}, script);
    await upgraded.connect();
    await upgraded.disconnect();
    version = "3.5.9";
    await expect(new SparkProvider(config, {}, script).connect()).rejects.toBeInstanceOf(ConnectionError);
    const [first, second, third] = probes();
    expect(second).toBe(first as string);
    expect(third).not.toBe(first as string);
  });

  test("the remembered probe sessions are bounded: past the bound the oldest is dropped", async () => {
    const script = scripted({
      version: "3.5.9",
      unary: (rpc) => (rpc === "ReleaseSession" ? Promise.reject(unimplemented()) : undefined),
    });
    const refuse = async (id: string): Promise<string> => {
      const before = script.calls.length;
      await expect(new SparkProvider(connection(1, { id }), {}, script).connect()).rejects.toBeInstanceOf(
        ConnectionError,
      );
      return script.calls.slice(before).find((call) => call.rpc === "AnalyzePlan")?.sessionId as string;
    };
    const first: string[] = [];
    for (let index = 0; index <= SPARK_REFUSED_SESSION_MAP_MAX; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each connect is remembered in order, so they run one at a time.
      first.push(await refuse(`bound-${index}`));
    }
    expect(new Set(first).size).toBe(SPARK_REFUSED_SESSION_MAP_MAX + 1);
    // The second oldest is still remembered; the oldest was dropped, so its next connect uses a new session id.
    expect(await refuse("bound-1")).toBe(first[1] as string);
    const again = await refuse("bound-0");
    expect(first.includes(again)).toBe(false);
  });

  test("refused connects through a tunnel whose local port changes on every attempt read the version on one probe session id", async () => {
    const script = scripted({
      version: "3.5.9",
      unary: (rpc) => (rpc === "ReleaseSession" ? Promise.reject(unimplemented()) : undefined),
    });
    const farEnd = { host: "spark.remote", port: 15002 };
    // Each attempt's tunnel listens on a new local port; the far end stays the same.
    for (const localPort of [40001, 40002]) {
      const provider = new SparkProvider(tunnelled("probe-tunnel", localPort, farEnd), {}, script);
      // oxlint-disable-next-line no-await-in-loop -- the connects are sequential on purpose.
      await expect(provider.connect()).rejects.toThrow(SPARK_ERROR_SENTENCES.versionTooOld("3.5.9"));
    }
    const probes = script.calls.filter((call) => call.rpc === "AnalyzePlan").map((call) => call.sessionId);
    expect(probes).toHaveLength(2);
    expect(probes[1]).toBe(probes[0] as string);
  });

  test("refused connects of one connection to different far ends through one local port use different probe session ids", async () => {
    const script = scripted({
      version: "3.5.9",
      unary: (rpc) => (rpc === "ReleaseSession" ? Promise.reject(unimplemented()) : undefined),
    });
    const probeOf = async (farEnd: TunnelFarEnd): Promise<string> => {
      const before = script.calls.length;
      const provider = new SparkProvider(tunnelled("probe-far-ends", 40001, farEnd), {}, script);
      await expect(provider.connect()).rejects.toBeInstanceOf(ConnectionError);
      return script.calls.slice(before).find((call) => call.rpc === "AnalyzePlan")?.sessionId as string;
    };
    const probes = [
      await probeOf({ host: "spark.remote", port: 15002 }),
      await probeOf({ host: "spark.other", port: 15002 }),
      await probeOf({ host: "spark.remote", port: 15003 }),
      // Run together, this host and port would spell the first far end's host and port.
      await probeOf({ host: "spark.remote1", port: 5002 }),
    ];
    expect(new Set(probes).size).toBe(4);
  });

  test("refused connects of two connections whose id and host would run together use different probe session ids", async () => {
    const script = scripted({
      version: "3.5.9",
      unary: (rpc) => (rpc === "ReleaseSession" ? Promise.reject(unimplemented()) : undefined),
    });
    const probeOf = async (id: string, host: string): Promise<string> => {
      const before = script.calls.length;
      const provider = new SparkProvider(connection(15002, { id, host }), {}, script);
      await expect(provider.connect()).rejects.toThrow(SPARK_ERROR_SENTENCES.versionTooOld("3.5.9"));
      return script.calls.slice(before).find((call) => call.rpc === "AnalyzePlan")?.sessionId as string;
    };
    const probes = [
      await probeOf("probe-x", "1a.remote"),
      // Run together, this id and host would spell the first connection's id and host.
      await probeOf("probe-x1", "a.remote"),
    ];
    expect(new Set(probes).size).toBe(2);
  });

  test("a failed release of the metadata session logs one warning holding only its category, never the server's text or the token", async () => {
    let failRelease = false;
    const script = scripted({
      unary: (rpc) =>
        failRelease && rpc === "ReleaseSession"
          ? Promise.reject(
              Object.assign(new Error("13 INTERNAL: release-server-detail"), {
                code: 13,
                details: "release-server-detail",
              }),
            )
          : undefined,
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
    });
    const provider = new SparkProvider(connection(1, { password: TOKEN }), {}, script);
    await provider.connect();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      failRelease = true;
      await provider.disconnect();
      expect(warn).toHaveBeenCalledTimes(1);
      const [message, fields] = warn.mock.calls[0] ?? [];
      expect(message).toBe("A Spark session release failed");
      expect(fields).toStrictEqual({ category: "spark" });
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain("release-server-detail");
      expect(logged).not.toContain(TOKEN);
      expect(provider.isConnected()).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("a probe release that fails does not fail a connect whose version meets the floor", async () => {
    let probeReleased = false;
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      unary: (rpc) => {
        if (rpc !== "ReleaseSession" || probeReleased) return undefined;
        probeReleased = true;
        return Promise.reject(unavailable());
      },
    });
    const provider = new SparkProvider(connection(1, { id: "probe-release-fails" }), {}, script);
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    await provider.disconnect();
  });

  test("unreadable version text is refused naming it", async () => {
    const script = scripted({ version: "spark-unknown" });
    const provider = new SparkProvider(connection(1), {}, script);
    const failure = await failureOf(provider.connect());
    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.versionUnreadable("spark-unknown"));
  });

  test("a second connect replaces and closes the first, and a failure at each step closes what it opened", async () => {
    const script = scripted({ commands: { "SHOW CURRENT NAMESPACE": CURRENT } });
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    const firstMetadata = script.calls.find((call) => call.rpc === "Config")?.sessionId;
    await provider.connect();
    expect(script.closed()).toBe(1);
    expect(provider.isConnected()).toBe(true);
    // Closing the first connection released its metadata session.
    expect(script.calls.filter((call) => call.rpc === "ReleaseSession").map((call) => call.sessionId)).toContain(
      firstMetadata as string,
    );
    await provider.disconnect();
    for (const failing of ["AnalyzePlan", "Config", "ExecutePlan"]) {
      const broken = scripted({
        unary: (rpc) => (rpc === failing ? Promise.reject(unavailable()) : undefined),
        stream: (sql) =>
          failing === "ExecutePlan" && sql === "SHOW CURRENT NAMESPACE" ? failingStream(unavailable()) : undefined,
      });
      const failed = new SparkProvider(connection(1), {}, broken);
      // oxlint-disable-next-line no-await-in-loop -- one broken step per connect.
      const failure = await failureOf(failed.connect());
      expect(failure).toBeInstanceOf(ConnectionError);
      expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.notConnected("127.0.0.1", 1));
      expect(broken.closed()).toBe(1);
      expect(failed.isConnected()).toBe(false);
      expect(failed.hasRunsInFlight()).toBe(false);
    }
  });

  test("a connect a second connect displaced ends cancelled and leaves the second connected", async () => {
    const first = gate();
    let shows = 0;
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      stream: (sql, request, call) => {
        if (sql !== "SHOW CURRENT NAMESPACE") return undefined;
        shows += 1;
        return shows === 1 ? heldStream(request, call, CURRENT, first.promise) : undefined;
      },
    });
    const provider = new SparkProvider(connection(1), {}, script);
    const displaced = failureOf(provider.connect());
    await eventually(() => shows === 1);
    await provider.connect();
    first.open();
    expect(await displaced).toBeInstanceOf(QueryCancelledError);
    expect(provider.isConnected()).toBe(true);
    expect(script.closed()).toBe(1);
    await provider.disconnect();
    expect(script.closed()).toBe(2);
  });

  test("a second connect the version floor refuses closes the first connection too, so nothing stays open behind a disconnected provider", async () => {
    let version = "4.2.0";
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT, "SELECT 1": ONE },
      unary: (rpc) => (rpc === "AnalyzePlan" ? Promise.resolve({ spark_version: { version } }) : undefined),
    });
    const channels = channelsOf(script);
    const provider = new SparkProvider(connection(1), {}, channels);
    await provider.connect();
    await provider.query("SELECT 1", undefined, "q-first", "scope-first");
    // The first connection's metadata session and the scope's session, each set up by one Config call.
    const sessions = script.calls.filter((call) => call.rpc === "Config").map((call) => call.sessionId);
    expect(sessions).toHaveLength(2);
    // The server behind the same address now runs a version below the floor.
    version = "3.5.9";
    const before = script.calls.length;
    const failure = await failureOf(provider.connect());
    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.versionTooOld("3.5.9"));
    const sent = script.calls.slice(before);
    const probe = sent.find((call) => call.rpc === "AnalyzePlan")?.sessionId as string;
    expect(sent.filter((call) => call.rpc === "ReleaseSession").map((call) => call.sessionId)).toStrictEqual([
      probe,
      ...sessions,
    ]);
    // The first connection's channel and the refused connect's own.
    expect(channels.closed()).toStrictEqual([true, true]);
    expect(provider.isConnected()).toBe(false);
    expect(provider.hasRunsInFlight()).toBe(false);
    expect(provider.connectWarnings()).toStrictEqual([]);
    const settled = script.calls.length;
    const refused = await failureOf(provider.query("SELECT 1"));
    expect(refused).toBeInstanceOf(DatabaseConfigError);
    expect((refused as Error).message).toBe("Provider is not connected. Call connect() first.");
    expect(await provider.endOpenQueryTransaction("scope-first")).toBe("none");
    expect(script.calls.length).toBe(settled);
  });

  test("a failed release of the first connection's session leaves the refusal of the connect that closed it as its failure", async () => {
    let version = "4.2.0";
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      unary: (rpc, request) => {
        if (rpc === "AnalyzePlan") return Promise.resolve({ spark_version: { version } });
        return rpc === "ReleaseSession" && sessionOf(request) === metadata()
          ? Promise.reject(unavailable())
          : undefined;
      },
    });
    const metadata = () => script.calls.find((call) => call.rpc === "Config")?.sessionId;
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    version = "3.5.9";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const failure = await failureOf(provider.connect());
      expect(failure).toBeInstanceOf(ConnectionError);
      expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.versionTooOld("3.5.9"));
      // The release was sent and failed, and its warning is the one trace it leaves.
      expect(warn.mock.calls).toStrictEqual([["A Spark session release failed", { category: "not-connected" }]]);
      expect(provider.isConnected()).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("a third connect that completes while a failed second connect is still closing keeps its connection and its state", async () => {
    const release = gate();
    let shows = 0;
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT, "SELECT 1": ONE },
      stream: (sql) => {
        if (sql !== "SHOW CURRENT NAMESPACE") return undefined;
        shows += 1;
        return shows === 2 ? failingStream(unavailable()) : undefined;
      },
      unary: (rpc, request) =>
        rpc === "ReleaseSession" && sessionOf(request) === secondMetadata()
          ? release.promise.then(() => ({}))
          : undefined,
    });
    const secondMetadata = () => script.calls.filter((call) => call.rpc === "Config")[1]?.sessionId;
    const channels = channelsOf(script);
    const provider = new SparkProvider(connection(1), {}, channels);
    await provider.connect();
    const failed = failureOf(provider.connect());
    // The failed connect is closing what it opened: the release of its metadata session waits on the test.
    await eventually(() =>
      script.calls.some((call) => call.rpc === "ReleaseSession" && call.sessionId === secondMetadata()),
    );
    expect(provider.isConnected()).toBe(false);
    await provider.connect();
    release.open();
    const failure = await failed;
    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.notConnected("127.0.0.1", 1));
    // The first and the second closed by the failed connect, the third open.
    expect(channels.closed()).toStrictEqual([true, true, false]);
    expect(provider.isConnected()).toBe(true);
    expect((await provider.query("SELECT 1")).rows).toStrictEqual([{ "1": 1 }]);
    await provider.disconnect();
  });

  test("a disconnect while a failed second connect still closes its own connection finds the first connection closed and its sessions released, and answers once that close ended", async () => {
    const release = gate();
    let shows = 0;
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT, "SELECT 1": ONE },
      stream: (sql) => {
        if (sql !== "SHOW CURRENT NAMESPACE") return undefined;
        shows += 1;
        return shows === 2 ? failingStream(unavailable()) : undefined;
      },
      unary: (rpc, request) =>
        rpc === "ReleaseSession" && sessionOf(request) === secondMetadata()
          ? release.promise.then(() => ({}))
          : undefined,
    });
    // The first connection's metadata session, the scope's session, then the second connect's metadata session.
    const sessions = () => script.calls.filter((call) => call.rpc === "Config").map((call) => call.sessionId);
    const secondMetadata = () => sessions()[2];
    const released = () => script.calls.filter((call) => call.rpc === "ReleaseSession").map((call) => call.sessionId);
    const channels = channelsOf(script);
    const provider = new SparkProvider(connection(1), {}, channels);
    await provider.connect();
    await provider.query("SELECT 1", undefined, "q-first", "scope-first");
    const first = sessions();
    expect(first).toHaveLength(2);
    const failed = failureOf(provider.connect());
    // The failed connect is closing what it opened: the release of its metadata session waits on the test.
    await eventually(() =>
      script.calls.some((call) => call.rpc === "ReleaseSession" && call.sessionId === secondMetadata()),
    );
    let disconnected = false;
    const closing = provider.disconnect().then(() => {
      disconnected = true;
    });
    await later(20);
    expect(disconnected).toBe(false);
    expect(channels.closed()).toStrictEqual([true, false]);
    expect(released().filter((id) => first.includes(id))).toStrictEqual(first);
    release.open();
    await closing;
    expect(channels.closed()).toStrictEqual([true, true]);
    const failure = await failed;
    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.notConnected("127.0.0.1", 1));
    expect(channels.closed()).toStrictEqual([true, true]);
    expect(provider.isConnected()).toBe(false);
    expect(provider.hasRunsInFlight()).toBe(false);
  });

  test("a connect displaced while it replaced a live connection leaves the connect that displaced it connected", async () => {
    const held = gate();
    let shows = 0;
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT, "SELECT 1": ONE },
      stream: (sql, request, call) => {
        if (sql !== "SHOW CURRENT NAMESPACE") return undefined;
        shows += 1;
        // The second connect's namespace read waits on the test.
        return shows === 2 ? heldStream(request, call, CURRENT, held.promise) : undefined;
      },
    });
    const channels = channelsOf(script);
    const provider = new SparkProvider(connection(1), {}, channels);
    await provider.connect();
    const displaced = failureOf(provider.connect());
    await eventually(() => shows === 2);
    await provider.connect();
    held.open();
    expect(await displaced).toBeInstanceOf(QueryCancelledError);
    // The first was closed by the third connect, which replaced it, and the second by its own failure.
    expect(channels.closed()).toStrictEqual([true, true, false]);
    expect(provider.isConnected()).toBe(true);
    expect((await provider.query("SELECT 1")).rows).toStrictEqual([{ "1": 1 }]);
    await provider.disconnect();
    expect(channels.closed()).toStrictEqual([true, true, true]);
  });

  test("a disconnect during connect ends the connect cancelled, its namespace read stopped once", async () => {
    const never = gate();
    const script = scripted({
      stream: (sql, request, call) =>
        sql === "SHOW CURRENT NAMESPACE" ? heldStream(request, call, CURRENT, never.promise) : undefined,
    });
    const provider = new SparkProvider(connection(1), {}, script);
    const pending = failureOf(provider.connect());
    await eventually(() => script.calls.some((call) => call.rpc === "ExecutePlan"));
    await provider.disconnect();
    expect(await pending).toBeInstanceOf(QueryCancelledError);
    expect(provider.isConnected()).toBe(false);
    expect(provider.hasRunsInFlight()).toBe(false);
    expect(script.calls.filter((call) => call.rpc === "Interrupt")).toHaveLength(1);
    expect(script.closed()).toBe(1);
  });

  test("a connect a disconnect cuts at once ends cancelled and records no reachability error, though the server answers", async () => {
    const provider = new SparkProvider(connection(port));
    const connecting = failureOf(provider.connect());
    await provider.disconnect();
    const failure = await connecting;
    expect(failure).toBeInstanceOf(QueryCancelledError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.cancelled);
    expect(lastErrorOf(provider)).toBe(failure as Error);
    expect(provider.isConnected()).toBe(false);
    expect(provider.hasRunsInFlight()).toBe(false);
    // The server answered all along: the next connect succeeds.
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    await provider.disconnect();
  });

  test("a connect a second connect displaced ends cancelled though its own call then fails as unreachable, and leaves the second connect's state alone", async () => {
    const probe = gate();
    const namespace = gate();
    let versions = 0;
    const script = scripted({
      unary: (rpc) => {
        if (rpc !== "AnalyzePlan") return undefined;
        versions += 1;
        // The first connect's version read fails as an unreachable server's would.
        return versions === 1 ? probe.promise.then(() => Promise.reject(unavailable())) : undefined;
      },
      // The second connect's namespace read waits on the test, so the first fails while the second still connects.
      stream: (sql, request, call) =>
        sql === "SHOW CURRENT NAMESPACE" ? heldStream(request, call, CURRENT, namespace.promise) : undefined,
    });
    const channels = channelsOf(script);
    const provider = new SparkProvider(connection(1), {}, channels);
    const displaced = failureOf(provider.connect());
    await eventually(() => versions === 1);
    const second = provider.connect();
    await eventually(() => script.calls.some((call) => statementOf(call.request) === "SHOW CURRENT NAMESPACE"));
    probe.open();
    const failure = await displaced;
    expect(failure).toBeInstanceOf(QueryCancelledError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.cancelled);
    expect(lastErrorOf(provider)).toBeUndefined();
    expect(channels.closed()).toStrictEqual([true, false]);
    namespace.open();
    await second;
    expect(provider.isConnected()).toBe(true);
    expect(lastErrorOf(provider)).toBeUndefined();
    await provider.disconnect();
  });

  test("a second connect then a disconnect while the first connect still reads its version close each connection once its probe is released, the disconnect answers only then, and only the probes' releases follow", async () => {
    const firstVersion = gate();
    let versions = 0;
    const script = scripted({
      commands: {
        "SHOW CURRENT NAMESPACE": CURRENT,
        "SET CATALOG 'spark_catalog'": SET_ANSWER,
        "USE NAMESPACE `default`": SET_ANSWER,
      },
      unary: (rpc, request) => {
        if (rpc !== "AnalyzePlan") return undefined;
        versions += 1;
        // The first connect's version read waits on the test.
        const answer = { session_id: sessionOf(request), spark_version: { version: "4.2.0" } };
        return versions === 1 ? firstVersion.promise.then(() => answer) : undefined;
      },
    });
    const channels = channelsOf(script);
    const provider = new SparkProvider(connection(1, { database: "spark_catalog", schema: "default" }), {}, channels);
    const first = failureOf(provider.connect());
    await eventually(() => versions === 1);
    const second = failureOf(provider.connect());
    const at = script.calls.length;
    let disconnected = false;
    const closing = provider.disconnect().then(() => {
      disconnected = true;
    });
    await later(20);
    // The second connection closed once its probe was released; the first still waits for its version answer.
    expect(disconnected).toBe(false);
    expect(channels.closed()).toStrictEqual([false, true]);
    firstVersion.open();
    await closing;
    expect(channels.closed()).toStrictEqual([true, true]);
    const failures = await Promise.all([first, second]);
    expect(
      failures.map((failure) => [failure instanceof QueryCancelledError, (failure as Error).message]),
    ).toStrictEqual([
      [true, SPARK_ERROR_SENTENCES.cancelled],
      [true, SPARK_ERROR_SENTENCES.cancelled],
    ]);
    // The disconnect took the second connect, whose failure stays the provider's last; the displaced first leaves it.
    expect(lastErrorOf(provider)).toBe(failures[1] as Error);
    const [firstProbe, secondProbe] = script.calls
      .filter((call) => call.rpc === "AnalyzePlan")
      .map((call) => call.sessionId);
    expect(script.calls.slice(at).map((call) => [call.rpc, call.sessionId])).toStrictEqual([
      ["ReleaseSession", secondProbe],
      ["ReleaseSession", firstProbe],
    ]);
    expect(provider.isConnected()).toBe(false);
    expect(provider.hasRunsInFlight()).toBe(false);
  });

  test.each<[string, string, boolean]>([
    ["connects", "4.2.0", true],
    ["is refused by the version floor", "3.5.1", false],
  ])(
    "a connect that displaced another and %s answers only once the displaced connection is closed",
    async (_label, version, connects) => {
      const firstNamespace = gate();
      const interrupt = gate();
      let shows = 0;
      let versions = 0;
      const script = scripted({
        commands: { "SHOW CURRENT NAMESPACE": CURRENT },
        stream: (sql, request, call) => {
          if (sql !== "SHOW CURRENT NAMESPACE") return undefined;
          shows += 1;
          return shows === 1 ? heldStream(request, call, CURRENT, firstNamespace.promise) : undefined;
        },
        unary: (rpc, request) => {
          // The Interrupt that stops the first connect's namespace read waits on the test.
          if (rpc === "Interrupt") return interrupt.promise.then(() => ({ interrupted_ids: [] }));
          if (rpc !== "AnalyzePlan") return undefined;
          versions += 1;
          const answered = versions === 1 ? "4.2.0" : version;
          return Promise.resolve({ session_id: sessionOf(request), spark_version: { version: answered } });
        },
      });
      const channels = channelsOf(script);
      const provider = new SparkProvider(connection(1), {}, channels);
      const displaced = failureOf(provider.connect());
      await eventually(() => shows === 1);
      let settled = false;
      const second = failureOf(provider.connect()).then((failure) => {
        settled = true;
        return failure;
      });
      await eventually(() => provider.isConnected() || lastErrorOf(provider) !== undefined);
      await later(20);
      expect(settled).toBe(false);
      expect(provider.isConnected()).toBe(connects);
      // The first connection still closes, its namespace read's Interrupt unanswered; a refused second closed its own.
      expect(channels.closed()).toStrictEqual([false, !connects]);
      expect(script.calls.filter((call) => call.rpc === "Interrupt")).toHaveLength(1);
      interrupt.open();
      const failure = await second;
      expect(channels.closed()).toStrictEqual([true, !connects]);
      if (connects) {
        expect(failure).toBeUndefined();
        expect(lastErrorOf(provider)).toBeUndefined();
      } else {
        expect(failure).toBeInstanceOf(ConnectionError);
        expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.versionTooOld("3.5.1"));
        expect(lastErrorOf(provider)).toBe(failure as Error);
      }
      const cut = await displaced;
      expect(cut).toBeInstanceOf(QueryCancelledError);
      expect((cut as Error).message).toBe(SPARK_ERROR_SENTENCES.cancelled);
      firstNamespace.open();
      await provider.disconnect();
      expect(channels.closed()).toStrictEqual([true, true]);
      expect(provider.hasRunsInFlight()).toBe(false);
    },
  );

  test.each<[string, (request: object) => Promise<object>, string]>([
    [
      "the version floor refused it",
      (request) => Promise.resolve({ session_id: sessionOf(request), spark_version: { version: "3.5.1" } }),
      SPARK_ERROR_SENTENCES.versionTooOld("3.5.1"),
    ],
    [
      "its server did not answer",
      () => Promise.reject(unavailable()),
      SPARK_ERROR_SENTENCES.notConnected("127.0.0.1", 1),
    ],
  ])(
    "a displaced connect that ends after the connect that displaced it failed because %s leaves that failure as the provider's last error",
    async (_label, secondVersion, message) => {
      const firstVersion = gate();
      let versions = 0;
      const script = scripted({
        commands: { "SHOW CURRENT NAMESPACE": CURRENT },
        unary: (rpc, request) => {
          if (rpc !== "AnalyzePlan") return undefined;
          versions += 1;
          if (versions === 2) return secondVersion(request);
          const answer = { session_id: sessionOf(request), spark_version: { version: "4.2.0" } };
          return versions === 1 ? firstVersion.promise.then(() => answer) : undefined;
        },
      });
      const provider = new SparkProvider(connection(1), {}, script);
      const displaced = failureOf(provider.connect());
      await eventually(() => versions === 1);
      const second = failureOf(provider.connect());
      // The second connect's failure is the provider's state at once; the connect answers once the first connection's
      // close, which waits for the first probe's release, ended.
      await eventually(() => lastErrorOf(provider) !== undefined);
      const recorded = lastErrorOf(provider);
      firstVersion.open();
      const failure = await second;
      expect(failure).toBe(recorded);
      expect(failure).toBeInstanceOf(ConnectionError);
      expect((failure as Error).message).toBe(message);
      const cut = await displaced;
      expect(cut).toBeInstanceOf(QueryCancelledError);
      expect((cut as Error).message).toBe(SPARK_ERROR_SENTENCES.cancelled);
      expect(lastErrorOf(provider)).toBe(failure as Error);
      expect(provider.isConnected()).toBe(false);
      expect(provider.hasRunsInFlight()).toBe(false);
      expect(script.closed()).toBe(2);
    },
  );

  test.each<[string, string, boolean]>([
    ["failed", "3.5.1", false],
    ["connected and was disconnected", "4.2.0", true],
  ])(
    "a connect a disconnect took that ends after a later connect %s leaves the provider's last error as that later connect left it",
    async (_label, laterVersion, connects) => {
      const firstVersion = gate();
      let versions = 0;
      const script = scripted({
        commands: { "SHOW CURRENT NAMESPACE": CURRENT },
        unary: (rpc, request) => {
          if (rpc !== "AnalyzePlan") return undefined;
          versions += 1;
          // The first connect's version read waits on the test; the later connect's answers at once.
          const answer = {
            session_id: sessionOf(request),
            spark_version: { version: versions === 1 ? "4.2.0" : laterVersion },
          };
          return versions === 1 ? firstVersion.promise.then(() => answer) : Promise.resolve(answer);
        },
      });
      const provider = new SparkProvider(connection(1), {}, script);
      const taken = failureOf(provider.connect());
      await eventually(() => versions === 1);
      // The disconnect takes the first connect, and its close waits for the first probe's release.
      const closing = provider.disconnect();
      const next = await failureOf(provider.connect());
      const ending = connects ? provider.disconnect() : Promise.resolve();
      const recorded = lastErrorOf(provider);
      if (connects) {
        expect(next).toBeUndefined();
        expect(recorded).toBeUndefined();
      } else {
        expect(next).toBeInstanceOf(ConnectionError);
        expect((next as Error).message).toBe(SPARK_ERROR_SENTENCES.versionTooOld("3.5.1"));
        expect(recorded).toBe(next as Error);
      }
      firstVersion.open();
      await Promise.all([closing, ending]);
      const cut = await taken;
      expect(cut).toBeInstanceOf(QueryCancelledError);
      expect((cut as Error).message).toBe(SPARK_ERROR_SENTENCES.cancelled);
      expect(lastErrorOf(provider)).toBe(recorded);
      expect(provider.isConnected()).toBe(false);
      expect(provider.hasRunsInFlight()).toBe(false);
      expect(script.closed()).toBe(2);
    },
  );

  test("a connect a disconnect took, with no later connect, records its cancelled failure as the provider's last error once it ends", async () => {
    const firstVersion = gate();
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      unary: (rpc, request) =>
        rpc === "AnalyzePlan"
          ? firstVersion.promise.then(() => ({ session_id: sessionOf(request), spark_version: { version: "4.2.0" } }))
          : undefined,
    });
    const provider = new SparkProvider(connection(1), {}, script);
    const taken = failureOf(provider.connect());
    await eventually(() => script.calls.some((call) => call.rpc === "AnalyzePlan"));
    const closing = provider.disconnect();
    expect(lastErrorOf(provider)).toBeUndefined();
    firstVersion.open();
    await closing;
    const cut = await taken;
    expect(cut).toBeInstanceOf(QueryCancelledError);
    expect((cut as Error).message).toBe(SPARK_ERROR_SENTENCES.cancelled);
    expect(lastErrorOf(provider)).toBe(cut as Error);
    expect(provider.isConnected()).toBe(false);
  });

  test("a channel whose close() throws fails the disconnect with that error and leaves nothing closing, so the next disconnect answers", async () => {
    const script = scripted({ commands: { "SHOW CURRENT NAMESPACE": CURRENT } });
    const broken = new Error("the channel did not close");
    const transport: SparkWireTransport = (options) => {
      const channel = script.transport(options);
      return {
        ...channel,
        close: () => {
          channel.close();
          throw broken;
        },
      };
    };
    const provider = new SparkProvider(connection(1), {}, { transport });
    await provider.connect();
    expect(await failureOf(provider.disconnect())).toBe(broken);
    expect(provider.hasRunsInFlight()).toBe(false);
    expect(await failureOf(provider.disconnect())).toBeUndefined();
    expect(provider.isConnected()).toBe(false);
    expect(script.closed()).toBe(1);
  });

  test("the close of a displaced connection whose channel's close() throws leaves no rejection unhandled, and the connect that displaced it meets that error", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      const firstNamespace = gate();
      const secondNamespace = gate();
      let shows = 0;
      const script = scripted({
        commands: { "SHOW CURRENT NAMESPACE": CURRENT },
        // Each connect's namespace read waits on the test. The first one's answer arrives after its close ended, which
        // stops the run without waiting for its stream, so the displaced connect still waits when that close fails.
        stream: (sql, request, call) => {
          if (sql !== "SHOW CURRENT NAMESPACE") return undefined;
          shows += 1;
          if (shows > 1) return heldStream(request, call, CURRENT, secondNamespace.promise);
          let reads = 0;
          return {
            read: async () => {
              reads += 1;
              if (reads > 1) return undefined;
              await firstNamespace.promise;
              return commandAnswer(request, CURRENT);
            },
            receivedBytes: 0,
            truncated: false,
            cancel: () => undefined,
          };
        },
      });
      const broken = new Error("the channel did not close");
      let opens = 0;
      const transport: SparkWireTransport = (options) => {
        const channel = script.transport(options);
        opens += 1;
        const first = opens === 1;
        return {
          ...channel,
          close: () => {
            channel.close();
            if (first) throw broken;
          },
        };
      };
      const provider = new SparkProvider(connection(1), {}, { transport });
      const displaced = failureOf(provider.connect());
      await eventually(() => shows === 1);
      const displacing = failureOf(provider.connect());
      // The first connection's close has stopped its run, released its session and failed at its channel's close().
      await eventually(() => script.closed() === 1);
      // A rejection that no handler took is reported once the turn that raised it is over.
      await later(20);
      expect(unhandled).toStrictEqual([]);
      secondNamespace.open();
      expect(await displacing).toBe(broken);
      firstNamespace.open();
      expect(await displaced).toBe(broken);
      expect(provider.isConnected()).toBe(true);
      expect(provider.hasRunsInFlight()).toBe(false);
      await provider.disconnect();
      expect(script.closed()).toBe(2);
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});

describe("SparkProvider: Stop at the edges of a run", () => {
  test("Stop during the scope's session setup: the setup is shared, and neither an ExecutePlan nor an Interrupt follows", async () => {
    let releaseConfig: () => void = () => undefined;
    let configCalls = 0;
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT, "SELECT 1": ONE },
      unary: (rpc) => {
        if (rpc !== "Config") return undefined;
        configCalls += 1;
        // The first is the metadata session's setup at connect.
        if (configCalls === 1) return undefined;
        return new Promise((resolve) => {
          releaseConfig = () => resolve({ pairs: [], warnings: [] });
        });
      },
    });
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    const before = script.calls.length;
    const first = provider.query("SELECT 1", undefined, "q-1", "scope-in-setup");
    const second = provider.query("SELECT 1", undefined, "q-2", "scope-in-setup");
    await eventually(() => configCalls === 2);
    expect(provider.hasRunsInFlight()).toBe(true);
    expect(await provider.cancelQuery("q-1")).toBe(true);
    releaseConfig();
    await expect(first).rejects.toBeInstanceOf(QueryCancelledError);
    expect((await second).rows).toStrictEqual([{ "1": 1 }]);
    const after = script.calls.slice(before);
    expect(after.filter((call) => call.rpc === "Config")).toHaveLength(1);
    expect(after.filter((call) => call.rpc === "ExecutePlan" && statementOf(call.request) === "SELECT 1")).toHaveLength(
      1,
    );
    // A run stopped before its ExecutePlan has nothing on Spark to stop, so it sends no Interrupt.
    expect(after.filter((call) => call.rpc === "Interrupt")).toHaveLength(0);
    expect(await provider.cancelQuery("q-2")).toBe(false);
    expect(await provider.cancelQuery("unknown")).toBe(false);
    await provider.endOpenQueryTransaction("scope-in-setup");
    expect(provider.hasRunsInFlight()).toBe(false);
    await provider.disconnect();
  });

  test("Stop as the deadline fires: one Interrupt, the run ends cancelled, and Stop answers true", async () => {
    const slow = gate();
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      stream: (sql, request, call) => (sql === "SLOW" ? heldStream(request, call, ONE, slow.promise) : undefined),
    });
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    const running = failureOf(provider.query("SLOW", undefined, "q-at-once", "scope-at-once"));
    await eventually(() => script.calls.some((call) => statementOf(call.request) === "SLOW"));
    const stopped = provider.cancelQuery("q-at-once");
    slow.fail(deadlineStatus());
    expect(await stopped).toBe(true);
    expect(await running).toBeInstanceOf(QueryCancelledError);
    expect(script.calls.filter((call) => call.rpc === "Interrupt")).toHaveLength(1);
    expect(provider.hasRunsInFlight()).toBe(false);
    await provider.disconnect();
  });

  test("Stop just after the deadline: one Interrupt, the deadline's sentence, and Stop answers false", async () => {
    const slow = gate();
    const interrupt = gate();
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      stream: (sql, request, call) => (sql === "SLOW" ? heldStream(request, call, ONE, slow.promise) : undefined),
      unary: (rpc) => (rpc === "Interrupt" ? interrupt.promise.then(() => ({ interrupted_ids: [] })) : undefined),
    });
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    const running = failureOf(provider.query("SLOW", undefined, "q-late", "scope-late"));
    await eventually(() => script.calls.some((call) => statementOf(call.request) === "SLOW"));
    slow.fail(deadlineStatus());
    // The run's own Interrupt is on its way when Stop arrives.
    await eventually(() => script.calls.some((call) => call.rpc === "Interrupt"));
    const stopped = provider.cancelQuery("q-late");
    interrupt.open();
    expect(await stopped).toBe(false);
    const failure = await running;
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.deadline(DEFAULT_QUERY_TIMEOUT));
    expect(script.calls.filter((call) => call.rpc === "Interrupt")).toHaveLength(1);
    expect(provider.hasRunsInFlight()).toBe(false);
    await provider.disconnect();
  });

  test("Stop after the stream ended answers false and sends nothing", async () => {
    const provider = new SparkProvider(connection(port));
    await provider.connect();
    try {
      await provider.query("SELECT 1", undefined, "q-ended");
      fake.log.clear();
      expect(await provider.cancelQuery("q-ended")).toBe(false);
      expect(fake.log.entries).toStrictEqual([]);
      expect(provider.hasRunsInFlight()).toBe(false);
    } finally {
      await provider.disconnect();
    }
  });

  test("Stop reaches a run on a connection that a second connect is closing", async () => {
    const slow = gate();
    const interrupt = gate();
    let holdInterrupts = false;
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      stream: (sql, request, call) => (sql === "SLOW" ? heldStream(request, call, ONE, slow.promise) : undefined),
      unary: (rpc) =>
        rpc === "Interrupt" && holdInterrupts ? interrupt.promise.then(() => ({ interrupted_ids: [] })) : undefined,
    });
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    const running = failureOf(provider.query("SLOW", undefined, "q-old", "scope-old"));
    await eventually(() => script.calls.some((call) => statementOf(call.request) === "SLOW"));
    holdInterrupts = true;
    const reconnected = provider.connect();
    // The close of the first connection is stopping the run: its Interrupt waits on the test.
    await eventually(() => script.calls.some((call) => call.rpc === "Interrupt"));
    expect(provider.hasRunsInFlight()).toBe(true);
    expect(await provider.cancelQuery("q-old")).toBe(true);
    interrupt.open();
    await reconnected;
    expect(await running).toBeInstanceOf(QueryCancelledError);
    expect(script.calls.filter((call) => call.rpc === "Interrupt")).toHaveLength(1);
    expect(provider.isConnected()).toBe(true);
    expect(provider.hasRunsInFlight()).toBe(false);
    await provider.disconnect();
  });

  test("Stop reaches a run on the first connection while a failed second connect still closes its own connection", async () => {
    const slow = gate();
    const interrupt = gate();
    const release = gate();
    let shows = 0;
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      stream: (sql, request, call) => {
        if (sql === "SLOW") return heldStream(request, call, ONE, slow.promise);
        if (sql !== "SHOW CURRENT NAMESPACE") return undefined;
        shows += 1;
        return shows === 2 ? failingStream(unavailable()) : undefined;
      },
      unary: (rpc, request) => {
        if (rpc === "Interrupt" && sessionOf(request) === runSession()) {
          return interrupt.promise.then(() => ({ interrupted_ids: [] }));
        }
        return rpc === "ReleaseSession" && sessionOf(request) === secondMetadata()
          ? release.promise.then(() => ({}))
          : undefined;
      },
    });
    const runSession = () => script.calls.find((call) => statementOf(call.request) === "SLOW")?.sessionId;
    // The first connection's metadata session, the run's scope session, then the second connect's metadata session.
    const secondMetadata = () => script.calls.filter((call) => call.rpc === "Config")[2]?.sessionId;
    const channels = channelsOf(script);
    const provider = new SparkProvider(connection(1), {}, channels);
    await provider.connect();
    const running = failureOf(provider.query("SLOW", undefined, "q-first", "scope-first"));
    await eventually(() => runSession() !== undefined);
    const failed = failureOf(provider.connect());
    // The failed connect is closing what it opened: the release of its metadata session waits on the test.
    await eventually(() =>
      script.calls.some((call) => call.rpc === "ReleaseSession" && call.sessionId === secondMetadata()),
    );
    expect(provider.isConnected()).toBe(false);
    expect(await provider.cancelQuery("q-first")).toBe(true);
    // The first connection's close stopped the run while that release is still held.
    expect(await running).toBeInstanceOf(QueryCancelledError);
    interrupt.open();
    release.open();
    const failure = await failed;
    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.notConnected("127.0.0.1", 1));
    expect(script.calls.filter((call) => call.rpc === "Interrupt" && call.sessionId === runSession())).toHaveLength(1);
    expect(channels.closed()).toStrictEqual([true, true]);
    expect(provider.isConnected()).toBe(false);
    expect(provider.hasRunsInFlight()).toBe(false);
  });

  test("a beat goes out under the heartbeat deadline on the run's own session, the setup under the control deadline", async () => {
    const slow = gate();
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      stream: (sql, request, call) => (sql === "SLOW" ? heldStream(request, call, ONE, slow.promise) : undefined),
    });
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const ticks: (() => void)[] = [];
    const handles: object[] = [];
    const cleared: unknown[] = [];
    const setSpy = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms?: number) => {
      if (ms !== SPARK_HEARTBEAT_INTERVAL_MS) return realSetInterval(callback, ms);
      const handle = {};
      ticks.push(callback);
      handles.push(handle);
      return handle;
    }) as unknown as typeof setInterval);
    const clearSpy = spyOn(globalThis, "clearInterval").mockImplementation(((handle?: unknown) => {
      if (handles.includes(handle as object)) cleared.push(handle);
      else realClearInterval(handle as ReturnType<typeof setInterval>);
    }) as unknown as typeof clearInterval);
    const now = spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const running = provider.query("SLOW", undefined, "q-beat", "scope-beat");
      await eventually(() => ticks.length === 1);
      expect(provider.hasRunsInFlight()).toBe(true);
      ticks[0]?.();
      const isBeat = (call: ScriptedCall) =>
        call.rpc === "Config" &&
        (call.request as { operation?: { get_option?: unknown } }).operation?.get_option !== undefined;
      await eventually(() => script.calls.some(isBeat));
      const run = script.calls.find((call) => statementOf(call.request) === "SLOW") as ScriptedCall;
      const setup = script.calls.find(
        (call) => call.rpc === "Config" && call.sessionId === run.sessionId && setsConfig(call.request),
      ) as ScriptedCall;
      const beat = script.calls.find(isBeat) as ScriptedCall;
      expect(beat.sessionId).toBe(run.sessionId);
      expect((beat.request as { operation?: unknown }).operation).toStrictEqual({
        get_option: { keys: ["spark.sql.ansi.enabled"] },
      });
      expect(beat.deadline - beat.at).toBe(SPARK_HEARTBEAT_DEADLINE_MS);
      expect(setup.deadline - setup.at).toBe(SPARK_CONTROL_DEADLINE_MS);
      // The run itself is bounded by the connection's query timeout.
      expect(run.deadline - run.at).toBe(DEFAULT_QUERY_TIMEOUT);
      slow.open();
      expect((await running).rows).toStrictEqual([{ "1": 1 }]);
      expect(cleared).toStrictEqual(handles);
      expect(provider.hasRunsInFlight()).toBe(false);
    } finally {
      now.mockRestore();
      setSpy.mockRestore();
      clearSpy.mockRestore();
      await provider.disconnect();
    }
  });

  test("a session release in progress counts as in flight until it settles", async () => {
    const release = gate();
    let holdReleases = false;
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT, "SELECT 1": ONE },
      unary: (rpc) =>
        rpc === "ReleaseSession" && holdReleases ? release.promise.then(() => ({ session_id: "" })) : undefined,
    });
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    await provider.query("SELECT 1", undefined, "q-release", "scope-release");
    holdReleases = true;
    const before = script.calls.length;
    const ending = provider.endOpenQueryTransaction("scope-release");
    await eventually(() => script.calls.slice(before).some((call) => call.rpc === "ReleaseSession"));
    expect(provider.hasRunsInFlight()).toBe(true);
    release.open();
    expect(await ending).toBe("none");
    expect(provider.hasRunsInFlight()).toBe(false);
    holdReleases = false;
    await provider.disconnect();
  });
});

describe("SparkProvider: the panels through getMonitoringData", () => {
  test("every panel getter is called: the overview, {}, the three [] and the two refusals", async () => {
    const script = scripted({
      commands: {
        "SHOW CURRENT NAMESPACE": CURRENT,
        [`SHOW VIEWS IN ${DEFAULT}`]: listing("viewName", []),
        [`SHOW TABLES IN ${DEFAULT}`]: listing("tableName", ["t1", "t2"]),
      },
      unary: (rpc, request) => {
        const prefix = (request as { operation?: { get_all?: { prefix?: string } } }).operation?.get_all?.prefix;
        if (rpc !== "Config" || prefix !== "spark.app.") return undefined;
        return Promise.resolve({
          pairs: [
            { key: "startTime", value: "1700000000000" },
            { key: "name", value: "Spark Connect server" },
          ],
          warnings: [],
        });
      },
    });
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    const data = await provider.getMonitoringData({ includeTables: true, includeIndexes: true, includeStorage: true });
    // The uptime is read against the clock, so the overview is matched without it.
    expect(data.overview).toMatchObject({
      version: "4.2.0",
      startTime: new Date(1_700_000_000_000),
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 2,
      indexCount: 0,
    });
    expect(data.performance).toStrictEqual({});
    expect(data.slowQueries).toStrictEqual([]);
    expect(data.activeSessions).toStrictEqual([]);
    expect(data.indexes).toStrictEqual([]);
    expect(data.tables).toBeUndefined();
    expect(data.storage).toBeUndefined();
    expect(data.errors).toStrictEqual({
      tables: SPARK_MONITORING_LABELS.tablesRefused,
      storage: SPARK_MONITORING_LABELS.storageRefused,
    });
    expect(await provider.getHealth()).toStrictEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    await provider.disconnect();
  });

  test("the overview's version is the server's text as a version sentence quotes it: a token withheld, a long text cut", async () => {
    let version = "4.2.0";
    const script = scripted({
      commands: {
        "SHOW CURRENT NAMESPACE": CURRENT,
        [`SHOW VIEWS IN ${DEFAULT}`]: listing("viewName", []),
        [`SHOW TABLES IN ${DEFAULT}`]: listing("tableName", ["t1"]),
      },
      unary: (rpc) => (rpc === "AnalyzePlan" ? Promise.resolve({ spark_version: { version } }) : undefined),
    });
    const provider = new SparkProvider(connection(1, { password: TOKEN }), {}, script);
    await provider.connect();
    const overview = (shown: string) => ({
      version: shown,
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 1,
      tableCountSampledFrom: "the tables of spark_catalog.default, the connection's current namespace",
      indexCount: 0,
    });
    const health = { databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] };
    try {
      version = `4.2.0 (served with Bearer ${TOKEN})`;
      expect(await provider.getOverview()).toStrictEqual(
        overview("(the server's text was withheld because it contained the configured credential)"),
      );
      expect(await provider.getHealth()).toStrictEqual(health);
      version = `4.2.0-${"x".repeat(9_994)}`;
      expect(await provider.getOverview()).toStrictEqual(
        overview(`4.2.0-${"x".repeat(SPARK_VERSION_TEXT_MAX_CHARS - 6)}`),
      );
      expect(await provider.getHealth()).toStrictEqual(health);
    } finally {
      await provider.disconnect();
    }
  });

  test("an overview whose SHOW CURRENT NAMESPACE answers no row is refused as unreadable, and sends no listing", async () => {
    const commands: Record<string, Uint8Array> = {
      "SHOW CURRENT NAMESPACE": CURRENT,
      [`SHOW VIEWS IN ${DEFAULT}`]: listing("viewName", []),
      [`SHOW TABLES IN ${DEFAULT}`]: listing("tableName", ["t1"]),
    };
    const script = scripted({ commands });
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    try {
      commands["SHOW CURRENT NAMESPACE"] = columnsStream([
        { name: "catalog", kind: "utf8", values: [] },
        { name: "namespace", kind: "utf8", values: [] },
      ]);
      const sentAt = script.calls.length;
      const failure = await failureOf(provider.getOverview());
      expect(failure).toBeInstanceOf(QueryError);
      expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.unreadable("SHOW CURRENT NAMESPACE"));
      expect(
        script.calls
          .slice(sentAt)
          .filter((call) => call.rpc === "ExecutePlan")
          .map((call) => statementOf(call.request)),
      ).toStrictEqual(["SHOW CURRENT NAMESPACE"]);
    } finally {
      await provider.disconnect();
    }
  });
});

describe("SparkProvider: the metadata session after the server closed it", () => {
  test("after a restart, getHealth answers on a new metadata session after exactly one repeat", async () => {
    const provider = new SparkProvider(connection(port));
    await provider.connect();
    try {
      const start = fake.log.entries.length;
      fake.restart();
      expect(await provider.getHealth()).toBeDefined();
      const after = fake.log.entries.slice(start);
      const versions = after.filter((entry) => entry.rpc === "AnalyzePlan").map((entry) => entry.sessionId);
      expect(versions).toHaveLength(2);
      expect(versions[1]).not.toBe(versions[0] as string);
      // The one setup between the two reads is the new metadata session's.
      expect(after.filter((entry) => entry.rpc === "Config").map((entry) => entry.sessionId)).toStrictEqual([
        versions[1] as string,
      ]);
    } finally {
      await provider.disconnect();
    }
  });

  test("a metadata session the server released is replaced, and the statement that met it is sent again once", async () => {
    fake.log.clear();
    const provider = new SparkProvider(connection(port));
    await provider.connect();
    try {
      const metadata = fake.log.entries.find((entry) => entry.rpc === "Config")?.sessionId as string;
      const outside = grpcWireTransport(buildSparkConnectionOptions(connection(port), { queryTimeout: 5_000 }));
      try {
        await outside.unary("ReleaseSession", releaseSessionRequest({ sessionId: metadata }), {
          metadata: {},
          deadline: new Date(Date.now() + 5_000),
          signal: new AbortController().signal,
        });
      } finally {
        outside.close();
      }
      const start = fake.log.entries.length;
      expect(await provider.listContainers()).toStrictEqual([
        { path: ["spark_catalog"], name: "spark_catalog", level: 0, isSessionDefault: true },
      ]);
      const after = fake.log.entries.slice(start);
      const reads = after
        .filter((entry) => statementOf(entry.request) === "SHOW CURRENT NAMESPACE")
        .map((entry) => entry.sessionId);
      expect(reads).toHaveLength(2);
      expect(reads[0]).toBe(metadata);
      expect(reads[1]).not.toBe(metadata);
      expect(
        after.filter((entry) => entry.rpc === "Config" && setsConfig(entry.request)).map((entry) => entry.sessionId),
      ).toStrictEqual([reads[1] as string]);
    } finally {
      await provider.disconnect();
    }
  });

  test("a metadata statement that meets a closed session once is sent again on a new metadata session", async () => {
    const closed = new Set<string>();
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT, "SHOW CATALOGS": CATALOGS },
      stream: (_sql, request) =>
        closed.has(sessionOf(request))
          ? failingStream(new SparkError("session-closed", SPARK_ERROR_SENTENCES.sessionClosed))
          : undefined,
    });
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    const metadata = script.calls.find((call) => call.rpc === "Config")?.sessionId as string;
    closed.add(metadata);
    const start = script.calls.length;
    expect(await provider.listContainers()).toStrictEqual([
      { path: ["spark_catalog"], name: "spark_catalog", level: 0, isSessionDefault: true },
    ]);
    const after = script.calls.slice(start);
    const reads = after
      .filter((call) => statementOf(call.request) === "SHOW CURRENT NAMESPACE")
      .map((call) => call.sessionId);
    expect(reads).toHaveLength(2);
    expect(reads[0]).toBe(metadata);
    expect(
      after.filter((call) => call.rpc === "Config" && setsConfig(call.request)).map((call) => call.sessionId),
    ).toStrictEqual([reads[1] as string]);
    await provider.disconnect();
  });

  test("a metadata statement that meets a closed session twice fails with the metadata-session sentence", async () => {
    let closing = false;
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      stream: (sql) =>
        closing && sql === "SHOW CURRENT NAMESPACE"
          ? failingStream(new SparkError("session-closed", SPARK_ERROR_SENTENCES.sessionClosed))
          : undefined,
    });
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    closing = true;
    const start = script.calls.length;
    const failure = await failureOf(provider.listContainers());
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.metadataSessionLost);
    const reads = script.calls.slice(start).filter((call) => statementOf(call.request) === "SHOW CURRENT NAMESPACE");
    expect(new Set(reads.map((call) => call.sessionId)).size).toBe(2);
    await provider.disconnect();
  });

  test("a metadata statement still waiting for the new metadata session's setup at its deadline is refused, as unsent only when it was never sent, and the setup goes on", async () => {
    const timeout = 200;
    const setup = gate();
    const server = laterSetupsHeld(setup.promise);
    let closed = false;
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT, "SHOW CATALOGS": CATALOGS },
      unary: server.unary,
      stream: (_sql, request) =>
        closed && sessionOf(request) === server.first()
          ? failingStream(new SparkError("session-closed", SPARK_ERROR_SENTENCES.sessionClosed))
          : undefined,
    });
    const provider = new SparkProvider(connection(1), { queryTimeout: timeout }, script);
    await provider.connect();
    try {
      closed = true;
      const sentAt = script.calls.length;
      const setups = () => script.calls.filter((call) => call.rpc === "Config" && setsConfig(call.request)).length;
      // One read meets the closed session and waits for the new one's setup; another asks while that is in flight.
      const met = failureOf(provider.listContainers());
      await eventually(() => setups() === 2);
      const after = failureOf(provider.countObjects(["spark_catalog", "default"]));
      const outcome = await Promise.race([
        Promise.all([met, after]).then((failures) =>
          failures.map((failure) => [failure instanceof QueryError, (failure as Error).message]),
        ),
        later(timeout * 3).then(() => "still waiting at three timeouts"),
      ]);
      // The read that met the closed session had sent its statement there; the one that asked later had sent nothing.
      expect(outcome).toStrictEqual([
        [true, SPARK_ERROR_SENTENCES.metadataSessionLost],
        [true, SPARK_ERROR_SENTENCES.deadlineBeforeSend(timeout)],
      ]);
      expect(
        script.calls
          .slice(sentAt)
          .filter((call) => call.rpc === "ExecutePlan")
          .map((call) => statementOf(call.request)),
      ).toStrictEqual(["SHOW CURRENT NAMESPACE"]);
      // The setup goes on, and the next read runs on the new session it set up.
      setup.open();
      expect(await provider.listContainers()).toStrictEqual([
        { path: ["spark_catalog"], name: "spark_catalog", level: 0, isSessionDefault: true },
      ]);
      expect(setups()).toBe(2);
      expect(provider.hasRunsInFlight()).toBe(false);
    } finally {
      setup.open();
      await provider.disconnect();
    }
  });

  test("a metadata statement whose time is up once the new metadata session is set up is refused as a lost metadata session, and is not sent again", async () => {
    const timeout = 10_000;
    const setup = gate();
    const server = laterSetupsHeld(setup.promise);
    let closed = false;
    let now = Date.now();
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      unary: server.unary,
      // Only statements meet the closed session, so the overview's version and Config reads answer on it.
      stream: (_sql, request) =>
        closed && sessionOf(request) === server.first()
          ? failingStream(new SparkError("session-closed", SPARK_ERROR_SENTENCES.sessionClosed))
          : undefined,
    });
    const provider = new SparkProvider(connection(1), { queryTimeout: timeout }, script);
    await provider.connect();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      closed = true;
      const sentAt = script.calls.length;
      const setups = () => script.calls.filter((call) => call.rpc === "Config" && setsConfig(call.request));
      const overview = failureOf(provider.getOverview());
      await eventually(() => setups().length === 2);
      // The statement's time is up when the new session's setup answers, before its wait's own timer refuses it.
      now += timeout;
      setup.open();
      const failure = await overview;
      expect(failure).toBeInstanceOf(QueryError);
      expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.metadataSessionLost);
      expect(
        script.calls
          .slice(sentAt)
          .map((call) =>
            call.rpc === "ExecutePlan"
              ? statementOf(call.request)
              : call.rpc === "Config"
                ? `Config ${setsConfig(call.request) ? "set" : "read"}`
                : call.rpc,
          ),
      ).toStrictEqual(["AnalyzePlan", "Config read", "SHOW CURRENT NAMESPACE", "Config set"]);
    } finally {
      setup.open();
      clock.mockRestore();
      await provider.disconnect();
    }
  });

  test("getHealth whose version read met the closed metadata session waits for the new session's setup as long as it takes, past the query timeout", async () => {
    const timeout = 50;
    const setup = gate();
    const server = laterSetupsHeld(setup.promise);
    let closed = false;
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      unary: (rpc, request) =>
        closed && rpc === "AnalyzePlan" && sessionOf(request) === server.first()
          ? Promise.reject(new SparkError("session-closed", SPARK_ERROR_SENTENCES.sessionClosed))
          : server.unary(rpc, request),
    });
    const provider = new SparkProvider(connection(1), { queryTimeout: timeout }, script);
    await provider.connect();
    try {
      closed = true;
      const health = provider.getHealth().then(
        (answer) => answer,
        (error: unknown) => `refused: ${(error as Error).message}`,
      );
      // The new session's setup takes four query timeouts.
      await later(timeout * 4);
      setup.open();
      expect(await health).toStrictEqual({
        databaseSize: "N/A",
        cacheHitRatio: "N/A",
        slowQueries: [],
        activeSessions: [],
      });
    } finally {
      setup.open();
      await provider.disconnect();
    }
  });

  test("getOverview whose Config read met the closed metadata session waits for the new session's setup as long as it takes, past the query timeout", async () => {
    const timeout = 50;
    const setup = gate();
    const server = laterSetupsHeld(setup.promise);
    let closed = false;
    const script = scripted({
      commands: {
        "SHOW CURRENT NAMESPACE": CURRENT,
        [`SHOW VIEWS IN ${DEFAULT}`]: listing("viewName", []),
        [`SHOW TABLES IN ${DEFAULT}`]: listing("tableName", ["t"]),
      },
      unary: (rpc, request) =>
        closed && rpc === "Config" && !setsConfig(request) && sessionOf(request) === server.first()
          ? Promise.reject(new SparkError("session-closed", SPARK_ERROR_SENTENCES.sessionClosed))
          : server.unary(rpc, request),
    });
    const provider = new SparkProvider(connection(1), { queryTimeout: timeout }, script);
    await provider.connect();
    try {
      closed = true;
      const overview = provider.getOverview().then(
        (answer) => answer,
        (error: unknown) => `refused: ${(error as Error).message}`,
      );
      // The new session's setup takes four query timeouts.
      await later(timeout * 4);
      setup.open();
      expect(await overview).toStrictEqual({
        version: "4.2.0",
        uptime: "N/A",
        maxConnections: 0,
        databaseSize: "N/A",
        tableCount: 1,
        tableCountSampledFrom: "the tables of spark_catalog.default, the connection's current namespace",
        indexCount: 0,
      });
    } finally {
      setup.open();
      await provider.disconnect();
    }
  });

  test("a metadata statement's wait for the metadata session's setup leaves no timer behind once the setup answers", async () => {
    const timeout = 7_919;
    const script = scripted({ commands: { "SHOW CURRENT NAMESPACE": CURRENT } });
    const provider = new SparkProvider(connection(1), { queryTimeout: timeout }, script);
    // On a frozen clock each wait's timer is set for exactly the query timeout, which no other timer of a connect uses.
    const frozen = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(frozen);
    const set = spyOn(globalThis, "setTimeout");
    const cleared = spyOn(globalThis, "clearTimeout");
    try {
      await provider.connect();
      const timers = set.mock.calls.flatMap((call, index) =>
        call[1] === timeout ? [set.mock.results[index]?.value as unknown] : [],
      );
      // Connect's one metadata statement waited once for the setup, and its timer was cleared when the setup answered.
      expect(timers).toHaveLength(1);
      expect(cleared.mock.calls.map(([timer]) => timer as unknown)).toContain(timers[0]);
    } finally {
      set.mockRestore();
      cleared.mockRestore();
      clock.mockRestore();
      await provider.disconnect();
    }
  });

  test("the new metadata session's failed setup reaches getHealth as its mapped sentence, never the channel's own text", async () => {
    let metadataClosed = false;
    let configCalls = 0;
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      unary: (rpc) => {
        // The version read meets a closed session, in the form the provider's mapping gives it, so the read is repeated.
        if (rpc === "AnalyzePlan" && metadataClosed) {
          return Promise.reject(new SparkError("session-closed", SPARK_ERROR_SENTENCES.sessionClosed));
        }
        if (rpc !== "Config") return undefined;
        configCalls += 1;
        return configCalls === 1 ? undefined : Promise.reject(new Error("a local channel failure"));
      },
    });
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    metadataClosed = true;
    const failure = await failureOf(provider.getHealth());
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.localClientError);
    expect(configCalls).toBe(2);
    await provider.disconnect();
  });

  test("a setup statement of the new metadata session that fails reaches getHealth as its mapped sentence", async () => {
    let metadataClosed = false;
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT, "SET CATALOG 'spark_catalog'": SET_ANSWER },
      unary: (rpc) =>
        rpc === "AnalyzePlan" && metadataClosed
          ? Promise.reject(new SparkError("session-closed", SPARK_ERROR_SENTENCES.sessionClosed))
          : undefined,
      stream: (sql) =>
        metadataClosed && sql === "SET CATALOG 'spark_catalog'"
          ? failingStream(new Error("a local channel failure"))
          : undefined,
    });
    const provider = new SparkProvider(connection(1, { database: "spark_catalog" }), {}, script);
    await provider.connect();
    metadataClosed = true;
    const failure = await failureOf(provider.getHealth());
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.localClientError);
    await provider.disconnect();
  });

  test("a Config read of the metadata session that fails reaches the panel as its mapped sentence", async () => {
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      unary: (rpc, request) =>
        rpc === "Config" && !setsConfig(request) ? Promise.reject(new Error("a local channel failure")) : undefined,
    });
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    const failure = await failureOf(provider.getOverview());
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.localClientError);
    await provider.disconnect();
  });

  test.each<[string, Partial<DatabaseConnection>]>([
    ["no Catalog or Namespace", {}],
    ["a Catalog and a Namespace", { database: "spark_catalog", schema: "default" }],
  ])(
    "getHealth waiting for a new metadata session's setup when a disconnect begins is refused as cancelled, and only that session's release follows, with %s",
    async (_label, place) => {
      const setup = gate();
      const server = laterSetupsHeld(setup.promise);
      let closed = false;
      const script = scripted({
        commands: {
          "SHOW CURRENT NAMESPACE": CURRENT,
          "SET CATALOG 'spark_catalog'": SET_ANSWER,
          "USE NAMESPACE `default`": SET_ANSWER,
        },
        // The version read meets the closed session in the form the provider's mapping gives it.
        unary: (rpc, request) =>
          closed && rpc === "AnalyzePlan" && sessionOf(request) === server.first()
            ? Promise.reject(new SparkError("session-closed", SPARK_ERROR_SENTENCES.sessionClosed))
            : server.unary(rpc, request),
      });
      const provider = new SparkProvider(connection(1, place), {}, script);
      await provider.connect();
      closed = true;
      const setups = () => script.calls.filter((call) => call.rpc === "Config" && setsConfig(call.request));
      const health = failureOf(provider.getHealth());
      await eventually(() => setups().length === 2);
      const fresh = setups()[1]?.sessionId;
      const at = script.calls.length;
      const closing = provider.disconnect();
      setup.open();
      await closing;
      const failure = await health;
      expect(failure).toBeInstanceOf(QueryCancelledError);
      expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.cancelled);
      expect(script.calls.slice(at).map((call) => [call.rpc, call.sessionId])).toStrictEqual([
        ["ReleaseSession", fresh],
      ]);
      expect(script.closed()).toBe(1);
      expect(provider.hasRunsInFlight()).toBe(false);
    },
  );
});

describe("SparkProvider: a disconnect while a statement still runs", () => {
  /** A panel read, and the call by which it meets the metadata session the server closed. */
  interface ClosedRead {
    readonly meets: (rpc: string, request: object) => boolean;
    readonly read: (provider: SparkProvider) => Promise<unknown>;
  }
  const VERSION_READ: ClosedRead = { meets: (rpc) => rpc === "AnalyzePlan", read: (provider) => provider.getHealth() };
  const CONFIG_READ: ClosedRead = {
    meets: (rpc, request) => rpc === "Config" && !setsConfig(request),
    read: (provider) => provider.getOverview(),
  };
  const PLACE: Partial<DatabaseConnection> = { database: "spark_catalog", schema: "default" };

  /**
   * A connected provider whose user statement SELECT slow, once sent, runs until it is stopped, and whose Interrupt
   * answers only once `interrupt` opens. After `holdSetups()` every new session's Config set answers only once `setup`
   * opens; after `closeMetadata()` the server has closed the metadata session set up at connect, which `meets` names.
   */
  async function busy(place: Partial<DatabaseConnection>, meets: ClosedRead["meets"] = () => false) {
    const setup = gate();
    const interrupt = gate();
    let metadata: string | undefined;
    let closed = false;
    let holding = false;
    const script = scripted({
      commands: {
        "SHOW CURRENT NAMESPACE": CURRENT,
        "SET CATALOG 'spark_catalog'": SET_ANSWER,
        "USE NAMESPACE `default`": SET_ANSWER,
        "SELECT 1": ONE,
      },
      unary: (rpc, request) => {
        if (rpc === "Interrupt") return interrupt.promise.then(() => ({ interrupted_ids: [] }));
        if (rpc === "Config" && setsConfig(request)) {
          metadata ??= sessionOf(request);
          const answer = {
            session_id: sessionOf(request),
            server_side_session_id: "server-1",
            pairs: [],
            warnings: [],
          };
          return holding ? setup.promise.then(() => answer) : undefined;
        }
        // The read meets the closed session in the form the provider's mapping gives it.
        return closed && sessionOf(request) === metadata && meets(rpc, request)
          ? Promise.reject(new SparkError("session-closed", SPARK_ERROR_SENTENCES.sessionClosed))
          : undefined;
      },
      stream: (sql, request, call) =>
        sql === "SELECT slow" ? heldStream(request, call, ONE, gate().promise) : undefined,
    });
    const provider = new SparkProvider(connection(1, place), {}, script);
    await provider.connect();
    const running = failureOf(provider.query("SELECT slow", undefined, "q-slow", "scope-slow"));
    await eventually(() => script.calls.some((call) => statementOf(call.request) === "SELECT slow"));
    return {
      provider,
      script,
      running,
      setup,
      interrupt,
      run: script.calls.find((call) => statementOf(call.request) === "SELECT slow")?.sessionId,
      setups: () => script.calls.filter((call) => call.rpc === "Config" && setsConfig(call.request)),
      holdSetups: () => {
        holding = true;
      },
      closeMetadata: () => {
        closed = true;
      },
    };
  }

  /** Every call from the `at`-th on, as its RPC and the name `names` gives its session. */
  const namedCalls = (calls: readonly ScriptedCall[], at: number, names: Readonly<Record<string, string>>) =>
    calls.slice(at).map((call): [string, string] => [call.rpc, names[call.sessionId] ?? call.sessionId]);

  test.each<[string, string, ClosedRead, Partial<DatabaseConnection>, [string, string][]]>([
    [
      "getHealth's version read",
      "no Catalog or Namespace",
      VERSION_READ,
      {},
      [
        ["Interrupt", "run"],
        ["ReleaseSession", "run"],
        ["ReleaseSession", "fresh"],
      ],
    ],
    [
      "getHealth's version read",
      "a Catalog and a Namespace",
      VERSION_READ,
      PLACE,
      [
        ["Interrupt", "run"],
        ["ReleaseSession", "fresh"],
        ["ReleaseSession", "run"],
      ],
    ],
    [
      "getOverview's Config read",
      "no Catalog or Namespace",
      CONFIG_READ,
      {},
      [
        ["Interrupt", "run"],
        ["ReleaseSession", "run"],
        ["ReleaseSession", "fresh"],
      ],
    ],
    [
      "getOverview's Config read",
      "a Catalog and a Namespace",
      CONFIG_READ,
      PLACE,
      [
        ["Interrupt", "run"],
        ["ReleaseSession", "fresh"],
        ["ReleaseSession", "run"],
      ],
    ],
  ])(
    "%s waiting for a new metadata session's setup is refused as cancelled once a disconnect began, while the running statement's Interrupt is still unanswered, with %s; only the Interrupt and the releases follow",
    async (_label, _placeLabel, { meets, read }, place, after) => {
      const world = await busy(place, meets);
      world.holdSetups();
      world.closeMetadata();
      const before = world.setups().length;
      const failure = failureOf(read(world.provider));
      await eventually(() => world.setups().length === before + 1);
      const fresh = world.setups().at(-1)?.sessionId as string;
      const at = world.script.calls.length;
      const closing = world.provider.disconnect();
      await eventually(() => world.script.calls.slice(at).some((call) => call.rpc === "Interrupt"));
      world.setup.open();
      // Refused while the disconnect still waits for the Interrupt.
      const refusal = await failure;
      expect(refusal).toBeInstanceOf(QueryCancelledError);
      expect((refusal as Error).message).toBe(SPARK_ERROR_SENTENCES.cancelled);
      world.interrupt.open();
      await closing;
      expect(namedCalls(world.script.calls, at, { [world.run as string]: "run", [fresh]: "fresh" })).toStrictEqual(
        after,
      );
      expect(await world.running).toBeInstanceOf(QueryCancelledError);
      expect(world.provider.isConnected()).toBe(false);
      expect(world.provider.hasRunsInFlight()).toBe(false);
      expect(world.script.closed()).toBe(1);
    },
  );

  test("a statement of another scope whose session's setup answers once a disconnect began sends no further setup step while the running statement's Interrupt is still unanswered", async () => {
    const world = await busy(PLACE);
    world.holdSetups();
    const metadata = world.setups()[0]?.sessionId as string;
    const other = failureOf(world.provider.query("SELECT 1", undefined, "q-other", "scope-other"));
    await eventually(() => world.setups().length === 3);
    const scope = world.setups()[2]?.sessionId as string;
    const at = world.script.calls.length;
    const closing = world.provider.disconnect();
    await eventually(() => world.script.calls.slice(at).some((call) => call.rpc === "Interrupt"));
    world.setup.open();
    const refusal = await other;
    expect(refusal).toBeInstanceOf(QueryCancelledError);
    expect((refusal as Error).message).toBe(SPARK_ERROR_SENTENCES.cancelled);
    world.interrupt.open();
    await closing;
    expect(
      namedCalls(world.script.calls, at, { [world.run as string]: "run", [scope]: "scope", [metadata]: "metadata" }),
    ).toStrictEqual([
      ["Interrupt", "run"],
      ["ReleaseSession", "scope"],
      ["ReleaseSession", "metadata"],
      ["ReleaseSession", "run"],
    ]);
    expect(await world.running).toBeInstanceOf(QueryCancelledError);
    expect(world.provider.hasRunsInFlight()).toBe(false);
  });

  test("a tree read whose listing answers as a disconnect begins sends no Config read after it and is refused as cancelled", async () => {
    let closing: Promise<void> | undefined;
    const script = scripted({
      commands: { "SHOW CURRENT NAMESPACE": CURRENT },
      // The disconnect begins as SHOW CATALOGS answers, before the read goes on to its Config read.
      stream: (sql, request) => {
        if (sql !== "SHOW CATALOGS") return undefined;
        const answers = streamOf([commandAnswer(request, CATALOGS)]);
        return {
          ...answers,
          read: () => {
            closing ??= provider.disconnect();
            return answers.read();
          },
        };
      },
    });
    const provider = new SparkProvider(connection(1), {}, script);
    await provider.connect();
    const at = script.calls.length;
    const failure = await failureOf(provider.listContainers());
    await closing;
    expect(failure).toBeInstanceOf(QueryCancelledError);
    expect((failure as Error).message).toBe(SPARK_ERROR_SENTENCES.cancelled);
    // The Interrupt stops SHOW CATALOGS, which the disconnect found still open; the release is the metadata session's.
    expect(
      script.calls.slice(at).map((call) => (call.rpc === "ExecutePlan" ? statementOf(call.request) : call.rpc)),
    ).toStrictEqual(["SHOW CURRENT NAMESPACE", "SHOW CATALOGS", "Interrupt", "ReleaseSession"]);
    expect(provider.hasRunsInFlight()).toBe(false);
  });
});

describe("SparkProvider: a read whose connection closes under it", () => {
  test.each<[string, (rpc: string, request: object) => boolean, (provider: SparkProvider) => Promise<unknown>]>([
    ["getHealth's version read", (rpc) => rpc === "AnalyzePlan", (provider) => provider.getHealth()],
    ["getOverview's version read", (rpc) => rpc === "AnalyzePlan", (provider) => provider.getOverview()],
    [
      "getOverview's Config read",
      (rpc, request) => rpc === "Config" && !setsConfig(request),
      (provider) => provider.getOverview(),
    ],
    [
      "listContainers' Config read",
      (rpc, request) => rpc === "Config" && !setsConfig(request),
      (provider) => provider.listContainers(),
    ],
  ])(
    "%s in flight when a disconnect closes the channel ends cancelled, never as a server that did not answer",
    async (_label, held, read) => {
      const shut = gate();
      let holding = false;
      const script = scripted({
        commands: { "SHOW CURRENT NAMESPACE": CURRENT, "SHOW CATALOGS": CATALOGS },
        // The held call fails as grpc-js fails a call whose channel closed under it.
        unary: (rpc, request) =>
          holding && held(rpc, request) ? shut.promise.then(() => Promise.reject(unavailable())) : undefined,
      });
      const transport: SparkWireTransport = (options) => {
        const channel = script.transport(options);
        return {
          ...channel,
          close: () => {
            channel.close();
            shut.open();
          },
        };
      };
      const provider = new SparkProvider(connection(1), {}, { transport });
      await provider.connect();
      const metadata = script.calls.find((call) => call.rpc === "Config")?.sessionId as string;
      holding = true;
      const at = script.calls.length;
      const failure = failureOf(read(provider));
      await eventually(() => script.calls.slice(at).some((call) => held(call.rpc, call.request)));
      const closedAt = script.calls.length;
      await provider.disconnect();
      const refusal = await failure;
      expect(refusal).toBeInstanceOf(QueryCancelledError);
      expect((refusal as Error).message).toBe(SPARK_ERROR_SENTENCES.cancelled);
      expect(script.calls.slice(closedAt).map((call) => [call.rpc, call.sessionId])).toStrictEqual([
        ["ReleaseSession", metadata],
      ]);
      expect(provider.isConnected()).toBe(false);
    },
  );
});
