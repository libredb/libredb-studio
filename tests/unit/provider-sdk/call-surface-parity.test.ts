/**
 * Every input a provider is built with today, and every member of today's console request and answer and of today's
 * transaction surface, has a place in the provider contract's calls, or a stated reason it stays with the host
 * (docs/providers/CONTRACT.md, clause C-7). So a provider moves onto the contract without a behaviour change.
 *
 * A provider is built from the connection's fields and from the marks core sets beside them under symbol keys: the
 * tunnel's far end and route, the literal seed-file mark (`ProviderConnection` in src/lib/db/provider-connection.ts),
 * and the files core admitted (`admittedFileConnection` and `admittedHostPathConnection` in
 * src/lib/db/provider-files.ts). The connection census covers the fields and the mark census covers the marks.
 *
 * The census is exhaustive by type. Each record below is a `Record` over the keys of a Studio type, so a new key fails
 * `bun run typecheck` here until it is placed, and every placement names its contract member as a key of the SDK's own
 * type, so a placement naming a member the SDK does not have fails typecheck too. The tests read the records at run
 * time: a connection field is one the schema's field vocabulary names, and every reason is a sentence.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  CancelAnswer,
  Column,
  ConsoleFacet,
  EgressDecision as SdkEgressDecision,
  EndScopeAnswer,
  ExecuteAnswer,
  ExecuteRequest,
  OpenContext,
  OpenPolicy,
  PoolSettings,
  ResultSource,
  TlsSettings,
  TransactionAction,
  TransactionAnswer,
  TransactionRequest,
  TrustMaterial as SdkTrustMaterial,
  TunnelFarEnd as SdkTunnelFarEnd,
  VectorColumnShape,
  Warning,
} from "@libredb/provider-sdk/calls";
import type { FieldName } from "@libredb/provider-sdk/manifest";
import type { ProviderConnection } from "@/lib/db/provider-connection";
import type { QueryCancelProvider } from "@/lib/db/query-cancel";
import type {
  BeginTransactionOptions,
  BeginTransactionResult,
  DatabaseProvider,
  EgressDecision,
  OpenQueryTransactionOutcome,
  PoolConfig,
  PreparedQuery,
  ProviderBuildContext,
  ProviderOptions,
  QueryPrepareOptions,
  TransactionProvider,
  TrustMaterial,
} from "@/lib/db/types";
import type { VectorColumn } from "@/lib/db/vector/types";
import type {
  DatabaseConnection,
  QueryResult,
  QueryResultSet,
  QueryWarning,
  SSLConfig,
  TunnelFarEnd,
  WithAdmittedFile,
  WithAdmittedHostPaths,
} from "@/lib/types";
import { ADMITTED_FILE, ADMITTED_HOST_PATHS, LITERAL_SEED_FILE, TUNNEL_FAR_END, TUNNEL_ROUTE } from "@/lib/types";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SCHEMA = JSON.parse(
  readFileSync(path.join(ROOT, "packages/provider-sdk/src/manifest/manifest.schema.json"), "utf8"),
) as { $defs: { fieldName: { enum: string[] } } };

/** An input or answer member that stays with the host, and why. */
interface HostOnly {
  readonly where: "host";
  readonly reason: string;
}

/** An input the open context carries, under a member of its own or of its policy. */
type InputPlacement =
  | { readonly where: "open-context"; readonly member: keyof OpenContext; readonly note?: string }
  | { readonly where: "policy"; readonly member: keyof OpenPolicy }
  | HostOnly;

/** A connection key that is a contract field name, carried in `ctx.connection` under its own name. */
interface ConnectionField {
  readonly where: "connection";
}

/** A member of today's console request or answer, as the console calls carry it. */
type ConsolePlacement =
  | { readonly where: "execute-request"; readonly member: keyof ExecuteRequest; readonly note?: string }
  | { readonly where: "execute-answer"; readonly member: keyof ExecuteAnswer; readonly note?: string }
  | { readonly where: "result-source"; readonly member: keyof ResultSource; readonly note?: string }
  | { readonly where: "column"; readonly member: keyof Column }
  | {
      readonly where: "console-call";
      readonly call: "execute" | ConsoleFacet;
      readonly action?: TransactionAction;
      readonly note?: string;
    }
  | { readonly where: "transaction-request"; readonly member: keyof BeginRequest; readonly note?: string }
  | { readonly where: "transaction-answer"; readonly member: keyof TransactionAnswer; readonly note?: string }
  | HostOnly;

/** The transaction request that opens a transaction, the one that carries begin's options. */
type BeginRequest = Extract<TransactionRequest, { action: "begin" }>;

