import { z } from "zod";
import { MCP_EXPOSABLE, READ_ONLY_ENFORCED } from "@/lib/db/compatibility";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";

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

// Allowed roles in current iteration (matches JWT role: 'admin' | 'user' + wildcard)
const AllowedRoleSchema = z.enum(["*", "admin", "user"]);

/**
 * The load's refusal of an MCP opt-in on an engine MCP is not offered for (#1089). Read from the record
 * it is handed, `MCP_EXPOSABLE` in `SeedConnectionSchema`, never a type-id branch, so an engine is
 * admitted by its own entry. Refused rather than stripped, because a stripped opt-in would load a file
 * that asks for something the product will not do. A factory over the record, the way
 * `offersReadOnlyToggle` takes its engine's answer, so the refusal is tested before any shipped engine
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
  "opengauss",
  "etcd",
]);

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
    // Unlike the maps in `connection-secrets.ts` and `use-connection-payload.ts`, this
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
  })
  .superRefine((conn, ctx) => {
    if (conn.type === "elasticsearch") return;
    if (conn.apiKeyId === undefined && conn.apiKeySecret === undefined) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "apiKeyId and apiKeySecret are Elasticsearch-only. OpenSearch (and every other engine) refuses the pair: nothing here has measured whether OpenSearch's security plugin accepts Authorization: ApiKey, so a seed that carries it is rejected rather than listed as a connection that silently falls back to user/password.",
      path: conn.apiKeyId !== undefined ? ["apiKeyId"] : ["apiKeySecret"],
    });
  })
  // An MCP opt-in on an engine MCP is not offered for (#1089), read from MCP_EXPOSABLE.
  .superRefine(refuseMcpWhereNotOffered(MCP_EXPOSABLE))
  // A read-only mode the engine's provider ignores would be a promise nobody keeps: the seed would be
  // listed as read-only and still write (#1089). Read from READ_ONLY_ENFORCED, never a type-id branch,
  // so an engine is admitted by its own declaration.
  .superRefine((conn, ctx) => {
    if (conn.readOnly !== true || READ_ONLY_ENFORCED[conn.type]) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `readOnly is not offered for ${conn.type}: its provider does not enforce a read-only mode, so the connection would be listed as read-only and still write. Remove readOnly from this connection, or connect with a database role that cannot write.`,
      path: ["readOnly"],
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

export const SeedConfigSchema = z
  .object({
    version: z.literal("1"),
    defaults: SeedDefaultsSchema.optional(),
    connections: z.array(SeedConnectionSchema).min(1, "At least one connection is required"),
  })
  .refine((cfg) => new Set(cfg.connections.map((c) => c.id)).size === cfg.connections.length, {
    message: "Connection IDs must be unique",
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
}
