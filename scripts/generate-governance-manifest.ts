#!/usr/bin/env bun
/**
 * Writes tests/fixtures/governance/contract-v1.json, the manifest of governance contract v1 (spec 7.10), from
 * src/lib/governance/contract.ts and src/lib/governance/settings-registry.ts.
 *
 * A control plane vendors this file from a Studio release, pinned by its SHA-256, and builds on it: its database
 * tests check that every object exists with the listed columns, types, CHECKs and grants and run every listed
 * statement with its sample parameters as `libredb_studio`, its settings allowlist is generated from the registry,
 * and its connection form offers only definition keys and values the allowlist admits. The heartbeat columns and
 * the readiness body are published as JSON Schema from the same zod schemas Studio validates with, each with an
 * example.
 *
 * The file is committed and never edited by hand. tests/unit/governance-contract-manifest.test.ts regenerates it in
 * memory and fails on any byte of difference, so a change to the contract module lands with its manifest.
 *
 * Run: bun scripts/generate-governance-manifest.ts --write | --check [--out <file>]
 * --write writes the manifest, --check exits 1 when the file differs from what the code builds (an absent file
 * included), and --out names another file for either, resolved against the working directory.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  API_CODES,
  buildHeartbeatUpsert,
  buildListenerProbeStatement,
  buildListenStatement,
  buildPingListenStatement,
  buildPingNotifyStatement,
  buildQueryEventInsert,
  buildSnapshotStatements,
  CanaryResultsSchema,
  type ColumnCheck,
  type ContractColumn,
  type ContractObject,
  CONFORMANCE_FILES,
  CONTRACT_OBJECTS,
  DEFAULT_GOVERNANCE_SCHEMA,
  DEFINITION_ALLOWLIST,
  ENVELOPE_CODES,
  FRESHNESS_STATES,
  HEARTBEAT_COLUMNS,
  LISTENER_STATES,
  NOTIFY_CHANNEL,
  NOTIFY_KINDS,
  NOTIFY_PAYLOAD_VERSION,
  PING_CHANNEL_PREFIX,
  pingChannel,
  PLAINTEXT_KEYS,
  PLAINTEXT_MAX_BYTES,
  QUERY_EVENT_COLUMNS,
  READINESS_BY_FRESHNESS,
  READINESS_WITHOUT_GOVERNANCE,
  ReadinessBodySchema,
  SCHEMA_GRANTS,
  SinkStateSchema,
  SKIP_CODES,
  SkippedSchema,
  SUPPORTED_CONTRACT_VERSIONS,
  VIEW_OPTIONS,
} from "../src/lib/governance/contract";
import { SETTINGS_REGISTRY } from "../src/lib/governance/settings-registry";

/** The manifest's path in the repository, which is also where a control plane finds it in a release. */
export const CONTRACT_MANIFEST_FILE = "tests/fixtures/governance/contract-v1.json";

/** The instance id of the samples: the stable id an installer gives the one Studio replica of a v1 install. */
export const SAMPLE_INSTANCE_ID = "libredb-studio";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const WRITE_COMMAND = `bun scripts/generate-governance-manifest.ts --write`;
const USAGE = "Usage: bun scripts/generate-governance-manifest.ts --write | --check [--out <file>]";

/** A key id of the samples, standing for the one key in the instance's keyring. */
const SAMPLE_KID = "0123456789abcdef";

/** The examples of the three heartbeat JSON columns, which the sample heartbeat also sends. */
const SKIPPED_EXAMPLE = [
  {
    kind: "connection",
    id: "0b1e7c3d-9f2a-4e6b-8c5d-7a4f3e2d1c0b",
    level: "write",
    code: "WRITE_SECRET_UNOPENABLE",
  },
  { kind: "connection", id: "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d", path: "password", code: "DEFINITION_HAS_SECRET" },
  { kind: "setting", id: "query.timeoutMs", code: "SETTING_INVALID" },
];
const SINK_EXAMPLE = {
  queued: 12,
  dropped: 0,
  rejected: 1,
  lastFlushAt: "2026-10-14T12:00:04.000Z",
  backingOff: false,
  lastSqlstate: "23514",
};
/** One canary opened with the instance's key, and one sealed to a key id the instance does not hold. */
const CANARY_EXAMPLE = { [SAMPLE_KID]: "ok", fedcba9876543210: "UNKNOWN_KID" };

