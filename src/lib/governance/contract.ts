/**
 * Governance contract v1: what Studio and a governance source share (docs/GOVERNANCE.md).
 *
 * A governance source is a PostgreSQL schema, `bridge` unless `GOVERNANCE_POSTGRES_SCHEMA` names another, that a
 * control plane publishes and Studio reads with its own least-privilege role: views that list connections, grants,
 * runtime settings, session revocations and seal canaries, a view Studio inserts query events into, and a view it
 * upserts its heartbeat into. The two never call each other; this module is the whole of what they agree on.
 *
 * It holds the contract as data, the objects, columns and CHECKs docs/GOVERNANCE.md#objects describes, and builds every
 * statement Studio issues against a governance source. `scripts/generate-governance-manifest.ts` turns both into
 * `tests/fixtures/governance/contract-v1.json`, which a control plane vendors from a Studio release and tests its
 * schema against, and `docs/GOVERNANCE.md` explains them. A change here regenerates the manifest in the same commit,
 * which `tests/unit/governance-contract-manifest.test.ts` enforces byte for byte.
 *
 * Nothing here reads the environment or opens a connection: callers pass the schema name, and each builder quotes
 * it after checking it against the rule `GOVERNANCE_POSTGRES_SCHEMA` is read with.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { SCHEMA_NAME } from "@/lib/storage/schema-name";
import { SETTING_KEY_PATTERN } from "./settings-registry";

/** The contract versions this Studio can read; it uses the highest one the governance source also publishes. */
export const SUPPORTED_CONTRACT_VERSIONS: readonly number[] = [1];

/** The schema a governance source publishes the contract in when `GOVERNANCE_POSTGRES_SCHEMA` is unset. */
export const DEFAULT_GOVERNANCE_SCHEMA = "bridge";

/**
 * The files a control plane pins from a Studio release, each with a `.sha256` (docs/GOVERNANCE.md#conformance-files).
 */
export const CONFORMANCE_FILES = [
  "docs/GOVERNANCE.md",
  "tests/fixtures/governance/contract-v1.json",
  "tests/fixtures/governance/lsb1-vectors.json",
] as const;

/**
 * The channel the governance source notifies after a change commits; its payload is only a hint
 * (docs/GOVERNANCE.md#change-notification).
 */
