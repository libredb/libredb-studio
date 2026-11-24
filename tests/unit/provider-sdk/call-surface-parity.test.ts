/**
 * Every input a provider is built with today, and every member of today's console request and answer, of today's
 * transaction surface, of today's object tree surface and of today's maintenance surface, has a place in the provider
 * contract's calls, or a stated reason it stays with the host (docs/providers/CONTRACT.md, clause C-7). So a provider
 * moves onto the contract without a behaviour change. A session's maintenance, narrowed by what its server accepts, is
 * what Studio's `narrowMaintenance` answers for every shipped spec (clause C-68).
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
  type MaintenanceAccepted,
  type MaintenanceFacet,
  type MaintenancePreview as SdkMaintenancePreview,
  type MaintenancePreviewRequest,
  type MaintenanceRunAnswer,
  type MaintenanceRunRequest,
  type OpenAnswer,
  sessionMaintenance,
} from "@libredb/provider-sdk/calls";
import type {
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
  ObjectReadRange as SdkObjectReadRange,
  ObjectsFacet,
  OpenContext,
  OpenPolicy,
  PoolSettings,
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
} from "@libredb/provider-sdk/manifest";
import type { ProviderConnection } from "@/lib/db/provider-connection";
import type { QueryCancelProvider } from "@/lib/db/query-cancel";
import type {
  BeginTransactionOptions,
  BeginTransactionResult,
  Container,
  DatabaseObject,
  DatabaseProvider,
  DescribeObjectsOptions,
  EgressDecision,
  KindCount,
  MaintenanceDeclaration,
  MaintenanceOperation,
  MaintenanceOperationSpec,
  MaintenancePreview,
  MaintenanceResult,
  MeasuredMaintenancePlacements,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectReadOptions,
  ObjectReadRange,
  OpenQueryTransactionOutcome,
  PoolConfig,
  PreparedQuery,
  ProviderBuildContext,
  ProviderOptions,
  QueryPrepareOptions,
  TransactionProvider,
  TrustMaterial,
} from "@/lib/db/types";
import { narrowMaintenance } from "@/lib/db/types";
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

/**
 * Today's object tree surface: the five provider members the object routes, the VS Code backend's tree calls and the
 * inventory read. `Pick` fails typecheck when one of them is renamed or removed.
 */
type ObjectTreeProvider = Pick<
  DatabaseProvider,
  "listContainers" | "countObjects" | "listObjects" | "describeObject" | "describeObjects"
>;

const TREE_MEMBER_CENSUS = {
  listContainers: { where: "objects-call", call: "tree", action: "containers" },
  countObjects: { where: "objects-call", call: "tree", action: "count" },
  listObjects: { where: "objects-call", call: "tree", action: "list" },
  describeObject: { where: "objects-call", call: "tree", action: "describe" },
  describeObjects: { where: "objects-call", call: "tree", action: "describeMany" },
} as const satisfies { readonly [K in keyof ObjectTreeProvider]: TreePlacement };

/** Each member's arguments, in order, each placed. */
const LIST_CONTAINERS_ARGUMENT_CENSUS = {
  parent: { where: "tree-request", action: "containers", member: "parent", note: "absent means the top level" },
} as const satisfies Record<string, TreePlacement>;

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
const TREE_ARGUMENT_COUNTS: { readonly [K in keyof ObjectTreeProvider]: number } = {
  listContainers: 1 satisfies Required<Parameters<ObjectTreeProvider["listContainers"]>>["length"],
  countObjects: 2 satisfies Required<Parameters<ObjectTreeProvider["countObjects"]>>["length"],
  listObjects: 3 satisfies Required<Parameters<ObjectTreeProvider["listObjects"]>>["length"],
  describeObject: 2 satisfies Required<Parameters<ObjectTreeProvider["describeObject"]>>["length"],
  describeObjects: 4 satisfies Required<Parameters<ObjectTreeProvider["describeObjects"]>>["length"],
};

/** Why the billed-read allowance stays with the host. */
const READ_ALLOWANCE_REASON =
  "The billed-read allowance is the per-run ledger of the agent and MCP, which read the tree on the profiled cache; the object routes and the VS Code backend never pass one, and it moves with the agent surface.";

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
type Placement = InputPlacement | ConsolePlacement | ConnectionField | TreePlacement | MaintenancePlacement;

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
    tree: TREE_MEMBER_CENSUS,
    "listContainers arguments": LIST_CONTAINERS_ARGUMENT_CENSUS,
    "countObjects arguments": COUNT_OBJECTS_ARGUMENT_CENSUS,
    "listObjects arguments": LIST_OBJECTS_ARGUMENT_CENSUS,
    "describeObject arguments": DESCRIBE_OBJECT_ARGUMENT_CENSUS,
    "describeObjects arguments": DESCRIBE_OBJECTS_ARGUMENT_CENSUS,
    ObjectReadOptions: OBJECT_READ_OPTIONS_CENSUS,
    DescribeObjectsOptions: DESCRIBE_OBJECTS_OPTIONS_CENSUS,
    maintenance: MAINTENANCE_MEMBER_CENSUS,
    "runMaintenance arguments": RUN_MAINTENANCE_ARGUMENT_CENSUS,
    "previewMaintenance arguments": PREVIEW_MAINTENANCE_ARGUMENT_CENSUS,
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

  test("every member of today's object tree surface has a place in the objects calls", () => {
    const argumentCensuses: { readonly [K in keyof ObjectTreeProvider]: Record<string, TreePlacement> } = {
      listContainers: LIST_CONTAINERS_ARGUMENT_CENSUS,
      countObjects: COUNT_OBJECTS_ARGUMENT_CENSUS,
      listObjects: LIST_OBJECTS_ARGUMENT_CENSUS,
      describeObject: DESCRIBE_OBJECT_ARGUMENT_CENSUS,
      describeObjects: DESCRIBE_OBJECTS_ARGUMENT_CENSUS,
    };
    const tree = placements().filter(([census]) => census === "tree");

    expect(Object.keys(TREE_MEMBER_CENSUS)).toEqual([
      "listContainers",
      "countObjects",
      "listObjects",
      "describeObject",
      "describeObjects",
    ]);
    expect(tree.map(([, , placement]) => ("action" in placement ? placement.action : placement.where))).toEqual([
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
    expect(OBJECT_READ_OPTIONS_CENSUS.readAllowance.where).toBe("host");
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
      Mutual<TreeCountAnswer["counts"], Awaited<ReturnType<ObjectTreeProvider["countObjects"]>>>,
      Mutual<Element<TreeListAnswer["objects"]>, Element<Awaited<ReturnType<ObjectTreeProvider["listObjects"]>>>>,
      Mutual<TreeDescribeAnswer["detail"], Awaited<ReturnType<ObjectTreeProvider["describeObject"]>>>,
      Mutual<SdkObjectDetailBatch, Awaited<ReturnType<ObjectTreeProvider["describeObjects"]>>>,
    ] = [true, true, true, true, true];

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
    expect(answers).toEqual([true, true, true, true, true]);
    expect(back).toEqual([containers, counts, objects, detail, batch]);
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
