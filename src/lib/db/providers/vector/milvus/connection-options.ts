/**
 * Maps a connection to the options the gRPC adapter opens its one channel with (vector-family spec 5.2), after E1,
 * E4, VF1, E6 and the seed stage of 3.12. No socket opens here: every refusal is a DatabaseConfigError raised before
 * any client is built, and none repeats the value it refuses.
 *
 * Every field read is checked before it is used, because a connection sent to the API arrives as the caller wrote it:
 * a field that is not the type `DatabaseConnection` declares is refused, naming the field. A null reads as absent, as
 * does an empty string in a text field, which the dialog writes for a blank User or Password; `readOnly` is the one
 * exception, where a null is refused, as `assertReadOnlyHonoured` does.
 *
 * The target is `dns:` and the validated host and port, an IPv6 literal kept in its brackets (E1): grpc-js reads the
 * text before the first colon as a resolver name, so a host named `unix` would otherwise dial a Unix socket. The TLS
 * identity is the tunnel's far end when a tunnel carries the connection, else the host, always set as
 * `grpc.ssl_target_name_override`; an IP identity is overridden with MILVUS_IP_SERVER_NAME, because Node 25 and later
 * and Bun refuse an IP as a TLS server name, and `grpcChannelCredentials` (src/lib/db/grpc/credentials.ts) verifies the
 * certificate against the IP itself (E6).
 *
 * The endpoint host rule and the TLS panel are the shared gRPC transport's (src/lib/db/grpc/tls.ts); the credential
 * rules are Milvus's own: a password alone is a token, and a user and a password are a pair (5.2).
 *
 * The parameter is named `config` on purpose: tests/unit/lib/db-ui-config.test.ts finds which addressing fields a
 * provider reads by the `config.<field>` pattern, and this file reads `config.user`, `config.password` and
 * `config.database` as written.
 */
import { readOnlySeedRefusal } from "@/lib/db/credential-warnings";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  type GrpcConfigWords,
  type GrpcTlsOptions,
  grpcEndpointHost,
  grpcTarget,
  grpcTlsIdentity,
  readGrpcTlsPanel,
} from "@/lib/db/grpc/tls";
import { plaintextSecretRefusal, validatePort } from "@/lib/db/http/endpoint";
import { secretForms } from "@/lib/db/utils/server-text";
import {
  type DatabaseConnection,
  type DatabaseType,
  type SSHTunnelConfig,
  TUNNEL_FAR_END,
  type TunnelFarEnd,
  type WithTunnelFarEnd,
} from "@/lib/types";
import type { X509Certificate } from "node:crypto";
import type { MilvusErrorConnection } from "./errors";

export type MilvusAuth =
  | { readonly kind: "none" }
  | { readonly kind: "password"; readonly user: string; readonly password: string }
  /** The Password or token box with the user empty: sent as base64 of the token (5.2). */
  | { readonly kind: "token"; readonly token: string };

/** Where a read-only mode was set; part C's write-policy.ts words its refusal by it. */
export type MilvusReadOnlySource = "connection" | "seed" | "execution-profile";

export interface MilvusConnectionOptions {
  /** `dns:<host>:<port>` from the validated parts; the local forward under a tunnel. */
  readonly target: string;
  /** The endpoint as configured (the far end under a tunnel), bare host; what sentences name. */
  readonly endpoint: { readonly host: string; readonly port: number };
  readonly tls?: GrpcTlsOptions;
  readonly auth: MilvusAuth;
  /** Sent on every call as `db_name` (5.2, E16). */
  readonly database: string;
  /** E33's engine principal; absent with no credential. */
  readonly principal?: string;
  readonly readOnly?: MilvusReadOnlySource;
  /** The connection's query timeout, which caps every call's deadline (E14). */
  readonly callTimeoutMs: number;
  readonly receiveCapBytes: number;
  /** `secretForms` of everything the credential sends or a server could echo (3.9). */
  readonly secretForms: readonly string[];
}

/** The one port Milvus serves gRPC on, with TLS or without (5.2, R04 F4). */
export const MILVUS_DEFAULT_PORT = 19530;
export const MILVUS_DEFAULT_DATABASE = "default";
/** The fixed override for an IP identity: a name that is not an IP; `.invalid` belongs to no host (RFC 6761). */
export const MILVUS_IP_SERVER_NAME = "milvus.invalid";
/** The channel's receive cap (5.6, M9): four times grpc-js's default and twice the byte budget. */
export const MILVUS_RECEIVE_CAP_BYTES = 16 * 1024 * 1024;

