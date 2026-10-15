/**
 * The published manifest of governance contract v1: `tests/fixtures/governance/contract-v1.json`
 * (docs/GOVERNANCE.md#conformance-files).
 *
 * A control plane vendors this file from a pinned Studio release and never edits it: its database tests compare
 * its views with the objects listed here and run every statement listed here as `libredb_studio`, and its settings
 * allowlist and connection form are generated from it. So the file has to be exactly what the code builds, and
 * what the code builds has to be exactly the contract. The expected objects below, the CHECK texts included, are
 * written out by hand from the contract rather than read from `contract.ts`, so a slip there cannot certify itself.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  buildContractManifest,
  CONTRACT_MANIFEST_FILE,
  renderContractManifest,
  SAMPLE_INSTANCE_ID,
} from "../../scripts/generate-governance-manifest";
import * as contract from "@/lib/governance/contract";
import { SETTINGS_REGISTRY } from "@/lib/governance/settings-registry";
import { SeedConnectionSchema } from "@/lib/seed/types";

const ROOT = path.resolve(import.meta.dir, "../..");
const SCRIPT = path.join(ROOT, "scripts/generate-governance-manifest.ts");
const CHECKED_IN = readFileSync(path.join(ROOT, CONTRACT_MANIFEST_FILE), "utf8");

interface ManifestCheck {
  kind: string;
  values?: string[];
  pattern?: string;
  min?: number | null;
  max?: number;
  jsonType?: string;
  maxItems?: number | null;
  sql: string;
}
interface ManifestColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  check: ManifestCheck | null;
}
interface ManifestObject {
  name: string;
  kind: string;
  columns?: ManifestColumn[];
  constraints?: { name: string; check: string }[];
  primaryKey?: string[];
  arguments?: { name: string; type: string; default: string | null }[];
  returns?: string;
  securityDefiner?: boolean;
  over?: string | null;
  where?: string | null;
  checkOption?: string | null;
  notifyKind?: string | null;
  grants: { libredb_studio: string[]; libredb_platform: string[] };
}
interface ManifestStatement {
  id: string;
  description: string;
  sql: string;
  params: unknown[];
}
interface Manifest {
  contractVersion: number;
  supportedContractVersions: number[];
  schema: string;
  schemaGrants: { libredb_studio: string[]; libredb_platform: string[] };
  viewOptions: Record<string, boolean>;
  conformanceFiles: string[];
  notification: { channel: string; payloadVersion: number; kinds: string[]; pingChannelPrefix: string };
  objects: ManifestObject[];
  statements: ManifestStatement[];
  settings: Record<string, unknown>[];
  definitionAllowlist: { path: string; domain: Record<string, unknown> }[];
  plaintext: { keys: string[]; maxBytes: number };
  codes: { skip: string[]; envelope: string[]; api: { code: string; httpStatus: number }[] };
  listenerStates: string[];
  heartbeat: Record<"skipped" | "sink" | "canary", { schema: Record<string, unknown>; example: unknown }>;
  readiness: {
    path: string;
    schema: Record<string, unknown>;
    withoutGovernance: { status: string; httpStatus: number };
    freshness: { state: string; status: string; httpStatus: number }[];
    examples: { status: string }[];
  };
}

const manifest = JSON.parse(CHECKED_IN) as Manifest;

/**
 * A validator built from a published JSON Schema document, not from the zod schema it was generated from: the claim
 * under test is that the shapes a control plane reads accept the published examples and refuse the probes.
 * `z.fromJSONSchema()` is semi-experimental, so an upgrade of zod can change it; measured on zod 4.6.5, it gave the
 * verdict of Ajv 8 in strict draft 2020-12 mode on every shape, example and probe in this file.
 */
function validatorFor(schema: Record<string, unknown>): (value: unknown) => boolean {
  const parsed = z.fromJSONSchema(schema);
  return (value) => parsed.safeParse(value).success;
}

const objectNamed = (name: string): ManifestObject => {
  const found = manifest.objects.find((object) => object.name === name);
  if (found === undefined) throw new Error(`the manifest lists no object ${name}`);
  return found;
};

type ExpectedColumn = readonly [name: string, type: string, nullable: boolean, defaultSql: string | null];
interface ExpectedObject {
  name: string;
  kind: "view" | "table" | "function";
  columns?: readonly ExpectedColumn[];
  studio: readonly string[];
  platform: readonly string[];
}

const NOT_NULL = false;
const NULL = true;

