/**
 * Maps a connection to the options the S3 provider opens its transport with. No socket opens
 * here: every refusal is a DatabaseConfigError tagged "s3", raised before any transport exists, in the order of the
 * section's table, and none repeats the value it refuses. `connect()` is the authority, since a seed or an API call
 * never passes the dialog's checks.
 *
 * `user` is the access key ID, `password` the secret access key, `region` the signing region and `database` the
 * pinned bucket. A null or an empty string reads as absent; any other string is read as typed, so a
 * Region or Bucket of spaces is refused by its pattern, never trimmed. A field the type declares but this provider
 * does not read is not refused. Plain HTTP is refused for signed and unsigned connections alike,
 * decided by `isLoopbackHost`, never by the shared plaintext-secret refusal, whose sentence speaks of a password.
 *
 * Through an SSH tunnel the origin dialled is the local forward, while the endpoint a sentence names, the identity a
 * certificate is checked against and the host the plaintext rule judges are the tunnel's far end; the far end's
 * literal is refused here when it is link-local, because PR 1's transport sees only the local forward.
 *
 * The parameter is named `config` on purpose: tests/unit/lib/db-ui-config.test.ts finds which addressing fields a
 * provider reads by the `config.<field>` pattern.
 */
import { readOnlySeedRefusal } from "@/lib/db/credential-warnings";
import { DatabaseConfigError } from "@/lib/db/errors";
import { assertNotLinkLocalLiteral } from "@/lib/db/http/egress-policy";
import { type HttpOrigin, httpOrigin, isLoopbackHost, validateHost, validatePort } from "@/lib/db/http/endpoint";
import { type NodeTlsMaterial, nodeTlsMaterial } from "@/lib/db/http/node-transport";
import { secretForms } from "@/lib/db/utils/server-text";
import {
  type DatabaseConnection,
  type SSHTunnelConfig,
  TUNNEL_FAR_END,
  type TunnelFarEnd,
  type WithTunnelFarEnd,
} from "@/lib/types";
import {
  S3_ACCESS_KEY_ID_MAX_CHARS,
  S3_ACCESS_KEY_ID_MIN_CHARS,
  S3_ACCESS_KEY_ID_PATTERN,
  S3_BUCKET_PATTERN,
  S3_DEFAULT_PORT,
  S3_DEFAULT_REGION,
  S3_REGION_PATTERN,
  S3_SURFACE_DEADLINE_MS,
  S3_TYPE,
} from "./constants";

// Defined in constants.ts (browser-safe) and re-exported here, beside the refusals that use them.
export { S3_ACCESS_KEY_ID_PATTERN, S3_BUCKET_PATTERN, S3_REGION_PATTERN } from "./constants";

export type S3ReadOnlySource = "connection" | "seed" | "execution-profile";

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface S3ConnectionOptions {
  /** What is dialled: the local forward under an SSH tunnel; "https" exactly when TLS is on. */
  readonly origin: HttpOrigin;
  /** The endpoint as configured (the far end under a tunnel); what sentences name. IPv6 without brackets. */
  readonly endpoint: { readonly scheme: "http" | "https"; readonly host: string; readonly port: number };
  readonly tunnelled: boolean;
  readonly tls: NodeTlsMaterial | null;
  /** The signing region: the Region field, or S3_DEFAULT_REGION when blank. */
  readonly region: string;
  /** Null: unsigned requests (both keys blank). */
  readonly credentials: S3Credentials | null;
  /** The Bucket field, or undefined when blank. */
  readonly pinnedBucket?: string;
  readonly allowInsecureAuth: boolean;
  readonly readOnly?: S3ReadOnlySource;
  readonly callTimeoutMs: number;
  /** min(callTimeoutMs, S3_SURFACE_DEADLINE_MS) */
  readonly surfaceTimeoutMs: number;
  /** secretForms([secretAccessKey, accessKeyId]) when signed, [] when unsigned. */
  readonly secretForms: readonly string[];
}

const MAX_QUERY_TIMEOUT_MS = 2_147_483_647;

