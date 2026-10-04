/**
 * Maps a connection to the options the gRPC adapter opens its one channel with (spec 6.1), after the
 * checks of spec E1, E2 and E5 and the TLS panel check of 6.1. No socket opens here: every refusal is
 * a DatabaseConfigError raised before any client is built, and none repeats the value it refuses.
 *
 * Every field read here is checked before it is used, because a connection sent to the API arrives as
 * the caller wrote it (`resolveConnection` hands an inline connection on untouched): a field that is
 * not the type `DatabaseConnection` declares for it is refused, naming the field. A null reads as
 * absent, as a JSON body writes an absent field, and so does an empty string in a text field, which the
 * dialog writes for a blank User or Password (spec E2). `readOnly` is the one exception: a null there is
 * refused, as every value but a boolean is, the rule `assertReadOnlyHonoured` applies before any
 * provider is built (spec E6).
 *
 * The target is `dns:` and the validated host and port, an IPv6 literal kept in its brackets (spec E1):
 * grpc-js reads the text before the first colon as a resolver name, so without the scheme the host
 * `unix` would dial a Unix socket, and without the brackets `::1:2379` is the address `::1:2379` on
 * port 443. The Kafka provider strips the brackets because its client takes the host and the port
 * apart; this target never loses them.
 *
 * The TLS identity is the tunnel's far end when a tunnel carries the connection, else the host, and it
 * is always set as `grpc.ssl_target_name_override`, because grpc-js otherwise takes the server name
 * from the dial target, which through a tunnel is always 127.0.0.1 (spec E5). An IP identity is
 * overridden with ETCD_IP_SERVER_NAME, because Node 25 and later and Bun refuse an IP as a TLS server
 * name, and `grpcChannelCredentials` (src/lib/db/grpc/credentials.ts) verifies the certificate against
 * the IP itself (reconciliation D0-3).
 *
 * The TLS panel is read by the shared gRPC mapping, `readGrpcTlsPanel` and `grpcTlsIdentity` in
 * src/lib/db/grpc/tls.ts, which docs/BACKLOG.md D37 counts once for every gRPC provider.
 *
 * The parameter is named `config` on purpose: tests/unit/lib/db-ui-config.test.ts finds which
 * addressing fields a provider reads by the `config.<field>` pattern, so this file reads `config.user`
 * as written and never reads a `database` field, since one connection is one cluster (spec 6.1).
 */
import { X509Certificate } from "node:crypto";
import { validatePort } from "@/lib/db/http/endpoint";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  type GrpcConfigWords,
  type GrpcTlsOptions,
  grpcEndpointHost,
  grpcTarget,
  grpcTlsIdentity,
  readGrpcTlsPanel,
} from "@/lib/db/grpc/tls";
import {
  type DatabaseConnection,
  type DatabaseType,
  type SSHTunnelConfig,
  TUNNEL_FAR_END,
  type TunnelFarEnd,
  type WithTunnelFarEnd,
} from "@/lib/types";
import type { EtcdErrorConnection } from "./errors";
import type { ReadOnlySource } from "./write-policy";

export type EtcdAuthMode =
  | { readonly kind: "none" }
  /** A user and a password; with a client certificate too, etcd authenticates the password (spec 6.1). */
  | { readonly kind: "password"; readonly user: string; readonly password: string }
  /** A client certificate and no password: etcd reads its Common Name as the user under RBAC. */
  | { readonly kind: "certificate" };

/** The client port etcd listens on (spec 6.1), for a connection that names no port. */
export const ETCD_DEFAULT_PORT = 2379;

/**
 * The fixed override for an IP identity: a name that is not an IP (spec E5). `.invalid` is reserved
 * (RFC 6761), so the name belongs to no host; R07 measured it, with a server identity check that
 * verifies the IP, connecting under Node 24.14.0, 26.7.0 and 26.10.0 and Bun 1.4.2
 * (`07-MEASUREMENTS-grpc.md`, the iponly log).
 */
export const ETCD_IP_SERVER_NAME = "etcd.invalid";

/**
 * The channel's maximum receive size M (spec 5.4, E14): four times grpc-js 1.14.5's own default of
 * 4 MiB and twice the byte budget B of 8 MiB. A get page whose answer is past M is asked again with
 * half its limit (execute.ts readPage), so only a get page of one key past M, or any other answer past
 * M, fails naming the cap rather than filling the process. Kept by Task 22's measurement on 2026-10-01
 * (KE4: gets of twenty 1 MiB values and of 64 KiB values stopped at B with 7 and 127 rows in 99 and
 * 48 ms).
 */
export const ETCD_RECEIVE_CAP_BYTES = 16 * 1024 * 1024;

