import { z } from "zod";
import {
  CONNECTION_STRING_ACCEPTED,
  MCP_AGENT_CREDENTIAL_REQUIRED,
  MCP_EXPOSABLE,
  READ_ROOTS_REQUIRED,
  WRITE_REACH,
} from "@/lib/db/compatibility";
import type { WriteReach } from "@/lib/db/write-reach";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import { publishedDefaultPairWarning, readOnlySeedRefusal } from "@/lib/db/credential-warnings";
import {
  CONNECTION_FIELDS,
  SEED_AGENT_CREDENTIAL,
  SEED_ONLY_FIELDS,
  type SeedAgentCredential,
  type SeedOnlyFields,
} from "@/lib/db/connection-fields";
import { isCredentialReference } from "./credential-resolver";
import { connectionStringFor } from "@/lib/db/connection-string";

// SSLMode matches the union in src/lib/types.ts — NO 'prefer'. Kept in step BY HAND: a zod
// enum is a value, so a mode missing here is not a compile error, it is a seed file the
// server rejects with "invalid enum value" for a mode the product supports.
const SSLModeSchema = z.enum(["disable", "require", "verify-system", "verify-ca", "verify-full"]);

const SSLConfigSchema = z
  .object({
    mode: SSLModeSchema.optional(),
    rejectUnauthorized: z.boolean().optional(),
    caCert: z.string().optional(),
    clientCert: z.string().optional(),
    clientKey: z.string().optional(),
  })
  .optional();

const ConnectionEnvironmentSchema = z.enum(["production", "staging", "development", "local", "other"]);

/**
 * A C0 or C1 control character or DEL. A seed role name may hold none (AllowedRoleSchema), and seedRolesOf
 * (src/lib/seed/roles.ts) drops a claim role holding one, so the two refuse one class.
 */
export const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f-\x9f]/;

// Allowed roles: standard roles ('*', 'admin', 'user') or custom roles from OIDC role claim
const AllowedRoleSchema = z
  .string()
  .min(1, "Role cannot be empty")
  .max(64, "Role name must not exceed 64 characters")
  .refine((r) => Buffer.byteLength(r, "utf8") <= 64, "Role name must not exceed 64 bytes in UTF-8")
  .refine((r) => r.trim() === r, "Role name cannot have leading or trailing whitespace")
  .refine((r) => !CONTROL_CHAR_REGEX.test(r), "Role name cannot contain control characters");

/**
 * One issue per present field of every "each" row, then one issue per "set" row with any field present, at the first
 * present field. The "each" pass runs first so the OPC UA issues keep their place before the API-key issue.
 */
function refuseSeedOnlyFields(conn: { readonly type: DatabaseType }, ctx: z.RefinementCtx): void {
  const rows = Object.entries(SEED_ONLY_FIELDS).filter(
    (entry): entry is [string, SeedOnlyFields] => entry[1] !== null && entry[0] !== conn.type,
  );
  const fields = conn as Readonly<Record<string, unknown>>;
  for (const [, row] of rows) {
    if (row.kind !== "each") continue;
    for (const field of row.fields) {
      if (fields[field] === undefined) continue;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: row.refusal(field), path: [field] });
    }
  }
  for (const [, row] of rows) {
    if (row.kind !== "set") continue;
    const present = row.fields.find((field) => fields[field] !== undefined);
    if (present === undefined) continue;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: row.refusal(present), path: [present] });
  }
}

/**
 * The load's refusal of an MCP opt-in on an engine MCP is not offered for (#1089). Read from the record
 * it is handed, `MCP_EXPOSABLE` in `SeedConnectionSchema`, never a type-id branch, so an engine is
 * admitted by its own entry. Refused rather than stripped, because a stripped opt-in would load a file
 * that asks for something the product will not do. A factory over the record, the way
 * `readOnlyControl` takes its engine's answer, so the refusal is tested before any shipped engine
 * answers false.
 */
export function refuseMcpWhereNotOffered(exposable: Readonly<Record<DatabaseType, boolean>>) {
  return (conn: { type: DatabaseType; mcp?: boolean }, ctx: z.RefinementCtx): void => {
    if (conn.mcp !== true || exposable[conn.type]) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `mcp is not offered for ${conn.type}: the product does not expose this engine to MCP clients. Remove mcp from this connection.`,
      path: ["mcp"],
    });
  };
}