/** The columns of bridge.query_event, in column order. */
const QUERY_EVENT_COLUMNS: readonly ExpectedColumn[] = [
  ["event_id", "uuid", NOT_NULL, null],
  ["started_at", "timestamptz", NOT_NULL, null],
  ["finished_at", "timestamptz", NOT_NULL, null],
  ["received_at", "timestamptz", NOT_NULL, "now()"],
  ["contract_version", "smallint", NOT_NULL, null],
  ["studio_instance", "text", NOT_NULL, null],
  ["subject", "text", NOT_NULL, null],
  ["username", "text", NULL, null],
  ["session_role", "text", NOT_NULL, null],
  ["connection_id", "text", NOT_NULL, null],
  ["connection_name", "text", NULL, null],
  ["engine", "text", NULL, null],
  ["access_level", "text", NULL, null],
  ["source", "text", NOT_NULL, null],
  ["statement_type", "text", NOT_NULL, null],
  ["explain", "text", NULL, null],
  ["statement_capture", "text", NOT_NULL, null],
  ["statement", "text", NULL, null],
  ["statement_truncated", "boolean", NOT_NULL, "false"],
  ["statement_fingerprint", "text", NULL, null],
  ["unit_index", "integer", NULL, null],
  ["row_count", "bigint", NULL, null],
  ["duration_ms", "integer", NOT_NULL, null],
  ["status", "text", NOT_NULL, null],
  ["error_code", "text", NULL, null],
  ["error_message", "text", NULL, null],
  ["correlation_id", "text", NULL, null],
  ["transaction_id", "text", NULL, null],
  ["transaction_outcome", "text", NULL, null],
  ["client_ip", "inet", NULL, null],
];

/** The columns of bridge.studio_instance, in column order. */
const STUDIO_INSTANCE_COLUMNS: readonly ExpectedColumn[] = [
  ["instance_id", "text", NOT_NULL, null],
  ["studio_version", "text", NOT_NULL, null],
  ["supported_contracts", "smallint[]", NOT_NULL, "'{}'"],
  ["contract_version", "smallint", NOT_NULL, null],
  ["keyring_kids", "text[]", NOT_NULL, "'{}'"],
  ["listener_state", "text", NOT_NULL, null],
  ["last_notification_at", "timestamptz", NULL, null],
  ["snapshot_loaded_at", "timestamptz", NULL, null],
  ["skipped", "jsonb", NOT_NULL, "'[]'::jsonb"],
  ["sink", "jsonb", NOT_NULL, "'{}'::jsonb"],
  ["canary", "jsonb", NOT_NULL, "'{}'::jsonb"],
  ["started_at", "timestamptz", NOT_NULL, null],
  ["last_seen_at", "timestamptz", NOT_NULL, "now()"],
];

/**
 * Every object of the contract (docs/GOVERNANCE.md#objects). A view column's nullability is the guarantee its
 * definition gives (PostgreSQL records no NOT NULL on a view); a view's default is only one set on the view itself,
 * since an insert through a view over a table otherwise takes the table's default.
 */
