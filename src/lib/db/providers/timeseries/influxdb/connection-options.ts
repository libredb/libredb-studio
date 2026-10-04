/**
 * Maps a connection to the options the InfluxDB client opens its transport with (InfluxDB spec 6.2), for both
 * type-ids: the endpoint, the one Authorization header of I6, the TLS mapping, the plaintext rule of I7 with its
 * consent, the database field, the read-only seed stage of R23 and the bounds of 5.5. No socket opens here: every
 * refusal is a DatabaseConfigError raised before any client is built, and none repeats the value it refuses.
 *
 * Every field read is checked before it is used, because a connection sent to the API arrives as the caller wrote
 * it: a field that is not the type `DatabaseConnection` declares is refused, naming the field. A null reads as
 * absent, as does an empty string in a text field, which the dialog writes for a blank box; `readOnly` is the one
 * exception, where a null is refused, as `assertReadOnlyHonoured` does.
 *
 * The credential travels as one `authorization` header, set once per connection, and nowhere else: never in a URL,
 * a query string or a body (E14). `AUTHORIZATION_BY_TYPE` is the whole rule: `influxdb` sends Basic with a user and
 * a password and `Token` with a password alone, which a 1.x server reads as a user's password and a 2.x or 3.x
 * server as a token; `influxdb3` sends `Bearer` and has no user name.
 *
 * Through an SSH tunnel the origin dialled is the local forward, while the endpoint a sentence names, the host the
 * plaintext rule judges and the identity a certificate is checked against are the tunnel's far end.
 *
 * No execution context is read: both types are read-only whatever the connection's flag says, so `readOnly` only
 * selects the seed stage (R23).
 *
 * The parameter is named `config` on purpose: tests/unit/lib/db-ui-config.test.ts finds which addressing fields a
 * provider reads by the `config.<field>` pattern, and this file reads `config.user`, `config.password` and
 * `config.database` as written.
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
  type QueryWarning,
  type SSHTunnelConfig,
  TUNNEL_FAR_END,
  type TunnelFarEnd,
  type WithTunnelFarEnd,
} from "@/lib/types";

/** The two connection types this directory serves. */
export type InfluxType = "influxdb" | "influxdb3";

export interface InfluxConnectionOptions {
  readonly type: InfluxType;
  /** What is dialled: the validated host and port, the local forward under a tunnel; `https` exactly when TLS is on. */
  readonly origin: HttpOrigin;
  /** The endpoint as configured (the far end under a tunnel), an IPv6 literal without brackets; what sentences name. */
  readonly endpoint: { readonly host: string; readonly port: number };
  /** The SSL / TLS panel as the transport takes it; null for plaintext. */
  readonly tls: NodeTlsMaterial | null;
  /** The headers set once per connection: the one `authorization` header, or none. */
  readonly headers: Readonly<Record<string, string>>;
  /** The connection's Database field: 1 to 255 characters with no C0 control, or undefined when it is blank. */
  readonly database: string | undefined;
  /** The provider's in-flight bound, which is the transport's socket bound. */
  readonly maxSockets: number;
  /** The most bytes one response may hold. */
  readonly responseCapBytes: number;
  /** The connection's query timeout, which is a statement's deadline. */
  readonly callTimeoutMs: number;
  /** The deadline of a tree, connect or monitoring read: `min(INFLUX_SURFACE_TIMEOUT_MS, callTimeoutMs)`. */
  readonly surfaceTimeoutMs: number;
  /** A user name is configured, which only `influxdb` accepts. */
  readonly hasUser: boolean;
  /** A password or token is configured. */
  readonly hasSecret: boolean;
  /** R23: true when the connection is a read-only seed (`readOnly: true` with a `seedId`), which ran the seed stage. */
  readonly readOnlySeed: boolean;
  /** `secretForms` of the password and, with a user, of `user:password`, the value Basic encodes; empty with no password. */
  readonly secretForms: readonly string[];
}