/** The placement of a key the open context carries as a connection field. */
function connectionField(): ConnectionField {
  return { where: "connection" };
}

/** Only a key that is a contract field name may be carried as a connection field. */
type ConnectionCensus = {
  readonly [K in keyof Required<DatabaseConnection>]: K extends FieldName ? ConnectionField : InputPlacement;
};

const CONNECTION_CENSUS = {
  id: {
    where: "open-context",
    member: "connectionId",
    note: "the same across every session of the connection, so a provider keys state it keeps between sessions on it",
  },
  name: { where: "host", reason: "The connection's name is presentation core draws, never read by a provider." },
  type: { where: "open-context", member: "engine", note: "the engine id the package serves the connection as" },
  host: connectionField(),
  port: connectionField(),
  user: connectionField(),
  password: connectionField(),
  database: connectionField(),
  schema: connectionField(),
  connectionString: connectionField(),
  queryTimeout: {
    where: "host",
    reason: "The host turns the connection's statement timeout into the deadline of each call it makes.",
  },
  createdAt: { where: "host", reason: "When the connection was saved is core's record, never read by a provider." },
  color: { where: "host", reason: "The connection's colour is presentation core draws." },
  environment: { where: "host", reason: "The environment label is governance core applies before any call." },
  group: { where: "host", reason: "The connection's group is presentation core draws." },
  ssl: { where: "open-context", member: "tls" },
  sshTunnel: {
    where: "host",
    reason:
      "Core opens the SSH tunnel itself and hands the provider the tunnel's local endpoint as the host and port fields.",
  },
  serviceName: connectionField(),
  instanceName: connectionField(),
  localDataCenter: connectionField(),
  authSource: connectionField(),
  saslMechanism: connectionField(),
  allowInsecureAuth: connectionField(),
  dataServers: connectionField(),
  warehouse: connectionField(),
  region: connectionField(),
  apiPath: connectionField(),
  namespaces: connectionField(),
  tlsServerName: connectionField(),
  securityMode: connectionField(),
  serverCertificateThumbprint: connectionField(),
  securityPolicyUri: connectionField(),
  clientCertificatePath: connectionField(),
  clientPrivateKeyPath: connectionField(),
  location: connectionField(),
  amqpPort: connectionField(),
  authMethod: connectionField(),
  privateKey: connectionField(),
  privateKeyPassphrase: connectionField(),
  hostKeyFingerprint: connectionField(),
  role: connectionField(),
  skipObjectScan: {
    where: "host",
    reason: "Whether the object panel scans on open is the editor's choice; no provider reads it.",
  },
  readOnly: { where: "policy", member: "refuseWrites" },
  managed: { where: "policy", member: "managed" },
  seedId: {
    where: "open-context",
    member: "seedId",
    note: "a read-only source names a seed's refusal by it, and InfluxDB runs its read-only seed stage on it",
  },
  agentUser: {
    where: "host",
    reason: "Core resolves the agent credential and hands it to the provider as the user and password fields.",
  },
  agentPassword: {
    where: "host",
    reason: "Core resolves the agent credential and hands it to the provider as the user and password fields.",
  },
  agentReadRoots: connectionField(),
  apiKeyId: connectionField(),
  apiKeySecret: connectionField(),
  registerMap: connectionField(),
} as const satisfies ConnectionCensus;

/** The marks core sets on the connection a provider is built from, beside its fields: its symbol keys. */
type ConnectionMark = Exclude<
  keyof (ProviderConnection & WithAdmittedFile & WithAdmittedHostPaths),
  keyof DatabaseConnection
>;

const MARK_CENSUS = {
  [TUNNEL_FAR_END]: { where: "open-context", member: "tunnelFarEnd" },
  [TUNNEL_ROUTE]: { where: "open-context", member: "tunnelRoute" },
  [LITERAL_SEED_FILE]: { where: "policy", member: "literalSeedFile" },
  [ADMITTED_FILE]: { where: "open-context", member: "admittedFile" },
  [ADMITTED_HOST_PATHS]: { where: "open-context", member: "admittedHostPaths" },
} as const satisfies { readonly [K in ConnectionMark]: InputPlacement };

const OPTIONS_CENSUS = {
  pool: { where: "open-context", member: "pool", note: "with core's defaults filled in" },
  queryTimeout: {
    where: "host",
    reason: "The host turns the statement timeout into the deadline of each call it makes.",
  },
  ssl: {
    where: "host",
    reason:
      "Studio sets no such option; a connection's TLS reaches a package only as its SSL settings, and the legacy bridge keeps passing an embedder's option to a legacy provider.",
  },
  timezone: { where: "open-context", member: "timezone" },
} as const satisfies { readonly [K in keyof Required<ProviderOptions>]: InputPlacement };