export interface EtcdConnectionOptions {
  /** `dns:<host>:<port>` from the validated parts, an IPv6 literal bracketed (spec E1); the local forward under a tunnel. */
  readonly target: string;
  /**
   * The endpoint as configured (the tunnel's far end when there is one): what 5.6's sentences and the
   * endpoint rows name. `host` is validated and bare, an IPv6 address without its brackets, as
   * `EtcdErrorConnection.host` is; a reader that joins it with the port brackets an IPv6 host.
   */
  readonly endpoint: { readonly host: string; readonly port: number };
  readonly tls?: GrpcTlsOptions;
  readonly auth: EtcdAuthMode;
  /** Who etcd sees: the `user`, or the client certificate's subject Common Name read with X509Certificate (spec 4.7). */
  readonly principal?: { readonly name: string; readonly via: "password" | "certificate" };
  /** Where a read-only mode was set, or absent on a read-write provider (spec E6). */
  readonly readOnly?: ReadOnlySource;
  /** The connection's query timeout, the deadline on every call (spec 5.3). */
  readonly callTimeoutMs: number;
  readonly receiveCapBytes: number;
}

const PROVIDER: DatabaseType = "etcd";

/** What the shared TLS panel reader words its refusals with: etcd's name and etcd's own errors. */
const WORDS: GrpcConfigWords = { engine: "etcd", refuse: configError, wrongType };

/** CR, LF and NUL: a pasted credential carries one by mistake, and trimming it would send a different secret (spec E2). */
const FORBIDDEN_IN_CREDENTIAL = /[\r\n\0]/;

/** The largest query timeout, the dialog's own bound (`validateQueryTimeout`): above it Node's timers fire at once. */
const MAX_QUERY_TIMEOUT_MS = 2_147_483_647;

/** Spec E2's sentence, for a user or a password over no TLS. */
const CREDENTIAL_NEEDS_TLS =
  "A User or Password needs TLS on etcd: choose an SSL mode under SSL / TLS, or clear them. A plaintext etcd with password authentication cannot be connected.";
const CREDENTIAL_PAIR =
  "A User and a Password go together on etcd: enter both, or clear both to sign in with the client certificate under SSL / TLS or with no credential.";
const TUNNEL_NOT_OPENED =
  "This connection's SSH tunnel is on, but the connection arrived without its tunnel, so etcd was not dialled directly: the tunnel opens only when both Host and Port are set.";
const READ_ONLY_NOT_BOOLEAN = "readOnly must be true or false.";
const QUERY_TIMEOUT_RANGE = "Query timeout must be a whole number between 1 and 2147483647 milliseconds.";

/** Throws DatabaseConfigError for every refusal of E1, E2 and E5 and the TLS panel check of 6.1; never echoes a value. */
export function buildEtcdConnectionOptions(
  config: DatabaseConnection & WithTunnelFarEnd,
  context: { readonly executionReadOnly: boolean; readonly queryTimeout: number },
): EtcdConnectionOptions {
  const farEnd = tunnelFarEnd(config);
  const targetHost = grpcEndpointHost(config.host, WORDS);
  const targetPort = shared(() => validatePort(config.port ?? ETCD_DEFAULT_PORT));
  const endpoint =
    farEnd === undefined
      ? { host: targetHost, port: targetPort }
      : { host: grpcEndpointHost(farEnd.host, WORDS), port: shared(() => validatePort(farEnd.port)) };
  const material = readGrpcTlsPanel(config.ssl, WORDS);
  const tls = material === undefined ? undefined : grpcTlsIdentity(material, endpoint.host, ETCD_IP_SERVER_NAME);
  const { auth, principal } = credentials(config, tls);
  const readOnly = readOnlySource(config, context.executionReadOnly);
  return {
    target: grpcTarget(targetHost, targetPort),
    endpoint,
    ...(tls === undefined ? {} : { tls }),
    auth,
    ...(principal === undefined ? {} : { principal }),
    ...(readOnly === undefined ? {} : { readOnly }),
    callTimeoutMs: callTimeout(context.queryTimeout),
    receiveCapBytes: ETCD_RECEIVE_CAP_BYTES,
  };
}

/**
 * The facts errors.ts words its sentences with (C9): the configured endpoint, never the tunnel's local
 * forward; the TLS identity the certificate is checked against, the IP itself for an IP identity; the
 * runtime, since under Bun a handshake the server refused carries no cause (spec E5, R07); M and the
 * timeout. A caller whose call runs under a shorter deadline replaces `timeoutMs` with it.
 */
export function etcdErrorConnection(options: EtcdConnectionOptions): EtcdErrorConnection {
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

/**
 * The far end the factory's tunnel reaches, or undefined when no tunnel carries the connection. The
 * factory opens a tunnel only when `sshTunnel.enabled`, `host` and `port` are all set, and otherwise
 * hands the connection on untouched (`withOneShotTunnel`, `getOrCreateProvider` and
 * `acquireExecutionProfileProvider` in src/lib/db/factory.ts), so a tunnel that is on and arrived with
 * no far end would have etcd dialled directly, past the tunnel: refused (spec E3).
 */
function tunnelFarEnd(config: DatabaseConnection & WithTunnelFarEnd): TunnelFarEnd | undefined {
  const tunnel = optionalObject<keyof SSHTunnelConfig>(config.sshTunnel, "sshTunnel");
  const enabled = optionalBoolean(tunnel?.enabled, "sshTunnel.enabled") === true;
  const farEnd = config[TUNNEL_FAR_END];
  if (enabled && farEnd === undefined) throw configError(TUNNEL_NOT_OPENED);
  return farEnd;
}

/** The shared validators refuse with a DatabaseConfigError that names no provider; re-raised as etcd's, the message unchanged. */
function shared<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw configError((error as Error).message);
  }
}

