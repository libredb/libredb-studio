/**
 * Maps a connection to the options the REST client opens its transport with (#1566 spec 6.1), after the endpoint
 * check (W1), the token check, the TLS mapping, the plaintext rule (W2) and the read-only seed stage. No socket
 * opens here: every refusal is a DatabaseConfigError raised before any client is built, and none repeats the value
 * it refuses.
 *
 * Every field read is checked before it is used, because a connection sent to the API arrives as the caller wrote
 * it: a field that is not the type `DatabaseConnection` declares is refused, naming the field. A null in a text
 * field reads as absent, as does an empty string, which the dialog writes for a blank box; `readOnly` must be true
 * or false when present, as Qdrant's.
 *
 * Weaviate takes an API key and an OIDC access token alike as a bearer token, so the secret sits in the password
 * and travels as one `Authorization: Bearer` header, set once per connection, never in a URL or a query string. No
 * other header is ever set (spec W3): a model-provider key such as `X-OpenAI-Api-Key` cannot be sent. REST and
 * GraphQL share the one port dialled; gRPC (50051) never is.
 *
 * The parameter is named `config` on purpose: tests/unit/lib/db-ui-config.test.ts finds which addressing fields a
 * provider reads by the `config.<field>` pattern, and this file reads `config.user` and `config.password` as written.
 */
import { readOnlySeedRefusal } from "@/lib/db/credential-warnings";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  type HttpOrigin,
  httpOrigin,
  plaintextSecretRefusal,
  validateHost,
  validatePort,
} from "@/lib/db/http/endpoint";
import { type NodeTlsMaterial, nodeTlsMaterial } from "@/lib/db/http/node-transport";
import { secretForms } from "@/lib/db/utils/server-text";
import {
  type DatabaseConnection,
  type DatabaseType,
  type SSHTunnelConfig,
  TUNNEL_FAR_END,
  type TunnelFarEnd,
  type WithTunnelFarEnd,
} from "@/lib/types";

/** Where a read-only mode was set; the provider words its refusal by it. */
export type WeaviateReadOnlySource = "connection" | "seed" | "execution-profile";

export interface WeaviateConnectionOptions {
  /** What is dialled: the validated host and port, the local forward under a tunnel; `https` exactly when TLS is on. */
  readonly origin: HttpOrigin;
  /** The endpoint as configured (the far end under a tunnel), an IPv6 literal without brackets; what sentences name. */
  readonly endpoint: { readonly host: string; readonly port: number };
  /** The SSL / TLS panel as the transport takes it; null for plaintext. */
  readonly tls: NodeTlsMaterial | null;
  /** The headers set once per connection: the one `Authorization` header, or none. */
  readonly headers: Readonly<Record<string, string>>;
  /** The provider's in-flight bound, which is the transport's socket bound. */
  readonly maxSockets: number;
  /** The most bytes one response may hold. */
  readonly responseCapBytes: number;
  readonly readOnly?: WeaviateReadOnlySource;
  /** The connection's query timeout, which caps every request's deadline. */
  readonly callTimeoutMs: number;
  /** `secretForms` of the secret: empty with no secret. */
  readonly secretForms: readonly string[];
}

/** REST and GraphQL, with TLS or without; the only Weaviate port this provider dials. */
export const WEAVIATE_DEFAULT_PORT = 8080;
/** The calls in flight for one provider, and so the sockets of its one Agent. */
export const WEAVIATE_MAX_IN_FLIGHT = 4;
/** The transport's cap on one response: twice the 8 MiB conversion budget (spec W8). */
export const WEAVIATE_RESPONSE_CAP_BYTES = 16 * 1024 * 1024;

const PROVIDER: DatabaseType = "weaviate";
const SECRET_LABEL = "API key or token";
/** Printable ASCII: what a bearer header carries unchanged. A line break, a NUL, a tab or a non-ASCII character is refused. */
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;
const MAX_QUERY_TIMEOUT_MS = 2_147_483_647;

const USER_NOT_TAKEN =
  "Weaviate takes no user name: clear the connection's user, and put the API key or OIDC access token in the password. Nothing was sent.";
const SECRET_NOT_PRINTABLE =
  "The connection's password (the API key or token) holds a space, a line break, a NUL or another character outside printable ASCII; remove it. Nothing was sent.";
const TUNNEL_NOT_OPENED =
  "This connection's SSH tunnel is on, but the connection arrived without its tunnel, so Weaviate was not dialled directly: the tunnel opens only when both Host and Port are set.";
const SEED_REFUSED =
  "This read-only seed connection is refused with this credential, because the mode would promise a boundary the server does not keep; nothing was sent.";
const READ_ONLY_NOT_BOOLEAN = "readOnly must be true or false.";
const QUERY_TIMEOUT_RANGE = "Query timeout must be a whole number between 1 and 2147483647 milliseconds.";

