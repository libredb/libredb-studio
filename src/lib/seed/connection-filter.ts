import type { SSLConfig } from "@/lib/types";
import type { SeedConnection, SeedDefaults, ManagedConnection } from "./types";

export function mergeDefaults(conn: SeedConnection, defaults: SeedDefaults | undefined): SeedConnection {
  if (!defaults) return conn;
  return {
    ...conn,
    managed: conn.managed ?? defaults.managed,
    environment: conn.environment ?? defaults.environment,
    ssl: conn.ssl ?? defaults.ssl,
  };
}

function rolesMatch(connectionRoles: string[], userRoles: string[]): boolean {
  if (connectionRoles.includes("*")) return true;
  return connectionRoles.some((r) => userRoles.includes(r));
}

/**
 * The pair is Elasticsearch-only. Seed schema already refuses it on any other
 * type-id; this is the mapper's own gate so a SeedConnection constructed in
 * memory (bypassing zod) cannot be projected as a managed OpenSearch connection
 * whose transport would then drop the pair with no error (#708).
 */
function assertApiKeyPairIsElasticsearch(conn: SeedConnection): void {
  if (conn.type === "elasticsearch") return;
  if (!conn.apiKeyId && !conn.apiKeySecret) return;
  throw new Error(
    `Seed connection "${conn.id}" of type "${conn.type}" carries an Elasticsearch API key pair. The pair is Elasticsearch-only; OpenSearch's security plugin has not been measured to accept Authorization: ApiKey, so the seed is refused rather than projected as a connection that silently falls back to user/password.`,
  );
}

export function filterByRoles(connections: SeedConnection[], userRoles: string[]): ManagedConnection[] {
  return connections
    .filter((conn) => rolesMatch(conn.roles, userRoles))
    .map((conn) => {
      assertApiKeyPairIsElasticsearch(conn);
      return {
        id: `seed:${conn.id}`,
        name: conn.name,
        type: conn.type,
        host: conn.host,
        port: conn.port,
        database: conn.database,
        user: conn.user,
        password: conn.password,
        connectionString: conn.connectionString,
        environment: conn.environment,
        group: conn.group,
        color: conn.color,
        ssl: conn.ssl as SSLConfig | undefined,
        serviceName: conn.serviceName,
        instanceName: conn.instanceName,
        // Cassandra's required data centre. Dropping it here would list a seeded ring
        // the product cannot open, because the driver refuses to connect without one.
        localDataCenter: conn.localDataCenter,
        // MongoDB's auth database. Dropping it here would list a seeded connection that
        // authenticates against the wrong database and reports a credentials error.
        authSource: conn.authSource,
        // Elasticsearch's API key pair (#708). Dropping either half here would seed a
        // connection that falls back to user/password silently, which is the exact "a
        // field validated above and not copied here" failure this comment block warns
        // about for skipObjectScan below.
        apiKeyId: conn.apiKeyId,
        apiKeySecret: conn.apiKeySecret,
        // Kafka's SASL mechanism (#1088). Dropping it here would list a seeded SCRAM connection
        // with its user and password and no mechanism to send them by, which the provider refuses.
        saslMechanism: conn.saslMechanism,
        schema: conn.schema,
        // The second half of the seed round-trip, and the half a zod field cannot cover:
        // this mapper is a hand-written field list, so a field validated above and not
        // copied here reaches the browser as `undefined` and the seeded connection scans
        // the catalog the deployment asked it not to (#765).
        skipObjectScan: conn.skipObjectScan,
        createdAt: new Date(),
        managed: conn.managed ?? true,
        roles: conn.roles,
        seedId: conn.id,
      };
    });
}