const PROVIDER: DatabaseType = "milvus";

/** What the shared TLS panel reader words its refusals with: Milvus's name, its own errors and E6's client-certificate preflight. */
const WORDS: GrpcConfigWords = { engine: "Milvus", refuse: configError, wrongType, clientCertificateRefusal };

const FORBIDDEN_IN_CREDENTIAL = /[\r\n\0]/;
/** Milvus's user name rule: at most 32 characters, a letter first (R04 F23, `internal/proxy/util.go` near 1256-1296). */
const MILVUS_USER_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/;
/** Collection, alias and database names (5.6, M10). */
const MILVUS_DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
const MAX_QUERY_TIMEOUT_MS = 2_147_483_647;

const USER_NAME_RULE =
  "The Milvus user name must start with a letter, hold only letters, digits, _, . and -, and be at most 32 characters.";
const DATABASE_NAME_RULE =
  "The Milvus database name must start with a letter or _, hold only letters, digits and _, and be at most 255 characters.";
/** The extended key usage OIDs a client certificate may carry: clientAuth, or any usage. */
const CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
const ANY_EXTENDED_KEY_USAGE = "2.5.29.37.0";
const NOT_FOR_CLIENT_AUTH =
  "The client certificate is not issued for client authentication: its extended key usage lacks clientAuth, so Milvus would refuse it. Paste a certificate issued for client use under SSL / TLS.";
const TUNNEL_NOT_OPENED =
  "This connection's SSH tunnel is on, but the connection arrived without its tunnel, so Milvus was not dialled directly: the tunnel opens only when both Host and Port are set.";
const SEED_REFUSED =
  "This read-only seed connection is refused with this credential, because the mode would promise a boundary the server does not keep; nothing was sent.";
const READ_ONLY_NOT_BOOLEAN = "readOnly must be true or false.";
const QUERY_TIMEOUT_RANGE = "Query timeout must be a whole number between 1 and 2147483647 milliseconds.";

/** Throws DatabaseConfigError for every refusal of E1, E4, VF1, E6 and the seed stage; never echoes a value. */
export function buildMilvusConnectionOptions(
  config: DatabaseConnection & WithTunnelFarEnd,
  context: { readonly executionReadOnly: boolean; readonly queryTimeout: number },
): MilvusConnectionOptions {
  const farEnd = tunnelFarEnd(config);
  const targetHost = grpcEndpointHost(config.host, WORDS);
  const targetPort = shared(() => validatePort(config.port ?? MILVUS_DEFAULT_PORT));
  const endpoint =
    farEnd === undefined
      ? { host: targetHost, port: targetPort }
      : { host: grpcEndpointHost(farEnd.host, WORDS), port: shared(() => validatePort(farEnd.port)) };
  const credential = credentials(config);
  const material = readGrpcTlsPanel(config.ssl, WORDS);
  const tls = material === undefined ? undefined : grpcTlsIdentity(material, endpoint.host, MILVUS_IP_SERVER_NAME);
  const plaintext = plaintextSecretRefusal({
    host: endpoint.host,
    tunnelled: farEnd !== undefined,
    tls: tls !== undefined,
    hasSecret: credential.secrets.length > 0,
  });
  if (plaintext !== undefined) throw configError(plaintext);
  const readOnly = readOnlySource(config, context.executionReadOnly);
  if (readOnly === "seed") seedStage(credential.raw);
  return {
    target: grpcTarget(targetHost, targetPort),
    endpoint,
    ...(tls === undefined ? {} : { tls }),
    auth: credential.auth,
    database: databaseName(config.database),
    ...(credential.principal === undefined ? {} : { principal: credential.principal }),
    ...(readOnly === undefined ? {} : { readOnly }),
    callTimeoutMs: callTimeout(context.queryTimeout),
    receiveCapBytes: MILVUS_RECEIVE_CAP_BYTES,
    secretForms: secretForms(credential.secrets),
  };
}

/** The facts errors.ts words its sentences with: the configured endpoint, the TLS identity, the runtime. */
export function milvusErrorConnection(options: MilvusConnectionOptions): MilvusErrorConnection {
  const { tls } = options;
  return {
    host: options.endpoint.host,
    port: options.endpoint.port,
    ...(tls === undefined
      ? {}
      : { tls: { serverName: tls.identity, clientCertificate: tls.clientCertificate !== undefined } }),
    runtimeReportsTlsCause: typeof Bun === "undefined",
    receiveCapBytes: options.receiveCapBytes,
    timeoutMs: options.callTimeoutMs,
  };
}