export const NOTIFY_CHANNEL = "libredb_bridge";
/** The `v` of a notification payload `{"v":1,"kind":"<kind>"}`. */
export const NOTIFY_PAYLOAD_VERSION = 1;
/** The `kind` of a notification payload: which source changed. */
export const NOTIFY_KINDS = ["connections", "grants", "settings", "revocations", "canary"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** Each instance pings itself on this prefix plus the first 16 hex digits of the SHA-256 of its instance id. */
export const PING_CHANNEL_PREFIX = "libredb_bridge_ping_";

/**
 * Why Studio left a row out of its snapshot (docs/GOVERNANCE.md#row-admission-and-skip-codes). A skip carries ids,
 * levels, paths and codes, never values.
 */
export const SKIP_CODES = [
  "READ_SECRET_UNOPENABLE",
  "WRITE_SECRET_UNOPENABLE",
  "DEFINITION_INVALID",
  "DEFINITION_HAS_SECRET",
  "ENGINE_UNSUPPORTED",
  "ENGINE_NOT_ALLOWED",
  "SERVER_LEVEL_NOT_ALLOWED",
  "SETTING_INVALID",
] as const;

/** Why a sealed `lsb1` envelope did not open (docs/GOVERNANCE.md#sealed-credentials-lsb1). */
export const ENVELOPE_CODES = ["FORMAT", "UNKNOWN_KID", "AUTH_FAILED", "LOW_ORDER_POINT", "PLAINTEXT_INVALID"] as const;

/** The error codes Studio's API answers under governance, with their HTTP status. */
export const API_CODES = [
  { code: "CONNECTION_NOT_FOUND", httpStatus: 404 },
  { code: "GOVERNANCE_UNAVAILABLE", httpStatus: 503 },
  { code: "AUDIT_UNAVAILABLE", httpStatus: 503 },
  { code: "TRANSACTION_CREDENTIAL_CHANGED", httpStatus: 409 },
  { code: "AI_DISABLED", httpStatus: 403 },
] as const;

/** The states of Studio's notification listener, reported in the heartbeat (docs/GOVERNANCE.md#change-notification). */
export const LISTENER_STATES = ["listening", "reconnecting", "polling", "deaf"] as const;

/** How fresh Studio's snapshot of the governance source is (docs/GOVERNANCE.md#freshness-and-readiness). */
export const FRESHNESS_STATES = ["loading", "ok", "degraded", "unavailable", "misconfigured", "incompatible"] as const;
type FreshnessState = (typeof FRESHNESS_STATES)[number];

/** The `status` of the `GET /api/ready` body. `ready` is answered only with governance off. */
export const READINESS_STATUSES = ["ready", "ok", "degraded", "loading", "misconfigured", "incompatible"] as const;
type ReadinessStatus = (typeof READINESS_STATUSES)[number];

interface ReadinessAnswer {
  readonly status: ReadinessStatus;
  readonly httpStatus: number;
}

/**
 * What `GET /api/ready` answers in each freshness state. An unavailable snapshot is reported as degraded with 200,
 * so an orchestrator keeps the instance and an administrator can still reach its status page.
 */
export const READINESS_BY_FRESHNESS: Readonly<Record<FreshnessState, ReadinessAnswer>> = {
  loading: { status: "loading", httpStatus: 503 },
  ok: { status: "ok", httpStatus: 200 },
  degraded: { status: "degraded", httpStatus: 200 },
  unavailable: { status: "degraded", httpStatus: 200 },
  misconfigured: { status: "misconfigured", httpStatus: 503 },
  incompatible: { status: "incompatible", httpStatus: 503 },
};

/** What `GET /api/ready` answers when governance is off. */
export const READINESS_WITHOUT_GOVERNANCE: ReadinessAnswer = { status: "ready", httpStatus: 200 };

/**
 * The keys a sealed credential's plaintext may carry, all strings (docs/GOVERNANCE.md#sealed-credentials-lsb1). Each
 * level's envelope is a complete credential set, so none of them ever appears in a connection's definition.
 */
export const PLAINTEXT_KEYS = [
  "user",
  "password",
  "connectionString",
  "privateKey",
  "privateKeyPassphrase",
  "apiKeyId",
  "apiKeySecret",
  "sslClientKey",
  "sslClientCert",
] as const;

/** The largest plaintext an envelope may carry, in UTF-8 bytes. */
export const PLAINTEXT_MAX_BYTES = 65536;

/** A value domain as a JSON Schema fragment, the form `z.toJSONSchema()` gives the same field of `SeedConnectionSchema`. */
type DefinitionDomain =
  | { readonly type: "string"; readonly enum?: readonly string[] }
  | { readonly type: "integer"; readonly minimum: number; readonly maximum: number }
  | { readonly type: "boolean" };

/**
 * The closed allowlist of keys a connection definition may carry, with the values `SeedConnectionSchema` accepts for
 * each (docs/GOVERNANCE.md#row-admission-and-skip-codes). A dotted path is a key of a nested object. Any other key,
 * credential or not, is a skip.
 */
export const DEFINITION_ALLOWLIST: readonly { readonly path: string; readonly domain: DefinitionDomain }[] = [
  { path: "host", domain: { type: "string" } },
  { path: "port", domain: { type: "integer", minimum: 1, maximum: 65535 } },
  { path: "database", domain: { type: "string" } },
  { path: "schema", domain: { type: "string" } },
  { path: "serviceName", domain: { type: "string" } },
  { path: "instanceName", domain: { type: "string" } },
  { path: "authSource", domain: { type: "string" } },
  { path: "skipObjectScan", domain: { type: "boolean" } },
  {
    path: "ssl.mode",
    domain: { type: "string", enum: ["disable", "require", "verify-system", "verify-ca", "verify-full"] },
  },
  { path: "ssl.rejectUnauthorized", domain: { type: "boolean" } },
  { path: "ssl.caCert", domain: { type: "string" } },
];

/** The two runtime roles of the contract: Studio's, and the control plane's. */
type ContractRole = "libredb_studio" | "libredb_platform";
type Privilege = "USAGE" | "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "EXECUTE";
/** The privileges each runtime role must hold on an object, and no more. */
export type ContractGrants = Readonly<Record<ContractRole, readonly Privilege[]>>;

/**
 * A rule every value of a column keeps. On a table it is a CHECK constraint the table declares; on a view over a
 * control plane's own tables it is a rule the governance source must keep for the rows behind the view
 * (docs/GOVERNANCE.md#objects), so that Studio is never handed a row it has to refuse for its shape. NULL always
 * passes, as it does in a CHECK.
 */
export type ColumnCheck =
  | { readonly kind: "values"; readonly values: readonly string[] }
  | { readonly kind: "pattern"; readonly pattern: string }
  | { readonly kind: "length"; readonly min: number | null; readonly max: number }
  | { readonly kind: "bytes"; readonly max: number }
  | { readonly kind: "minimum"; readonly min: number }
  | { readonly kind: "cardinality"; readonly max: number }
  | { readonly kind: "json"; readonly jsonType: "array" | "object"; readonly maxItems: number | null };

export interface ContractColumn {
  readonly name: string;
  /** A PostgreSQL type name, as `::regtype` accepts it. */
  readonly type: string;
  /** On a view, whether the definition can yield NULL: PostgreSQL records no NOT NULL for a view column. */
  readonly nullable: boolean;
  /** The default as SQL. On a view, only a default set on the view itself; an insert otherwise takes the table's. */
  readonly default: string | null;
  readonly check: ColumnCheck | null;
}

interface ContractView {
  readonly kind: "view";
  readonly name: string;
  readonly description: string;
  /** The contract table the view is a window on, which Studio writes through; null for a view over private tables. */
  readonly over: string | null;
  readonly where: string | null;
  readonly checkOption: "local" | null;
  /** The notification kind a change to the rows behind the view sends. */
  readonly notifyKind: NotifyKind | null;
  readonly columns: readonly ContractColumn[];
  readonly grants: ContractGrants;
}

interface ContractTable {
  readonly kind: "table";
  readonly name: string;
  readonly description: string;
  readonly columns: readonly ContractColumn[];
  readonly primaryKey: readonly string[];
  /** Table CHECK constraints spanning several columns, by name, as SQL. */
  readonly constraints: readonly { readonly name: string; readonly check: string }[];
  readonly grants: ContractGrants;
}

interface ContractFunction {
  readonly kind: "function";
  readonly name: string;
  readonly description: string;
  readonly arguments: readonly { readonly name: string; readonly type: string; readonly default: string | null }[];
  readonly returns: string;
  readonly securityDefiner: boolean;
  readonly grants: ContractGrants;
}

export type ContractObject = ContractView | ContractTable | ContractFunction;

/** Every view of the contract is created with these options, so it reads its sources with its owner's rights. */
export const VIEW_OPTIONS = { security_barrier: true, security_invoker: false } as const;

/** Both runtime roles need USAGE on the schema to reach any object in it. */
export const SCHEMA_GRANTS: ContractGrants = { libredb_studio: ["USAGE"], libredb_platform: ["USAGE"] };

const READ_BY_BOTH: ContractGrants = { libredb_studio: ["SELECT"], libredb_platform: ["SELECT"] };

const CONTRACT_STATUSES = ["current", "deprecated"] as const;
const ENVIRONMENTS = ["production", "staging", "development", "local", "other"] as const;
const CONNECTION_ID_PATTERN = "^[a-z0-9-]{1,64}$";
const ENGINE_PATTERN = "^[a-z][a-z0-9]{0,31}$";
const KID_PATTERN = "^[0-9a-f]{16}$";
/**
 * An envelope's format and key id; the rest of the envelope is the reader's to check
 * (docs/GOVERNANCE.md#sealed-credentials-lsb1).
 */
const ENVELOPE_PREFIX_PATTERN = "^lsb[1-9][0-9]*\\.[0-9a-f]{16}\\.";
/** `source` and `transaction_outcome` are open vocabularies, checked by format only, so a newer Studio fits. */
const OPEN_VOCABULARY_PATTERN = "^[a-z][a-z-]{0,31}$";

const notNull = (
  name: string,
  type: string,
  rule: { readonly default?: string; readonly check?: ColumnCheck } = {},
): ContractColumn => ({ name, type, nullable: false, default: rule.default ?? null, check: rule.check ?? null });
const nullable = (name: string, type: string, rule: { readonly check?: ColumnCheck } = {}): ContractColumn => ({
  name,
  type,
  nullable: true,
  default: null,
  check: rule.check ?? null,
});
/** A table's column as a view over the table shows it, where only a default set on the view itself counts. */
const onView = (column: ContractColumn, viewDefault: string | null = null): ContractColumn => ({
  name: column.name,
  type: column.type,
  nullable: column.nullable,
  default: viewDefault,
  check: column.check,
});

const oneOf = (values: readonly string[]): ColumnCheck => ({ kind: "values", values });
const matching = (pattern: string): ColumnCheck => ({ kind: "pattern", pattern });
const lengthBetween = (min: number, max: number): ColumnCheck => ({ kind: "length", min, max });
const lengthAtMost = (max: number): ColumnCheck => ({ kind: "length", min: null, max });
const atLeast = (min: number): ColumnCheck => ({ kind: "minimum", min });
const cardinalityAtMost = (max: number): ColumnCheck => ({ kind: "cardinality", max });
const JSON_OBJECT: ColumnCheck = { kind: "json", jsonType: "object", maxItems: null };

const CONTRACT_VIEW: ContractView = {
  kind: "view",
  name: "contract",
  description:
    "The contract versions the governance source publishes, with their status, sunset time and notification channel. Its shape never changes.",
  over: null,
  where: null,
  checkOption: null,
  notifyKind: null,
  columns: [
    notNull("version", "smallint"),
    notNull("status", "text", { check: oneOf(CONTRACT_STATUSES) }),
    nullable("sunset_after", "timestamptz"),
    notNull("notify_channel", "text"),
  ],
  grants: READ_BY_BOTH,
};

const CONNECTIONS_V1: ContractView = {
  kind: "view",
  name: "connections_v1",
  description:
    "The active connections: id, name, engine, environment, group, color, non-secret definition, sealed read and write credentials, MCP flag and update time.",
  over: null,
  where: null,
  checkOption: null,
  notifyKind: "connections",
  columns: [
    notNull("connection_id", "text", { check: matching(CONNECTION_ID_PATTERN) }),
    notNull("name", "text", { check: lengthBetween(1, 128) }),
    notNull("engine", "text", { check: matching(ENGINE_PATTERN) }),
    nullable("environment", "text", { check: oneOf(ENVIRONMENTS) }),
    nullable("group_name", "text", { check: lengthBetween(1, 64) }),
    nullable("color", "text", { check: matching("^#[0-9A-Fa-f]{6}$") }),
    notNull("definition", "jsonb", { check: JSON_OBJECT }),
    notNull("read_secret", "text", { check: matching(ENVELOPE_PREFIX_PATTERN) }),
    nullable("write_secret", "text", { check: matching(ENVELOPE_PREFIX_PATTERN) }),
    notNull("mcp_enabled", "boolean"),
    notNull("updated_at", "timestamptz"),
  ],
  grants: READ_BY_BOTH,
};

const GRANTS_V1: ContractView = {
  kind: "view",
  name: "grants_v1",
  description:
    "One effective grant per subject and connection: its level, when that level ends, whether a write grant was downgraded to read for want of a write credential, and when access was first granted.",
  over: null,
  where: null,
  checkOption: null,
  notifyKind: "grants",
  columns: [
    notNull("subject", "text", { check: lengthBetween(1, 512) }),
    notNull("connection_id", "text", { check: matching(CONNECTION_ID_PATTERN) }),
    notNull("level", "text", { check: oneOf(["read", "write"]) }),
    nullable("expires_at", "timestamptz"),
    notNull("downgraded", "boolean"),
    notNull("granted_at", "timestamptz"),
  ],
  grants: READ_BY_BOTH,
};

const SETTINGS_V1: ContractView = {
  kind: "view",
  name: "settings_v1",
  description: "The runtime settings the control plane set, limited to allowlisted keys published by contract 1.",
  over: null,
  where: null,
  checkOption: null,
  notifyKind: "settings",
  columns: [
    notNull("key", "text", { check: matching(SETTING_KEY_PATTERN) }),
    notNull("value", "jsonb"),
    notNull("updated_at", "timestamptz"),
  ],
  grants: READ_BY_BOTH,
};

const SESSION_REVOCATIONS_V1: ContractView = {
  kind: "view",
  name: "session_revocations_v1",
  description:
    "One row per subject whose sessions must end: a session issued at or before revoked_before is refused. Deny-only.",
  over: null,
  where: null,
  checkOption: null,
  notifyKind: "revocations",
  columns: [notNull("subject", "text", { check: lengthBetween(1, 512) }), notNull("revoked_before", "timestamptz")],
  grants: READ_BY_BOTH,
};

const SEAL_CANARY_V1: ContractView = {
  kind: "view",
  name: "seal_canary_v1",
  description:
    "One test envelope per key id, sealed by the control plane, which Studio opens on every load and reports in its heartbeat.",
  over: null,
  where: null,
  checkOption: null,
  notifyKind: "canary",
  columns: [
    notNull("kid", "text", { check: matching(KID_PATTERN) }),
    notNull("envelope", "text", { check: matching(ENVELOPE_PREFIX_PATTERN) }),
    notNull("created_at", "timestamptz"),
  ],
  grants: READ_BY_BOTH,
};

const QUERY_EVENT: ContractTable = {
  kind: "table",
  name: "query_event",
  description:
    "The rows behind query_events_v1. The control plane reads them; Studio can only insert through the view.",
  columns: [
    notNull("event_id", "uuid"),
    notNull("started_at", "timestamptz"),
    notNull("finished_at", "timestamptz"),
    notNull("received_at", "timestamptz", { default: "now()" }),
    notNull("contract_version", "smallint"),
    notNull("studio_instance", "text", { check: lengthBetween(1, 128) }),
    notNull("subject", "text", { check: lengthBetween(1, 512) }),
    nullable("username", "text", { check: lengthAtMost(320) }),
    notNull("session_role", "text", { check: oneOf(["admin", "user"]) }),
    notNull("connection_id", "text", { check: lengthBetween(1, 64) }),
    nullable("connection_name", "text", { check: lengthAtMost(128) }),
    nullable("engine", "text", { check: matching(ENGINE_PATTERN) }),
    nullable("access_level", "text", { check: oneOf(["read", "write"]) }),
    notNull("source", "text", { check: matching(OPEN_VOCABULARY_PATTERN) }),
    notNull("statement_type", "text", { check: oneOf(["SELECT", "INSERT", "UPDATE", "DELETE", "DDL", "OTHER"]) }),
    nullable("explain", "text", { check: oneOf(["plan", "analyze"]) }),
    notNull("statement_capture", "text", { check: oneOf(["none", "redacted", "full"]) }),
    nullable("statement", "text", { check: { kind: "bytes", max: 65536 } }),
    notNull("statement_truncated", "boolean", { default: "false" }),
    nullable("statement_fingerprint", "text", { check: matching("^[0-9a-f]{64}$") }),
    nullable("unit_index", "integer", { check: atLeast(0) }),
    nullable("row_count", "bigint", { check: atLeast(0) }),
    notNull("duration_ms", "integer", { check: atLeast(0) }),
    notNull("status", "text", { check: oneOf(["success", "error", "cancelled", "refused"]) }),
    nullable("error_code", "text", { check: lengthAtMost(64) }),
    nullable("error_message", "text", { check: lengthAtMost(1000) }),
    nullable("correlation_id", "text", { check: lengthAtMost(128) }),
    nullable("transaction_id", "text", { check: lengthAtMost(128) }),
    nullable("transaction_outcome", "text", { check: matching(OPEN_VOCABULARY_PATTERN) }),
    nullable("client_ip", "inet"),
  ],
  primaryKey: ["event_id"],
  constraints: [
    { name: "query_event_time_order", check: "finished_at >= started_at" },
    { name: "query_event_not_future", check: "started_at <= received_at + interval '5 minutes'" },
    {
      name: "query_event_capture_none",
      check: "statement_capture <> 'none' OR (statement IS NULL AND statement_fingerprint IS NULL)",
    },
    { name: "query_event_error_text_full_only", check: "statement_capture = 'full' OR error_message IS NULL" },
    { name: "query_event_resolved", check: "status = 'refused' OR (engine IS NOT NULL AND access_level IS NOT NULL)" },
  ],
  grants: { libredb_studio: [], libredb_platform: ["SELECT"] },
};

const QUERY_EVENTS_V1: ContractView = {
  kind: "view",
  name: "query_events_v1",
  description:
    "One row per executed unit, inserted by Studio. The database stamps received_at, which the view does not show.",
  over: "query_event",
  where: "contract_version = 1",
  checkOption: "local",
  notifyKind: null,
  // Every column of the table but received_at; contract_version defaults to 1 on the view itself.
  columns: QUERY_EVENT.columns
    .filter((column) => column.name !== "received_at")
    .map((column) => onView(column, column.name === "contract_version" ? "1" : null)),
  grants: { libredb_studio: ["INSERT"], libredb_platform: [] },
};

const STUDIO_INSTANCE: ContractTable = {
  kind: "table",
  name: "studio_instance",
  description:
    "The rows behind studio_instances_v1. The control plane reads them and deletes rows of retired instances.",
  columns: [
    notNull("instance_id", "text", { check: matching("^[A-Za-z0-9._:-]{1,128}$") }),
    notNull("studio_version", "text", { check: lengthBetween(1, 64) }),
    notNull("supported_contracts", "smallint[]", { default: "'{}'", check: cardinalityAtMost(16) }),
    notNull("contract_version", "smallint"),
    notNull("keyring_kids", "text[]", { default: "'{}'", check: cardinalityAtMost(16) }),
    notNull("listener_state", "text", { check: oneOf(LISTENER_STATES) }),
    nullable("last_notification_at", "timestamptz"),
    nullable("snapshot_loaded_at", "timestamptz"),
    notNull("skipped", "jsonb", { default: "'[]'::jsonb", check: { kind: "json", jsonType: "array", maxItems: 500 } }),
    notNull("sink", "jsonb", { default: "'{}'::jsonb", check: JSON_OBJECT }),
    notNull("canary", "jsonb", { default: "'{}'::jsonb", check: JSON_OBJECT }),
    notNull("started_at", "timestamptz"),
    notNull("last_seen_at", "timestamptz", { default: "now()" }),
  ],
  primaryKey: ["instance_id"],
  constraints: [],
  grants: { libredb_studio: [], libredb_platform: ["SELECT", "DELETE"] },
};

const STUDIO_INSTANCES_V1: ContractView = {
  kind: "view",
  name: "studio_instances_v1",
  description: "Each Studio instance's heartbeat and health, upserted by the instance every 30 seconds.",
  over: "studio_instance",
  where: null,
  checkOption: null,
  notifyKind: null,
  columns: STUDIO_INSTANCE.columns.map((column) => onView(column)),
  grants: { libredb_studio: ["SELECT", "INSERT", "UPDATE"], libredb_platform: [] },
};

const TRIM_QUERY_EVENTS: ContractFunction = {
  kind: "function",
  name: "trim_query_events",
  description:
    "Retention: deletes the oldest query events that started more than p_retention_days ago (90 when null, never fewer than 7), at most p_batch a call (10000 by default, never more than 100000), and returns how many it deleted.",
  arguments: [
    { name: "p_retention_days", type: "integer", default: null },
    { name: "p_batch", type: "integer", default: "10000" },
  ],
  returns: "bigint",
  securityDefiner: true,
  grants: { libredb_studio: [], libredb_platform: ["EXECUTE"] },
};

/**
 * Every object of contract v1 in the order docs/GOVERNANCE.md#objects lists them, each table before the view over it.
 */
export const CONTRACT_OBJECTS: readonly ContractObject[] = [
  CONTRACT_VIEW,
  CONNECTIONS_V1,
  GRANTS_V1,
  SETTINGS_V1,
  SESSION_REVOCATIONS_V1,
  SEAL_CANARY_V1,
  QUERY_EVENT,
  QUERY_EVENTS_V1,
  STUDIO_INSTANCE,
  STUDIO_INSTANCES_V1,
  TRIM_QUERY_EVENTS,
];

/**
 * The schema name, double-quoted. Refused unless it is a plain lowercase identifier of at most 63 characters, the
 * rule `readSchemaName()` reads `GOVERNANCE_POSTGRES_SCHEMA` with, so no caller can turn a configured name into SQL
 * of its own and the quoted name means what it says.
 */
export function quoteSchemaName(schema: string): string {
  if (!SCHEMA_NAME.test(schema)) {
    throw new Error(
      `Invalid governance schema name ${JSON.stringify(schema)}: a schema name is 1 to 63 lowercase letters, digits and underscores, not starting with a digit`,
    );
  }
  return `"${schema}"`;
}

/**
 * The reads of a snapshot, in the order the protocol runs them (docs/GOVERNANCE.md#snapshot-protocol). Each names its
 * columns, because a view may gain appended columns within version 1 and Studio reads only the columns of the version
 * it supports.
 */
export const SNAPSHOT_READS = [
  { object: "contract", columns: ["version", "status", "sunset_after", "notify_channel"] },
  {
    object: "connections_v1",
    columns: [
      "connection_id",
      "name",
      "engine",
      "environment",
      "group_name",
      "color",
      "definition",
      "read_secret",
      "write_secret",
      "mcp_enabled",
      "updated_at",
    ],
  },
  { object: "grants_v1", columns: ["subject", "connection_id", "level", "expires_at", "downgraded", "granted_at"] },
  { object: "settings_v1", columns: ["key", "value", "updated_at"] },
  { object: "session_revocations_v1", columns: ["subject", "revoked_before"] },
  { object: "seal_canary_v1", columns: ["kid", "envelope"] },
] as const;

/**
 * One snapshot: a read-only repeatable-read transaction that reads `contract` first
 * (docs/GOVERNANCE.md#snapshot-protocol).
 */
interface SnapshotStatements {
  readonly begin: string;
  readonly contract: string;
  readonly connections: string;
  readonly grants: string;
  readonly settings: string;
  readonly revocations: string;
  readonly canary: string;
  readonly commit: string;
}

export function buildSnapshotStatements(schema: string): SnapshotStatements {
  const qualified = quoteSchemaName(schema);
  const [contract, connections, grants, settings, revocations, canary] = SNAPSHOT_READS.map(
    (read) => `SELECT ${read.columns.join(", ")} FROM ${qualified}.${read.object}`,
  );
  return {
    begin: "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    contract,
    connections,
    grants,
    settings,
    revocations,
    canary,
    commit: "COMMIT",
  };
}

/** `LISTEN` on the channel the governance source notifies after every committed change. */
export function buildListenStatement(): string {
  return `LISTEN ${NOTIFY_CHANNEL}`;
}

/**
 * The channel one instance pings itself on to prove its listener still hears (docs/GOVERNANCE.md#change-notification):
 * the prefix and the first 16 hex digits of the SHA-256 of the instance id, 36 characters, within PostgreSQL's 63-byte
 * identifier limit.
 */
export function pingChannel(instanceId: string): string {
  return `${PING_CHANNEL_PREFIX}${createHash("sha256").update(instanceId, "utf8").digest("hex").slice(0, 16)}`;
}

/** `LISTEN` on this instance's own ping channel. */
export function buildPingListenStatement(instanceId: string): string {
  return `LISTEN ${pingChannel(instanceId)}`;
}

/** The ping itself: `$1` is the ping channel and `$2` a nonce. */
export function buildPingNotifyStatement(): string {
  return "SELECT pg_notify($1, $2)";
}

/** The listener's liveness query, raced against a timer because a half-open TCP connection never errors. */
export function buildListenerProbeStatement(): string {
  return "SELECT 1";
}

/** The columns every heartbeat writes, as its parameters `$1` to `$12` in this order. */
export const HEARTBEAT_COLUMNS = [
  "instance_id",
  "studio_version",
  "supported_contracts",
  "contract_version",
  "keyring_kids",
  "listener_state",
  "last_notification_at",
  "snapshot_loaded_at",
  "skipped",
  "sink",
  "canary",
  "started_at",
] as const;

/**
 * The heartbeat upsert (docs/GOVERNANCE.md#heartbeat). The first beat inserts `started_at` as the process start time;
 * every later beat of the same instance id updates each reported column and stamps `last_seen_at = now()`, and never
 * touches `started_at`, so a control plane reads liveness from `last_seen_at` and uptime from `started_at`.
 */
export function buildHeartbeatUpsert(schema: string): string {
  const qualified = quoteSchemaName(schema);
  const reported = HEARTBEAT_COLUMNS.filter((column) => column !== "instance_id" && column !== "started_at");
  const assignments = [...reported.map((column) => `${column} = EXCLUDED.${column}`), "last_seen_at = now()"];
  return `INSERT INTO ${qualified}.studio_instances_v1 (${HEARTBEAT_COLUMNS.join(", ")}) VALUES (${HEARTBEAT_COLUMNS.map((_, index) => `$${index + 1}`).join(", ")}) ON CONFLICT (instance_id) DO UPDATE SET ${assignments.join(", ")}`;
}

/** The columns of a query event row, in the order every insert binds them. */
export const QUERY_EVENT_COLUMNS: readonly string[] = QUERY_EVENTS_V1.columns.map((column) => column.name);

/** The most rows one insert can bind: PostgreSQL takes at most 65535 parameters per statement. */
export const QUERY_EVENT_INSERT_MAX_ROWS = Math.floor(65535 / QUERY_EVENT_COLUMNS.length);

/**
 * One multi-row insert of `rows` query events (docs/GOVERNANCE.md#query-events). Studio generates each `event_id`
 * before the first attempt and keeps it across retries, so `ON CONFLICT DO NOTHING` makes a retried batch idempotent
 * for a role that may only insert.
 */
export function buildQueryEventInsert(schema: string, rows: number): string {
  const qualified = quoteSchemaName(schema);
  if (!Number.isInteger(rows) || rows < 1 || rows > QUERY_EVENT_INSERT_MAX_ROWS) {
    throw new RangeError(
      `A query event insert binds 1 to ${QUERY_EVENT_INSERT_MAX_ROWS} rows, not ${rows}: PostgreSQL takes at most 65535 parameters per statement`,
    );
  }
  const width = QUERY_EVENT_COLUMNS.length;
  const tuples = Array.from(
    { length: rows },
    (_, row) => `(${QUERY_EVENT_COLUMNS.map((_, column) => `$${row * width + column + 1}`).join(", ")})`,
  );
  return `INSERT INTO ${qualified}.query_events_v1 (${QUERY_EVENT_COLUMNS.join(", ")}) VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`;
}

/** One row Studio left out of its snapshot, as the heartbeat reports it: ids, levels, paths and codes, never values. */
export const SkippedItemSchema = z.strictObject({
  kind: z.enum(["connection", "setting"]),
  /** A connection id, or a setting key. */
  id: z.string().min(1),
  level: z.enum(["read", "write"]).optional(),
  /** The definition field or setting path the code is about. */
  path: z.string().min(1).optional(),
  code: z.enum(SKIP_CODES),
});

/** The heartbeat's `skipped` column, capped at 500 items by its CHECK. */
export const SkippedSchema = z.array(SkippedItemSchema).max(500);

/** The heartbeat's `sink` column: the state of the query event queue. */
export const SinkStateSchema = z.strictObject({
  queued: z.int().min(0),
  dropped: z.int().min(0),
  rejected: z.int().min(0),
  lastFlushAt: z.iso.datetime().nullable(),
  backingOff: z.boolean(),
  lastSqlstate: z
    .string()
    .regex(/^[0-9A-Z]{5}$/)
    .nullable(),
});

/** The heartbeat's `canary` column: for each key id with a canary, `ok` or the code the envelope failed with. */
export const CanaryResultsSchema = z.record(
  z.string().regex(new RegExp(KID_PATTERN)),
  z.enum(["ok", ...ENVELOPE_CODES] as const),
);

/** The body of `GET /api/ready` in every state (docs/GOVERNANCE.md#freshness-and-readiness). */
export const ReadinessBodySchema = z.strictObject({
  status: z.enum(READINESS_STATUSES),
  contract: z.strictObject({
    supported: z.array(z.int().min(1)).min(1),
    /** The negotiated contract version, or null when none is. */
    active: z.int().min(1).nullable(),
  }),
  /** The missing object or privilege, or both version sets. */
  detail: z.string().min(1).optional(),
});