/** The HTTP API port of InfluxDB 1.x and 2.x. */
export const INFLUXDB_DEFAULT_PORT = 8086;
/** The HTTP API port of InfluxDB 3. */
export const INFLUXDB3_DEFAULT_PORT = 8181;
/** The calls in flight for one provider, and so the sockets of its one Agent. */
export const INFLUX_MAX_IN_FLIGHT = 2;
/**
 * The limiter of each type-id: one provider's calls, the whole engine's, and the queue behind them (K3, R45).
 * Measured in the image runtime under its heap flag and the chart's 512Mi limit, four runs at the 32 MiB cap fit
 * on the InfluxQL 1.x line and eight do not; the two type-ids' engines add up in one process, so each keeps two.
 */
export const INFLUX_LIMITER_OPTIONS = { perProvider: INFLUX_MAX_IN_FLIGHT, perEngine: 2, queueDepth: 64 } as const;
/** The transport's cap on one response, past which the socket is destroyed (K3). */
export const INFLUX_RESPONSE_CAP_BYTES = 32 * 1024 * 1024;
/** The longest a tree, connect or monitoring read may take, under the query timeout. */
export const INFLUX_SURFACE_TIMEOUT_MS = 10_000;
/** The most rows one result holds before it is cut (K3). Here because both results modules read it. */
export const INFLUX_ROW_CUT = 10_000;
/** The most cells one result holds before it is cut (K3). */
export const INFLUX_CELL_BUDGET = 250_000;

/** The bounds a results module shapes one answer under. Here because both results modules take it (seam rule 2). */
export interface InfluxShapeLimits {
  /** `INFLUX_ROW_CUT`. */
  readonly rowCut: number;
  /** `INFLUX_CELL_BUDGET`: rows times columns. */
  readonly cellBudget: number;
}

/** One shaped answer of either results module. */
export interface ShapedResult {
  readonly fields: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  /** True when the row cut or the cell budget dropped rows; the provider reports it on `pagination.wasLimited`. */
  readonly cut: boolean;
  /**
   * Engine notices only (R26): on `/query` the server's `messages` and the last document's `partial` marker; a jsonl
   * answer carries none.
   */
  readonly warnings: readonly QueryWarning[];
}
/** The most names one tree listing holds. Here because the SQL objects module may not import an InfluxQL one. */
export const INFLUX_LIST_CAP = 2000;

/** The label the dialog gives each field a sentence names. */
type CredentialField = "User" | "Password or token" | "Token";

/** Every fixed sentence this module throws, so the provider-doc tests read them back. */
export const INFLUX_CONNECTION_SENTENCES = Object.freeze({
  plaintext:
    "This connection would send its password or token to InfluxDB without TLS, to a host that is not this machine, where anyone on the path can read it. Choose an SSL mode under SSL / TLS (docs/providers/influxdb.md has a TLS recipe for each version), connect through an SSH tunnel, or tick Send the password without TLS to accept that risk for this connection. Inside a container, localhost is the container itself, not the host. Nothing was sent.",
  userWithoutPassword: "A user without a password sends nothing InfluxDB reads; fill Password or token, or clear User.",
  influxdb3User: "InfluxDB 3 has no user name: clear User and put the token in Token.",
  userColon: "User holds a colon, which Basic authentication cannot carry; check the user name.",
  malformed: (field: CredentialField): string =>
    `${field} holds a character outside printable ASCII, which an HTTP header cannot carry; re-enter it.`,
  databaseControl: "The connection's database holds a control character.",
});

