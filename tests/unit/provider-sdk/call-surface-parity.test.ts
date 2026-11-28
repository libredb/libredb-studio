/**
 * Every input a provider is built with today, and every member of today's console request and answer, of today's
 * transaction surface, of today's object tree surface, of today's maintenance surface and of today's monitoring, pool
 * statistics and health surface, has a place in the provider contract's calls, or a stated reason it stays with the host
 * (docs/providers/CONTRACT.md, clause C-7). So a provider
 * moves onto the contract without a behaviour change. A session's maintenance, narrowed by what its server accepts, is
 * what Studio's `narrowMaintenance` answers for every shipped spec (clause C-68), and so is the maintenance the legacy
 * bridge answers for a connected provider (clause C-50).
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
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  type ActiveSessionDetails as SdkActiveSessionDetails,
  type ActiveSession as SdkActiveSession,
  type DatabaseOverview as SdkDatabaseOverview,
  type HealthInfo as SdkHealthInfo,
  type IndexStats as SdkIndexStats,
  type MaintenanceAccepted,
  type MaintenanceFacet,
  type MaintenancePreview as SdkMaintenancePreview,
  type MaintenancePreviewRequest,
  type MaintenanceRunAnswer,
  type MaintenanceRunRequest,
  type MonitoringPanelAnswer,
  type MonitoringPanelRequest,
  type MonitoringPanel as SdkMonitoringPanel,
  type OpenAnswer,
  type PerformanceMetrics as SdkPerformanceMetrics,
  type PoolStats as SdkPoolStats,
  READ_ONLY_MODES,
  type SessionActivity as SdkSessionActivity,
  type SlowQuery as SdkSlowQuery,
  type SlowQueryStats as SdkSlowQueryStats,
  type StorageStats as SdkStorageStats,
  sessionMaintenance,
  type TableStats as SdkTableStats,
} from "@libredb/provider-sdk/calls";
import type {
  CallContext,
  CancelAnswer,
  Column,
  ColumnSchema as SdkColumnSchema,
  ConsoleFacet,
  Container as SdkContainer,
  DatabaseObject as SdkDatabaseObject,
  EgressDecision as SdkEgressDecision,
  EndScopeAnswer,
  ExclusionConstraintSchema as SdkExclusionConstraintSchema,
  ExecuteAnswer,
  ExecuteRequest,
  ForeignKeySchema as SdkForeignKeySchema,
  IndexSchema as SdkIndexSchema,
  KindCount as SdkKindCount,
  ObjectDetail as SdkObjectDetail,
  ObjectDetailBatch as SdkObjectDetailBatch,
  ObjectPartEdit as SdkObjectPartEdit,
  ObjectReadRange as SdkObjectReadRange,
  ObjectSourceDocument as SdkObjectSourceDocument,
  ObjectSourceForm as SdkObjectSourceForm,
  ObjectSourceOrigin as SdkObjectSourceOrigin,
  ObjectSourcePart as SdkObjectSourcePart,
  ObjectsFacet,
  OpenContext,
  OpenPolicy,
  PoolSettings,
  ReadBudget,
  ReadOnlyExecute,
  ResultSource,
  TlsSettings,
  TransactionAction,
  TransactionAnswer,
  TransactionRequest,
  TreeAction,
  TreeContainersAnswer,
  TreeCountAnswer,
  TreeDescribeAnswer,
  TreeListAnswer,
  TreeRequest,
  TrustMaterial as SdkTrustMaterial,
  TunnelFarEnd as SdkTunnelFarEnd,
  VectorColumnShape,
  Warning,
} from "@libredb/provider-sdk/calls";
import type {
  EngineDeclaration,
  FieldName,
  MaintenanceSpec,
  MaintenanceOperation as SdkMaintenanceOperation,
  TlsMode,
} from "@libredb/provider-sdk/manifest";
import type { MonitoringPanel } from "@/lib/db/engine-facets/types";
import type { ProviderConnection } from "@/lib/db/provider-connection";
import type { MSSQLProvider } from "@/lib/db/providers/sql/mssql";
import type { OracleProvider } from "@/lib/db/providers/sql/oracle";
import type { PostgresProvider } from "@/lib/db/providers/sql/postgres";
import type { QueryCancelProvider } from "@/lib/db/query-cancel";
import type {
  ActiveSession,
  ActiveSessionDetails,
  BeginTransactionOptions,
  BeginTransactionResult,
  Container,
  DatabaseObject,
  DatabaseOverview,
  DatabaseProvider,
  DescribeObjectsOptions,
  EgressDecision,
  HealthInfo,
  IndexStats,
  KindCount,
  MaintenanceDeclaration,
  MaintenanceOperation,
  MaintenanceOperationSpec,
  MaintenancePreview,
  MaintenanceResult,
  MeasuredMaintenancePlacements,
  MonitoringData,
  MonitoringOptions,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectPartEdit,
  ObjectReadOptions,
  ObjectReadRange,
  ObjectSourceDocument,
  ObjectSourceForm,
  ObjectSourceOrigin,
  ObjectSourcePart,
  OpenQueryTransactionOutcome,
  PerformanceMetrics,
  PoolConfig,
  PreparedQuery,
  ProviderBuildContext,
  ProviderOptions,
  QueryPrepareOptions,
  ReadOnlyStatementBudget,
  ReadOnlyStatementMode,
  SessionActivity,
  SlowQuery,
  SlowQueryStats,
  StorageStats,
  TableStats,
  TransactionProvider,
  TrustMaterial,
} from "@/lib/db/types";
import { narrowMaintenance } from "@/lib/db/types";
import { bridgedMaintenance } from "@/lib/provider-host/legacy-bridge";
import type { VectorColumn } from "@/lib/db/vector/types";
import type {
  ColumnSchema,
  DatabaseConnection,
  ExclusionConstraintSchema,
  ForeignKeySchema,
  IndexSchema,
  QueryResult,
  QueryResultSet,
  QueryWarning,
  SSLConfig,
  SSLMode,
  TunnelFarEnd,
  WithAdmittedFile,
  WithAdmittedHostPaths,
} from "@/lib/types";
import { ADMITTED_FILE, ADMITTED_HOST_PATHS, LITERAL_SEED_FILE, TUNNEL_FAR_END, TUNNEL_ROUTE } from "@/lib/types";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SCHEMA = JSON.parse(
  readFileSync(path.join(ROOT, "packages/provider-sdk/src/manifest/manifest.schema.json"), "utf8"),
) as { $defs: { fieldName: { enum: string[] }; tlsMode?: { enum: string[] } } };

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
  | { readonly where: "read-only-execute"; readonly member: keyof ReadOnlyExecute; readonly note?: string }
  | { readonly where: "read-budget"; readonly member: keyof ReadBudget }
  | { readonly where: "call-context"; readonly member: keyof CallContext; readonly note?: string }
  | HostOnly;

/** A member of today's object tree surface, as the objects calls carry it. */
type TreePlacement =
  | { readonly where: "objects-call"; readonly call: ObjectsFacet; readonly action: TreeAction }
  | {
      readonly [Action in TreeAction]: {
        readonly where: "tree-request";
        readonly action: Action;
        readonly member: Exclude<keyof Extract<TreeRequest, { readonly action: Action }>, "action">;
        readonly note?: string;
      };
    }[TreeAction]
  | {
      readonly where: "tree-answer";
      readonly action: "containers";
      readonly member: Exclude<keyof TreeContainersAnswer, "containers">;
      readonly note?: string;
    }
  | { readonly where: "options"; readonly census: "ObjectReadOptions" | "DescribeObjectsOptions" }
  | HostOnly;

/** A member of today's maintenance surface, as the maintenance calls or the open answer carry it. */
type MaintenancePlacement =
  | { readonly where: "maintenance-call"; readonly call: MaintenanceFacet }
  | {
      readonly where: "maintenance-request";
      readonly call: "run";
      readonly member: keyof MaintenanceRunRequest;
      readonly note?: string;
    }
  | {
      readonly where: "maintenance-request";
      readonly call: "preview";
      readonly member: keyof MaintenancePreviewRequest;
    }
  | { readonly where: "open-answer"; readonly member: keyof OpenAnswer<unknown>; readonly note?: string }
  | HostOnly;