function tunnelFarEnd(config: DatabaseConnection & WithTunnelFarEnd): TunnelFarEnd | undefined {
  const tunnel = optionalObject<keyof SSHTunnelConfig>(config.sshTunnel, "sshTunnel");
  const enabled = optionalBoolean(tunnel?.enabled, "sshTunnel.enabled") === true;
  const farEnd = config[TUNNEL_FAR_END];
  if (enabled && farEnd === undefined) throw configError(TUNNEL_NOT_OPENED);
  return farEnd;
}

/** The shared validators refuse with a DatabaseConfigError that names no provider; re-raised as Milvus's. */
function shared<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw configError((error as Error).message);
  }
}

interface Credential {
  readonly auth: MilvusAuth;
  readonly principal?: string;
  readonly secrets: readonly string[];
  /** The credential as configured, for the seed stage. */
  readonly raw: { readonly user?: string; readonly password?: string };
}

/**
 * E4 and 5.2: a pair, a token, or nothing. A user with no password is the pair with an empty password, sent as base64
 * of `user:`; it carries no secret, so VF1 does not refuse it and no secret form is computed.
 */
function credentials(config: DatabaseConnection): Credential {
  const user = credential(config.user, "user");
  const password = credential(config.password, "password");
  const raw = { ...(user === undefined ? {} : { user }), ...(password === undefined ? {} : { password }) };
  if (user !== undefined && !MILVUS_USER_NAME.test(user)) throw configError(USER_NAME_RULE);
  if (user !== undefined && password === undefined) {
    return { auth: { kind: "password", user, password: "" }, principal: user, secrets: [], raw };
  }
  if (password === undefined) return { auth: { kind: "none" }, secrets: [], raw };
  if (user !== undefined) {
    return {
      auth: { kind: "password", user, password },
      principal: user,
      secrets: [password, `${user}:${password}`],
      raw,
    };
  }
  const colon = password.indexOf(":");
  return {
    auth: { kind: "token", token: password },
    principal: colon > 0 ? password.slice(0, colon) : "token",
    secrets: colon > 0 ? [password, password.slice(colon + 1)] : [password],
    raw,
  };
}

function credential(value: unknown, field: "user" | "password"): string | undefined {
  const text = optionalText(value, field);
  if (text !== undefined && FORBIDDEN_IN_CREDENTIAL.test(text)) {
    throw configError(`The connection's ${field} holds a line break or a NUL character; remove it. Nothing was sent.`);
  }
  return text;
}

/** 3.12's resolution stage: a read-only seed whose resolved credential the record declares unsafe (E22). */
function seedStage(raw: { readonly user?: string; readonly password?: string }): void {
  const refusal = readOnlySeedRefusal(PROVIDER, raw);
  if (refusal !== undefined) throw configError(`${refusal} ${SEED_REFUSED}`);
}

function databaseName(value: unknown): string {
  const name = optionalText(value, "database") ?? MILVUS_DEFAULT_DATABASE;
  if (!MILVUS_DATABASE_NAME.test(name)) throw configError(DATABASE_NAME_RULE);
  return name;
}

/** The connection's own `readOnly` first (a seed's when it carries `seedId`), then the execution profile's. */
function readOnlySource(config: DatabaseConnection, executionReadOnly: boolean): MilvusReadOnlySource | undefined {
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

/**
 * Why Milvus would refuse this client certificate, or undefined: an extended key usage that exists and lacks
 * clientAuth, or a validity that has ended. A certificate with no extended key usage extension is accepted, as the
 * server accepts it (R42 F6); `keyUsage` is undefined then, whatever the typings say.
 */
export function clientCertificateRefusal(x509: X509Certificate, now: number): string | undefined {
  const usages: readonly string[] | undefined = x509.keyUsage;
  if (usages !== undefined && !usages.includes(CLIENT_AUTH) && !usages.includes(ANY_EXTENDED_KEY_USAGE)) {
    return NOT_FOR_CLIENT_AUTH;
  }
  if (Date.parse(x509.validTo) < now) {
    return `The client certificate expired on ${x509.validTo}, so Milvus would refuse it: paste a current one under SSL / TLS.`;
  }
  return undefined;
}