const A3_OBJECTS: readonly ExpectedObject[] = [
  {
    name: "contract",
    kind: "view",
    columns: [
      ["version", "smallint", NOT_NULL, null],
      ["status", "text", NOT_NULL, null],
      ["sunset_after", "timestamptz", NULL, null],
      ["notify_channel", "text", NOT_NULL, null],
    ],
    studio: ["SELECT"],
    platform: ["SELECT"],
  },
  {
    name: "connections_v1",
    kind: "view",
    columns: [
      ["connection_id", "text", NOT_NULL, null],
      ["name", "text", NOT_NULL, null],
      ["engine", "text", NOT_NULL, null],
      ["environment", "text", NULL, null],
      ["group_name", "text", NULL, null],
      ["color", "text", NULL, null],
      ["definition", "jsonb", NOT_NULL, null],
      ["read_secret", "text", NOT_NULL, null],
      ["write_secret", "text", NULL, null],
      ["mcp_enabled", "boolean", NOT_NULL, null],
      ["updated_at", "timestamptz", NOT_NULL, null],
    ],
    studio: ["SELECT"],
    platform: ["SELECT"],
  },
  {
    name: "grants_v1",
    kind: "view",
    columns: [
      ["subject", "text", NOT_NULL, null],
      ["connection_id", "text", NOT_NULL, null],
      ["level", "text", NOT_NULL, null],
      ["expires_at", "timestamptz", NULL, null],
      ["downgraded", "boolean", NOT_NULL, null],
      ["granted_at", "timestamptz", NOT_NULL, null],
    ],
    studio: ["SELECT"],
    platform: ["SELECT"],
  },
  {
    name: "settings_v1",
    kind: "view",
    columns: [
      ["key", "text", NOT_NULL, null],
      ["value", "jsonb", NOT_NULL, null],
      ["updated_at", "timestamptz", NOT_NULL, null],
    ],
    studio: ["SELECT"],
    platform: ["SELECT"],
  },
  {
    name: "session_revocations_v1",
    kind: "view",
    columns: [
      ["subject", "text", NOT_NULL, null],
      ["revoked_before", "timestamptz", NOT_NULL, null],
    ],
    studio: ["SELECT"],
    platform: ["SELECT"],
  },
  {
    name: "seal_canary_v1",
    kind: "view",
    columns: [
      ["kid", "text", NOT_NULL, null],
      ["envelope", "text", NOT_NULL, null],
      ["created_at", "timestamptz", NOT_NULL, null],
    ],
    studio: ["SELECT"],
    platform: ["SELECT"],
  },
  { name: "query_event", kind: "table", columns: QUERY_EVENT_COLUMNS, studio: [], platform: ["SELECT"] },
  {
    name: "query_events_v1",
    kind: "view",
    columns: QUERY_EVENT_COLUMNS.filter(([name]) => name !== "received_at").map(([name, type, nullable]) => [
      name,
      type,
      nullable,
      name === "contract_version" ? "1" : null,
    ]),
    studio: ["INSERT"],
    platform: [],
  },
  {
    name: "studio_instance",
    kind: "table",
    columns: STUDIO_INSTANCE_COLUMNS,
    studio: [],
    platform: ["SELECT", "DELETE"],
  },
  {
    name: "studio_instances_v1",
    kind: "view",
    columns: STUDIO_INSTANCE_COLUMNS.map(([name, type, nullable]) => [name, type, nullable, null]),
    studio: ["SELECT", "INSERT", "UPDATE"],
    platform: [],
  },
  { name: "trim_query_events", kind: "function", studio: [], platform: ["EXECUTE"] },
];

/** Every column CHECK of the contract's tables, written out by hand. */
const A3_COLUMN_CHECKS: Record<string, Record<string, string>> = {
  query_event: {
    studio_instance: "char_length(studio_instance) BETWEEN 1 AND 128",
    subject: "char_length(subject) BETWEEN 1 AND 512",
    username: "char_length(username) <= 320",
    session_role: "session_role IN ('admin','user')",
    connection_id: "char_length(connection_id) BETWEEN 1 AND 64",
    connection_name: "char_length(connection_name) <= 128",
    engine: "engine ~ '^[a-z][a-z0-9]{0,31}$'",
    access_level: "access_level IN ('read','write')",
    source: "source ~ '^[a-z][a-z-]{0,31}$'",
    statement_type: "statement_type IN ('SELECT','INSERT','UPDATE','DELETE','DDL','OTHER')",
    explain: "explain IN ('plan','analyze')",
    statement_capture: "statement_capture IN ('none','redacted','full')",
    statement: "octet_length(statement) <= 65536",
    statement_fingerprint: "statement_fingerprint ~ '^[0-9a-f]{64}$'",
    unit_index: "unit_index >= 0",
    row_count: "row_count >= 0",
    duration_ms: "duration_ms >= 0",
    status: "status IN ('success','error','cancelled','refused')",
    error_code: "char_length(error_code) <= 64",
    error_message: "char_length(error_message) <= 1000",
    correlation_id: "char_length(correlation_id) <= 128",
    transaction_id: "char_length(transaction_id) <= 128",
    transaction_outcome: "transaction_outcome ~ '^[a-z][a-z-]{0,31}$'",
  },
  studio_instance: {
    instance_id: "instance_id ~ '^[A-Za-z0-9._:-]{1,128}$'",
    studio_version: "char_length(studio_version) BETWEEN 1 AND 64",
    supported_contracts: "cardinality(supported_contracts) <= 16",
    keyring_kids: "cardinality(keyring_kids) <= 16",
    listener_state: "listener_state IN ('listening','reconnecting','polling','deaf')",
    skipped: "jsonb_typeof(skipped) = 'array' AND jsonb_array_length(skipped) <= 500",
    sink: "jsonb_typeof(sink) = 'object'",
    canary: "jsonb_typeof(canary) = 'object'",
  },
};