/** One member of one panel's request, typed by that panel's request form. */
type PanelRequestMember = {
  readonly [Panel in SdkMonitoringPanel]: {
    readonly panel: Panel;
    readonly member: Exclude<keyof Extract<MonitoringPanelRequest, { readonly panel: Panel }>, "panel">;
  };
}[SdkMonitoringPanel];

/** The panel whose answer form has the one key `Panel`. */
type AnswerPanel = {
  readonly [Panel in SdkMonitoringPanel]: Extract<MonitoringPanelAnswer, Readonly<Record<Panel, unknown>>> extends never
    ? never
    : Panel;
}[SdkMonitoringPanel];

/** A member of today's monitoring, pool statistics and health surface, as the monitoring calls or health carry it. */
type MonitoringPlacement =
  | { readonly where: "monitoring-call"; readonly call: "panel"; readonly panel: SdkMonitoringPanel }
  | { readonly where: "monitoring-call"; readonly call: "poolStats" }
  | ({ readonly where: "panel-request"; readonly note?: string } & PanelRequestMember)
  | { readonly where: "panel-requests"; readonly requests: readonly PanelRequestMember[]; readonly note?: string }
  | { readonly where: "panel-answer"; readonly panel: AnswerPanel }
  | { readonly where: "mandatory-call"; readonly call: "health" }
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

/** The read-only statement path's provider member today; `Pick` fails typecheck when it is renamed or removed. */
type ReadOnlyStatementProvider = Pick<DatabaseProvider, "queryReadOnly">;

const READ_ONLY_MEMBER_CENSUS = {
  queryReadOnly: {
    where: "execute-request",
    member: "readOnly",
    note: "console execute sent with readOnly, only to a session opened under the read-only policy to be sent statements",
  },
} as const satisfies { readonly [K in keyof Required<ReadOnlyStatementProvider>]: ConsolePlacement };

/** `DatabaseProvider.queryReadOnly`'s three arguments, in order, each placed. */
const QUERY_READ_ONLY_ARGUMENT_CENSUS = {
  statement: { where: "execute-request", member: "statement" },
  budget: { where: "read-only-execute", member: "budget", note: "its rows and bytes; its time is the deadline" },
  mode: { where: "read-only-execute", member: "mode", note: "absent executes the statement" },
} as const satisfies Record<string, ConsolePlacement>;

const QUERY_READ_ONLY_ARGUMENT_COUNT: Required<
  Parameters<Required<ReadOnlyStatementProvider>["queryReadOnly"]>
>["length"] = 3;

const READ_ONLY_BUDGET_CENSUS = {
  statementTimeoutMs: {
    where: "call-context",
    member: "deadline",
    note: "the host sets the call's deadline the timeout ahead",
  },
  maxResultRows: { where: "read-budget", member: "maxRows" },
  maxResultBytes: { where: "read-budget", member: "maxBytes" },
  readAllowance: {
    where: "host",
    reason:
      "The billed-read allowance is a ledger the host charges synchronously as each request is sent, which no frame carries, so it reaches only a legacy provider, through the bridge's read-only statement session, until the contract carries it in a form that crosses a frame.",
  },
} as const satisfies { readonly [K in keyof Required<ReadOnlyStatementBudget>]: ConsolePlacement };

/**
 * Today's object tree surface: the five provider members the object routes, the VS Code backend's tree calls and the
 * inventory read, and the inventory's configuration question the grounding walk asks. `Pick` fails typecheck when one
 * of them is renamed or removed.
 */
type ObjectTreeProvider = Pick<
  DatabaseProvider,
  | "listContainers"
  | "inventoryNeedsConfiguration"
  | "countObjects"
  | "listObjects"
  | "describeObject"
  | "describeObjects"
>;

const TREE_MEMBER_CENSUS = {
  listContainers: { where: "objects-call", call: "tree", action: "containers" },
  inventoryNeedsConfiguration: {
    where: "tree-answer",
    action: "containers",
    member: "needsConfiguration",
    note: "answered only on a top-level listing that lists no container",
  },
  countObjects: { where: "objects-call", call: "tree", action: "count" },
  listObjects: { where: "objects-call", call: "tree", action: "list" },
  describeObject: { where: "objects-call", call: "tree", action: "describe" },
  describeObjects: { where: "objects-call", call: "tree", action: "describeMany" },
} as const satisfies { readonly [K in keyof ObjectTreeProvider]-?: TreePlacement };

/** Each member's arguments, in order, each placed. */
const LIST_CONTAINERS_ARGUMENT_CENSUS = {
  parent: { where: "tree-request", action: "containers", member: "parent", note: "absent means the top level" },
} as const satisfies Record<string, TreePlacement>;

const INVENTORY_NEEDS_CONFIGURATION_ARGUMENT_CENSUS = {} as const satisfies Record<string, TreePlacement>;

const COUNT_OBJECTS_ARGUMENT_CENSUS = {
  container: { where: "tree-request", action: "count", member: "container" },
  options: { where: "options", census: "ObjectReadOptions" },
} as const satisfies Record<string, TreePlacement>;

const LIST_OBJECTS_ARGUMENT_CENSUS = {
  container: { where: "tree-request", action: "list", member: "container" },
  kind: { where: "tree-request", action: "list", member: "kind" },
  options: { where: "options", census: "ObjectReadOptions" },
} as const satisfies Record<string, TreePlacement>;

const DESCRIBE_OBJECT_ARGUMENT_CENSUS = {
  path: { where: "tree-request", action: "describe", member: "path" },
  kind: { where: "tree-request", action: "describe", member: "kind" },
} as const satisfies Record<string, TreePlacement>;

const DESCRIBE_OBJECTS_ARGUMENT_CENSUS = {
  container: { where: "tree-request", action: "describeMany", member: "container" },
  kind: { where: "tree-request", action: "describeMany", member: "kind" },
  limit: { where: "tree-request", action: "describeMany", member: "limit", note: "absent means unbounded" },
  options: { where: "options", census: "DescribeObjectsOptions" },
} as const satisfies Record<string, TreePlacement>;

/** Each member's argument count, held to its census's length by the test. */
const TREE_ARGUMENT_COUNTS: { readonly [K in keyof ObjectTreeProvider]-?: number } = {
  listContainers: 1 satisfies Required<Parameters<ObjectTreeProvider["listContainers"]>>["length"],
  inventoryNeedsConfiguration: 0 satisfies Required<
    Parameters<NonNullable<ObjectTreeProvider["inventoryNeedsConfiguration"]>>
  >["length"],
  countObjects: 2 satisfies Required<Parameters<ObjectTreeProvider["countObjects"]>>["length"],
  listObjects: 3 satisfies Required<Parameters<ObjectTreeProvider["listObjects"]>>["length"],
  describeObject: 2 satisfies Required<Parameters<ObjectTreeProvider["describeObject"]>>["length"],
  describeObjects: 4 satisfies Required<Parameters<ObjectTreeProvider["describeObjects"]>>["length"],
};

/** Why the billed-read allowance stays with the host. */
const READ_ALLOWANCE_REASON =
  "The billed-read allowance is the per-run ledger of the agent and MCP, which read the tree on the profiled cache; the object routes and the VS Code backend never pass one, and it reaches a legacy provider's tree reads through the bridge's session input until the contract carries it.";

const OBJECT_READ_OPTIONS_CENSUS = {
  readAllowance: { where: "host", reason: READ_ALLOWANCE_REASON },
} as const satisfies { readonly [K in keyof Required<ObjectReadOptions>]: TreePlacement };

const DESCRIBE_OBJECTS_OPTIONS_CENSUS = {
  defaultSql: {
    where: "tree-request",
    action: "describeMany",
    member: "defaultSql",
    note: "sent only as true, since a caller asks for the SQL text or does not",
  },
  readAllowance: { where: "host", reason: READ_ALLOWANCE_REASON },
} as const satisfies { readonly [K in keyof Required<DescribeObjectsOptions>]: TreePlacement };

