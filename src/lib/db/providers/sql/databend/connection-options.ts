/**
 * Maps a connection to the options the Databend transport opens with (design 3.2, 3.5, 3.6, 3.12, 3.14, 6.3): the
 * origin dialled and the far end named, the latch key, the TLS material, the headers set once per connection, the
 * closed list of per-request header names, the bounds and the secret forms. No socket opens here: every refusal is a
 * DatabaseConfigError raised before any transport is built, and none repeats the value it refuses. `connect()` is the
 * authority, since a seed or an API call never passes the dialog's checks.
 *
 * Every field read is checked before it is used, because a connection sent to the API arrives as the caller wrote
 * it: a field that is not the type `DatabaseConnection` declares is refused, naming the field. A null reads as
 * absent, as does an empty string, which the dialog writes for a blank box.
 *
 * Authorization is Basic on every request, with an empty password when none is set: Databend answers a request with
 * no Authorization header 401 with 5100 even for a `no_password` user (I10, UC1, UC2). The credential travels in
 * that one header and nowhere else. The user-agent names Studio and never a browser word, which Databend reads as
 * its worksheet mode; the client caps ask for the client session of design 3.4.
 *
 * Through an SSH tunnel the origin dialled is the local forward, while the endpoint a sentence names, the host the
 * plaintext rule judges, the identity a certificate is checked against and the latch key are the tunnel's far end
 * (X03).
 *
 * The parameter is named `config` on purpose: tests/unit/lib/db-ui-config.test.ts finds which addressing fields a
 * provider reads by the `config.<field>` pattern.
 */
import { getAppVersion } from "@/lib/app-version";
import { tunnelRoute } from "@/lib/db/connection-fingerprint";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  type HttpOrigin,
  httpOriginWithCoreDecision,
  plaintextSecretRefusal,
  validateHost,
  validatePort,
} from "@/lib/db/http/endpoint";
import { type NodeTlsMaterial, nodeTlsMaterial } from "@/lib/db/http/node-transport";
import { secretForms } from "@/lib/db/utils/server-text";
import {
  type DatabaseConnection,
  type SSHTunnelConfig,
  TUNNEL_FAR_END,
  type TunnelFarEnd,
  type WithTunnelFarEnd,
} from "@/lib/types";
import { authLatchKey } from "./auth-latch";

export interface DatabendConnectionOptions {
  /** What is dialled: the validated host and port, the local forward under a tunnel; `https` exactly when TLS is on. */
  readonly origin: HttpOrigin;
  /** The endpoint as configured (the far end under a tunnel), an IPv6 literal without brackets; what sentences name. */
  readonly endpoint: { readonly host: string; readonly port: number };
  /** The SSL / TLS panel as the transport takes it; null for plaintext. */
  readonly tls: NodeTlsMaterial | null;
  /** The headers set once per connection (design 3.2). */
  readonly headers: Readonly<Record<string, string>>;
  /** The names a single request may add, the transport's closed `requestHeaderNames`. */
  readonly requestHeaderNames: readonly string[];
  /** The SQL user every request signs in as. */
  readonly user: string;
  /** A password is set; with none, Basic still goes, with an empty password. */
  readonly hasPassword: boolean;
  /** The connection's Database field, or undefined when it is blank. */
  readonly database: string | undefined;
  /**
   * The Warehouse field, or undefined when it is blank, which `headers` sends as `x-databend-warehouse` on every
   * request. A connected session also puts here, for its sentences only, the warehouse an older Databend Cloud host
   * names when the field is blank (`index.ts`); that one is never sent as a header.
   */
  readonly warehouse: string | undefined;
  /** The key of this sign-in in the process latch (design 3.5). */
  readonly latchKey: string;
  /** The transport's socket bound: two statements and a kill. */
  readonly maxSockets: number;
  /** The most bytes one answer may hold. */
  readonly responseCapBytes: number;
  /** The most bytes of answer text one statement may read across its pages. */
  readonly statementBytes: number;
  /** The most cells one result holds. */
  readonly cellBudget: number;
  /** The connection's query timeout, which is a statement's deadline. */
  readonly callTimeoutMs: number;
  /** The deadline of a tree, monitoring or caution read: `min(DATABEND_SURFACE_TIMEOUT_MS, callTimeoutMs)`. */
  readonly surfaceTimeoutMs: number;
  /** The deadline of each kill, final, ROLLBACK and logout, off the statement's signal. */
  readonly closeTimeoutMs: number;
  /** `secretForms` of the password and of `user:password`, the value Basic encodes; empty with no password. */
  readonly secretForms: readonly string[];
}

/**
 * The query node's HTTP handler port. 443 comes from a DSN or an `https://` paste, never from the host: choosing an SSL
 * mode by hand keeps Port at 8000.
 */