/**
 * The load's refusal of `readOnly: true` on an engine whose write reach is `open` (#1089): some path there sends a
 * write no Studio gate refuses, so the seed would be listed as read-only and still write. Accepted wherever the reach
 * is `guarded` or `none`; on a `none` engine the flag changes no write, and a policy that marks every seed read-only
 * still loads. Read from the record it is handed, `WRITE_REACH` in `SeedConnectionSchema`, never a type-id branch,
 * and a factory over it for the reason `refuseMcpWhereNotOffered` gives. The credential refusal and the `managed`
 * refusal below apply on every engine this admits, `none` included, because a read-only seed promises a boundary on
 * the host as well as in Studio's code.
 */
export function refuseReadOnlyWhereOpen(reach: Readonly<Record<DatabaseType, WriteReach>>) {
  return (conn: { type: DatabaseType; readOnly?: boolean }, ctx: z.RefinementCtx): void => {
    if (conn.readOnly !== true || reach[conn.type] !== "open") return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `readOnly is not offered for ${conn.type}: its provider does not enforce a read-only mode, so the connection would be listed as read-only and still write. Remove readOnly from this connection, or connect with a database role that cannot write.`,
      path: ["readOnly"],
    });
  };
}

/** The two fields of a seed's agent credential, in the order a refusal names them. */
const AGENT_FIELDS = ["agentUser", "agentPassword"] as const;

/** The agent credential fields the load refusals read, as the file writes them. */
interface AgentCredentialFields {
  readonly id: string;
  readonly type: DatabaseType;
  readonly user?: string;
  readonly connectionString?: string;
  readonly agentUser?: string;
  readonly agentPassword?: string;
}

/** Set, as the factory's form check reads a field: an empty string counts as absent. */
const isSet = (value: string | undefined): value is string => value !== undefined && value !== "";

/** A value the file shows as it is: set, and not a reference resolution replaces. */
const isLiteral = (value: string | undefined): value is string => isSet(value) && !isCredentialReference(value);

/**
 * The load's refusals of an agent credential its engine's row does not take, read from the table it is handed,
 * `SEED_AGENT_CREDENTIAL` in `SeedConnectionSchema`, never a type-id branch. Each names the connection and the field,
 * never the value, and a reference is unknown here: load refuses what the file shows, and the factory refuses the rest
 * at open, before it connects. A factory over the table, the way `refuseMcpWhereNotOffered` takes its record, so each
 * form is tested on an engine of the test's choosing.
 */
export function refuseInvalidAgentCredential(table: Readonly<Record<DatabaseType, SeedAgentCredential | null>>) {
  return (conn: AgentCredentialFields, ctx: z.RefinementCtx): void => {
    const set = AGENT_FIELDS.filter((field) => isSet(conn[field]));
    const present = AGENT_FIELDS.filter((field) => conn[field] !== undefined);
    if (present.length === 0) return;
    const refuse = (field: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [field] });
    };
    const row = table[conn.type];
    if (row === null) {
      for (const field of present) {
        refuse(
          field,
          `Seed connection "${conn.id}": ${field} is refused: a ${conn.type} seed takes no agent credential, so the agent and MCP could not run under one. Remove ${field} from this connection.`,
        );
      }
      return;
    }
    if (row.form === "secret" && conn.agentUser !== undefined) {
      refuse(
        "agentUser",
        `Seed connection "${conn.id}": agentUser is refused: the ${conn.type} provider takes the agent's credential as agentPassword alone. Remove agentUser from this connection.`,
      );
    }
    if (row.form !== "secret" && set.length === 1) {
      const [field] = set;
      const missing = field === "agentUser" ? "agentPassword" : "agentUser";
      refuse(
        field,
        `Seed connection "${conn.id}" sets ${field} without ${missing}: an agent credential on ${conn.type} is a user and a password together. Set both, or remove ${field}.`,
      );
    }
    if (conn.connectionString !== undefined) {
      const fields = CONNECTION_FIELDS[conn.type].filter((field) => field !== "connectionString").join(", ");
      refuse(
        "connectionString",
        `Seed connection "${conn.id}" sets an agent credential beside connectionString, which the provider ignores for the agent: move the value into the separate fields a ${conn.type} seed takes (${fields}), or remove the agent credential.`,
      );
    }
    const fields = conn as unknown as Readonly<Record<string, unknown>>;
    const superseding = row.supersededBy.find((field) => fields[field] !== undefined);
    if (superseding !== undefined) {
      refuse(
        present[0],
        `Seed connection "${conn.id}" sets an agent credential beside ${superseding}, which the ${conn.type} provider signs in with in preference to a user and password, so the agent and MCP would run under the connection's own credential. Remove ${superseding} or the agent credential.`,
      );
    }
    if (row.form === "dedicated-pair" && isLiteral(conn.agentUser) && isLiteral(conn.user)) {
      if (conn.agentUser.trim().toLowerCase() === conn.user.trim().toLowerCase()) {
        refuse(
          "agentUser",
          `Seed connection "${conn.id}": agentUser is refused: it names the connection's own user, and the ${conn.type} provider takes only an agent user of its own. Name a dedicated agent user.`,
        );
      }
    }
    if (row.form !== "secret" && isLiteral(conn.agentUser) && isLiteral(conn.agentPassword)) {
      const warning = publishedDefaultPairWarning(conn.type, { user: conn.agentUser, password: conn.agentPassword });
      if (warning !== undefined) {
        refuse(
          "agentPassword",
          `Seed connection "${conn.id}": the agent credential is refused: ${warning} An agent credential exists to narrow the principal, and a published default narrows nothing. Give the agent a credential of its own.`,
        );
      }
    }
    if (row.form === "secret" && isSet(conn.agentPassword) && isLiteral(conn.user)) {
      if (CONNECTION_FIELDS[conn.type].includes("user")) {
        refuse(
          "agentPassword",
          `Seed connection "${conn.id}" sets an agent credential beside user: the ${conn.type} provider keeps the connection's user beside the agent's secret and signs in with both, which has no read-only form, so every agent profile would be refused. Remove user from this connection, or remove the agent credential.`,
        );
      }
    }
  };
}

