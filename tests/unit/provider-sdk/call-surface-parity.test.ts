/**
 * Every input a provider is built with today, and every member of today's console request and answer, has a place in
 * the provider contract's calls, or a stated reason it stays with the host (docs/providers/CONTRACT.md, clause C-7).
 * So a provider moves onto the contract without a behaviour change.
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
  TrustMaterial as SdkTrustMaterial,
  VectorColumnShape,
  Warning,
} from "@libredb/provider-sdk/calls";
import type { FieldName } from "@libredb/provider-sdk/manifest";
import type { QueryCancelProvider } from "@/lib/db/query-cancel";
import type {
  DatabaseProvider,
  EgressDecision,
  OpenQueryTransactionOutcome,
  PoolConfig,
  PreparedQuery,
  ProviderBuildContext,
  ProviderOptions,
  QueryPrepareOptions,
  TrustMaterial,
} from "@/lib/db/types";
import type { VectorColumn } from "@/lib/db/vector/types";
import type { DatabaseConnection, QueryResult, QueryResultSet, QueryWarning, SSLConfig } from "@/lib/types";

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
  | { readonly where: "console-call"; readonly call: "execute" | ConsoleFacet; readonly note?: string }
  | HostOnly;

const CONNECTION_FIELD: ConnectionField = { where: "connection" };

/** Only a key that is a contract field name may be carried as a connection field. */
type ConnectionCensus = {
  readonly [K in keyof Required<DatabaseConnection>]: K extends FieldName ? ConnectionField : InputPlacement;
};

const CONNECTION_CENSUS = {
  id: { where: "host", reason: "The connection's id is core's record key; a provider never names its connection." },
  name: { where: "host", reason: "The connection's name is presentation core draws, never read by a provider." },
  type: { where: "open-context", member: "engine", note: "the engine id the package serves the connection as" },
  host: CONNECTION_FIELD,
  port: CONNECTION_FIELD,
  user: CONNECTION_FIELD,
  password: CONNECTION_FIELD,
  database: CONNECTION_FIELD,
  schema: CONNECTION_FIELD,
  connectionString: CONNECTION_FIELD,
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
  serviceName: CONNECTION_FIELD,
  instanceName: CONNECTION_FIELD,
  localDataCenter: CONNECTION_FIELD,
  authSource: CONNECTION_FIELD,
  saslMechanism: CONNECTION_FIELD,
  allowInsecureAuth: CONNECTION_FIELD,
  dataServers: CONNECTION_FIELD,
  warehouse: CONNECTION_FIELD,
  region: CONNECTION_FIELD,
  apiPath: CONNECTION_FIELD,
  namespaces: CONNECTION_FIELD,
  tlsServerName: CONNECTION_FIELD,
  securityMode: CONNECTION_FIELD,
  serverCertificateThumbprint: CONNECTION_FIELD,
  securityPolicyUri: CONNECTION_FIELD,
  clientCertificatePath: CONNECTION_FIELD,
  clientPrivateKeyPath: CONNECTION_FIELD,
  location: CONNECTION_FIELD,
  amqpPort: CONNECTION_FIELD,
  authMethod: CONNECTION_FIELD,
  privateKey: CONNECTION_FIELD,
  privateKeyPassphrase: CONNECTION_FIELD,
  hostKeyFingerprint: CONNECTION_FIELD,
  role: CONNECTION_FIELD,
  skipObjectScan: {
    where: "host",
    reason: "Whether the object panel scans on open is the editor's choice; no provider reads it.",
  },
  readOnly: { where: "policy", member: "refuseWrites" },
  managed: { where: "host", reason: "Whether an admin manages the connection is core's record, drawn by the UI." },
  seedId: { where: "host", reason: "The seed the connection came from is core's record key." },
  agentUser: {
    where: "host",
    reason: "Core resolves the agent credential and hands it to the provider as the user and password fields.",
  },
  agentPassword: {
    where: "host",
    reason: "Core resolves the agent credential and hands it to the provider as the user and password fields.",
  },
  agentReadRoots: CONNECTION_FIELD,
  apiKeyId: CONNECTION_FIELD,
  apiKeySecret: CONNECTION_FIELD,
  registerMap: CONNECTION_FIELD,
} as const satisfies ConnectionCensus;

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

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Every placement of every census, by census name and key. */
function placements(): [string, string, InputPlacement | ConsolePlacement | ConnectionField][] {
  const censuses: Record<string, Record<string, InputPlacement | ConsolePlacement | ConnectionField>> = {
    DatabaseConnection: CONNECTION_CENSUS,
    ProviderOptions: OPTIONS_CENSUS,
    ProviderBuildContext: BUILD_CONTEXT_CENSUS,
    QueryResult: RESULT_CENSUS,
    QueryResultSet: RESULT_SET_CENSUS,
    PreparedQuery: PREPARED_CENSUS,
    QueryPrepareOptions: PREPARE_OPTIONS_CENSUS,
    console: CONSOLE_MEMBER_CENSUS,
    "query arguments": QUERY_ARGUMENT_CENSUS,
  };
  return Object.entries(censuses).flatMap(([census, entries]) =>
    Object.entries(entries).map(([key, placement]): [string, string, (typeof entries)[string]] => [
      census,
      key,
      placement,
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

  test("the context's shared shapes are Studio's own", () => {
    const parity: [
      Mutual<TlsSettings, SSLConfig>,
      Mutual<SdkEgressDecision, EgressDecision>,
      Mutual<SdkTrustMaterial, TrustMaterial>,
      Mutual<PoolSettings, PoolConfig>,
      Mutual<Warning, QueryWarning>,
      Mutual<VectorColumnShape, VectorColumn>,
      Mutual<EndScopeAnswer["openTransaction"], OpenQueryTransactionOutcome>,
      Mutual<CancelAnswer["cancelled"], Awaited<ReturnType<QueryCancelProvider["cancelQuery"]>>>,
    ] = [true, true, true, true, true, true, true, true];

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

    expect(parity).toEqual([true, true, true, true, true, true, true, true]);
    expect(back).toEqual([tls, egress, trust, pool]);
  });
});