const BUILD_CONTEXT_CENSUS = {
  readOnly: { where: "policy", member: "readOnly" },
  sendsStatements: { where: "policy", member: "sendsStatements" },
  allowExternalFileAccess: { where: "policy", member: "allowExternalFileAccess" },
  owner: {
    where: "host",
    reason: "The host keys each session by its owner, so two owners never share one; a provider never names the owner.",
  },
  ownerPoolMax: { where: "open-context", member: "pool", note: "as the pool's max" },
  egress: { where: "open-context", member: "egress" },
  trust: { where: "open-context", member: "trust" },
} as const satisfies { readonly [K in keyof Required<ProviderBuildContext>]: InputPlacement };

const RESULT_CENSUS = {
  rows: { where: "result-source", member: "next", note: "rows are positional under the columns, read in batches" },
  fields: { where: "column", member: "name" },
  rowCount: { where: "result-source", member: "rowCount", note: "the provider's own count, never the host's recount" },
  executionTime: { where: "execute-answer", member: "executionTimeMs" },
  explainPlan: { where: "execute-answer", member: "explainPlan" },
  rolledBack: {
    where: "host",
    reason: "The client sets it when a sandbox run's rollback was confirmed; no provider sets it.",
  },
  pagination: {
    where: "execute-answer",
    member: "boundApplied",
    note: "a bound the provider applied of its own; the host derives the rest from the page and the row past it",
  },
  warnings: { where: "execute-answer", member: "warnings" },
  columnTypes: { where: "column", member: "type" },
  vectorColumns: { where: "column", member: "vector" },
  resultSets: { where: "execute-answer", member: "results", note: "one result source per result set, in order" },
} as const satisfies { readonly [K in keyof Required<QueryResult>]: ConsolePlacement };

const RESULT_SET_CENSUS = {
  rows: { where: "result-source", member: "next" },
  fields: { where: "column", member: "name" },
  columnTypes: { where: "column", member: "type" },
} as const satisfies { readonly [K in keyof Required<QueryResultSet>]: ConsolePlacement };

const PREPARED_CENSUS = {
  query: {
    where: "console-call",
    call: "execute",
    note: "the provider applies the page to the statement inside execute",
  },
  wasLimited: { where: "execute-answer", member: "pageApplied" },
  limit: { where: "execute-request", member: "page" },
  offset: { where: "execute-request", member: "page" },
} as const satisfies { readonly [K in keyof Required<PreparedQuery>]: ConsolePlacement };

const PREPARE_OPTIONS_CENSUS = {
  limit: { where: "execute-request", member: "page", note: "resolved by the host from its default and maximum" },
  offset: { where: "execute-request", member: "page" },
  unlimited: { where: "execute-request", member: "page" },
} as const satisfies { readonly [K in keyof Required<QueryPrepareOptions>]: ConsolePlacement };

/** The console path's provider members today; `Pick` fails typecheck when one of them is renamed or removed. */
type ConsoleMember =
  | keyof Pick<DatabaseProvider, "query" | "prepareQuery" | "endOpenQueryTransaction">
  | keyof QueryCancelProvider;

const CONSOLE_MEMBER_CENSUS = {
  query: { where: "console-call", call: "execute" },
  prepareQuery: { where: "console-call", call: "execute", note: "the page travels in the execute request" },
  cancelQuery: { where: "console-call", call: "cancel" },
  endOpenQueryTransaction: { where: "console-call", call: "endScope" },
} as const satisfies { readonly [K in ConsoleMember]: ConsolePlacement };

/** `DatabaseProvider.query`'s four arguments, in order, each placed. */
const QUERY_ARGUMENT_CENSUS = {
  sql: { where: "execute-request", member: "statement" },
  params: { where: "execute-request", member: "params" },
  queryId: { where: "execute-request", member: "runId" },
  scope: { where: "execute-request", member: "scope", note: "sent only to a package that offers console.endScope" },
} as const satisfies Record<string, ConsolePlacement>;

const QUERY_ARGUMENT_COUNT: Required<Parameters<DatabaseProvider["query"]>>["length"] = 4;