/** The named constraints of the contract's tables, whitespace collapsed. */
const A3_TABLE_CONSTRAINTS: Record<string, { name: string; check: string }[]> = {
  query_event: [
    { name: "query_event_time_order", check: "finished_at >= started_at" },
    { name: "query_event_not_future", check: "started_at <= received_at + interval '5 minutes'" },
    {
      name: "query_event_capture_none",
      check: "statement_capture <> 'none' OR (statement IS NULL AND statement_fingerprint IS NULL)",
    },
    { name: "query_event_error_text_full_only", check: "statement_capture = 'full' OR error_message IS NULL" },
    {
      name: "query_event_resolved",
      check: "status = 'refused' OR (engine IS NOT NULL AND access_level IS NOT NULL)",
    },
  ],
  studio_instance: [],
};

/**
 * The rules a governance source keeps for the rows behind each read view (docs/GOVERNANCE.md#objects), named by the
 * view's columns. A governance source that keeps them never hands Studio a row its admission has to skip for shape
 * alone.
 */
const A2_VIEW_DOMAINS: Record<string, Record<string, string>> = {
  contract: { status: "status IN ('current','deprecated')" },
  connections_v1: {
    connection_id: "connection_id ~ '^[a-z0-9-]{1,64}$'",
    name: "char_length(name) BETWEEN 1 AND 128",
    engine: "engine ~ '^[a-z][a-z0-9]{0,31}$'",
    environment: "environment IN ('production','staging','development','local','other')",
    group_name: "char_length(group_name) BETWEEN 1 AND 64",
    color: "color ~ '^#[0-9A-Fa-f]{6}$'",
    definition: "jsonb_typeof(definition) = 'object'",
    read_secret: "read_secret ~ '^lsb[1-9][0-9]*\\.[0-9a-f]{16}\\.'",
    write_secret: "write_secret ~ '^lsb[1-9][0-9]*\\.[0-9a-f]{16}\\.'",
  },
  grants_v1: {
    subject: "char_length(subject) BETWEEN 1 AND 512",
    connection_id: "connection_id ~ '^[a-z0-9-]{1,64}$'",
    level: "level IN ('read','write')",
  },
  settings_v1: { key: "key ~ '^[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*)+$'" },
  session_revocations_v1: { subject: "char_length(subject) BETWEEN 1 AND 512" },
  seal_canary_v1: {
    kid: "kid ~ '^[0-9a-f]{16}$'",
    envelope: "envelope ~ '^lsb[1-9][0-9]*\\.[0-9a-f]{16}\\.'",
  },
};

/** Whether a value passes one published column CHECK, the way PostgreSQL evaluates it (NULL passes). */
function satisfies(check: ManifestCheck, value: unknown): boolean {
  if (value === null) return true;
  switch (check.kind) {
    case "values":
      return (check.values ?? []).includes(value as string);
    case "pattern":
      return new RegExp(check.pattern as string).test(value as string);
    case "length":
      return (
        [...(value as string)].length >= (check.min ?? 0) && [...(value as string)].length <= (check.max as number)
      );
    case "bytes":
      return Buffer.byteLength(value as string, "utf8") <= (check.max as number);
    case "minimum":
      return (value as number) >= (check.min as number);
    case "cardinality":
      return (value as unknown[]).length <= (check.max as number);
    case "json": {
      const parsed = JSON.parse(value as string) as unknown;
      if (check.jsonType === "array") {
        return Array.isArray(parsed) && (check.maxItems === null || parsed.length <= (check.maxItems as number));
      }
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    }
    default:
      throw new Error(`unknown check kind ${check.kind}`);
  }
}

/** Every NOT NULL and column CHECK of `table` that the named values break, as readable strings. */
function violations(table: string, row: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const column of objectNamed(table).columns ?? []) {
    if (!(column.name in row)) continue;
    const value = row[column.name];
    if (value === null && !column.nullable) found.push(`${column.name} is NOT NULL`);
    if (column.check !== null && !satisfies(column.check, value)) found.push(`${column.name}: ${column.check.sql}`);
  }
  return found;
}

/** The value domain `SeedConnectionSchema` gives the field at a dotted definition path, optional wrappers removed. */
function seedFieldSchema(dottedPath: string): z.ZodType {
  const unwrap = (schema: z.ZodType): z.ZodType =>
    schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodType) : schema;
  let schema: z.ZodType = SeedConnectionSchema;
  for (const segment of dottedPath.split(".")) {
    const shape = (unwrap(schema) as z.ZodObject).shape as Record<string, z.ZodType | undefined>;
    const next = shape[segment];
    if (next === undefined) throw new Error(`SeedConnectionSchema declares no field ${dottedPath}`);
    schema = next;
  }
  return unwrap(schema);
}