/**
 * Today's maintenance surface: the two provider members the maintenance routes call and the engine principal the
 * maintenance audit row names. `Pick` fails typecheck when one of them is renamed or removed.
 */
type MaintenanceProvider = Pick<DatabaseProvider, "runMaintenance" | "previewMaintenance" | "engineUser">;

const MAINTENANCE_MEMBER_CENSUS = {
  runMaintenance: { where: "maintenance-call", call: "run" },
  previewMaintenance: { where: "maintenance-call", call: "preview" },
  engineUser: {
    where: "open-answer",
    member: "engineUser",
    note: "read once, at open, since a session acts as one principal",
  },
} as const satisfies { readonly [K in keyof Required<MaintenanceProvider>]: MaintenancePlacement };

/** `runMaintenance`'s arguments, in order, each placed. */
const RUN_MAINTENANCE_ARGUMENT_CENSUS = {
  type: { where: "maintenance-request", call: "run", member: "operation" },
  target: { where: "maintenance-request", call: "run", member: "target", note: "absent runs over the whole database" },
  container: { where: "maintenance-request", call: "run", member: "container", note: "absent names none" },
} as const satisfies Record<string, MaintenancePlacement>;

/** `previewMaintenance`'s arguments, in order, each placed. */
const PREVIEW_MAINTENANCE_ARGUMENT_CENSUS = {
  type: { where: "maintenance-request", call: "preview", member: "operation" },
  path: { where: "maintenance-request", call: "preview", member: "path" },
} as const satisfies Record<string, MaintenancePlacement>;

/** Each maintenance member's argument count, held to its census's length by the test. */
const MAINTENANCE_ARGUMENT_COUNTS = {
  runMaintenance: 3 satisfies Required<Parameters<MaintenanceProvider["runMaintenance"]>>["length"],
  previewMaintenance: 2 satisfies Required<
    Parameters<NonNullable<MaintenanceProvider["previewMaintenance"]>>
  >["length"],
};

/**
 * Today's monitoring and health surface: the provider members the monitoring, health and fleet health routes, Test
 * Connection and the agent call. `Pick` fails typecheck when one of them is renamed or removed.
 */
type MonitoringProvider = Pick<
  DatabaseProvider,
  | "getHealth"
  | "getMonitoringData"
  | "getOverview"
  | "getPerformanceMetrics"
  | "getSlowQueries"
  | "getActiveSessions"
  | "getTableStats"
  | "getIndexStats"
  | "getStorageStats"
>;

/**
 * The pool statistics the pool-stats route reads by presence: no `DatabaseProvider` member declares it, so its census is
 * typed over one implementer's own class, and the answer below is held to each implementer's.
 */
type PoolStatsReader = Pick<PostgresProvider, "getPoolStats">;

/** Why the dashboard's orchestration of the panels stays with the host. */
const PANEL_ORCHESTRATION_REASON =
  "The host reads each offered, requested panel through monitoring.panel independently and assembles the dashboard's payload, its panels answered, failed, not requested or not offered.";

const MONITORING_MEMBER_CENSUS = {
  getHealth: { where: "mandatory-call", call: "health" },
  getMonitoringData: { where: "host", reason: PANEL_ORCHESTRATION_REASON },
  getOverview: { where: "monitoring-call", call: "panel", panel: "overview" },
  getPerformanceMetrics: { where: "monitoring-call", call: "panel", panel: "performance" },
  getSlowQueries: { where: "monitoring-call", call: "panel", panel: "slowQueries" },
  getActiveSessions: { where: "monitoring-call", call: "panel", panel: "activeSessions" },
  getTableStats: { where: "monitoring-call", call: "panel", panel: "tables" },
  getIndexStats: { where: "monitoring-call", call: "panel", panel: "indexes" },
  getStorageStats: { where: "monitoring-call", call: "panel", panel: "storage" },
} as const satisfies { readonly [K in keyof MonitoringProvider]: MonitoringPlacement };

const POOL_STATS_CENSUS = {
  getPoolStats: { where: "monitoring-call", call: "poolStats" },
} as const satisfies { readonly [K in keyof PoolStatsReader]: MonitoringPlacement };

/** The options of `getSlowQueries` and `getActiveSessions`, each member placed. */
const SLOW_QUERIES_OPTIONS_CENSUS = {
  limit: {
    where: "panel-request",
    panel: "slowQueries",
    member: "limit",
    note: "required in the request, since the host resolves the default",
  },
} as const satisfies {
  readonly [K in keyof Required<NonNullable<Parameters<MonitoringProvider["getSlowQueries"]>[0]>>]: MonitoringPlacement;
};

const ACTIVE_SESSIONS_OPTIONS_CENSUS = {
  limit: {
    where: "panel-request",
    panel: "activeSessions",
    member: "limit",
    note: "required in the request, since the host resolves the default",
  },
} as const satisfies {
  readonly [K in keyof Required<
    NonNullable<Parameters<MonitoringProvider["getActiveSessions"]>[0]>
  >]: MonitoringPlacement;
};

/** The options of `getTableStats` and `getIndexStats`, each member placed. */
const TABLE_STATS_OPTIONS_CENSUS = {
  schema: { where: "panel-request", panel: "tables", member: "schema", note: "absent for every user schema" },
} as const satisfies {
  readonly [K in keyof Required<NonNullable<Parameters<MonitoringProvider["getTableStats"]>[0]>>]: MonitoringPlacement;
};

const INDEX_STATS_OPTIONS_CENSUS = {
  schema: { where: "panel-request", panel: "indexes", member: "schema", note: "absent for every user schema" },
} as const satisfies {
  readonly [K in keyof Required<NonNullable<Parameters<MonitoringProvider["getIndexStats"]>[0]>>]: MonitoringPlacement;
};

/** Each monitoring member's argument count, held to its census by the test. */
const MONITORING_ARGUMENT_COUNTS = {
  getHealth: 0 satisfies Required<Parameters<MonitoringProvider["getHealth"]>>["length"],
  getMonitoringData: 1 satisfies Required<Parameters<MonitoringProvider["getMonitoringData"]>>["length"],
  getOverview: 0 satisfies Required<Parameters<MonitoringProvider["getOverview"]>>["length"],
  getPerformanceMetrics: 0 satisfies Required<Parameters<MonitoringProvider["getPerformanceMetrics"]>>["length"],
  getSlowQueries: 1 satisfies Required<Parameters<MonitoringProvider["getSlowQueries"]>>["length"],
  getActiveSessions: 1 satisfies Required<Parameters<MonitoringProvider["getActiveSessions"]>>["length"],
  getTableStats: 1 satisfies Required<Parameters<MonitoringProvider["getTableStats"]>>["length"],
  getIndexStats: 1 satisfies Required<Parameters<MonitoringProvider["getIndexStats"]>>["length"],
  getStorageStats: 0 satisfies Required<Parameters<MonitoringProvider["getStorageStats"]>>["length"],
  getPoolStats: 0 satisfies Required<Parameters<PoolStatsReader["getPoolStats"]>>["length"],
} as const;

/** Why the options that choose which panels are read stay with the host. */
const PANEL_CHOICE_REASON = "Which panels a dashboard read asks is the host's choice, made before any panel call.";

const MONITORING_OPTIONS_CENSUS = {
  includeTables: { where: "host", reason: PANEL_CHOICE_REASON },
  includeIndexes: { where: "host", reason: PANEL_CHOICE_REASON },
  includeStorage: { where: "host", reason: PANEL_CHOICE_REASON },
  slowQueryLimit: {
    where: "panel-requests",
    requests: [{ panel: "slowQueries", member: "limit" }],
    note: "the host resolves the default, 10",
  },
  sessionLimit: {
    where: "panel-requests",
    requests: [{ panel: "activeSessions", member: "limit" }],
    note: "the host resolves the default, 50",
  },
  schemaFilter: {
    where: "panel-requests",
    requests: [
      { panel: "tables", member: "schema" },
      { panel: "indexes", member: "schema" },
    ],
  },
} as const satisfies { readonly [K in keyof Required<MonitoringOptions>]: MonitoringPlacement };