/** The transaction route's provider members today, each placed on the transaction facet or on execute. */
const TRANSACTION_MEMBER_CENSUS = {
  beginTransaction: { where: "console-call", call: "transaction", action: "begin" },
  commitTransaction: { where: "console-call", call: "transaction", action: "commit" },
  rollbackTransaction: { where: "console-call", call: "transaction", action: "rollback" },
  isInTransaction: {
    where: "console-call",
    call: "transaction",
    action: "state",
    note: "every transaction answer, and every answer to a statement inside the transaction, also carries the state",
  },
  queryInTransaction: {
    where: "execute-request",
    member: "transaction",
    note: "a statement inside the transaction is console execute sent with transaction",
  },
} as const satisfies { readonly [K in keyof TransactionProvider]: ConsolePlacement };

const BEGIN_OPTIONS_CENSUS = {
  requireReportedState: { where: "transaction-request", member: "requireReportedState" },
} as const satisfies { readonly [K in keyof Required<BeginTransactionOptions>]: ConsolePlacement };

const BEGIN_RESULT_CENSUS = {
  stateReported: { where: "transaction-answer", member: "stateReported", note: "answered by a begin only" },
} as const satisfies { readonly [K in keyof Required<BeginTransactionResult>]: ConsolePlacement };

/** `TransactionProvider.queryInTransaction`'s two arguments, in order, each placed. */
const QUERY_IN_TRANSACTION_ARGUMENT_CENSUS = {
  sql: { where: "execute-request", member: "statement" },
  params: { where: "execute-request", member: "params" },
} as const satisfies Record<string, ConsolePlacement>;

const QUERY_IN_TRANSACTION_ARGUMENT_COUNT: Required<Parameters<TransactionProvider["queryInTransaction"]>>["length"] =
  2;

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Every placement of every census, by census name and key. */
function placements(): [string, string, InputPlacement | ConsolePlacement | ConnectionField][] {
  const censuses: Record<string, Record<PropertyKey, InputPlacement | ConsolePlacement | ConnectionField>> = {
    DatabaseConnection: CONNECTION_CENSUS,
    "connection marks": MARK_CENSUS,
    ProviderOptions: OPTIONS_CENSUS,
    ProviderBuildContext: BUILD_CONTEXT_CENSUS,
    QueryResult: RESULT_CENSUS,
    QueryResultSet: RESULT_SET_CENSUS,
    PreparedQuery: PREPARED_CENSUS,
    QueryPrepareOptions: PREPARE_OPTIONS_CENSUS,
    console: CONSOLE_MEMBER_CENSUS,
    "query arguments": QUERY_ARGUMENT_CENSUS,
    transaction: TRANSACTION_MEMBER_CENSUS,
    BeginTransactionOptions: BEGIN_OPTIONS_CENSUS,
    BeginTransactionResult: BEGIN_RESULT_CENSUS,
    "queryInTransaction arguments": QUERY_IN_TRANSACTION_ARGUMENT_CENSUS,
  };
  return Object.entries(censuses).flatMap(([census, entries]) =>
    Reflect.ownKeys(entries).map((key): [string, string, (typeof entries)[PropertyKey]] => [
      census,
      typeof key === "symbol" ? String(key.description) : key,
      entries[key],
    ]),
  );
}