export const DATABEND_DEFAULT_PORT = 8000;
/** The limiter over every statement (design 2.3, 3.12): two per provider and two per engine, 64 queued [X04]. */
export const DATABEND_LIMITER_OPTIONS = { perProvider: 2, perEngine: 2, queueDepth: 64 } as const;
/** One socket more than the statements the limiter admits, so a kill always has one [X04]. */
export const DATABEND_MAX_SOCKETS = 3;
/** The transport's cap on one answer, past which the socket is destroyed: the Qdrant and InfluxDB value. */
export const DATABEND_RESPONSE_CAP_BYTES = 16 * 1024 * 1024;
/** The answer text one statement may read across its pages before its result is cut. */
export const DATABEND_STATEMENT_BYTES = 16 * 1024 * 1024;
/** The most cells one result holds before it is cut: the InfluxDB value. */
export const DATABEND_CELL_BUDGET = 250_000;
/** The longest a tree, monitoring or caution read may take, under the query timeout. */
export const DATABEND_SURFACE_TIMEOUT_MS = 10_000;
/** The longest each kill, final, ROLLBACK or logout may take. */
export const DATABEND_CLOSE_TIMEOUT_MS = 5_000;
/** The headers one request may carry beside the connection's: the client session, the query id, and the routing pair. */
export const DATABEND_REQUEST_HEADER_NAMES = Object.freeze([
  "x-databend-session",
  "x-databend-query-id",
  "x-databend-route-hint",
  "x-databend-sticky-node",
] as const);

/** The product word of the user-agent, followed by `/<version>` when the build knows one (I15). */
const USER_AGENT_PRODUCT = "libredb-studio";
/** Asks for the client session, which carries the session in a header (design 3.4). */
const CLIENT_CAPS = "session_header";
/** A header-safe superset of Databend Cloud's warehouse names: letters, digits and hyphens, plus `_` (design 3.6). */
const WAREHOUSE_NAME = /^[A-Za-z0-9_-]{1,63}$/;
/** U+0000 to U+001F, built from the code points so that no control character is written into this file. */
const C0_CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}]`);
const MAX_QUERY_TIMEOUT_MS = 2_147_483_647;

/** Every fixed sentence this module throws, so the provider-doc tests read them back. */
export const DATABEND_CONNECTION_SENTENCES = Object.freeze({
  userRequired:
    "User is required: Databend signs in every request as a SQL user, root on a fresh self-hosted node. Nothing was sent.",
  userColon: "User holds a colon, which Basic authentication cannot carry; check the user name. Nothing was sent.",
  control: (field: "User" | "Password"): string =>
    `${field} holds a control character, which Databend does not accept in a sign-in; re-enter it. Nothing was sent.`,
  malformed: (field: "User" | "Password"): string =>
    `${field} holds a broken character, a lone UTF-16 surrogate, which cannot be sent as UTF-8; re-enter it. Nothing was sent.`,
  warehouse:
    "Warehouse must be 1 to 63 letters, digits, hyphens or underscores, as the warehouse is named in Databend Cloud. Nothing was sent.",
  plaintext:
    "This connection would send its password to Databend without TLS, to a host that is not this machine, where anyone on the path can read it. Choose an SSL mode under SSL / TLS, connect through an SSH tunnel, or tick Send the password without TLS to accept that risk for this connection. Nothing was sent.",
  tunnelNotOpened:
    "This connection's SSH tunnel is on, but the connection arrived without its tunnel, so Databend was not dialled directly: the tunnel opens only when both Host and Port are set.",
  queryTimeout: "Query timeout must be a whole number between 1 and 2147483647 milliseconds.",
  wrongType: (field: string, expected: string): string =>
    `The connection's ${field} must be ${expected}; nothing was sent.`,
});

