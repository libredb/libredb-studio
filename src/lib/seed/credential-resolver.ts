import { logger } from "@/lib/logger";
import type { SeedConnection } from "./types";
import { readVaultSecret, VaultError, type VaultDeps } from "./vault-client";

const ENV_VAR_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;
const VAULT_PREFIX = "${vault:";
const VAULT_REF_PATTERN = /^\$\{vault:([^#{}]+)#([^{}]+)\}$/;
const RESOLVABLE_FIELDS = ["password", "connectionString", "user", "host", "database"] as const;

type ResolvableField = (typeof RESOLVABLE_FIELDS)[number];

/** The shape `resolveVaultCredentials` needs. Kept structural so a `ManagedConnection` passes through intact. */
interface VaultResolvableConnection {
  id: string;
  password?: string;
  connectionString?: string;
  user?: string;
  host?: string;
  database?: string;
}

const warnedPlaintext = new Set<string>();

export function resetPlaintextWarnings(): void {
  warnedPlaintext.clear();
}

function isVaultReference(value: string): boolean {
  return value.startsWith(VAULT_PREFIX);
}

function resolveField(value: string | undefined, fieldName: string, connId: string): string | undefined {
  if (value === undefined) return undefined;

  // Left untouched here and resolved by `resolveVaultCredentials` below, when the one
  // connection that carries it is opened. A Vault read on the list path would read every
  // secret of every connection on every page load, and the reference is not plaintext, so
  // it must not trip the plaintext-password warning either.
  if (isVaultReference(value)) return value;

  const match = value.match(ENV_VAR_PATTERN);
  if (!match) {
    if (fieldName === "password" && value.length > 0 && !warnedPlaintext.has(connId)) {
      warnedPlaintext.add(connId);
      logger.warn("Seed connection has plaintext password, use ${ENV_VAR} syntax", {
        route: "seed/credential-resolver",
        connectionId: connId,
      });
    }
    return value;
  }

  const envVar = match[1];
  const envValue = process.env[envVar];
  if (envValue === undefined) {
    throw new Error(
      `Environment variable ${envVar} is not defined (required by seed connection "${connId}" field "${fieldName}")`,
    );
  }

  return envValue;
}

export function resolveConnectionCredentials(conn: SeedConnection): SeedConnection {
  const resolved = { ...conn };
  for (const field of RESOLVABLE_FIELDS) {
    const value = resolved[field];
    if (typeof value === "string") {
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
      logger.error("Seed connection skipped due to credential resolution failure", err, {
        route: "seed/credential-resolver",
        connectionId: conn.id,
      });
    }
  }
  return results;
}

function parseVaultReference(value: string, connId: string, fieldName: ResolvableField): { path: string; key: string } {
  const match = value.match(VAULT_REF_PATTERN);
  if (!match) {
    // A VaultError, not a bare Error, so the API layer classifies a typo in the
    // reference the same way it classifies every other failed reference (see
    // `createErrorResponse`).
    throw new VaultError(
      `Invalid Vault reference "${value}" (seed connection "${connId}" field "${fieldName}"): expected \${vault:<mount>/data/<path>#<key>}`,
    );
  }
  return { path: match[1], key: match[2] };
}

/**
 * Resolves every `${vault:...}` reference on one connection.
 *
 * Called from `resolveConnection` after the role check, so a reference is read only for a
 * connection the caller may already open, and only once per connection. A connection with
 * no `${vault:...}` reference returns unchanged without touching Vault.
 */
export async function resolveVaultCredentials<T extends VaultResolvableConnection>(
  conn: T,
  deps?: VaultDeps,
): Promise<T> {
  const references = RESOLVABLE_FIELDS.flatMap((field) => {
    const value = conn[field];
    return typeof value === "string" && isVaultReference(value) ? [{ field, value }] : [];
  });
  if (references.length === 0) return conn;

  const resolved = { ...conn } as Record<string, unknown>;
  for (const { field, value } of references) {
    const { path, key } = parseVaultReference(value, conn.id, field);
    resolved[field] = await readVaultSecret(path, key, deps);
  }
  return resolved as T;
}