const MONITORING_DATA_CENSUS = {
  timestamp: { where: "host", reason: "The host stamps the dashboard payload when it assembles it." },
  overview: { where: "panel-answer", panel: "overview" },
  performance: { where: "panel-answer", panel: "performance" },
  slowQueries: { where: "panel-answer", panel: "slowQueries" },
  activeSessions: { where: "panel-answer", panel: "activeSessions" },
  tables: { where: "panel-answer", panel: "tables" },
  indexes: { where: "panel-answer", panel: "indexes" },
  storage: { where: "panel-answer", panel: "storage" },
  errors: {
    where: "host",
    reason: "A failed panel's sentence is the error its panel call raised, which the host lays under the panel's key.",
  },
  notOffered: {
    where: "host",
    reason:
      "The panels the session's engine does not offer are the host's reading of the engine's declaration, never read.",
  },
  maintenance: {
    where: "host",
    reason:
      "The connected provider's maintenance is the session's maintenance, which the host keeps beside the session.",
  },
} as const satisfies { readonly [K in keyof Required<MonitoringData>]: MonitoringPlacement };

/** The committed engine declarations, each the declaration of one shipped type-id. */
const DECLARATIONS_DIRECTORY = path.join(ROOT, "src/lib/db/engine-declarations");

function engineDeclarations(): EngineDeclaration[] {
  return readdirSync(DECLARATIONS_DIRECTORY)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(DECLARATIONS_DIRECTORY, name), "utf8")) as EngineDeclaration);
}

/** A declaration's spec in Studio's form, each member the declaration writes as null or false left out. */
function studioSpec(spec: MaintenanceSpec): MaintenanceOperationSpec {
  return {
    label: spec.label,
    perEntity: spec.perEntity,
    global: spec.global,
    ...(spec.title === null ? {} : { title: spec.title }),
    ...(spec.description === null ? {} : { description: spec.description }),
    ...(spec.confirmation === null ? {} : { confirmation: spec.confirmation }),
    ...(spec.preview ? { preview: true as const } : {}),
    ...(spec.kinds === null ? {} : { kinds: [...spec.kinds] }),
  };
}

/** An engine's maintenance in Studio's form, as a connected provider declares it. */
function studioMaintenance(facets: EngineDeclaration["facets"]): Required<MaintenanceDeclaration> {
  return {
    maintenanceOperations: [...facets.maintenance],
    maintenanceOperationSpecs: Object.fromEntries(
      facets.maintenanceSpecs.map((spec) => [spec.operation, studioSpec(spec)]),
    ),
  };
}

/** Studio's maintenance in the declaration's form, each member Studio leaves out written as null or false. */
function declarationMaintenance(studio: Required<MaintenanceDeclaration>): {
  readonly maintenance: readonly MaintenanceOperation[];
  readonly maintenanceSpecs: readonly MaintenanceSpec[];
} {
  return {
    maintenance: [...studio.maintenanceOperations],
    maintenanceSpecs: studio.maintenanceOperations.flatMap((operation) => {
      const spec = studio.maintenanceOperationSpecs[operation];
      if (spec === undefined) return [];
      return [
        {
          operation,
          label: spec.label,
          perEntity: spec.perEntity,
          global: spec.global,
          title: spec.title ?? null,
          description: spec.description ?? null,
          confirmation: spec.confirmation ?? null,
          preview: spec.preview === true,
          kinds: spec.kinds === undefined ? null : [...spec.kinds],
        },
      ];
    }),
  };
}

/** Each placement answer a server may give for one operation. */
const PLACEMENT_ANSWERS: readonly MeasuredMaintenancePlacements[] = [
  { perEntity: true, global: true },
  { perEntity: true, global: false },
  { perEntity: false, global: true },
  { perEntity: false, global: false },
];

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Whether two record types have the same keys, optional ones included, which `Mutual` alone does not hold. */
type SameKeys<A, B> = Mutual<keyof Required<A>, keyof Required<B>>;

/** One answer form's list, element by element: a Studio list is a mutable array, the SDK's a readonly one. */
type Element<List> = List extends readonly (infer Item)[] ? Item : never;

/** A placement of any census. */
type Placement =
  | InputPlacement
  | ConsolePlacement
  | ConnectionField
  | TreePlacement
  | MaintenancePlacement
  | MonitoringPlacement;