/** The heartbeat parameters, by column, as Studio binds them with node-postgres: jsonb as JSON text. */
const SAMPLE_HEARTBEAT: Record<(typeof HEARTBEAT_COLUMNS)[number], unknown> = {
  instance_id: SAMPLE_INSTANCE_ID,
  studio_version: "1.0.0",
  supported_contracts: [...SUPPORTED_CONTRACT_VERSIONS],
  contract_version: 1,
  keyring_kids: [SAMPLE_KID],
  listener_state: "listening",
  last_notification_at: "2026-10-14T12:00:02.000Z",
  snapshot_loaded_at: "2026-10-14T12:00:02.250Z",
  skipped: JSON.stringify(SKIPPED_EXAMPLE),
  sink: JSON.stringify(SINK_EXAMPLE),
  canary: JSON.stringify(CANARY_EXAMPLE),
  started_at: "2026-10-14T11:00:00.000Z",
};

const SAMPLE_SUBJECT = "8d0f6a4e-2b1c-4f3a-9e7d-5c6b4a3f2e1d";
const REDACTED_STATEMENT = "SELECT id, total FROM orders WHERE customer_id = ? LIMIT ?";

/**
 * Two query events: a statement that ran under a read grant with capture `redacted`, and a request for a connection
 * the subject holds no grant on, refused before anything ran, with capture `none`.
 */
const SAMPLE_EVENTS: readonly Record<string, unknown>[] = [
  {
    event_id: "01a13a48-9e00-7a3c-8d4e-5f6a7b8c9d0e",
    started_at: "2026-10-14T12:00:00.000Z",
    finished_at: "2026-10-14T12:00:00.042Z",
    contract_version: 1,
    studio_instance: SAMPLE_INSTANCE_ID,
    subject: SAMPLE_SUBJECT,
    username: "alice@example.com",
    session_role: "user",
    connection_id: "3f2c8a14-5b6e-4c0d-9a7f-1e2d3c4b5a69",
    connection_name: "Orders",
    engine: "postgres",
    access_level: "read",
    source: "editor",
    statement_type: "SELECT",
    explain: null,
    statement_capture: "redacted",
    statement: REDACTED_STATEMENT,
    statement_truncated: false,
    statement_fingerprint: createHash("sha256").update(REDACTED_STATEMENT, "utf8").digest("hex"),
    unit_index: null,
    row_count: 12,
    duration_ms: 42,
    status: "success",
    error_code: null,
    error_message: null,
    correlation_id: null,
    transaction_id: null,
    transaction_outcome: null,
    client_ip: "203.0.113.10",
  },
  {
    event_id: "01a13a48-a1e8-7b4d-9e5f-6a7b8c9d0e1f",
    started_at: "2026-10-14T12:00:01.000Z",
    finished_at: "2026-10-14T12:00:01.000Z",
    contract_version: 1,
    studio_instance: SAMPLE_INSTANCE_ID,
    subject: SAMPLE_SUBJECT,
    username: "alice@example.com",
    session_role: "user",
    connection_id: "0b1e7c3d-9f2a-4e6b-8c5d-7a4f3e2d1c0b",
    connection_name: null,
    engine: null,
    access_level: null,
    source: "editor",
    statement_type: "SELECT",
    explain: null,
    statement_capture: "none",
    statement: null,
    statement_truncated: false,
    statement_fingerprint: null,
    unit_index: null,
    row_count: null,
    duration_ms: 0,
    status: "refused",
    error_code: "CONNECTION_NOT_FOUND",
    error_message: null,
    correlation_id: null,
    transaction_id: null,
    transaction_outcome: null,
    client_ip: "203.0.113.10",
  },
];

/** One `GET /api/ready` body per status, in the order of the status enum. */
const READINESS_EXAMPLES = [
  { status: "ready", contract: { supported: [1], active: null } },
  { status: "ok", contract: { supported: [1], active: 1 } },
  { status: "degraded", contract: { supported: [1], active: 1 } },
  { status: "loading", contract: { supported: [1], active: null } },
  {
    status: "misconfigured",
    contract: { supported: [1], active: null },
    detail: "permission denied for view bridge.grants_v1 (SQLSTATE 42501)",
  },
  {
    status: "incompatible",
    contract: { supported: [1], active: null },
    detail: "no common contract version: Studio supports [1], the governance source publishes [2]",
  },
];

