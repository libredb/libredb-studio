import { logger } from "@/lib/logger";
import type { SeedConnection } from "./types";
import { readVaultSecret, VaultError, type VaultDeps } from "./vault-client";

const ENV_VAR_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;
const VAULT_PREFIX = "${vault:";
const VAULT_REF_PATTERN = /^\$\{vault:([^#{}]+)#([^{}]+)\}$/;
const SSL_PREFIX = "ssl.";
const RESOLVABLE_FIELDS = [
  "password",
  "connectionString",
  "user",
  "host",
  "database",
  // Elasticsearch API key pair (#708). A seeded `${ELASTIC_API_KEY_ID}` / `${vault:...}`
  // that is not on this list is sent literally and the cluster answers 401 on a key
  // that works. Both halves, not one: either left unresolved is a half-filled pair
  // the transport will silently fall back from.
  "apiKeyId",
  "apiKeySecret",
  // The TLS material (#1089), read and written under `ssl` and named by this dotted path in
  // an error. On a Kubernetes control-plane etcd the node's client certificate and key are
  // the only credential, and the chart mounts the seed file from a ConfigMap, so a reference
  // is how they come from a Secret with no private key in the ConfigMap. A multi-line PEM
  // passes through unchanged: the patterns match the reference, never the value. The key
  // stays a secret field (`SSL_FIELDS` in connection-secrets.ts) for every consumer.
  "ssl.caCert",
  "ssl.clientCert",
  "ssl.clientKey",
] as const satisfies readonly (TopLevelField | `${typeof SSL_PREFIX}${keyof ResolvableSsl}`)[];

type ResolvableField = (typeof RESOLVABLE_FIELDS)[number];
type SslField = Extract<ResolvableField, `${typeof SSL_PREFIX}${string}`>;

interface ResolvableSsl {
  caCert?: string;
  clientCert?: string;
  clientKey?: string;
}

/** The shape both loops need. Kept structural so a `ManagedConnection` passes through intact. */
interface VaultResolvableConnection {
  id: string;
  password?: string;
  connectionString?: string;
  user?: string;
  host?: string;
  database?: string;
  apiKeyId?: string;
  apiKeySecret?: string;
  ssl?: ResolvableSsl;
}

type TopLevelField = Exclude<keyof VaultResolvableConnection, "id" | "ssl">;

function isSslField(field: ResolvableField): field is SslField {
  return field.startsWith(SSL_PREFIX);
}

function sslKeyOf(field: SslField): keyof ResolvableSsl {
  return field.slice(SSL_PREFIX.length) as keyof ResolvableSsl;
}

/** A resolvable field's value: at the connection's top level, or under `ssl` for the TLS material. */
function fieldValue(conn: VaultResolvableConnection, field: ResolvableField): string | undefined {
  return isSslField(field) ? conn.ssl?.[sslKeyOf(field)] : conn[field];
}

/**
 * Writes a resolved value into `target`, a copy the caller made of the connection. Under `ssl` it
 * writes into a new object and never the connection's own: a connection with no `ssl` of its own
 * shares `defaults.ssl` with every other such connection (`mergeDefaults`), and the parsed seed file
 * is cached, so writing into it would put a resolved key into the cached file.
 */
function setFieldValue(target: VaultResolvableConnection, field: ResolvableField, value: string | undefined): void {
  if (isSslField(field)) target.ssl = { ...target.ssl, [sslKeyOf(field)]: value };
  else target[field] = value;
}

const warnedPlaintext = new Set<string>();

export function resetPlaintextWarnings(): void {
  warnedPlaintext.clear();
}

function isVaultReference(value: string): boolean {
  return value.startsWith(VAULT_PREFIX);
}

/**
 * Whether the resolver replaces this value, a `${ENV}` or a `${vault:...}` reference, rather than passing it on
 * as the literal it is. The seed schema reads it to tell what the file shows from what resolution decides.
 */
export function isCredentialReference(value: string | undefined): boolean {
  return value !== undefined && (isVaultReference(value) || ENV_VAR_PATTERN.test(value));
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
    const value = fieldValue(resolved, field);
    if (typeof value === "string") {
      setFieldValue(resolved, field, resolveField(value, field, conn.id));
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
    const value = fieldValue(conn, field);
    return typeof value === "string" && isVaultReference(value) ? [{ field, value }] : [];
  });
  if (references.length === 0) return conn;

  const resolved: VaultResolvableConnection = { ...conn };
  for (const { field, value } of references) {
    const { path, key } = parseVaultReference(value, conn.id, field);
    // oxlint-disable-next-line no-await-in-loop -- fields that share a path read it once: each later read is answered from the cache the one before it fills.
    setFieldValue(resolved, field, await readVaultSecret(path, key, deps));
  }
  return resolved as T;
}