/** Every placement of every census, by census name and key. */
function placements(): [string, string, Placement][] {
  const censuses: Record<string, Record<PropertyKey, Placement>> = {
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
    "read-only statement": READ_ONLY_MEMBER_CENSUS,
    "queryReadOnly arguments": QUERY_READ_ONLY_ARGUMENT_CENSUS,
    ReadOnlyStatementBudget: READ_ONLY_BUDGET_CENSUS,
    tree: TREE_MEMBER_CENSUS,
    "listContainers arguments": LIST_CONTAINERS_ARGUMENT_CENSUS,
    "inventoryNeedsConfiguration arguments": INVENTORY_NEEDS_CONFIGURATION_ARGUMENT_CENSUS,
    "countObjects arguments": COUNT_OBJECTS_ARGUMENT_CENSUS,
    "listObjects arguments": LIST_OBJECTS_ARGUMENT_CENSUS,
    "describeObject arguments": DESCRIBE_OBJECT_ARGUMENT_CENSUS,
    "describeObjects arguments": DESCRIBE_OBJECTS_ARGUMENT_CENSUS,
    ObjectReadOptions: OBJECT_READ_OPTIONS_CENSUS,
    DescribeObjectsOptions: DESCRIBE_OBJECTS_OPTIONS_CENSUS,
    maintenance: MAINTENANCE_MEMBER_CENSUS,
    "runMaintenance arguments": RUN_MAINTENANCE_ARGUMENT_CENSUS,
    "previewMaintenance arguments": PREVIEW_MAINTENANCE_ARGUMENT_CENSUS,
    monitoring: MONITORING_MEMBER_CENSUS,
    "pool statistics": POOL_STATS_CENSUS,
    "getSlowQueries options": SLOW_QUERIES_OPTIONS_CENSUS,
    "getActiveSessions options": ACTIVE_SESSIONS_OPTIONS_CENSUS,
    "getTableStats options": TABLE_STATS_OPTIONS_CENSUS,
    "getIndexStats options": INDEX_STATS_OPTIONS_CENSUS,
    MonitoringOptions: MONITORING_OPTIONS_CENSUS,
    MonitoringData: MONITORING_DATA_CENSUS,
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

  test("every member of today's read-only statement surface has a place in the console calls or with the host", () => {
    const readOnly = placements().filter(([census]) =>
      ["read-only statement", "queryReadOnly arguments", "ReadOnlyStatementBudget"].includes(census),
    );
    // Studio's mode is the SDK's, both ways, so a mode added to either fails typecheck here.
    const sameModes: Mutual<ReadOnlyStatementMode, (typeof READ_ONLY_MODES)[number]> = true;

    expect(QUERY_READ_ONLY_ARGUMENT_COUNT).toBe(3);
    expect(Object.keys(QUERY_READ_ONLY_ARGUMENT_CENSUS)).toHaveLength(QUERY_READ_ONLY_ARGUMENT_COUNT);
    expect(readOnly.map(([census, key, placement]) => [`${census}.${key}`, placement.where])).toEqual([
      ["read-only statement.queryReadOnly", "execute-request"],
      ["queryReadOnly arguments.statement", "execute-request"],
      ["queryReadOnly arguments.budget", "read-only-execute"],
      ["queryReadOnly arguments.mode", "read-only-execute"],
      ["ReadOnlyStatementBudget.statementTimeoutMs", "call-context"],
      ["ReadOnlyStatementBudget.maxResultRows", "read-budget"],
      ["ReadOnlyStatementBudget.maxResultBytes", "read-budget"],
      ["ReadOnlyStatementBudget.readAllowance", "host"],
    ]);
    expect(READ_ONLY_BUDGET_CENSUS.readAllowance.reason).toMatch(/^[A-Z][^\n]*\.$/);
    expect(sameModes).toBe(true);
    expect<readonly string[]>([...READ_ONLY_MODES]).toEqual(["execute", "estimate-plan"]);
  });

  test("every member of today's object tree surface has a place in the objects calls", () => {
    const argumentCensuses: { readonly [K in keyof ObjectTreeProvider]-?: Record<string, TreePlacement> } = {
      listContainers: LIST_CONTAINERS_ARGUMENT_CENSUS,
      inventoryNeedsConfiguration: INVENTORY_NEEDS_CONFIGURATION_ARGUMENT_CENSUS,
      countObjects: COUNT_OBJECTS_ARGUMENT_CENSUS,
      listObjects: LIST_OBJECTS_ARGUMENT_CENSUS,
      describeObject: DESCRIBE_OBJECT_ARGUMENT_CENSUS,
      describeObjects: DESCRIBE_OBJECTS_ARGUMENT_CENSUS,
    };
    const tree = placements().filter(([census]) => census === "tree");

    expect(Object.keys(TREE_MEMBER_CENSUS)).toEqual([
      "listContainers",
      "inventoryNeedsConfiguration",
      "countObjects",
      "listObjects",
      "describeObject",
      "describeObjects",
    ]);
    expect(tree.map(([, , placement]) => ("action" in placement ? placement.action : placement.where))).toEqual([
      "containers",
      "containers",
      "count",
      "list",
      "describe",
      "describeMany",
    ]);
    expect(Object.entries(argumentCensuses).map(([member, census]) => [member, Object.keys(census).length])).toEqual(
      Object.entries(TREE_ARGUMENT_COUNTS),
    );
    expect(Object.values(argumentCensuses).flatMap((census) => Object.keys(census))).toEqual([
      "parent",
      "container",
      "options",
      "container",
      "kind",
      "options",
      "path",
      "kind",
      "container",
      "kind",
      "limit",
      "options",
    ]);
    for (const [member, census] of Object.entries(argumentCensuses)) {
      const action = TREE_MEMBER_CENSUS[member as keyof ObjectTreeProvider].action;
      for (const placement of Object.values(census)) {
        if (placement.where === "tree-request") expect([member, placement.action]).toEqual([member, action]);
      }
    }
    expect(TREE_MEMBER_CENSUS.inventoryNeedsConfiguration).toEqual({
      where: "tree-answer",
      action: "containers",
      member: "needsConfiguration",
      note: "answered only on a top-level listing that lists no container",
    });
    expect(OBJECT_READ_OPTIONS_CENSUS.readAllowance.where).toBe("host");
    expect(READ_ALLOWANCE_REASON).toMatch(/through the bridge's session input/);
    expect(DESCRIBE_OBJECTS_OPTIONS_CENSUS.readAllowance.where).toBe("host");
    expect(DESCRIBE_OBJECTS_OPTIONS_CENSUS.defaultSql.member).toBe("defaultSql");
  });

  test("the object tree's answers are Studio's own shapes", () => {
    const parity: [
      Mutual<SdkContainer, Container>,
      Mutual<SdkObjectReadRange, ObjectReadRange>,
      Mutual<SdkDatabaseObject, DatabaseObject>,
      Mutual<SdkKindCount, KindCount>,
      Mutual<SdkColumnSchema, ColumnSchema>,
      Mutual<SdkIndexSchema, IndexSchema>,
      Mutual<SdkForeignKeySchema, ForeignKeySchema>,
      Mutual<SdkExclusionConstraintSchema, ExclusionConstraintSchema>,
      Mutual<SdkObjectDetail, ObjectDetail>,
      Mutual<SdkObjectDetailBatch, ObjectDetailBatch>,
    ] = [true, true, true, true, true, true, true, true, true, true];
    const keys: [
      SameKeys<SdkContainer, Container>,
      SameKeys<SdkDatabaseObject, DatabaseObject>,
      SameKeys<SdkColumnSchema, ColumnSchema>,
      SameKeys<SdkIndexSchema, IndexSchema>,
      SameKeys<SdkForeignKeySchema, ForeignKeySchema>,
      SameKeys<SdkExclusionConstraintSchema, ExclusionConstraintSchema>,
      SameKeys<SdkObjectDetail, ObjectDetail>,
      SameKeys<SdkObjectDetailBatch, ObjectDetailBatch>,
    ] = [true, true, true, true, true, true, true, true];
    const answers: [
      Mutual<
        Element<TreeContainersAnswer["containers"]>,
        Element<Awaited<ReturnType<ObjectTreeProvider["listContainers"]>>>
      >,
      Mutual<
        TreeContainersAnswer["needsConfiguration"],
        Awaited<ReturnType<NonNullable<ObjectTreeProvider["inventoryNeedsConfiguration"]>>>
      >,
      Mutual<TreeCountAnswer["counts"], Awaited<ReturnType<ObjectTreeProvider["countObjects"]>>>,
      Mutual<Element<TreeListAnswer["objects"]>, Element<Awaited<ReturnType<ObjectTreeProvider["listObjects"]>>>>,
      Mutual<TreeDescribeAnswer["detail"], Awaited<ReturnType<ObjectTreeProvider["describeObject"]>>>,
      Mutual<SdkObjectDetailBatch, Awaited<ReturnType<ObjectTreeProvider["describeObjects"]>>>,
    ] = [true, true, true, true, true, true];

    // A sample of each answer crosses both ways, Studio's mutable lists into the SDK's readonly ones and back by element.
    const containers: Container[] = [{ path: ["public"], name: "public", level: 0, kinds: ["table"] }];
    const counts: Record<string, KindCount> = {
      table: { count: 2 },
      view: { count: 1, sampledFrom: "one 1,000-key SCAN walk" },
      index: { unavailable: "permission denied" },
    };
    const objects: DatabaseObject[] = [
      { path: ["public", "orders"], name: "orders", kind: "table", readRanges: [{ prefix: "orders/" }] },
    ];
    const detail: ObjectDetail = {
      path: ["public", "orders"],
      columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
      indexes: [{ name: "orders_pkey", columns: ["id"], unique: true }],
      foreignKeys: [{ columnName: "id", referencedTable: "customers", referencedColumn: "id" }],
      exclusionConstraints: [{ name: "no_overlap", definition: "EXCLUDE USING gist (during WITH &&)" }],
    };
    const batch: ObjectDetailBatch = { details: [detail], truncated: { limit: 1, reason: "bounded" } };
    const sdkAnswers: [
      TreeContainersAnswer,
      TreeCountAnswer,
      TreeListAnswer,
      TreeDescribeAnswer,
      SdkObjectDetailBatch,
    ] = [{ containers }, { counts }, { objects }, { detail }, batch];
    const back: [Container[], Record<string, KindCount>, DatabaseObject[], ObjectDetail, ObjectDetailBatch] = [
      sdkAnswers[0].containers.map((item): Container => item),
      sdkAnswers[1].counts,
      sdkAnswers[2].objects.map((item): DatabaseObject => item),
      sdkAnswers[3].detail,
      sdkAnswers[4],
    ];

    expect(parity).toEqual([true, true, true, true, true, true, true, true, true, true]);
    expect(keys).toEqual([true, true, true, true, true, true, true, true]);
    expect(answers).toEqual([true, true, true, true, true, true]);
    expect(back).toEqual([containers, counts, objects, detail, batch]);
  });

  test("the object source document is Studio's own shape", () => {
    const parity: [
      Mutual<SdkObjectSourceForm, ObjectSourceForm>,
      Mutual<SdkObjectSourceOrigin, ObjectSourceOrigin>,
      Mutual<SdkObjectPartEdit, ObjectPartEdit>,
      Mutual<SdkObjectSourcePart, ObjectSourcePart>,
      Mutual<SdkObjectSourceDocument, ObjectSourceDocument>,
      Mutual<SdkObjectSourceDocument, Awaited<ReturnType<NonNullable<DatabaseProvider["readObjectSource"]>>>>,
    ] = [true, true, true, true, true, true];
    const keys: [SameKeys<SdkObjectSourceDocument, ObjectSourceDocument>] = [true];

    // A sample of each part form crosses both ways.
    const document: ObjectSourceDocument = {
      path: ["public", "order_total"],
      kind: "function",
      parts: [
        {
          id: "definition",
          label: "Definition",
          text: "CREATE FUNCTION order_total() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql",
          language: "sql",
          form: "complete",
          origin: "regenerated",
          truncated: { limit: 10, reason: "bounded" },
          edit: { offered: false, reason: "must be owner of function order_total" },
        },
        { id: "body", label: "Body", unavailable: "permission denied" },
        { id: "note", label: "Note", unavailable: "nothing is read here", statement: true },
      ],
    };
    const sdk: SdkObjectSourceDocument = document;
    const back: ObjectSourceDocument = sdk;

    expect(parity).toEqual([true, true, true, true, true, true]);
    expect(keys).toEqual([true]);
    expect(back).toBe(document);
  });

  test("every member of today's maintenance surface has a place in the maintenance calls or the open answer", () => {
    const maintenance = placements().filter(([census]) =>
      ["maintenance", "runMaintenance arguments", "previewMaintenance arguments"].includes(census),
    );

    expect(maintenance.map(([census, key]) => `${census}.${key}`)).toEqual([
      "maintenance.runMaintenance",
      "maintenance.previewMaintenance",
      "maintenance.engineUser",
      "runMaintenance arguments.type",
      "runMaintenance arguments.target",
      "runMaintenance arguments.container",
      "previewMaintenance arguments.type",
      "previewMaintenance arguments.path",
    ]);
    expect(Object.keys(RUN_MAINTENANCE_ARGUMENT_CENSUS)).toHaveLength(MAINTENANCE_ARGUMENT_COUNTS.runMaintenance);
    expect(Object.keys(PREVIEW_MAINTENANCE_ARGUMENT_CENSUS)).toHaveLength(
      MAINTENANCE_ARGUMENT_COUNTS.previewMaintenance,
    );
    expect(MAINTENANCE_ARGUMENT_COUNTS).toEqual({ runMaintenance: 3, previewMaintenance: 2 });
    for (const [census, call] of [
      [RUN_MAINTENANCE_ARGUMENT_CENSUS, MAINTENANCE_MEMBER_CENSUS.runMaintenance.call],
      [PREVIEW_MAINTENANCE_ARGUMENT_CENSUS, MAINTENANCE_MEMBER_CENSUS.previewMaintenance.call],
    ] as const) {
      for (const placement of Object.values(census)) expect(placement.call).toBe(call);
    }
    expect(maintenance.filter(([, , placement]) => placement.where === "host")).toEqual([]);
  });

  test("the maintenance answers are Studio's own shapes", () => {
    const parity: [
      Mutual<SdkMaintenanceOperation, MaintenanceOperation>,
      Mutual<Omit<MaintenanceRunAnswer, "rows" | "fields">, Omit<MaintenanceResult, "rows" | "fields">>,
      Mutual<Element<NonNullable<MaintenanceRunAnswer["rows"]>>, Element<NonNullable<MaintenanceResult["rows"]>>>,
      Mutual<Element<NonNullable<MaintenanceRunAnswer["fields"]>>, Element<NonNullable<MaintenanceResult["fields"]>>>,
      Mutual<SdkMaintenancePreview, MaintenancePreview>,
      Mutual<MaintenanceRunRequest["operation"], Parameters<MaintenanceProvider["runMaintenance"]>[0]>,
      Mutual<MaintenancePreviewRequest["path"], Parameters<NonNullable<MaintenanceProvider["previewMaintenance"]>>[1]>,
      Mutual<
        NonNullable<OpenAnswer<unknown>["engineUser"]>,
        NonNullable<ReturnType<NonNullable<MaintenanceProvider["engineUser"]>>>
      >,
      Mutual<
        MaintenanceAccepted["perEntity"] | MaintenanceAccepted["global"],
        MeasuredMaintenancePlacements[keyof MeasuredMaintenancePlacements]
      >,
    ] = [true, true, true, true, true, true, true, true, true];
    const keys: [
      SameKeys<MaintenanceRunAnswer, MaintenanceResult>,
      SameKeys<SdkMaintenancePreview, MaintenancePreview>,
    ] = [true, true];

    // A sample of each answer crosses both ways, Studio's mutable lists into the SDK's readonly ones and back by element.
    const result: MaintenanceResult = {
      success: true,
      executionTime: 12,
      message: "INFO answered 2 lines",
      rows: [{ section: "server", key: "redis_version", value: "8.2.1" }],
      fields: ["section", "key", "value"],
    };
    const preview: MaintenancePreview = {
      summary: "Releasing orders frees its memory on every query node.",
      facts: [{ label: "Loaded replicas", value: "2" }],
      refusal: "orders is not loaded",
      note: "as reported by the server",
    };
    const sdkResult: MaintenanceRunAnswer = result;
    const sdkPreview: SdkMaintenancePreview = preview;
    const back: [MaintenanceResult, MaintenancePreview] = [
      {
        ...sdkResult,
        rows: sdkResult.rows?.map((row): Record<string, unknown> => row),
        fields: sdkResult.fields?.map((name) => name),
      },
      sdkPreview,
    ];

    expect(parity).toEqual([true, true, true, true, true, true, true, true, true]);
    expect(keys).toEqual([true, true]);
    expect(back).toEqual([result, preview]);
  });

  test("every member of today's monitoring and health surface has a place in the monitoring calls, the health call or with the host", () => {
    const optionCensuses = {
      getSlowQueries: SLOW_QUERIES_OPTIONS_CENSUS,
      getActiveSessions: ACTIVE_SESSIONS_OPTIONS_CENSUS,
      getTableStats: TABLE_STATS_OPTIONS_CENSUS,
      getIndexStats: INDEX_STATS_OPTIONS_CENSUS,
    } as const;
    const monitoring = placements().filter(([census]) =>
      [
        "monitoring",
        "pool statistics",
        "getSlowQueries options",
        "getActiveSessions options",
        "getTableStats options",
        "getIndexStats options",
        "MonitoringOptions",
        "MonitoringData",
      ].includes(census),
    );
    const panels: MonitoringPanel[] = [
      "overview",
      "performance",
      "slowQueries",
      "activeSessions",
      "tables",
      "indexes",
      "storage",
    ];

    expect(monitoring.map(([census, key]) => `${census}.${key}`)).toEqual([
      "monitoring.getHealth",
      "monitoring.getMonitoringData",
      "monitoring.getOverview",
      "monitoring.getPerformanceMetrics",
      "monitoring.getSlowQueries",
      "monitoring.getActiveSessions",
      "monitoring.getTableStats",
      "monitoring.getIndexStats",
      "monitoring.getStorageStats",
      "pool statistics.getPoolStats",
      "getSlowQueries options.limit",
      "getActiveSessions options.limit",
      "getTableStats options.schema",
      "getIndexStats options.schema",
      "MonitoringOptions.includeTables",
      "MonitoringOptions.includeIndexes",
      "MonitoringOptions.includeStorage",
      "MonitoringOptions.slowQueryLimit",
      "MonitoringOptions.sessionLimit",
      "MonitoringOptions.schemaFilter",
      "MonitoringData.timestamp",
      "MonitoringData.overview",
      "MonitoringData.performance",
      "MonitoringData.slowQueries",
      "MonitoringData.activeSessions",
      "MonitoringData.tables",
      "MonitoringData.indexes",
      "MonitoringData.storage",
      "MonitoringData.errors",
      "MonitoringData.notOffered",
      "MonitoringData.maintenance",
    ]);
    // Each panel is read by exactly one member, and each panel's answer fills the payload's member of the same name.
    expect(
      Object.values(MONITORING_MEMBER_CENSUS).flatMap((placement) => ("panel" in placement ? [placement.panel] : [])),
    ).toEqual(panels);
    expect(
      Object.entries(MONITORING_DATA_CENSUS).flatMap(([key, placement]) =>
        placement.where === "panel-answer" ? [[key, placement.panel]] : [],
      ),
    ).toEqual(panels.map((panel) => [panel, panel]));
    // Each option a member takes is placed on a member of the request of the panel that member reads.
    for (const [member, census] of Object.entries(optionCensuses)) {
      const read = MONITORING_MEMBER_CENSUS[member as keyof typeof optionCensuses].panel;
      for (const placement of Object.values(census)) expect([member, placement.panel]).toEqual([member, read]);
      expect([member, Object.keys(census).length]).toEqual([
        member,
        MONITORING_ARGUMENT_COUNTS[member as keyof typeof optionCensuses],
      ]);
    }
    expect(MONITORING_ARGUMENT_COUNTS).toEqual({
      getHealth: 0,
      getMonitoringData: 1,
      getOverview: 0,
      getPerformanceMetrics: 0,
      getSlowQueries: 1,
      getActiveSessions: 1,
      getTableStats: 1,
      getIndexStats: 1,
      getStorageStats: 0,
      getPoolStats: 0,
    });
    expect(
      Object.values(MONITORING_OPTIONS_CENSUS).flatMap((placement) =>
        placement.where === "panel-requests" ? placement.requests.map(({ panel, member }) => `${panel}.${member}`) : [],
      ),
    ).toEqual(["slowQueries.limit", "activeSessions.limit", "tables.schema", "indexes.schema"]);
    expect(
      monitoring.filter(([, , placement]) => placement.where === "host").map(([census, key]) => `${census}.${key}`),
    ).toEqual([
      "monitoring.getMonitoringData",
      "MonitoringOptions.includeTables",
      "MonitoringOptions.includeIndexes",
      "MonitoringOptions.includeStorage",
      "MonitoringData.timestamp",
      "MonitoringData.errors",
      "MonitoringData.notOffered",
      "MonitoringData.maintenance",
    ]);
  });

  test("the monitoring and health answers are Studio's own shapes", () => {
    type Form<Panel extends SdkMonitoringPanel> = Extract<MonitoringPanelAnswer, Readonly<Record<Panel, unknown>>>;
    const parity: [
      Mutual<SdkMonitoringPanel, MonitoringPanel>,
      Mutual<AnswerPanel, MonitoringPanel>,
      Mutual<SdkDatabaseOverview, DatabaseOverview>,
      Mutual<SdkPerformanceMetrics, PerformanceMetrics>,
      Mutual<SdkSlowQueryStats, SlowQueryStats>,
      Mutual<SdkSessionActivity, SessionActivity>,
      Mutual<SdkActiveSessionDetails, ActiveSessionDetails>,
      Mutual<SdkTableStats, TableStats>,
      Mutual<SdkIndexStats, IndexStats>,
      Mutual<SdkStorageStats, StorageStats>,
      Mutual<SdkSlowQuery, SlowQuery>,
      Mutual<SdkActiveSession, ActiveSession>,
      Mutual<Omit<SdkHealthInfo, "slowQueries" | "activeSessions">, Omit<HealthInfo, "slowQueries" | "activeSessions">>,
      Mutual<Element<SdkHealthInfo["slowQueries"]>, Element<HealthInfo["slowQueries"]>>,
      Mutual<Element<SdkHealthInfo["activeSessions"]>, Element<HealthInfo["activeSessions"]>>,
    ] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
    const keys: [
      SameKeys<SdkDatabaseOverview, DatabaseOverview>,
      SameKeys<SdkPerformanceMetrics, PerformanceMetrics>,
      SameKeys<SdkSlowQueryStats, SlowQueryStats>,
      SameKeys<SdkActiveSessionDetails, ActiveSessionDetails>,
      SameKeys<SdkTableStats, TableStats>,
      SameKeys<SdkIndexStats, IndexStats>,
      SameKeys<SdkStorageStats, StorageStats>,
      SameKeys<SdkSlowQuery, SlowQuery>,
      SameKeys<SdkActiveSession, ActiveSession>,
      SameKeys<SdkHealthInfo, HealthInfo>,
    ] = [true, true, true, true, true, true, true, true, true, true];
    const answers: [
      Mutual<Form<"overview">["overview"], Awaited<ReturnType<MonitoringProvider["getOverview"]>>>,
      Mutual<Form<"performance">["performance"], Awaited<ReturnType<MonitoringProvider["getPerformanceMetrics"]>>>,
      Mutual<
        Element<Form<"slowQueries">["slowQueries"]>,
        Element<Awaited<ReturnType<MonitoringProvider["getSlowQueries"]>>>
      >,
      Mutual<
        Element<Form<"activeSessions">["activeSessions"]>,
        Element<Awaited<ReturnType<MonitoringProvider["getActiveSessions"]>>>
      >,
      Mutual<Element<Form<"tables">["tables"]>, Element<Awaited<ReturnType<MonitoringProvider["getTableStats"]>>>>,
      Mutual<Element<Form<"indexes">["indexes"]>, Element<Awaited<ReturnType<MonitoringProvider["getIndexStats"]>>>>,
      Mutual<Element<Form<"storage">["storage"]>, Element<Awaited<ReturnType<MonitoringProvider["getStorageStats"]>>>>,
      Mutual<
        SdkHealthInfo["activeConnections"],
        Awaited<ReturnType<MonitoringProvider["getHealth"]>>["activeConnections"]
      >,
      Mutual<SdkPoolStats, ReturnType<PostgresProvider["getPoolStats"]>>,
      Mutual<SdkPoolStats, ReturnType<MSSQLProvider["getPoolStats"]>>,
      Mutual<SdkPoolStats, ReturnType<OracleProvider["getPoolStats"]>>,
    ] = [true, true, true, true, true, true, true, true, true, true, true];
    const requests: [
      Mutual<
        Extract<MonitoringPanelRequest, { readonly panel: "slowQueries" }>["limit"],
        NonNullable<NonNullable<Parameters<MonitoringProvider["getSlowQueries"]>[0]>["limit"]>
      >,
      Mutual<
        Extract<MonitoringPanelRequest, { readonly panel: "activeSessions" }>["limit"],
        NonNullable<NonNullable<Parameters<MonitoringProvider["getActiveSessions"]>[0]>["limit"]>
      >,
      Mutual<
        Extract<MonitoringPanelRequest, { readonly panel: "tables" }>["schema"],
        NonNullable<Parameters<MonitoringProvider["getTableStats"]>[0]>["schema"]
      >,
      Mutual<
        Extract<MonitoringPanelRequest, { readonly panel: "indexes" }>["schema"],
        NonNullable<Parameters<MonitoringProvider["getIndexStats"]>[0]>["schema"]
      >,
    ] = [true, true, true, true];

    // A sample of each answer crosses both ways, Studio's mutable lists into the SDK's readonly ones and back by element.
    const overview: DatabaseOverview = {
      version: "PostgreSQL 17.2",
      uptime: "3 days",
      startTime: new Date(1_700_000_000_000),
      maxConnections: 100,
      databaseSize: "8 MB",
      tableCount: 12,
      indexCount: 4,
    };
    const performance: PerformanceMetrics = { cacheHitRatio: 99.5, cacheHitAdvice: "Increase shared_buffers" };
    const slowQueries: SlowQueryStats[] = [{ query: "select 1", calls: 3, totalTime: 30, avgTime: 10, rows: 3 }];
    const activeSessions: ActiveSessionDetails[] = [
      {
        pid: 4711,
        user: "app",
        database: "orders",
        state: "active",
        activity: "active",
        query: "select 1",
        queryStart: new Date(1_700_000_001_000),
        duration: "1s",
        durationMs: 1000,
      },
    ];
    const tables: TableStats[] = [
      {
        schemaName: "public",
        tableName: "orders",
        totalSize: "8 kB",
        totalSizeBytes: 8192,
        lastVacuum: new Date(1_700_000_002_000),
      },
    ];
    const indexes: IndexStats[] = [
      {
        schemaName: "public",
        tableName: "orders",
        indexName: "orders_pkey",
        columns: ["id"],
        isUnique: true,
        isPrimary: true,
        indexSize: "8 kB",
        scans: 3,
      },
    ];
    const storage: StorageStats[] = [{ name: "pg_default", size: "8 MB", sizeBytes: 8_388_608 }];
    const health: HealthInfo = {
      databaseSize: "8 MB",
      cacheHitRatio: "99.5%",
      slowQueries: [{ query: "select 1", calls: 3, avgTime: "10 ms" }],
      activeSessions: [
        { pid: 4711, user: "app", database: "orders", state: "active", query: "select 1", duration: "1s" },
      ],
    };
    const pool: ReturnType<PostgresProvider["getPoolStats"]> = { total: 5, max: 10, idle: 2, active: 3, waiting: 0 };
    const sdkAnswers: [
      Form<"overview">,
      Form<"performance">,
      Form<"slowQueries">,
      Form<"activeSessions">,
      Form<"tables">,
      Form<"indexes">,
      Form<"storage">,
      SdkHealthInfo,
      SdkPoolStats,
    ] = [
      { overview },
      { performance },
      { slowQueries },
      { activeSessions },
      { tables },
      { indexes },
      { storage },
      health,
      pool,
    ];
    const back: [
      DatabaseOverview,
      PerformanceMetrics,
      SlowQueryStats[],
      ActiveSessionDetails[],
      TableStats[],
      IndexStats[],
      StorageStats[],
      HealthInfo,
      SdkPoolStats,
    ] = [
      sdkAnswers[0].overview,
      sdkAnswers[1].performance,
      sdkAnswers[2].slowQueries.map((item): SlowQueryStats => item),
      sdkAnswers[3].activeSessions.map((item): ActiveSessionDetails => item),
      sdkAnswers[4].tables.map((item): TableStats => item),
      sdkAnswers[5].indexes.map((item): IndexStats => item),
      sdkAnswers[6].storage.map((item): StorageStats => item),
      {
        ...sdkAnswers[7],
        slowQueries: sdkAnswers[7].slowQueries.map((item): SlowQuery => item),
        activeSessions: sdkAnswers[7].activeSessions.map((item): ActiveSession => item),
      },
      sdkAnswers[8],
    ];

    expect(parity).toEqual([true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]);
    expect(keys).toEqual([true, true, true, true, true, true, true, true, true, true]);
    expect(answers).toEqual([true, true, true, true, true, true, true, true, true, true, true]);
    expect(requests).toEqual([true, true, true, true]);
    expect(back).toEqual([overview, performance, slowQueries, activeSessions, tables, indexes, storage, health, pool]);
    expect(back[0].startTime).toBe(overview.startTime);
  });

  test("a session's maintenance is narrowMaintenance's answer for every shipped spec and every placement a server accepts", () => {
    const differing: string[] = [];
    const vacuity = { runs: 0, withdrawsOperation: 0, withdrawsPlacement: 0, namesKill: 0 };
    const compare = (declaration: EngineDeclaration, items: readonly MaintenanceAccepted[], label: string): void => {
      vacuity.runs += 1;
      const declared = {
        maintenance: declaration.facets.maintenance,
        maintenanceSpecs: declaration.facets.maintenanceSpecs,
      };
      const measured = Object.fromEntries(
        items.map((item) => [item.operation, { perEntity: item.perEntity, global: item.global }]),
      );
      const studio = declarationMaintenance(narrowMaintenance(studioMaintenance(declaration.facets), measured));
      const session = sessionMaintenance(declared, { maintenance: items });
      if (JSON.stringify(session) !== JSON.stringify(studio)) differing.push(`${declaration.id} ${label}`);
      if (session.maintenance.length < declared.maintenance.length) vacuity.withdrawsOperation += 1;
      const placementWithdrawn = session.maintenanceSpecs.some((spec) => {
        const before = declared.maintenanceSpecs.find((item) => item.operation === spec.operation);
        return before !== undefined && (before.perEntity !== spec.perEntity || before.global !== spec.global);
      });
      if (placementWithdrawn) vacuity.withdrawsPlacement += 1;
      if (items.some((item) => item.operation === "kill")) vacuity.namesKill += 1;
    };

    for (const declaration of engineDeclarations()) {
      for (const answer of PLACEMENT_ANSWERS) {
        const placed = `${answer.perEntity ? "row" : "no row"} and ${answer.global ? "whole database" : "no whole database"}`;
        for (const spec of declaration.facets.maintenanceSpecs) {
          compare(declaration, [{ operation: spec.operation, ...answer }], `${spec.operation} ${placed}`);
        }
        compare(
          declaration,
          declaration.facets.maintenance.map((operation) => ({
            operation,
            perEntity: answer.perEntity,
            global: answer.global,
          })),
          `every operation ${placed}`,
        );
      }
    }

    expect(differing).toEqual([]);
    expect(vacuity.runs).toBeGreaterThan(200);
    expect(vacuity.withdrawsOperation).toBeGreaterThan(0);
    expect(vacuity.withdrawsPlacement).toBeGreaterThan(0);
    expect(vacuity.namesKill).toBeGreaterThan(0);
  });

  test("a bridged session's maintenance is narrowMaintenance's answer for every shipped spec and every placement a connected server accepts", () => {
    const differing: string[] = [];
    const vacuity = { runs: 0, withdrawsOperation: 0, withdrawsPlacement: 0, namesKill: 0 };
    const compare = (declaration: EngineDeclaration, items: readonly MaintenanceAccepted[], label: string): void => {
      vacuity.runs += 1;
      const declared = studioMaintenance(declaration.facets);
      const measured = Object.fromEntries(
        items.map((item) => [item.operation, { perEntity: item.perEntity, global: item.global }]),
      );
      const connected = narrowMaintenance(declared, measured);
      const provider = {
        getCapabilities: () => ({ supportsMaintenance: true, ...connected }),
      } as unknown as DatabaseProvider;
      const studio = declarationMaintenance(connected);
      const bridged = bridgedMaintenance(provider, declared);
      if (JSON.stringify(bridged) !== JSON.stringify(studio)) differing.push(`${declaration.id} ${label}`);
      if (bridged.maintenance.length < declared.maintenanceOperations.length) vacuity.withdrawsOperation += 1;
      const placementWithdrawn = bridged.maintenanceSpecs.some((spec) => {
        const before = declaration.facets.maintenanceSpecs.find((item) => item.operation === spec.operation);
        return before !== undefined && (before.perEntity !== spec.perEntity || before.global !== spec.global);
      });
      if (placementWithdrawn) vacuity.withdrawsPlacement += 1;
      if (items.some((item) => item.operation === "kill")) vacuity.namesKill += 1;
    };

    for (const declaration of engineDeclarations()) {
      for (const answer of PLACEMENT_ANSWERS) {
        const placed = `${answer.perEntity ? "row" : "no row"} and ${answer.global ? "whole database" : "no whole database"}`;
        for (const spec of declaration.facets.maintenanceSpecs) {
          compare(declaration, [{ operation: spec.operation, ...answer }], `${spec.operation} ${placed}`);
        }
        compare(
          declaration,
          declaration.facets.maintenance.map((operation) => ({
            operation,
            perEntity: answer.perEntity,
            global: answer.global,
          })),
          `every operation ${placed}`,
        );
      }
    }

    expect(differing).toEqual([]);
    expect(vacuity.runs).toBeGreaterThan(200);
    expect(vacuity.withdrawsOperation).toBeGreaterThan(0);
    expect(vacuity.withdrawsPlacement).toBeGreaterThan(0);
    expect(vacuity.namesKill).toBeGreaterThan(0);
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

  test("the manifest's TLS modes are Studio's published SSL modes, in its order", () => {
    // A mode added to SSLMode fails the typecheck at this record, and one added to the schema fails at run time.
    const studioModes: Record<SSLMode, true> = {
      disable: true,
      require: true,
      "verify-system": true,
      "verify-ca": true,
      "verify-full": true,
    };
    const parity: Mutual<TlsMode, SSLMode> = true;

    expect(parity).toBe(true);
    expect(SCHEMA.$defs.tlsMode?.enum).toEqual(Object.keys(studioModes));
  });
});