/** What each snapshot statement does, by the key `buildSnapshotStatements()` returns it under. */
const SNAPSHOT_DESCRIPTIONS: Record<keyof ReturnType<typeof buildSnapshotStatements>, string> = {
  begin: "Opens the snapshot: every read below sees one committed state of the governance source.",
  contract: "Reads the published contract versions first; Studio stops here when no version is common to both sides.",
  connections: "Reads the active connections with their sealed credentials.",
  grants: "Reads one effective grant per subject and connection.",
  settings: "Reads the runtime settings the control plane set.",
  revocations: "Reads the latest session revocation per subject.",
  canary: "Reads the seal canary of each key id.",
  commit: "Ends the read-only snapshot.",
};

/** A column CHECK as the SQL a table declares it with. */
function checkSql(column: string, check: ColumnCheck): string {
  switch (check.kind) {
    case "values":
      return `${column} IN (${check.values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",")})`;
    case "pattern":
      return `${column} ~ '${check.pattern.replaceAll("'", "''")}'`;
    case "length":
      return check.min === null
        ? `char_length(${column}) <= ${check.max}`
        : `char_length(${column}) BETWEEN ${check.min} AND ${check.max}`;
    case "bytes":
      return `octet_length(${column}) <= ${check.max}`;
    case "minimum":
      return `${column} >= ${check.min}`;
    case "cardinality":
      return `cardinality(${column}) <= ${check.max}`;
    case "json":
      return check.maxItems === null
        ? `jsonb_typeof(${column}) = '${check.jsonType}'`
        : `jsonb_typeof(${column}) = '${check.jsonType}' AND jsonb_array_length(${column}) <= ${check.maxItems}`;
  }
}

function columnEntry(column: ContractColumn) {
  return {
    name: column.name,
    type: column.type,
    nullable: column.nullable,
    default: column.default,
    check: column.check === null ? null : { ...column.check, sql: checkSql(column.name, column.check) },
  };
}

function objectEntry(object: ContractObject) {
  switch (object.kind) {
    case "view":
      return {
        name: object.name,
        kind: object.kind,
        description: object.description,
        over: object.over,
        where: object.where,
        checkOption: object.checkOption,
        notifyKind: object.notifyKind,
        columns: object.columns.map(columnEntry),
        grants: object.grants,
      };
    case "table":
      return {
        name: object.name,
        kind: object.kind,
        description: object.description,
        primaryKey: object.primaryKey,
        columns: object.columns.map(columnEntry),
        constraints: object.constraints,
        grants: object.grants,
      };
    case "function":
      return {
        name: object.name,
        kind: object.kind,
        description: object.description,
        arguments: object.arguments,
        returns: object.returns,
        securityDefiner: object.securityDefiner,
        grants: object.grants,
      };
  }
}

function statementEntries() {
  const schema = DEFAULT_GOVERNANCE_SCHEMA;
  const snapshot = buildSnapshotStatements(schema);
  const snapshotEntries = (Object.keys(snapshot) as (keyof typeof snapshot)[]).map((key) => ({
    id: `snapshot.${key}`,
    description: SNAPSHOT_DESCRIPTIONS[key],
    sql: snapshot[key],
    params: [] as unknown[],
  }));
  return [
    ...snapshotEntries,
    {
      id: "listener.listen",
      description:
        "Subscribes the listener to change notifications; issued after every connect, before the first load.",
      sql: buildListenStatement(),
      params: [],
    },
    {
      id: "listener.listenPing",
      description: "Subscribes the listener to its own ping channel, derived from the instance id.",
      sql: buildPingListenStatement(SAMPLE_INSTANCE_ID),
      params: [],
    },
    {
      id: "listener.ping",
      description: "Pings the listener's own channel every 60 seconds with a nonce; two missed pings mark it deaf.",
      sql: buildPingNotifyStatement(),
      params: [pingChannel(SAMPLE_INSTANCE_ID), "5d41402abc4b2a76"],
    },
    {
      id: "listener.probe",
      description: "Checks that the listener's connection still answers, raced against a 5 second timer.",
      sql: buildListenerProbeStatement(),
      params: [],
    },
    {
      id: "heartbeat.upsert",
      description: "Reports this instance's state every 30 seconds; started_at is written by the first beat only.",
      sql: buildHeartbeatUpsert(schema),
      params: HEARTBEAT_COLUMNS.map((column) => SAMPLE_HEARTBEAT[column]),
    },
    {
      id: "queryEvents.insert",
      description:
        "Inserts a batch of query events, here two; a retried batch keeps its event ids, so it adds no duplicate.",
      sql: buildQueryEventInsert(schema, SAMPLE_EVENTS.length),
      params: SAMPLE_EVENTS.flatMap((event) => QUERY_EVENT_COLUMNS.map((column) => event[column])),
    },
  ];
}