/** Every sentence this module throws, so the provider doc's test reads them back. */
export const S3_CONNECTION_SENTENCES = Object.freeze({
  wrongType: (field: string, expected: string): string =>
    `The connection's ${field} must be ${expected}; nothing was sent.`,
  tunnelNotOpened:
    "This connection's SSH tunnel is on, but the connection arrived without its tunnel, so the S3 server was not dialled directly: the tunnel opens only when both Host and Port are set.",
  keyPair:
    "Access key ID and Secret access key go together: fill in both to sign requests, or clear both to send unsigned requests. Nothing was sent.",
  accessKeyIdCharacters:
    "Access key ID must be printable ASCII without spaces, commas, equals signs or slashes, because it is sent inside the signed Authorization header. Nothing was sent.",
  accessKeyIdLength:
    "Access key ID holds 3 to 512 characters, because S3 servers issue no shorter ID and it is sent inside the signed Authorization header. Nothing was sent.",
  secretMalformed:
    "Secret access key holds a broken character, a lone UTF-16 surrogate, which cannot be used to sign; re-enter it. Nothing was sent.",
  bucket:
    "Bucket must be 1 to 255 letters, digits, dots, hyphens or underscores, starting and ending with a letter or digit. Nothing was sent.",
  region: "Region must be 1 to 64 letters, digits, hyphens or underscores, such as us-east-1. Nothing was sent.",
  plaintext:
    "This connection would reach a host that is not this machine over plain HTTP, where anyone on the path can read bucket and object names, listings and previews, and replay a signed request. Choose an SSL mode under SSL / TLS, connect through an SSH tunnel, or tick Connect without TLS. Nothing was sent.",
  readOnlyNotBoolean: "readOnly must be true or false.",
  seedRefused: (refusal: string): string =>
    `${refusal} This read-only seed connection is refused with this credential, because the mode would promise a boundary the server does not keep; nothing was sent.`,
  queryTimeout: `Query timeout must be a whole number between 1 and ${MAX_QUERY_TIMEOUT_MS} milliseconds.`,
});

/** Throws DatabaseConfigError for every connect-time refusal, in a fixed order; never echoes a value. */
export function buildS3ConnectionOptions(
  config: DatabaseConnection & WithTunnelFarEnd,
  context: { readonly executionReadOnly: boolean; readonly queryTimeout: number },
): S3ConnectionOptions {
  // Row 1: every field this provider reads, by type, before anything else.
  const user = optionalText(config.user, "user");
  const password = optionalText(config.password, "password");
  const pinnedBucket = optionalText(config.database, "database");
  const regionField = optionalText(config.region, "region");
  const allowInsecureAuth = optionalBoolean(config.allowInsecureAuth, "allowInsecureAuth") === true;
  const seedId = optionalText(config.seedId, "seedId");
  const tunnel = optionalObject<keyof SSHTunnelConfig>(config.sshTunnel, "sshTunnel");
  const tunnelEnabled = optionalBoolean(tunnel?.enabled, "sshTunnel.enabled") === true;
  // Row 2.
  const farEnd: TunnelFarEnd | undefined = config[TUNNEL_FAR_END];
  if (tunnelEnabled && farEnd === undefined) throw refuse(S3_CONNECTION_SENTENCES.tunnelNotOpened);
  // Row 3: the dialled host and port, then the far end's.
  const dialled = shared(() => httpOrigin("http", config.host, config.port ?? S3_DEFAULT_PORT));
  const host = farEnd === undefined ? dialled.host : shared(() => validateHost(farEnd.host));
  const port = farEnd === undefined ? dialled.port : shared(() => validatePort(farEnd.port));
  // Row 4: PR 1 refuses the dialled origin when the transport is built; the far end is this module's.
  if (farEnd !== undefined) shared(() => assertNotLinkLocalLiteral(host));
  // Rows 5 to 9.
  if ((user === undefined) !== (password === undefined)) throw refuse(S3_CONNECTION_SENTENCES.keyPair);
  if (user !== undefined && !S3_ACCESS_KEY_ID_PATTERN.test(user))
    throw refuse(S3_CONNECTION_SENTENCES.accessKeyIdCharacters);
  if (user !== undefined && (user.length < S3_ACCESS_KEY_ID_MIN_CHARS || user.length > S3_ACCESS_KEY_ID_MAX_CHARS))
    throw refuse(S3_CONNECTION_SENTENCES.accessKeyIdLength);
  if (password !== undefined && !password.isWellFormed()) throw refuse(S3_CONNECTION_SENTENCES.secretMalformed);
  if (pinnedBucket !== undefined && !S3_BUCKET_PATTERN.test(pinnedBucket)) throw refuse(S3_CONNECTION_SENTENCES.bucket);
  const region = regionField ?? S3_DEFAULT_REGION;
  if (!S3_REGION_PATTERN.test(region)) throw refuse(S3_CONNECTION_SENTENCES.region);
  // Row 10: identity is the far end under a tunnel, never the local forward.
  const tls = shared(() => nodeTlsMaterial(config.ssl, host));
  // Row 11: no TLS, not loopback, not tunnelled, no consent: refused, signed or unsigned alike.
  if (tls === null && farEnd === undefined && !isLoopbackHost(host) && !allowInsecureAuth)
    throw refuse(S3_CONNECTION_SENTENCES.plaintext);
  // Rows 12 and 13.
  const readOnly = readOnlySource(config.readOnly, seedId, context.executionReadOnly);
  if (readOnly === "seed") {
    const refusal = readOnlySeedRefusal(S3_TYPE, {
      ...(user === undefined ? {} : { user }),
      ...(password === undefined ? {} : { password }),
    });
    if (refusal !== undefined) throw refuse(S3_CONNECTION_SENTENCES.seedRefused(refusal));
  }
  // Row 14.
  const callTimeoutMs = callTimeout(context.queryTimeout);
  const scheme = tls === null ? "http" : "https";
  const credentials =
    user !== undefined && password !== undefined ? { accessKeyId: user, secretAccessKey: password } : null;
  return {
    origin: { scheme, host: dialled.host, port: dialled.port },
    endpoint: { scheme, host: unbracketed(host), port },
    tunnelled: farEnd !== undefined,
    tls,
    region,
    credentials,
    ...(pinnedBucket === undefined ? {} : { pinnedBucket }),
    allowInsecureAuth,
    ...(readOnly === undefined ? {} : { readOnly }),
    callTimeoutMs,
    surfaceTimeoutMs: Math.min(callTimeoutMs, S3_SURFACE_DEADLINE_MS),
    // The access key ID is public and still withheld from quoted server text.
    secretForms: credentials === null ? [] : secretForms([credentials.secretAccessKey, credentials.accessKeyId]),
  };
}