/** Printable ASCII: what an `authorization` header carries unchanged. A line break, a NUL, a tab or a non-ASCII character is refused. */
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
/** U+0000 to U+001F, built from the code points so that no control character is written into this file. */
const C0_CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}]`);
const MAX_DATABASE_LENGTH = 255;
const MAX_QUERY_TIMEOUT_MS = 2_147_483_647;

const TUNNEL_NOT_OPENED =
  "This connection's SSH tunnel is on, but the connection arrived without its tunnel, so InfluxDB was not dialled directly: the tunnel opens only when both Host and Port are set.";
const DATABASE_TOO_LONG = "The connection's database is longer than 255 characters.";
const SEED_REFUSED =
  "This read-only seed connection is refused with this credential, because the mode would promise a boundary the server does not keep; nothing was sent.";
const READ_ONLY_NOT_BOOLEAN = "readOnly must be true or false.";
const QUERY_TIMEOUT_RANGE = "Query timeout must be a whole number between 1 and 2147483647 milliseconds.";

/** The port each type dials when the connection names none. */
const DEFAULT_PORT_BY_TYPE: Readonly<Record<InfluxType, number>> = {
  influxdb: INFLUXDB_DEFAULT_PORT,
  influxdb3: INFLUXDB3_DEFAULT_PORT,
};

/**
 * The Authorization header value each type sends for a credential, or undefined for none (I6). An empty user or
 * password reads as absent. A credential the type cannot send is refused with a DatabaseConfigError naming the
 * field and never the value: a character outside printable ASCII (C13), a Basic user holding a colon, a user with
 * no password on `influxdb`, and any user on `influxdb3`. `Bearer` is never sent on `influxdb`.
 */
export const AUTHORIZATION_BY_TYPE: Readonly<
  Record<InfluxType, (credential: { readonly user?: string; readonly password?: string }) => string | undefined>
> = Object.freeze({
  influxdb: (credential) => {
    const user = headerText(credential.user, "User", "influxdb");
    const password = headerText(credential.password, "Password or token", "influxdb");
    if (user === undefined) return password === undefined ? undefined : `Token ${password}`;
    if (user.includes(":")) throw new DatabaseConfigError(INFLUX_CONNECTION_SENTENCES.userColon, "influxdb");
    if (password === undefined) {
      throw new DatabaseConfigError(INFLUX_CONNECTION_SENTENCES.userWithoutPassword, "influxdb");
    }
    return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
  },
  influxdb3: (credential) => {
    if ((credential.user ?? "") !== "") {
      throw new DatabaseConfigError(INFLUX_CONNECTION_SENTENCES.influxdb3User, "influxdb3");
    }
    const token = headerText(credential.password, "Token", "influxdb3");
    return token === undefined ? undefined : `Bearer ${token}`;
  },
});

/** A credential field as a header carries it: undefined when blank, refused when it holds what a header cannot. */
function headerText(value: string | undefined, field: CredentialField, type: InfluxType): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!PRINTABLE_ASCII.test(value)) throw new DatabaseConfigError(INFLUX_CONNECTION_SENTENCES.malformed(field), type);
  return value;
}

/** Throws DatabaseConfigError for every refusal of spec 6.2, steps 1 to 9; never echoes a value. */
export function buildInfluxConnectionOptions(
  config: DatabaseConnection & WithTunnelFarEnd,
  context: { readonly type: InfluxType; readonly queryTimeout: number },
): InfluxConnectionOptions {
  const { type } = context;
  const farEnd = tunnelFarEnd(config, type);
  // validateHost, validatePort and the egress policy's literal-address guard, on the host that is dialled.
  const dialled = shared(type, () => httpOrigin("http", config.host, config.port ?? DEFAULT_PORT_BY_TYPE[type]));
  const endpoint =
    farEnd === undefined
      ? { host: unbracketed(dialled.host), port: dialled.port }
      : {
          host: unbracketed(shared(type, () => validateHost(farEnd.host))),
          port: shared(type, () => validatePort(farEnd.port)),
        };
  const user = optionalText(config.user, "user", type);
  const password = optionalText(config.password, "password", type);
  const authorization = AUTHORIZATION_BY_TYPE[type]({ user, password });
  const tls = shared(type, () => nodeTlsMaterial(config.ssl, endpoint.host));
  const plaintext = plaintextSecretRefusal({
    host: endpoint.host,
    tunnelled: farEnd !== undefined,
    tls: tls !== null,
    hasSecret: password !== undefined,
  });
  // I7: the consent lifts the refusal for this connection only. With a TLS mode on there is nothing to lift, so the
  // flag is accepted and ignored.
  if (plaintext !== undefined && config.allowInsecureAuth !== true) {
    throw new DatabaseConfigError(INFLUX_CONNECTION_SENTENCES.plaintext, type);
  }
  const database = databaseField(config, type);
  const readOnlySeed = isReadOnlySeed(config, type);
  if (readOnlySeed) seedStage(type, password);
  const callTimeoutMs = callTimeout(context.queryTimeout, type);
  return {
    type,
    origin: { scheme: tls === null ? "http" : "https", host: dialled.host, port: dialled.port },
    endpoint,
    tls,
    headers: authorization === undefined ? {} : { authorization },
    database,
    maxSockets: INFLUX_MAX_IN_FLIGHT,
    responseCapBytes: INFLUX_RESPONSE_CAP_BYTES,
    callTimeoutMs,
    surfaceTimeoutMs: Math.min(INFLUX_SURFACE_TIMEOUT_MS, callTimeoutMs),
    hasUser: user !== undefined,
    hasSecret: password !== undefined,
    readOnlySeed,
    secretForms: secretForms(credentialSecrets(user, password)),
  };
}

/**
 * What the error mapping must never repeat: the password and, with a user, `user:password`, because the Basic
 * header's `base64(user:password)` does not contain `base64(password)` (R28 SR1 F7).
 */
function credentialSecrets(user: string | undefined, password: string | undefined): readonly string[] {
  if (password === undefined) return [];
  return user === undefined ? [password] : [password, `${user}:${password}`];
}

function tunnelFarEnd(config: DatabaseConnection & WithTunnelFarEnd, type: InfluxType): TunnelFarEnd | undefined {
  const tunnel = optionalObject<keyof SSHTunnelConfig>(config.sshTunnel, "sshTunnel", type);
  const enabled = optionalBoolean(tunnel?.enabled, "sshTunnel.enabled", type) === true;
  const farEnd = config[TUNNEL_FAR_END];
  if (enabled && farEnd === undefined) throw new DatabaseConfigError(TUNNEL_NOT_OPENED, type);
  return farEnd;
}

function unbracketed(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** The shared validators refuse with a DatabaseConfigError that names no provider; re-raised as this type's. */
function shared<T>(type: InfluxType, validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw new DatabaseConfigError((error as Error).message, type);
  }
}

/** The Database field as written: optional, 1 to 255 characters, and no C0 control, which no database name holds. */
function databaseField(config: DatabaseConnection, type: InfluxType): string | undefined {
  const database = optionalText(config.database, "database", type);
  if (database === undefined) return undefined;
  if (database.length > MAX_DATABASE_LENGTH) throw new DatabaseConfigError(DATABASE_TOO_LONG, type);
  if (C0_CONTROL.test(database)) throw new DatabaseConfigError(INFLUX_CONNECTION_SENTENCES.databaseControl, type);
  return database;
}

/** R23: `readOnly: true` on a connection that carries a `seedId`. */
function isReadOnlySeed(config: DatabaseConnection, type: InfluxType): boolean {
  const readOnly: unknown = config.readOnly;
  if (readOnly !== undefined && typeof readOnly !== "boolean") {
    throw new DatabaseConfigError(READ_ONLY_NOT_BOOLEAN, type);
  }
  return readOnly === true && optionalText(config.seedId, "seedId", type) !== undefined;
}

/** A read-only seed whose resolved credential the type's record declares unsafe: no secret at all (E12). */
function seedStage(type: InfluxType, password: string | undefined): void {
  const refusal = readOnlySeedRefusal(type, password === undefined ? {} : { password });
  if (refusal !== undefined) throw new DatabaseConfigError(`${refusal} ${SEED_REFUSED}`, type);
}

function callTimeout(queryTimeout: number, type: InfluxType): number {
  if (!Number.isInteger(queryTimeout) || queryTimeout < 1 || queryTimeout > MAX_QUERY_TIMEOUT_MS) {
    throw new DatabaseConfigError(QUERY_TIMEOUT_RANGE, type);
  }
  return queryTimeout;
}

function optionalObject<Key extends string>(
  value: unknown,
  field: string,
  type: InfluxType,
): Partial<Record<Key, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw wrongType(field, "an object", type);
  return value as Partial<Record<Key, unknown>>;
}

function optionalText(value: unknown, field: string, type: InfluxType): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw wrongType(field, "a string", type);
  return value;
}

function optionalBoolean(value: unknown, field: string, type: InfluxType): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw wrongType(field, "true or false", type);
  return value;
}

function wrongType(field: string, expected: string, type: InfluxType): DatabaseConfigError {
  return new DatabaseConfigError(`The connection's ${field} must be ${expected}; nothing was sent.`, type);
}