/** Throws DatabaseConfigError for every refusal of W1, W2 and the seed stage; never echoes a value. */
export function buildWeaviateConnectionOptions(
  config: DatabaseConnection & WithTunnelFarEnd,
  context: { readonly executionReadOnly: boolean; readonly queryTimeout: number },
): WeaviateConnectionOptions {
  const farEnd = tunnelFarEnd(config);
  const dialled = shared(() => httpOrigin("http", config.host, config.port ?? WEAVIATE_DEFAULT_PORT));
  const endpoint =
    farEnd === undefined
      ? { host: unbracketed(dialled.host), port: dialled.port }
      : { host: unbracketed(shared(() => validateHost(farEnd.host))), port: shared(() => validatePort(farEnd.port)) };
  const secret = credential(config);
  const tls = shared(() => nodeTlsMaterial(config.ssl, endpoint.host));
  const plaintext = plaintextSecretRefusal({
    host: endpoint.host,
    tunnelled: farEnd !== undefined,
    tls: tls !== null,
    hasSecret: secret !== undefined,
    secretLabel: SECRET_LABEL,
  });
  if (plaintext !== undefined) throw configError(plaintext);
  const readOnly = readOnlySource(config, context.executionReadOnly);
  if (readOnly === "seed") seedStage(secret);
  return {
    origin: { scheme: tls === null ? "http" : "https", host: dialled.host, port: dialled.port },
    endpoint,
    tls,
    headers: secret === undefined ? {} : { authorization: `Bearer ${secret}` },
    maxSockets: WEAVIATE_MAX_IN_FLIGHT,
    responseCapBytes: WEAVIATE_RESPONSE_CAP_BYTES,
    ...(readOnly === undefined ? {} : { readOnly }),
    callTimeoutMs: callTimeout(context.queryTimeout),
    secretForms: secretForms(secret === undefined ? [] : [secret]),
  };
}

function tunnelFarEnd(config: DatabaseConnection & WithTunnelFarEnd): TunnelFarEnd | undefined {
  const tunnel = optionalObject<keyof SSHTunnelConfig>(config.sshTunnel, "sshTunnel");
  const enabled = optionalBoolean(tunnel?.enabled, "sshTunnel.enabled") === true;
  const farEnd = config[TUNNEL_FAR_END];
  if (enabled && farEnd === undefined) throw configError(TUNNEL_NOT_OPENED);
  return farEnd;
}

function unbracketed(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** The shared validators refuse with a DatabaseConfigError that names no provider; re-raised as Weaviate's. */
function shared<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw configError((error as Error).message);
  }
}

/** The bearer token, or undefined with none. A user is refused, because Weaviate has none to send it as. */
function credential(config: DatabaseConnection): string | undefined {
  if (optionalText(config.user, "user") !== undefined) throw configError(USER_NOT_TAKEN);
  const secret = optionalText(config.password, "password");
  if (secret !== undefined && !PRINTABLE_ASCII.test(secret)) throw configError(SECRET_NOT_PRINTABLE);
  return secret;
}

/** The resolution stage: a read-only seed whose resolved credential the record declares unsafe. */
function seedStage(secret: string | undefined): void {
  const refusal = readOnlySeedRefusal(PROVIDER, secret === undefined ? {} : { password: secret });
  if (refusal !== undefined) throw configError(`${refusal} ${SEED_REFUSED}`);
}

/** The connection's own `readOnly` first (a seed's when it carries `seedId`), then the execution profile's. */
function readOnlySource(config: DatabaseConnection, executionReadOnly: boolean): WeaviateReadOnlySource | undefined {
  const readOnly: unknown = config.readOnly;
  if (readOnly !== undefined && typeof readOnly !== "boolean") throw configError(READ_ONLY_NOT_BOOLEAN);
  if (readOnly === true) {
    const seedId = optionalText(config.seedId, "seedId");
    return seedId === undefined ? "connection" : "seed";
  }
  return executionReadOnly ? "execution-profile" : undefined;
}

function callTimeout(queryTimeout: number): number {
  if (!Number.isInteger(queryTimeout) || queryTimeout < 1 || queryTimeout > MAX_QUERY_TIMEOUT_MS) {
    throw configError(QUERY_TIMEOUT_RANGE);
  }
  return queryTimeout;
}

function optionalObject<Key extends string>(value: unknown, field: string): Partial<Record<Key, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw wrongType(field, "an object");
  return value as Partial<Record<Key, unknown>>;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw wrongType(field, "a string");
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw wrongType(field, "true or false");
  return value;
}

function wrongType(field: string, expected: string): DatabaseConfigError {
  return configError(`The connection's ${field} must be ${expected}; nothing was sent.`);
}

function configError(message: string): DatabaseConfigError {
  return new DatabaseConfigError(message, PROVIDER);
}