describe("contract-v1.json", () => {
  test("the checked-in contract-v1.json equals buildContractManifest() byte for byte", () => {
    expect(CHECKED_IN).toBe(renderContractManifest(buildContractManifest()));
  });

  test("it declares contract version 1, the default schema and the grants every runtime role needs on it", () => {
    expect(manifest.contractVersion).toBe(1);
    expect(manifest.supportedContractVersions).toEqual([1]);
    expect(manifest.schema).toBe("bridge");
    expect(manifest.schemaGrants).toEqual({ libredb_studio: ["USAGE"], libredb_platform: ["USAGE"] });
    expect(manifest.viewOptions).toEqual({ security_barrier: true, security_invoker: false });
    expect(manifest.notification).toEqual({
      channel: "libredb_bridge",
      payloadVersion: 1,
      kinds: ["connections", "grants", "settings", "revocations", "canary"],
      pingChannelPrefix: "libredb_bridge_ping_",
    });
    expect(manifest.conformanceFiles).toEqual([
      "docs/GOVERNANCE.md",
      "tests/fixtures/governance/contract-v1.json",
      "tests/fixtures/governance/lsb1-vectors.json",
    ]);
  });

  test("every contract object appears with its kind, ordered columns, types, defaults and required grants", () => {
    expect(
      manifest.objects.map((object) => ({
        name: object.name,
        kind: object.kind,
        columns: object.columns?.map((column) => [column.name, column.type, column.nullable, column.default]),
        studio: object.grants.libredb_studio,
        platform: object.grants.libredb_platform,
      })),
    ).toEqual(
      A3_OBJECTS.map((object) => ({
        name: object.name,
        kind: object.kind,
        columns: object.columns?.map((column) => [...column]),
        studio: [...object.studio],
        platform: [...object.platform],
      })),
    );
  });

  test("the tables carry every CHECK, constraint and primary key, rendered as written out above", () => {
    for (const [table, expected] of Object.entries(A3_COLUMN_CHECKS)) {
      const checks = Object.fromEntries(
        (objectNamed(table).columns ?? []).flatMap((column) =>
          column.check === null ? [] : [[column.name, column.check.sql]],
        ),
      );
      expect(checks).toEqual(expected);
      expect(objectNamed(table).constraints).toEqual(A3_TABLE_CONSTRAINTS[table]);
    }
    expect(objectNamed("query_event").primaryKey).toEqual(["event_id"]);
    expect(objectNamed("studio_instance").primaryKey).toEqual(["instance_id"]);
  });

  test("the views over the two tables keep their CHECKs, and query_events_v1 accepts only contract 1 rows", () => {
    for (const [view, table] of [
      ["query_events_v1", "query_event"],
      ["studio_instances_v1", "studio_instance"],
    ]) {
      expect(objectNamed(view).over).toBe(table);
      for (const column of objectNamed(view).columns ?? []) {
        const base = (objectNamed(table).columns ?? []).find((candidate) => candidate.name === column.name);
        expect(column.check).toEqual(base?.check ?? null);
      }
    }
    expect(objectNamed("query_events_v1").where).toBe("contract_version = 1");
    expect(objectNamed("query_events_v1").checkOption).toBe("local");
    expect(objectNamed("studio_instances_v1").where).toBeNull();
    expect(objectNamed("studio_instances_v1").checkOption).toBeNull();
  });

  test("the read views publish the domains their source rows keep, and the kind their change sends", () => {
    for (const [view, expected] of Object.entries(A2_VIEW_DOMAINS)) {
      const checks = Object.fromEntries(
        (objectNamed(view).columns ?? []).flatMap((column) =>
          column.check === null ? [] : [[column.name, column.check.sql]],
        ),
      );
      expect(checks).toEqual(expected);
      expect(objectNamed(view).over).toBeNull();
    }
    expect(
      ["contract", "connections_v1", "grants_v1", "settings_v1", "session_revocations_v1", "seal_canary_v1"].map(
        (view) => objectNamed(view).notifyKind,
      ),
    ).toEqual([null, "connections", "grants", "settings", "revocations", "canary"]);
  });

  test("the connection domains admit no value SeedConnectionSchema refuses for the same field", () => {
    const connections = objectNamed("connections_v1").columns ?? [];
    const check = (name: string) => connections.find((column) => column.name === name)?.check;
    const seed = (field: string) => z.toJSONSchema(seedFieldSchema(field)) as Record<string, unknown>;

    expect(check("environment")?.values).toEqual(seed("environment").enum as string[]);
    expect(check("color")?.pattern).toBe(seed("color").pattern as string);
    expect([check("name")?.min, check("name")?.max]).toEqual([
      seed("name").minLength as number,
      seed("name").maxLength as number,
    ]);
    expect(check("group_name")?.max).toBe(seed("group").maxLength as number);
    for (const id of ["a", "3f2c8a14-5b6e-4c0d-9a7f-1e2d3c4b5a69", "x".repeat(64)]) {
      expect(new RegExp(check("connection_id")?.pattern as string).test(id)).toBe(true);
      expect(seedFieldSchema("id").safeParse(id).success).toBe(true);
    }
  });

  test("trim_query_events takes a retention in days and a batch size, returns bigint and runs as its owner", () => {
    const trim = objectNamed("trim_query_events");
    expect(trim.arguments).toEqual([
      { name: "p_retention_days", type: "integer", default: null },
      { name: "p_batch", type: "integer", default: "10000" },
    ]);
    expect(trim.returns).toBe("bigint");
    expect(trim.securityDefiner).toBe(true);
  });

  test("contract-v1.json carries the eight registry keys with type, bounds, allowed values, default, since_contract and description", () => {
    expect(manifest.settings.map((setting) => setting.key)).toEqual([
      "ai.enabled",
      "agent.enabled",
      "mcp.enabled",
      "query.timeoutMs",
      "provider.poolMaxPerUser",
      "queryLog.statementCapture",
      "queryLog.maxStatementBytes",
      "queryLog.onSinkFailure",
    ]);
    for (const setting of manifest.settings) {
      expect(Object.keys(setting)).toEqual([
        "key",
        "type",
        "allowedValues",
        "min",
        "max",
        "default",
        "environment",
        "consumer",
        "sinceContract",
        "description",
      ]);
    }
    expect(manifest.settings).toEqual(JSON.parse(JSON.stringify(SETTINGS_REGISTRY)));
  });

  test("contract-v1.json lists the skip codes, the envelope codes and the API codes CONNECTION_NOT_FOUND, GOVERNANCE_UNAVAILABLE, AUDIT_UNAVAILABLE, TRANSACTION_CREDENTIAL_CHANGED and AI_DISABLED", () => {
    expect(manifest.codes.skip).toEqual([
      "READ_SECRET_UNOPENABLE",
      "WRITE_SECRET_UNOPENABLE",
      "DEFINITION_INVALID",
      "DEFINITION_HAS_SECRET",
      "ENGINE_UNSUPPORTED",
      "ENGINE_NOT_ALLOWED",
      "SERVER_LEVEL_NOT_ALLOWED",
      "SETTING_INVALID",
    ]);
    expect(manifest.codes.envelope).toEqual([
      "FORMAT",
      "UNKNOWN_KID",
      "AUTH_FAILED",
      "LOW_ORDER_POINT",
      "PLAINTEXT_INVALID",
    ]);
    expect(manifest.codes.api).toEqual([
      { code: "CONNECTION_NOT_FOUND", httpStatus: 404 },
      { code: "GOVERNANCE_UNAVAILABLE", httpStatus: 503 },
      { code: "AUDIT_UNAVAILABLE", httpStatus: 503 },
      { code: "TRANSACTION_CREDENTIAL_CHANGED", httpStatus: 409 },
      { code: "AI_DISABLED", httpStatus: 403 },
    ]);
    expect(manifest.listenerStates).toEqual(["listening", "reconnecting", "polling", "deaf"]);
  });

  test("contract-v1.json lists the lsb1 plaintext keys, none of which a definition may carry", () => {
    expect(manifest.plaintext).toEqual({
      keys: [
        "user",
        "password",
        "connectionString",
        "privateKey",
        "privateKeyPassphrase",
        "apiKeyId",
        "apiKeySecret",
        "sslClientKey",
        "sslClientCert",
      ],
      maxBytes: 65536,
    });
    const allowed = manifest.definitionAllowlist.map((entry) => entry.path);
    for (const key of [...manifest.plaintext.keys, "ssl.clientKey", "ssl.clientCert", "sshTunnel", "readOnly"]) {
      expect(allowed).not.toContain(key);
    }
  });

  test("contract-v1.json lists every statement contract.ts builds, each parameterised one with sample parameters", () => {
    const builders = Object.entries(contract)
      .filter(([name, value]) => typeof value === "function" && name.startsWith("build"))
      .map(([name]) => name)
      .sort();
    // A builder added without a line here is a statement the manifest would not publish.
    expect(builders).toEqual([
      "buildHeartbeatUpsert",
      "buildListenStatement",
      "buildListenerProbeStatement",
      "buildPingListenStatement",
      "buildPingNotifyStatement",
      "buildQueryEventInsert",
      "buildSnapshotStatements",
    ]);

    const snapshot = contract.buildSnapshotStatements(manifest.schema);
    expect(manifest.statements.map((statement) => [statement.id, statement.sql])).toEqual([
      ...Object.entries(snapshot).map(([key, sql]) => [`snapshot.${key}`, sql]),
      ["listener.listen", contract.buildListenStatement()],
      ["listener.listenPing", contract.buildPingListenStatement(SAMPLE_INSTANCE_ID)],
      ["listener.ping", contract.buildPingNotifyStatement()],
      ["listener.probe", contract.buildListenerProbeStatement()],
      ["heartbeat.upsert", contract.buildHeartbeatUpsert(manifest.schema)],
      ["queryEvents.insert", contract.buildQueryEventInsert(manifest.schema, 2)],
    ]);

    for (const statement of manifest.statements) {
      expect(statement.description.length).toBeGreaterThan(0);
      const placeholders = [...statement.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
      const highest = Math.max(0, ...placeholders);
      expect(new Set(placeholders)).toEqual(new Set(Array.from({ length: highest }, (_, index) => index + 1)));
      expect(statement.params.length).toBe(highest);
    }
    expect(manifest.statements.filter((statement) => statement.params.length > 0).map((s) => s.id)).toEqual([
      "listener.ping",
      "heartbeat.upsert",
      "queryEvents.insert",
    ]);
  });

  test("the ping pings the listener's own channel, and the heartbeat sample sends the published examples", () => {
    const params = (id: string) => manifest.statements.find((statement) => statement.id === id)?.params ?? [];
    expect(params("listener.ping")[0]).toBe(contract.pingChannel(SAMPLE_INSTANCE_ID));

    const beat = Object.fromEntries(
      contract.HEARTBEAT_COLUMNS.map((column, index) => [column, params("heartbeat.upsert")[index]]),
    );
    expect(beat.instance_id).toBe(SAMPLE_INSTANCE_ID);
    expect(JSON.parse(beat.skipped as string)).toEqual(manifest.heartbeat.skipped.example);
    expect(JSON.parse(beat.sink as string)).toEqual(manifest.heartbeat.sink.example);
    expect(JSON.parse(beat.canary as string)).toEqual(manifest.heartbeat.canary.example);
    expect(violations("studio_instance", beat)).toEqual([]);
  });

  test("the sample rows of the query event insert keep every NOT NULL and CHECK of bridge.query_event", () => {
    const insert = manifest.statements.find((statement) => statement.id === "queryEvents.insert");
    const width = contract.QUERY_EVENT_COLUMNS.length;
    const params = insert?.params ?? [];
    expect(params.length).toBe(2 * width);
    const rows = [0, 1].map((row) =>
      Object.fromEntries(contract.QUERY_EVENT_COLUMNS.map((column, index) => [column, params[row * width + index]])),
    );
    for (const row of rows) {
      expect(violations("query_event", row)).toEqual([]);
      // query_event_resolved, query_event_capture_none and query_event_error_text_full_only, which no column check covers.
      expect(row.status === "refused" || (row.engine !== null && row.access_level !== null)).toBe(true);
      expect(row.statement_capture !== "none" || (row.statement === null && row.statement_fingerprint === null)).toBe(
        true,
      );
      expect(row.statement_capture === "full" || row.error_message === null).toBe(true);
      expect(Date.parse(row.finished_at as string)).toBeGreaterThanOrEqual(Date.parse(row.started_at as string));
    }
    expect(rows.map((row) => row.status)).toEqual(["success", "refused"]);
  });

  test("contract-v1.json defines the JSON shape and an example of skipped, sink and canary, and each example validates against its shape", () => {
    expect(Object.keys(manifest.heartbeat)).toEqual(["skipped", "sink", "canary"]);
    const zodShapes = {
      skipped: contract.SkippedSchema,
      sink: contract.SinkStateSchema,
      canary: contract.CanaryResultsSchema,
    };
    for (const name of ["skipped", "sink", "canary"] as const) {
      const shape = manifest.heartbeat[name];
      expect(validatorFor(shape.schema)(shape.example)).toBe(true);
      expect(zodShapes[name].safeParse(shape.example).success).toBe(true);
    }
    const skipped = manifest.heartbeat.skipped.example as Record<string, unknown>[];
    expect(new Set(skipped.map((item) => item.kind))).toEqual(new Set(["connection", "setting"]));

    // The published shapes refuse a value next to an id, which is what "skips never carry values" means on the wire.
    const validateSkipped = validatorFor(manifest.heartbeat.skipped.schema);
    expect(validateSkipped([{ ...skipped[0], value: "secret" }])).toBe(false);
    const validateSink = validatorFor(manifest.heartbeat.sink.schema);
    expect(validateSink({ ...(manifest.heartbeat.sink.example as object), statement: "SELECT 1" })).toBe(false);
    const validateCanary = validatorFor(manifest.heartbeat.canary.schema);
    expect(validateCanary({ "0123456789abcdef": "nope" })).toBe(false);
  });

  test("contract-v1.json defines the readiness body with an example for every status", () => {
    const { readiness } = manifest;
    expect(readiness.path).toBe("/api/ready");
    const statuses = (readiness.schema.properties as Record<string, { enum: string[] }>).status.enum;
    expect(statuses).toEqual(["ready", "ok", "degraded", "loading", "misconfigured", "incompatible"]);
    expect(readiness.examples.map((example) => example.status)).toEqual(statuses);

    const validate = validatorFor(readiness.schema);
    for (const example of readiness.examples) {
      expect(validate(example)).toBe(true);
      expect(contract.ReadinessBodySchema.safeParse(example).success).toBe(true);
    }
    expect(validate({ status: "unavailable", contract: { supported: [1], active: null } })).toBe(false);

    expect(readiness.withoutGovernance).toEqual({ status: "ready", httpStatus: 200 });
    expect(readiness.freshness).toEqual([
      { state: "loading", status: "loading", httpStatus: 503 },
      { state: "ok", status: "ok", httpStatus: 200 },
      { state: "degraded", status: "degraded", httpStatus: 200 },
      { state: "unavailable", status: "degraded", httpStatus: 200 },
      { state: "misconfigured", status: "misconfigured", httpStatus: 503 },
      { state: "incompatible", status: "incompatible", httpStatus: 503 },
    ]);
  });

  test("each definition allowlist key's value domain equals what SeedConnectionSchema accepts for that key", () => {
    expect(manifest.definitionAllowlist.map((entry) => entry.path)).toEqual([
      "host",
      "port",
      "database",
      "schema",
      "serviceName",
      "instanceName",
      "authSource",
      "skipObjectScan",
      "ssl.mode",
      "ssl.rejectUnauthorized",
      "ssl.caCert",
    ]);
    for (const { path: field, domain } of manifest.definitionAllowlist) {
      const seed = seedFieldSchema(field);
      const seedDomain: Record<string, unknown> = { ...z.toJSONSchema(seed) };
      delete seedDomain.$schema;
      expect(domain).toEqual(seedDomain);

      // The same claim by probing: what the domain admits, SeedConnectionSchema admits, and the reverse.
      const validate = validatorFor(domain);
      const probes: unknown[] = [
        null,
        true,
        false,
        0,
        1,
        65535,
        65536,
        -1,
        1.5,
        "",
        "x",
        "5432",
        ...(Array.isArray(domain.enum) ? domain.enum : []),
        "prefer",
      ];
      for (const probe of probes) {
        expect([field, probe, validate(probe)]).toEqual([field, probe, seed.safeParse(probe).success]);
      }
    }
  });

  test("--check passes on the checked-in file, two --write runs produce identical bytes, and a stale file fails --check", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "governance-manifest-"));
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    try {
      expect(run("--check").exitCode).toBe(0);

      const out = path.join(dir, "contract-v1.json");
      expect(run("--write", "--out", out).exitCode).toBe(0);
      const first = readFileSync(out);
      expect(run("--write", "--out", out).exitCode).toBe(0);
      expect(readFileSync(out).equals(first)).toBe(true);
      expect(first.toString("utf8")).toBe(CHECKED_IN);
      expect(run("--check", "--out", out).exitCode).toBe(0);

      writeFileSync(out, CHECKED_IN.replace('"contractVersion": 1', '"contractVersion": 2'));
      const stale = run("--check", "--out", out);
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr.toString()).toContain("--write");

      const absent = run("--check", "--out", path.join(dir, "absent.json"));
      expect(absent.exitCode).toBe(1);

      for (const args of [[], ["--check", "--write"], ["--write", "--out"], ["--check", "--verbose"]]) {
        const refused = run(...args);
        expect(refused.exitCode).toBe(2);
        expect(refused.stderr.toString()).toContain("Usage:");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