/** Throws DatabaseConfigError for every refusal of design 6.3; never echoes a value. */
export function buildDatabendConnectionOptions(
  config: DatabaseConnection & WithTunnelFarEnd,
  context: { readonly queryTimeout: number; readonly appVersion?: string | null },
): DatabendConnectionOptions {
  const farEnd = tunnelFarEnd(config);
  // validateHost, validatePort and the egress policy's literal-address guard, on the host that is dialled.
  const dialled = shared(() => httpOriginWithCoreDecision("http", config.host, config.port ?? DATABEND_DEFAULT_PORT));
  const endpoint =
    farEnd === undefined
      ? { host: unbracketed(dialled.host), port: dialled.port }
      : { host: unbracketed(shared(() => validateHost(farEnd.host))), port: shared(() => validatePort(farEnd.port)) };
  const user = userField(config.user);
  const password = optionalText(config.password, "password") ?? "";
  if (C0_CONTROL.test(password)) throw refuse(DATABEND_CONNECTION_SENTENCES.control("Password"));
  if (!password.isWellFormed()) throw refuse(DATABEND_CONNECTION_SENTENCES.malformed("Password"));
  const warehouse = warehouseField(config.warehouse);
  const database = optionalText(config.database, "database");
  const tls = shared(() => nodeTlsMaterial(config.ssl, endpoint.host));
  const plaintext = plaintextSecretRefusal({
    host: endpoint.host,
    tunnelled: farEnd !== undefined,
    tls: tls !== null,
    hasSecret: password !== "",
  });
  // The consent lifts the refusal for this connection only; with a TLS mode on there is nothing to lift.
  if (plaintext !== undefined && config.allowInsecureAuth !== true) {
    throw refuse(DATABEND_CONNECTION_SENTENCES.plaintext);
  }
  const callTimeoutMs = callTimeout(context.queryTimeout);
  const scheme = tls === null ? "http" : "https";
  const version = context.appVersion === undefined ? getAppVersion() : context.appVersion;
  return {
    origin: { scheme, host: dialled.host, port: dialled.port },
    endpoint,
    tls,
    headers: {
      authorization: `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`,
      accept: "application/json",
      "user-agent": version === null ? USER_AGENT_PRODUCT : `${USER_AGENT_PRODUCT}/${version}`,
      "x-databend-client-caps": CLIENT_CAPS,
      ...(warehouse === undefined ? {} : { "x-databend-warehouse": warehouse }),
    },
    requestHeaderNames: DATABEND_REQUEST_HEADER_NAMES,
    user,
    hasPassword: password !== "",
    database,
    warehouse,
    latchKey: authLatchKey({
      scheme,
      host: endpoint.host,
      port: endpoint.port,
      route: tunnelRoute(farEnd === undefined ? undefined : config.sshTunnel),
      user,
      password,
    }),
    maxSockets: DATABEND_MAX_SOCKETS,
    responseCapBytes: DATABEND_RESPONSE_CAP_BYTES,
    statementBytes: DATABEND_STATEMENT_BYTES,
    cellBudget: DATABEND_CELL_BUDGET,
    callTimeoutMs,
    surfaceTimeoutMs: Math.min(DATABEND_SURFACE_TIMEOUT_MS, callTimeoutMs),
    closeTimeoutMs: DATABEND_CLOSE_TIMEOUT_MS,
    // What the error mapping must never repeat: the password and `user:password`, because the Basic header's
    // `base64(user:password)` does not contain `base64(password)`.
    secretForms: password === "" ? [] : secretForms([password, `${user}:${password}`]),
  };
}

/**
 * User is required (design 3.5), and holds neither a colon, which Basic cannot carry, nor a C0 control [05 C5], nor a
 * lone surrogate, which UTF-8 would carry as U+FFFD, another user.
 */
function userField(value: unknown): string {
  const user = optionalText(value, "user");
  if (user === undefined) throw refuse(DATABEND_CONNECTION_SENTENCES.userRequired);
  if (C0_CONTROL.test(user)) throw refuse(DATABEND_CONNECTION_SENTENCES.control("User"));
  if (!user.isWellFormed()) throw refuse(DATABEND_CONNECTION_SENTENCES.malformed("User"));
  if (user.includes(":")) throw refuse(DATABEND_CONNECTION_SENTENCES.userColon);
  return user;
}

function warehouseField(value: unknown): string | undefined {
  const warehouse = optionalText(value, "warehouse");
  if (warehouse !== undefined && !WAREHOUSE_NAME.test(warehouse)) {
    throw refuse(DATABEND_CONNECTION_SENTENCES.warehouse);
  }
  return warehouse;
}

function tunnelFarEnd(config: DatabaseConnection & WithTunnelFarEnd): TunnelFarEnd | undefined {
  const tunnel = optionalObject<keyof SSHTunnelConfig>(config.sshTunnel, "sshTunnel");
  const enabled = optionalBoolean(tunnel?.enabled, "sshTunnel.enabled") === true;
  const farEnd = config[TUNNEL_FAR_END];
  if (enabled && farEnd === undefined) throw refuse(DATABEND_CONNECTION_SENTENCES.tunnelNotOpened);
  return farEnd;
}

function unbracketed(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** The shared validators refuse with a DatabaseConfigError that names no provider; re-raised as Databend's. */
function shared<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw refuse((error as Error).message);
  }
}

function callTimeout(queryTimeout: number): number {
  if (!Number.isInteger(queryTimeout) || queryTimeout < 1 || queryTimeout > MAX_QUERY_TIMEOUT_MS) {
    throw refuse(DATABEND_CONNECTION_SENTENCES.queryTimeout);
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
  return refuse(DATABEND_CONNECTION_SENTENCES.wrongType(field, expected));
}

function refuse(message: string): DatabaseConfigError {
  return new DatabaseConfigError(message, "databend");
}