describe("the call surface census", () => {
  test("every input a provider is built with has a place in the open context or a reason it stays with the host", () => {
    const fieldNames = new Set(SCHEMA.$defs.fieldName.enum);
    const connectionFields = Object.entries(CONNECTION_CENSUS)
      .filter(([, placement]) => placement.where === "connection")
      .map(([key]) => key);

    expect(connectionFields.length).toBeGreaterThan(30);
    expect(connectionFields.filter((key) => !fieldNames.has(key))).toEqual([]);
    expect([...fieldNames].filter((name) => !connectionFields.includes(name))).toEqual([]);
    expect(Object.keys(BUILD_CONTEXT_CENSUS)).toContain("egress");
    expect(Object.keys(OPTIONS_CENSUS)).toEqual(["pool", "queryTimeout", "ssl", "timezone"]);
    expect(Reflect.ownKeys(MARK_CENSUS)).toEqual([
      TUNNEL_FAR_END,
      TUNNEL_ROUTE,
      LITERAL_SEED_FILE,
      ADMITTED_FILE,
      ADMITTED_HOST_PATHS,
    ]);
    expect(placements().filter(([census]) => census === "connection marks")).toHaveLength(5);
  });

  test("every member of today's console answer and request has a place in the console calls", () => {
    expect(QUERY_ARGUMENT_COUNT).toBe(4);
    expect(Object.keys(QUERY_ARGUMENT_CENSUS)).toHaveLength(QUERY_ARGUMENT_COUNT);
    expect(Object.keys(CONSOLE_MEMBER_CENSUS).sort()).toEqual([
      "cancelQuery",
      "endOpenQueryTransaction",
      "prepareQuery",
      "query",
    ]);
    const hostOnly = placements().filter(([, , placement]) => placement.where === "host");
    const unreasoned = hostOnly.filter(([, , placement]) => !/^[A-Z][^\n]*\.$/.test((placement as HostOnly).reason));

    expect(hostOnly.length).toBeGreaterThan(10);
    expect(unreasoned.map(([census, key]) => `${census}.${key}`)).toEqual([]);
  });

  test("every member of today's transaction surface has a place in the console calls", () => {
    const transaction = placements().filter(([census]) =>
      ["transaction", "BeginTransactionOptions", "BeginTransactionResult", "queryInTransaction arguments"].includes(
        census,
      ),
    );

    expect(QUERY_IN_TRANSACTION_ARGUMENT_COUNT).toBe(2);
    expect(Object.keys(QUERY_IN_TRANSACTION_ARGUMENT_CENSUS)).toHaveLength(QUERY_IN_TRANSACTION_ARGUMENT_COUNT);
    expect(Object.keys(TRANSACTION_MEMBER_CENSUS).sort()).toEqual([
      "beginTransaction",
      "commitTransaction",
      "isInTransaction",
      "queryInTransaction",
      "rollbackTransaction",
    ]);
    expect(
      Object.values(TRANSACTION_MEMBER_CENSUS).flatMap((placement) =>
        "action" in placement ? [placement.action] : [],
      ),
    ).toEqual(["begin", "commit", "rollback", "state"]);
    expect(transaction.map(([census, key]) => `${census}.${key}`)).toEqual([
      "transaction.beginTransaction",
      "transaction.commitTransaction",
      "transaction.rollbackTransaction",
      "transaction.isInTransaction",
      "transaction.queryInTransaction",
      "BeginTransactionOptions.requireReportedState",
      "BeginTransactionResult.stateReported",
      "queryInTransaction arguments.sql",
      "queryInTransaction arguments.params",
    ]);
    expect(transaction.filter(([, , placement]) => placement.where === "host")).toEqual([]);
  });

  test("the context's shared shapes are Studio's own", () => {
    const parity: [
      Mutual<TlsSettings, SSLConfig>,
      Mutual<SdkEgressDecision, EgressDecision>,
      Mutual<SdkTrustMaterial, TrustMaterial>,
      Mutual<PoolSettings, PoolConfig>,
      Mutual<SdkTunnelFarEnd, TunnelFarEnd>,
      Mutual<
        NonNullable<OpenContext["admittedHostPaths"]>,
        NonNullable<WithAdmittedHostPaths[typeof ADMITTED_HOST_PATHS]>
      >,
      Mutual<Warning, QueryWarning>,
      Mutual<VectorColumnShape, VectorColumn>,
      Mutual<EndScopeAnswer["openTransaction"], OpenQueryTransactionOutcome>,
      Mutual<CancelAnswer["cancelled"], Awaited<ReturnType<QueryCancelProvider["cancelQuery"]>>>,
      Mutual<NonNullable<TransactionAnswer["stateReported"]>, BeginTransactionResult["stateReported"]>,
    ] = [true, true, true, true, true, true, true, true, true, true, true];

    // A sample of each shape crosses both ways, so the types above are not only declared but used.
    const tls: SSLConfig = { mode: "verify-full", caCert: "ca", rejectUnauthorized: true };
    const egress: EgressDecision = { blocksPrivateHosts: true, source: "set" };
    const trust: TrustMaterial = { certificates: ["certificate"] };
    const pool: PoolConfig = { min: 0, max: 4, idleTimeout: 30000, acquireTimeout: 60000 };
    const sdkTls: TlsSettings = tls;
    const sdkEgress: SdkEgressDecision = egress;
    const sdkTrust: SdkTrustMaterial = trust;
    const sdkPool: PoolSettings = pool;
    const back: [SSLConfig, EgressDecision, TrustMaterial, PoolConfig] = [sdkTls, sdkEgress, sdkTrust, sdkPool];

    const farEnd: TunnelFarEnd = { host: "db.internal", port: 5432 };
    const sdkFarEnd: SdkTunnelFarEnd = farEnd;
    const farEndBack: TunnelFarEnd = sdkFarEnd;

    expect(parity).toEqual([true, true, true, true, true, true, true, true, true, true, true]);
    expect(back).toEqual([tls, egress, trust, pool]);
    expect(farEndBack).toEqual(farEnd);
  });
});