/**
 * The load's refusal of an MCP opt-in without an agent credential on an engine MCP reads only under one, read from
 * the record it is handed, `MCP_AGENT_CREDENTIAL_REQUIRED` in `SeedConnectionSchema`, never a type-id branch. The MCP
 * context refuses the same connection again at open (`assertAgentCredentialWhereRequired` in src/lib/mcp/context.ts).
 * A factory over the record for the reason `refuseMcpWhereNotOffered` is one: no shipped engine answers true yet.
 */
export function refuseMcpWithoutAgentCredential(required: Readonly<Record<DatabaseType, boolean>>) {
  return (conn: AgentCredentialFields & { readonly mcp?: boolean }, ctx: z.RefinementCtx): void => {
    if (conn.mcp !== true || !required[conn.type]) return;
    if (isSet(conn.agentUser) || isSet(conn.agentPassword)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Seed connection "${conn.id}" sets mcp: true on ${conn.type} without a read credential of its own (agentUser and agentPassword): MCP reads this engine only under that credential, whose grants are what bound what it reads. Set agentUser and agentPassword to a read credential, or remove mcp from this connection.`,
      path: ["mcp"],
    });
  };
}

/**
 * The load's refusal of an MCP opt-in without read roots on an engine MCP reads only beneath roots its seed declares,
 * read from the record it is handed, `READ_ROOTS_REQUIRED` in `SeedConnectionSchema`, never a type-id branch. The MCP
 * context refuses the same connection again at open (`assertReadRootsWhereRequired` in src/lib/mcp/context.ts).
 */
export function refuseMcpWithoutReadRoots(required: Readonly<Record<DatabaseType, boolean>>) {
  return (
    conn: {
      readonly id: string;
      readonly type: DatabaseType;
      readonly mcp?: boolean;
      readonly agentReadRoots?: unknown;
    },
    ctx: z.RefinementCtx,
  ): void => {
    if (conn.mcp !== true || !required[conn.type] || conn.agentReadRoots !== undefined) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Seed connection "${conn.id}" sets mcp: true on ${conn.type} without agentReadRoots: MCP reads this engine only beneath read roots its seed declares. Add agentReadRoots, or remove mcp from this connection.`,
      path: ["mcp"],
    });
  };
}

/** A provider sentence as a load refusal: the "Nothing was sent." ending is a connect's, not a file's. */
const atLoad = (sentence: string): string => sentence.replace(/ Nothing was sent\.$/, "");

