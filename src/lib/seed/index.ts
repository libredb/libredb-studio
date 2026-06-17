import { loadConfig } from './config-loader';
import { resolveAllCredentials } from './credential-resolver';
import { filterByRoles, mergeDefaults } from './connection-filter';
import type { ManagedConnection } from './types';

export type { ManagedConnection, SeedConfig, SeedConnection, SeedDefaults } from './types';
export { resetCache } from './config-loader';

async function loadAndResolve(): Promise<ManagedConnection[]> {
  const config = await loadConfig();
  if (!config) return [];
  const withDefaults = config.connections.map((conn) => mergeDefaults(conn, config.defaults));
  const resolved = resolveAllCredentials(withDefaults);
  return filterByRoles(resolved, ['*', 'admin', 'user']);
}

export async function getManagedConnections(roles: string[]): Promise<ManagedConnection[]> {
  const config = await loadConfig();
  if (!config) return [];
  const withDefaults = config.connections.map((conn) => mergeDefaults(conn, config.defaults));
  const resolved = resolveAllCredentials(withDefaults);
  return filterByRoles(resolved, roles);
}

export async function getSeedConnectionById(
  seedId: string,
  roles: string[],
): Promise<ManagedConnection | null> {
  const all = await getManagedConnections(roles);
  return all.find((c) => c.seedId === seedId) ?? null;
}

export async function getSeedConnectionByIdUnfiltered(
  seedId: string,
): Promise<ManagedConnection | null> {
  const all = await loadAndResolve();
  return all.find((c) => c.seedId === seedId) ?? null;
}
