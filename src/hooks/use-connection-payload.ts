import type { DatabaseConnection } from '@/lib/types';

/**
 * Builds the connection portion of an API request body.
 * For managed connections: sends { connectionId: "seed:X" } (no credentials).
 * For user connections: sends { connection: conn } (full object).
 */
export function buildConnectionPayload(
  conn: DatabaseConnection,
): { connectionId: string } | { connection: DatabaseConnection } {
  if (conn.managed && conn.seedId) {
    return { connectionId: `seed:${conn.seedId}` };
  }
  return { connection: conn };
}