// Kept in step with DatabaseType in src/lib/types.ts BY HAND: a zod enum is a value,
// so a type-id missing here is not a compile error - it is a seed file the server
// rejects with "invalid enum value" for a connection type the product supports.
const SeedDatabaseType = z.enum([
  "postgres",
  "mysql",
  "sqlite",
  "mongodb",
  "redis",
  "oracle",
  "db2",
  "mssql",
  "libredb",
  "couchbase",
  "clickhouse",
  "druid",
  "elasticsearch",
  "opensearch",
  "trino",
  "cassandra",
  "libsql",
  "duckdb",
  "prometheus",
  "kafka",
  "etcd",
  "neo4j",
  "milvus",
  "qdrant",
  "weaviate",
  "influxdb",
  "influxdb3",
  "oxia",
  "databend",
  "bigquery",
  "snowflake",
  "spark",
  "s3",
  "kubernetes",
  "mqtt",
  "firestore",
  "rabbitmq",
  "opcua",
  "mtconnect",
  "modbus",
  "netconf",
  "snmp",
  "sparkplug",
]);

const AGENT_CREDENTIAL_IN_DEFAULTS =
  "agentUser and agentPassword are set per connection and never in defaults: add the agent credential to each seed connection whose agent and MCP calls should run under it";

export const SeedDefaultsSchema = z.object({
  managed: z.boolean().optional(),
  environment: ConnectionEnvironmentSchema.optional(),
  ssl: SSLConfigSchema,
  // Refused rather than stripped (#246): a default would opt every later connection in to MCP.
  mcp: z
    .never({
      error:
        "mcp is set per connection and never in defaults: add mcp: true to each seed connection an MCP client may use",
    })
    .optional(),
  // Refused rather than stripped (#1089), like mcp: a default is merged only after the file is parsed,
  // past the refusal of an engine whose provider does not enforce the mode, so a merged default would
  // reach engines that ignore it.
  readOnly: z
    .never({
      error:
        "readOnly is set per connection and never in defaults: add readOnly: true to each seed connection that must refuse writes",
    })
    .optional(),
  // Refused rather than stripped, like mcp: a default would hand one agent principal to every later connection of the
  // file, on engines whose forms differ.
  agentUser: z.never({ error: AGENT_CREDENTIAL_IN_DEFAULTS }).optional(),
  agentPassword: z.never({ error: AGENT_CREDENTIAL_IN_DEFAULTS }).optional(),
  // Refused rather than stripped, like the agent credential: read roots name nodes on one server, so a default would
  // hand one server's roots to every OPC UA connection of the file.
  agentReadRoots: z
    .never({
      error:
        "agentReadRoots is set per connection and never in defaults: add the read roots to each OPC UA seed connection whose agent and MCP reads they bound.",
    })
    .optional(),
});