/** `${scheme}://${host}:${port}` of the endpoint, with an IPv6 host bracketed: what every sentence names. */
export function s3EndpointText(options: Pick<S3ConnectionOptions, "endpoint">): string {
  const { scheme, host, port } = options.endpoint;
  return `${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function unbracketed(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** The shared validators refuse with a DatabaseConfigError that names no provider; re-raised as S3's, unchanged. */
function shared<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw refuse((error as Error).message);
  }
}

/** The connection's own `readOnly` first (a seed's when it carries `seedId`), then the execution profile's. */
function readOnlySource(
  readOnly: unknown,
  seedId: string | undefined,
  executionReadOnly: boolean,
): S3ReadOnlySource | undefined {
  if (readOnly !== undefined && readOnly !== null && typeof readOnly !== "boolean")
    throw refuse(S3_CONNECTION_SENTENCES.readOnlyNotBoolean);
  if (readOnly === true) return seedId === undefined ? "connection" : "seed";
  return executionReadOnly ? "execution-profile" : undefined;
}

function callTimeout(queryTimeout: number): number {
  if (!Number.isInteger(queryTimeout) || queryTimeout < 1 || queryTimeout > MAX_QUERY_TIMEOUT_MS)
    throw refuse(S3_CONNECTION_SENTENCES.queryTimeout);
  return queryTimeout;
}

function optionalObject<Key extends string>(value: unknown, field: string): Partial<Record<Key, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw refuse(S3_CONNECTION_SENTENCES.wrongType(field, "an object"));
  return value as Partial<Record<Key, unknown>>;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw refuse(S3_CONNECTION_SENTENCES.wrongType(field, "a string"));
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw refuse(S3_CONNECTION_SENTENCES.wrongType(field, "true or false"));
  return value;
}

function refuse(message: string): DatabaseConfigError {
  return new DatabaseConfigError(message, S3_TYPE);
}
