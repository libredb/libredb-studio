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

export function filterByRoles(connections: SeedConnection[], userRoles: string[]): ManagedConnection[] {
  return connections
    .filter((conn) => rolesMatch(conn.roles, userRoles))
    .map((conn) => ({
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
      createdAt: new Date(),
      managed: conn.managed ?? true,
      roles: conn.roles,
      seedId: conn.id,
    }));
}