export const SeedConnectionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, "ID must be lowercase alphanumeric with hyphens"),
    name: z.string().min(1).max(128),
    type: SeedDatabaseType,
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    database: z.string().optional(),
    user: z.string().optional(),
    password: z.string().optional(),
    connectionString: z.string().optional(),
    environment: ConnectionEnvironmentSchema.optional(),
    group: z.string().max(64).optional(),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
    roles: z.array(AllowedRoleSchema).min(1, "At least one role is required"),
    managed: z.boolean().optional(),
    ssl: SSLConfigSchema,
    serviceName: z.string().optional(),
    instanceName: z.string().optional(),
    // Cassandra only, and REQUIRED by that driver rather than optional to it: a seeded
    // Cassandra connection without it cannot open at all. Optional here because the
    // other type-ids have no use for the field; the provider is what refuses a
    // connection that omits it.
    localDataCenter: z.string().optional(),
    // MongoDB only: the database its credentials live in (`admin` in the ordinary
    // deployment). Optional because the driver falls back to the database being opened,
    // which is right only when the two are the same.
    authSource: z.string().optional(),
    // Elasticsearch only (#708): an API key pair, preferred over user/password when both
    // are set. Same silent-strip risk as every field on this schema - see the note below.
    // The refine below is the type gate: without it an OpenSearch seed that carries the
    // pair validates, is copied through, and the transport would have dropped it with
    // no error. Refuse at parse instead.
    apiKeyId: z.string().optional(),
    apiKeySecret: z.string().optional(),
    // Kafka only (#1088): which SASL mechanism checks `user` and `password`, absent meaning none.
    // Declared, because zod strips an undeclared key and a seeded SCRAM connection would then reach
    // the provider as a credential with no mechanism, which it refuses. Kept in step with the union
    // on DatabaseConnection by hand, as the SSL modes above are. A mechanism names no credential
    // and no address, so it is not a field a `${ENV}` or `${vault:...}` reference is resolved in
    // (RESOLVABLE_FIELDS in credential-resolver.ts), and the file is validated before anything is
    // resolved: this enum refuses a reference here at load, naming the field. No type refine: the
    // field is inert on every other engine, and nothing falls back silently when it is absent.
    saslMechanism: z.enum(["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"]).optional(),
    schema: z.string().optional(),
    // Read no catalog when this connection opens (#765). Declarable in the seed file
    // because the deployment that ships a 40,000-object owner is the one that knows, and
    // a managed connection is read-only in the UI, so nobody could tick the box there.
    // Unlike the maps in `secret-fields.ts` and `use-connection-payload.ts`, this
    // schema fails SILENTLY when a field is missing: zod strips an unknown key, so a seed
    // file setting it would round-trip as `undefined` with no error anywhere.
    skipObjectScan: z.boolean().optional(),
    // Visible to MCP clients (#246). Per connection and never a default, because a file-wide
    // default would turn the opt-in into an opt-out for every connection the file later gains.
    // Declared for the reason skipObjectScan is: zod strips an undeclared key silently, and a seed
    // file's opt-in would validate and vanish. src/lib/seed/connection-filter.ts copies it.
    mcp: z.boolean().optional(),
    // Refuse every write on this connection (#1089). Declared for the reason skipObjectScan is: zod
    // strips an undeclared key silently, and a seed file's read-only mode would validate and vanish,
    // leaving a connection that writes. A literal boolean, never a reference: it names no credential
    // and no address, so it is not in RESOLVABLE_FIELDS, and a `${ENV}` here fails this type at load,
    // naming the field. Accepted only on an engine whose provider enforces it (the second refine
    // below), and only on a managed seed (SeedConfigSchema).
    readOnly: z.boolean().optional(),
    // Db2 (#786), both InfluxDB types and Oxia: accept that a connection with no TLS sends its password or token in
    // cleartext, which the provider otherwise refuses. Declared for the reason skipObjectScan is: zod strips an
    // undeclared key silently, and a seed file's consent would validate and vanish, leaving a
    // connection the provider refuses with a message naming a field the file did set.
    allowInsecureAuth: z.boolean().optional(),
    // Oxia only (O6): an address list the provider parses and refuses entry by entry; resolvable as `host` is
    // (`RESOLVABLE_FIELDS`).
    dataServers: z.string().optional(),
    // Databend and Snowflake: the warehouse statements run on, a compute name rather than a credential. Declared
    // for the reason skipObjectScan is: zod strips an undeclared key silently, and a seeded Databend Cloud connection
    // would lose the warehouse Cloud refuses to run without, a Snowflake one the warehouse it names over the user's
    // default.
    warehouse: z.string().optional(),
    // BigQuery only: the job location; absent, the provider detects it.
    location: z.string().optional(),
    // Snowflake only: the sign-in method. A string rather than an enum of `keypair` and `pat`, unlike saslMechanism,
    // because it is resolvable (`RESOLVABLE_FIELDS`) and the file is validated before anything is resolved, so an enum
    // would refuse a `${ENV}` reference here; the provider refuses any value other than `keypair` and `pat`.
    authMethod: z.string().optional(),
    // Snowflake only: the PEM private key's contents and the passphrase of an encrypted key, both secrets and both
    // resolvable, so a deployment keeps them in its environment or Vault. Declared for the reason skipObjectScan is:
    // zod strips an undeclared key silently, and a seeded key-pair connection would be refused for a key the file did
    // name.
    privateKey: z.string().optional(),
    privateKeyPassphrase: z.string().optional(),
    // Snowflake only: the role every statement runs as, which the provider requires. Declared for the reason
    // skipObjectScan is.
    role: z.string().optional(),
    // S3-compatible object storage only: the signing region. Declared for the reason skipObjectScan is: zod strips an
    // undeclared key silently, and a seeded connection to a server with a region of its own would be refused for a
    // region the file did name.
    region: z.string().optional(),
    // Kubernetes: the API path (also RabbitMQ's Path prefix), the namespaces the tree lists and the TLS server name,
    // the last two Kubernetes only. Declared for the reason skipObjectScan is: zod strips an undeclared key silently, and
    // a seeded connection behind a Rancher proxy or a reverse proxy would reach the proxy's own API with no word.
    apiPath: z.string().optional(),
    namespaces: z.string().optional(),
    tlsServerName: z.string().optional(),
    // An AMQP 0-9-1 port, digits as a string; read by no engine yet. Declared for the reason skipObjectScan is: zod
    // strips an undeclared key silently. A string, not a number, as the connection field is; resolvable as `host` is.
    amqpPort: z.string().optional(),
    /*
     * OPC UA only (#1677): the security mode the connection asks the server for, and the SHA-256
     * thumbprint the server's certificate must present.
     *
     * DECLARED BECAUSE THE PIN IS THE PROVIDER'S WHOLE SAFETY PROPERTY AND ZOD WOULD HAVE DROPPED
     * IT IN SILENCE, the way it would drop `skipObjectScan`. Measured before this was declared: a
     * seed file naming `securityMode: SignAndEncrypt` and a thumbprint parsed, validated, and
     * reached the provider with neither field - an UNPINNED connection, dialled with the library's
     * default, which trusts a server on first sight. An operator who seeded a pinned plant
     * connection would have been given the one thing the mode exists to prevent, with no warning.
     *
     * The mode is an enum rather than a string, for the reason `saslMechanism` is: it names no
     * credential and no address, so it is not resolved from `${ENV}` or `${vault:...}`
     * (RESOLVABLE_FIELDS), and this enum refuses a reference here at load, naming the field. The
     * thumbprint is a literal 64 hexadecimal characters, case-insensitive and separators removed by
     * the provider, and it is not a secret: it is published by the server it names.
     */
    securityMode: z.enum(["None", "Sign", "SignAndEncrypt"]).optional(),
    serverCertificateThumbprint: z.string().optional(),
    /**
     * NETCONF only: the device's SSH host key pin, `SHA256:` and base64 as `ssh-keygen -lf` prints it. The provider
     * refuses an empty pin (RFC 6242 section 6), so a seed without it can never be opened. Not a secret: the device
     * publishes its host key, so it is a literal and never resolved from a reference.
     */
    hostKeyFingerprint: z.string().optional(),
    /**
     * Modbus only: the register map, the JSON document the provider parses, saved byte for byte. Declared for the
     * reason skipObjectScan is: zod strips an undeclared key in silence, and a seeded connection without its map has
     * no named point to read. Not a secret: Modbus TCP defines no authentication, so it is a literal and never
     * resolved from a reference.
     */
    registerMap: z.string().optional(),
    // The agent credential: the principal the agent execution profiles and MCP sign in as, the engine's own user field
    // (a database role, an etcd user, an S3 access key ID), and that principal's secret, or on a secret-only engine the
    // whole credential (a bearer token, a service-account key JSON). Declared for the reason skipObjectScan is: zod
    // strips an undeclared key silently, and a seed file's agent credential would validate and vanish, leaving its
    // agent and MCP calls under the connection's own login. Strings, because both are resolvable (RESOLVABLE_FIELDS)
    // and the file is validated before anything is resolved. Which engines take which is SEED_AGENT_CREDENTIAL in
    // src/lib/db/connection-fields.ts, read by the refine below; only on a managed seed (SeedConfigSchema), and never
    // in defaults.
    agentUser: z.string().optional(),
    agentPassword: z.string().optional(),
    // OPC UA only: the read roots, the node ids beneath which agent mode and MCP read. Declared for the reason
    // skipObjectScan is: zod strips an undeclared key silently, and a seed's roots would validate and vanish, leaving
    // every agent and MCP read refused for roots the file did declare. Accepted here whatever it holds, so that the
    // engine's load check (OPCUA_CONNECTION_STRING.validateSeed, which runs readRootRefusals) answers every case in
    // its own words, a value that is not a list of strings included, framed with the connection's id. Never resolved
    // from a reference, and refused on every other type through SEED_ONLY_FIELDS.opcua.
    agentReadRoots: z.custom<readonly string[]>(() => true).optional(),
    // And the three OPC UA fields the dialog has no box for: why, at SEED_ONLY_FIELDS.opcua in src/lib/db/connection-fields.ts.
    securityPolicyUri: z.string().optional(),
    clientCertificatePath: z.string().optional(),
    clientPrivateKeyPath: z.string().optional(),
  })
  // A field only one engine's provider reads, refused at load on every other type: why, at that engine's row of
  // SEED_ONLY_FIELDS in src/lib/db/connection-fields.ts.
  .superRefine(refuseSeedOnlyFields)
  // The type's own checks before any socket (SF-038), from the validateSeed of its row in CONNECTION_STRING, so an entry
  // that can never open is refused with the file, by name, instead of loading and failing only when it is opened. A
  // type without one is not checked here. The message names the connection and the field, never the value, since a
  // refused account URL may carry a token.
  .superRefine((conn, ctx) => {
    for (const { field, sentence } of connectionStringFor(conn.type).validateSeed?.(conn, isCredentialReference) ??
      []) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Seed connection "${conn.id}": ${field} is refused: ${atLoad(sentence)}`,
        path: [field],
      });
    }
  })
  // An MCP opt-in on an engine MCP is not offered for (#1089), read from MCP_EXPOSABLE.
  .superRefine(refuseMcpWhereNotOffered(MCP_EXPOSABLE))
  // An MCP opt-in without an agent credential on an engine MCP reads only under one, read from
  // MCP_AGENT_CREDENTIAL_REQUIRED.
  .superRefine(refuseMcpWithoutAgentCredential(MCP_AGENT_CREDENTIAL_REQUIRED))
  // An MCP opt-in without read roots on an engine MCP reads only beneath them, read from READ_ROOTS_REQUIRED.
  .superRefine(refuseMcpWithoutReadRoots(READ_ROOTS_REQUIRED))
  // An agent credential the engine's row does not take, read from SEED_AGENT_CREDENTIAL.
  .superRefine(refuseInvalidAgentCredential(SEED_AGENT_CREDENTIAL))
  // A read-only mode on an engine Studio can write unguarded, read from WRITE_REACH.
  .superRefine(refuseReadOnlyWhereOpen(WRITE_REACH))
  // A read-only seed whose credential its type declares unsafe to rely on (src/lib/db/credential-warnings.ts): a
  // published default pair, or no secret where the type accepts none, so the mode would promise a boundary the
  // server does not keep. The file shows only literals, so a pair with a `${ENV}` or `${vault:...}` reference in
  // either field passes here and the type's provider checks the resolved value before it dials, while a password
  // the file leaves absent or empty is refused whatever the user is: load refuses what the file shows; resolution
  // refuses the rest. Read from the declared record, never a type-id branch. The message names the connection and
  // the field, never the value.
  .superRefine((conn, ctx) => {
    if (conn.readOnly !== true) return;
    if (isCredentialReference(conn.password)) return;
    const userIsReference = isCredentialReference(conn.user);
    if (userIsReference && (conn.password ?? "") !== "") return;
    const refusal = readOnlySeedRefusal(conn.type, {
      user: userIsReference ? undefined : conn.user,
      password: conn.password,
    });
    if (refusal === undefined) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Seed connection "${conn.id}": ${refusal} readOnly: true is refused with this credential, because the mode would promise a boundary the server does not keep. Give this connection a credential of its own, or remove readOnly.`,
      path: ["password"],
    });
  })
  // A connection string the type's provider does not read (Spec A section 7): the provider would drop it in
  // silence and open whatever the other fields say, so the seed would be listed as one database and reach
  // another, or none. Read from CONNECTION_STRING_ACCEPTED, never a type-id branch. Any set value counts, a
  // reference included, because the file is validated before anything is resolved. The message names the
  // connection and the type, never the value.
  .superRefine((conn, ctx) => {
    if (conn.connectionString === undefined || CONNECTION_STRING_ACCEPTED[conn.type]) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Seed connection "${conn.id}" sets connectionString, which the ${conn.type} provider does not read: move the value into host, port, user, password and database`,
      path: ["connectionString"],
    });
  });

/**
 * The load's refusal of a read-only seed that is not managed (#1089). An editable seed is copied into
 * the browser of every user its roles admit, with its password and TLS client key
 * (`GET /api/connections/managed`), and the sidebar's Duplicate turns that copy into a connection of
 * the user's own, which `resolveConnection` returns verbatim and whose readOnly the user can clear, so
 * the mode would bind nobody. It names `defaults.managed` when the value came from there, because that
 * is the line to change.
 */
function unmanagedReadOnlyMessage(fromDefaults: boolean): string {
  const managed = fromDefaults ? "managed: false from defaults.managed" : "managed: false";
  return `readOnly: true needs a managed connection, and this one has ${managed}: an unmanaged seed is copied into the browser of every user its roles admit, with its password and TLS client key, and Duplicate turns that copy into a connection of the user's own whose readOnly can be cleared. Set managed: true on this connection, or remove readOnly.`;
}

/**
 * The load's refusal of an agent credential on a seed that is not managed. An unmanaged seed is copied into the
 * browser of every user its roles admit, with its credentials (`GET /api/connections/managed`), and Duplicate turns
 * that copy into a connection of the user's own, so the agent's secret would reach every browser. Both fields, though
 * `agentUser` alone is public, because a browser copy that carries either no longer resolves to the seed. It names
 * `defaults.managed` when the value came from there, as `unmanagedReadOnlyMessage` does.
 */
function unmanagedAgentCredentialMessage(fromDefaults: boolean): string {
  const managed = fromDefaults ? "managed: false from defaults.managed" : "managed: false";
  return `An agent credential needs a managed connection, and this one has ${managed}: an unmanaged seed is copied into the browser of every user its roles admit, with its credentials, and Duplicate turns that copy into a connection of the user's own. Set managed: true on this connection, or remove the agent credential.`;
}

export const SeedConfigSchema = z
  .object({
    version: z.literal("1"),
    defaults: SeedDefaultsSchema.optional(),
    connections: z.array(SeedConnectionSchema).min(1, "At least one connection is required"),
  })
  // One issue per repeated id, at the path of its first repeat, so the error names the id. A seed id is a name, not
  // a value, so naming it is allowed.
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    const reported = new Set<string>();
    cfg.connections.forEach((conn, index) => {
      if (!seen.has(conn.id)) {
        seen.add(conn.id);
        return;
      }
      if (reported.has(conn.id)) return;
      reported.add(conn.id);
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Connection id "${conn.id}" is declared more than once`,
        path: ["connections", index, "id"],
      });
    });
  })
  // Here and not on SeedConnectionSchema, because `defaults.managed` is merged only after parsing
  // (connection-filter.ts): the effective value is the connection's own, else the default, else true,
  // the precedence mergeDefaults and filterByRoles apply.
  .superRefine((cfg, ctx) => {
    cfg.connections.forEach((conn, index) => {
      if (conn.readOnly !== true) return;
      if ((conn.managed ?? cfg.defaults?.managed ?? true) === true) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: unmanagedReadOnlyMessage(conn.managed === undefined),
        path: ["connections", index, "readOnly"],
      });
    });
  })
  // Here for the reason the read-only refusal above is: the effective managed value needs `defaults`.
  .superRefine((cfg, ctx) => {
    cfg.connections.forEach((conn, index) => {
      const field = AGENT_FIELDS.find((name) => conn[name] !== undefined);
      if (field === undefined) return;
      if ((conn.managed ?? cfg.defaults?.managed ?? true) === true) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: unmanagedAgentCredentialMessage(conn.managed === undefined),
        path: ["connections", index, field],
      });
    });
  });

export type SeedConnection = z.infer<typeof SeedConnectionSchema>;
export type SeedDefaults = z.infer<typeof SeedDefaultsSchema>;
export type SeedConfig = z.infer<typeof SeedConfigSchema>;

export interface ManagedConnection extends DatabaseConnection {
  managed: boolean;
  roles: string[];
  seedId: string;
  /** Visible to MCP clients (#246); absent on the built-in samples, which never opt in. */
  mcp?: boolean;
  /**
   * Set in code after the role filter, by the discovery source on every discovered connection and, for an
   * operator entry, by src/lib/seed/index.ts when the operator loader's fill read it as literal (every
   * file-like entry while SEED_LITERAL_VALUES is on); never read from a file;
   * stripped by GET /api/connections/managed. A connection carrying it is used with its values as
   * written: no `${NAME}` or `${vault:...}` in it is resolved.
   */
  literal?: true;
  /**
   * The Kubernetes Secret this connection's credentials come from. Set in code after the role filter, by a Kubernetes
   * discovery source, as `literal` is; never read from a file, because SeedConnectionSchema does not declare it;
   * stripped by GET /api/connections/managed. With the Kubernetes access review on, the connection carries
   * KUBERNETES_REVIEWED_ROLE and is listed and opened only for a session the review allows to `get` this Secret
   * (src/lib/kubernetes-access/gate.ts), and with it off for the admin role only, through the role filter
   * (src/lib/seed/index.ts).
   */
  kubernetesSecret?: { readonly namespace: string; readonly name: string };
  /**
   * Set in code by projectSeedConnection (src/lib/seed/connection-filter.ts) when the operator's own `roles` offer this
   * seed to any role but admin (`user`, `*`, a custom role, or the role reserved for the Kubernetes access review), read
   * before the projection narrows `roles` to the caller's. Never read from a file, because SeedConnectionSchema does not
   * declare it; stripped by GET /api/connections/managed. editorExecutionContext (src/lib/api/execution-context.ts)
   * decides the file-access posture from it, so every caller of one seed gets one posture and one cached handle.
   */
  sharedWithNonAdminRoles?: true;
  /**
   * Under governance only, set by GET /api/connections/managed from the grant level the record was resolved for: "read"
   * when statements run under the connection's read credential. Never read from a file.
   */
  access?: "read" | "write";
}
