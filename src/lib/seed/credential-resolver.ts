import { logger } from '@/lib/logger';
import type { SeedConnection } from './types';

const ENV_VAR_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;
const RESOLVABLE_FIELDS = ['password', 'connectionString', 'user', 'host', 'database'] as const;

const warnedPlaintext = new Set<string>();

export function resetPlaintextWarnings(): void {
  warnedPlaintext.clear();
}

function resolveField(value: string | undefined, fieldName: string, connId: string): string | undefined {
  if (value === undefined) return undefined;

  const match = value.match(ENV_VAR_PATTERN);
  if (!match) {
    if (fieldName === 'password' && value.length > 0 && !warnedPlaintext.has(connId)) {
      warnedPlaintext.add(connId);
      logger.warn('Seed connection has plaintext password, use ${ENV_VAR} syntax', {
        route: 'seed/credential-resolver',
        connectionId: connId,
      });
    }
    return value;
  }

  const envVar = match[1];
  const envValue = process.env[envVar];
  if (envValue === undefined) {
    throw new Error(`Environment variable ${envVar} is not defined (required by seed connection "${connId}" field "${fieldName}")`);
  }

  return envValue;
}

export function resolveConnectionCredentials(conn: SeedConnection): SeedConnection {
  const resolved = { ...conn };
  for (const field of RESOLVABLE_FIELDS) {
    const value = resolved[field];
    if (typeof value === 'string') {
      (resolved as Record<string, unknown>)[field] = resolveField(value, field, conn.id);
    }
  }
  return resolved;
}

export function resolveAllCredentials(connections: SeedConnection[]): SeedConnection[] {
  const results: SeedConnection[] = [];
  for (const conn of connections) {
    try {
      results.push(resolveConnectionCredentials(conn));
    } catch (err) {
      logger.error('Seed connection skipped due to credential resolution failure', {
        route: 'seed/credential-resolver',
        connectionId: conn.id,
        error: (err as Error).message,
      });
    }
  }
  return results;
}