/**
 * The sign-in mode of spec 6.1 and who etcd sees (spec 4.7). A user and a password travel together,
 * and only over TLS (spec E2), because `Authenticate` carries the password and every later call the
 * token; a user or a password alone is refused, since no step of the connect sequence would use it.
 * A configured client certificate is read whenever it is present, and `checkClientPair` has refused
 * one that is not a PEM certificate, in words, rather than the handshake.
 */
function credentials(
  config: DatabaseConnection,
  tls: GrpcTlsOptions | undefined,
): { readonly auth: EtcdAuthMode; readonly principal?: EtcdConnectionOptions["principal"] } {
  const user = credential(config.user, "user");
  const password = credential(config.password, "password");
  if ((user !== undefined || password !== undefined) && tls === undefined) throw configError(CREDENTIAL_NEEDS_TLS);
  if ((user === undefined) !== (password === undefined)) throw configError(CREDENTIAL_PAIR);
  const certificate = tls?.clientCertificate;
  const certificateName = certificate === undefined ? undefined : commonName(certificate.cert);
  if (user !== undefined && password !== undefined) {
    return { auth: { kind: "password", user, password }, principal: { name: user, via: "password" } };
  }
  if (certificate === undefined) return { auth: { kind: "none" } };
  return {
    auth: { kind: "certificate" },
    ...(certificateName === undefined ? {} : { principal: { name: certificateName, via: "certificate" } }),
  };
}

function credential(value: unknown, field: "user" | "password"): string | undefined {
  const text = optionalText(value, field);
  if (text !== undefined && FORBIDDEN_IN_CREDENTIAL.test(text)) {
    throw configError(`The connection's ${field} holds a line break or a NUL character; remove it. Nothing was sent`);
  }
  return text;
}

/**
 * The subject Common Name etcd reads as the user (spec 4.7, 6.1), or undefined when the certificate
 * names none. Read from the legacy object, whose values are the decoded strings: `subject` escapes
 * `,`, `+`, `\`, `<`, `>`, `;` and a leading or trailing space the RFC 2253 way (measured on Node
 * 24.14.0 and 26.10.0 and Bun 1.4.2), so a name holding one would be looked up as another user. A
 * subject with two Common Names reads as its last: etcd's `AuthInfoFromTLS` reads
 * `chains[0].Subject.CommonName` (SRC `etcd__server_auth_store.go`), which Go's `pkix.Name` fills with
 * the last CN attribute it meets.
 */
function commonName(pem: string): string | undefined {
  // checkClientPair has read this certificate, so it reads.
  const names: unknown = new X509Certificate(pem).toLegacyObject().subject.CN;
  const last = Array.isArray(names) ? names[names.length - 1] : names;
  return typeof last === "string" ? last : undefined;
}

/**
 * Where the read-only mode was set (spec E6): the connection's own `readOnly` first, a seed's when it
 * carries the `seedId` filterByRoles sets, then the execution profile's, so when both hold the
 * connection's sentence is the one given.
 */
function readOnlySource(config: DatabaseConnection, executionReadOnly: boolean): ReadOnlySource | undefined {
  const readOnly: unknown = config.readOnly;
  if (readOnly !== undefined && typeof readOnly !== "boolean") throw configError(READ_ONLY_NOT_BOOLEAN);
  if (readOnly === true) {
    const seedId = optionalText(config.seedId, "seedId");
    return seedId === undefined ? "connection" : "seed";
  }
  return executionReadOnly ? "execution-profile" : undefined;
}

/** The deadline on every call (spec 5.3), within the bound the connection dialog already holds a timeout to. */
function callTimeout(queryTimeout: number): number {
  if (!Number.isInteger(queryTimeout) || queryTimeout < 1 || queryTimeout > MAX_QUERY_TIMEOUT_MS) {
    throw configError(QUERY_TIMEOUT_RANGE);
  }
  return queryTimeout;
}

/** A field that holds an object when it is present, never an array; null reads as absent (the file header). */
function optionalObject<Key extends string>(value: unknown, field: string): Partial<Record<Key, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw wrongType(field, "an object");
  return value as Partial<Record<Key, unknown>>;
}

/** A field that holds a string when it is present; null and the empty string read as absent (the file header). */
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw wrongType(field, "a string");
  return value;
}

/** A field that holds a boolean when it is present; null reads as absent (the file header). */
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw wrongType(field, "true or false");
  return value;
}

/** Names the field and what it must be, never the value it holds, which can be a credential. */
function wrongType(field: string, expected: string): DatabaseConfigError {
  return configError(`The connection's ${field} must be ${expected}; nothing was sent`);
}

function configError(message: string): DatabaseConfigError {
  return new DatabaseConfigError(message, PROVIDER);
}
