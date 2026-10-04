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

/**
 * A read-only seed must be managed (#1089). The seed schema already refuses the pair at load, with
 * `defaults.managed` taken into account; this is the mapper's own gate, checked on the connection
 * `mergeDefaults` produced, so a SeedConnection built in memory (bypassing zod) cannot be projected as
 * a read-only connection whose password and client key reach the browser, where a duplicate of it
 * can clear the mode.
 */
function assertReadOnlySeedIsManaged(conn: SeedConnection): void {
  if (conn.readOnly !== true || conn.managed !== false) return;
  throw new Error(
    `Seed connection "${conn.id}" sets readOnly: true with managed: false. A read-only seed stays managed, because an unmanaged one is copied into the browser with its credentials, where a duplicate of it can clear the mode; the seed is refused rather than projected as a read-only connection that is not.`,
  );
}

export function filterByRoles(connections: SeedConnection[], userRoles: string[]): ManagedConnection[] {
  return connections
    .filter((conn) => rolesMatch(conn.roles, userRoles))
    .map((conn) => {
      assertApiKeyPairIsElasticsearch(conn);
      assertReadOnlySeedIsManaged(conn);
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
        // The MCP opt-in (#246), copied for the reason skipObjectScan is: dropped here, a seed that
        // opted in would reach the MCP context without its opt-in and never be visible.
        mcp: conn.mcp,
        // The read-only mode (#1089), copied for the reason skipObjectScan is: dropped here, a seed the
        // operator declared read-only would be listed and opened as a connection that writes.
        readOnly: conn.readOnly,
        // Db2's consent to a cleartext password (#786), copied for the reason skipObjectScan is:
        // dropped here, a seed the operator declared it for would be refused by the provider.
        allowInsecureAuth: conn.allowInsecureAuth,
        // Oxia's data servers (O6), copied for the reason skipObjectScan is: dropped here, a seeded cluster would be
        // refused by the provider for leaders the file did list.
        dataServers: conn.dataServers,
        createdAt: new Date(),
        managed: conn.managed ?? true,
        roles: conn.roles,
        seedId: conn.id,
      };
    });
}