/** The manifest of contract v1, built from the contract module and the settings registry. */
export function buildContractManifest() {
  return {
    $comment: `Governance contract v1, generated from src/lib/governance by scripts/generate-governance-manifest.ts. Do not edit: run ${WRITE_COMMAND}.`,
    contractVersion: 1,
    supportedContractVersions: [...SUPPORTED_CONTRACT_VERSIONS],
    schema: DEFAULT_GOVERNANCE_SCHEMA,
    schemaGrants: SCHEMA_GRANTS,
    viewOptions: VIEW_OPTIONS,
    conformanceFiles: [...CONFORMANCE_FILES],
    notification: {
      channel: NOTIFY_CHANNEL,
      payloadVersion: NOTIFY_PAYLOAD_VERSION,
      kinds: [...NOTIFY_KINDS],
      pingChannelPrefix: PING_CHANNEL_PREFIX,
    },
    objects: CONTRACT_OBJECTS.map(objectEntry),
    statements: statementEntries(),
    settings: SETTINGS_REGISTRY,
    definitionAllowlist: DEFINITION_ALLOWLIST,
    plaintext: { keys: [...PLAINTEXT_KEYS], maxBytes: PLAINTEXT_MAX_BYTES },
    codes: { skip: [...SKIP_CODES], envelope: [...ENVELOPE_CODES], api: API_CODES },
    listenerStates: [...LISTENER_STATES],
    heartbeat: {
      skipped: { schema: z.toJSONSchema(SkippedSchema), example: SKIPPED_EXAMPLE },
      sink: { schema: z.toJSONSchema(SinkStateSchema), example: SINK_EXAMPLE },
      canary: { schema: z.toJSONSchema(CanaryResultsSchema), example: CANARY_EXAMPLE },
    },
    readiness: {
      path: "/api/ready",
      schema: z.toJSONSchema(ReadinessBodySchema),
      withoutGovernance: READINESS_WITHOUT_GOVERNANCE,
      freshness: FRESHNESS_STATES.map((state) => {
        const { status, httpStatus } = READINESS_BY_FRESHNESS[state];
        return { state, status, httpStatus };
      }),
      examples: READINESS_EXAMPLES,
    },
  };
}

/** The manifest's bytes: two-space JSON and a final newline. */
export function renderContractManifest(manifest: ReturnType<typeof buildContractManifest>): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The file contents, or null when there is no file: absent and stale have the same fix. */
function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The command line, exactly `--write` or `--check`, optionally followed by `--out <file>`; null for anything else,
 * which the command refuses with its usage line, so a mistyped flag never rewrites the committed manifest.
 */
function parseArguments(argv: readonly string[]): { mode: "--write" | "--check"; out: string | undefined } | null {
  const [mode, flag, file, ...rest] = argv;
  if (mode !== "--write" && mode !== "--check") return null;
  if (flag === undefined) return { mode, out: undefined };
  if (flag !== "--out" || file === undefined || file.startsWith("--") || rest.length > 0) return null;
  return { mode, out: file };
}

function main(argv: readonly string[]): number {
  const parsed = parseArguments(argv);
  if (parsed === null) {
    console.error(USAGE);
    return 2;
  }
  const { mode, out } = parsed;

  const target = out === undefined ? path.join(REPO_ROOT, CONTRACT_MANIFEST_FILE) : path.resolve(out);
  const next = renderContractManifest(buildContractManifest());
  if (mode === "--check") {
    if (readOrNull(target) !== next) {
      console.error(`${target} is not the manifest the contract module builds; run: ${WRITE_COMMAND}`);
      return 1;
    }
    console.log(`${target} is up to date`);
    return 0;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, next);
  console.log(`Wrote ${target}`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
