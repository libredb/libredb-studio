/**
 * Maps a connection to its two endpoints, the management API and the optional AMQP port, after every refusal of the
 * connection rules: the address, the credentials, the TLS panel, the plaintext rule, the Path prefix and the fields
 * RabbitMQ does not offer. Nothing here opens a socket, and every refusal is an own error from `errors.ts` that names
 * the field and never repeats the value.
 *
 * A connection sent to the API arrives as the caller wrote it, so every field is checked for its type before it is
 * read. The dialog checks Path prefix and AMQP port with copies of these rules (`RABBITMQ_FIELD_RULES` in
 * src/lib/db-ui-config.ts), which tests/unit/lib/db-ui-config.test.ts holds to this module.
 *
 * The parameter is named `config` on purpose: tests/unit/lib/db-ui-config.test.ts finds which addressing fields a
 * provider reads by the `config.<field>` pattern.
 */
import { type HttpOrigin, httpOrigin, plaintextSecretRefusal } from "@/lib/db/http/endpoint";
import { type NodeTlsMaterial, nodeTlsMaterial } from "@/lib/db/http/node-transport";
import { type DatabaseConnection, type SSHTunnelConfig, TUNNEL_FAR_END, type WithTunnelFarEnd } from "@/lib/types";
import {
  AMQP_PORT_SHAPE,
  configError,
  credentialControl,
  endpointText,
  fieldNotOffered,
  fieldWrongType,
  PASSWORD_REQUIRED,
  PATH_PREFIX_API_SEGMENT,
  PATH_PREFIX_DOT_SEGMENT,
  PATH_PREFIX_NO_SLASH,
  PATH_PREFIX_NOT_PLAIN,
  PLAINTEXT_REFUSAL,
  TUNNEL_REFUSED,
  USER_COLON,
  USER_REQUIRED,
} from "./errors";
import { RABBITMQ_DEFAULT_MANAGEMENT_PORT } from "./limits";

export interface ManagementEndpoint {
  /** From httpOrigin(): host in URL form (IPv6 in brackets), scheme from the SSL mode. */
  readonly origin: HttpOrigin;
  /** "" or a validated prefix such as "/rabbitmq", without a trailing "/". */
  readonly pathPrefix: string;
  /** nodeTlsMaterial(ssl, identity): the host unbracketed and without one trailing dot; null for `disable`. */
  readonly tls: NodeTlsMaterial | null;
  readonly username: string;
  readonly password: string;
  /** "{host}:{port}", IPv6 in brackets. */
  readonly display: string;
}

export interface AmqpEndpoint {
  /** IPv6 literal without brackets. */
  readonly host: string;
  readonly port: number;
  readonly tls: NodeTlsMaterial | null;
  readonly username: string;
  readonly password: string;
  readonly display: string;
}

export interface RabbitMQEndpoints {
  readonly management: ManagementEndpoint;
  /** null when AMQP port is empty: browse only. */
  readonly amqp: AmqpEndpoint | null;
}

/** One path segment: RFC 3986 pchar without `%`, so the prefix is sent exactly as typed. */
const PLAIN_SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:@-]+$/;
/** A port as digits with no leading zero, so the dialog and the provider read one spelling. */
const PORT_DIGITS = /^[1-9][0-9]{0,4}$/;
/** U+0000 to U+001F and DEL, built from the code points so no control character is written into this file. */
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`);

/**
 * The Path prefix rule: empty is no prefix; otherwise it starts with `/`, takes no `%`, `?` or `#` and only plain
 * path characters, has no empty, `.` or `..` segment and no segment `api`, and loses one trailing `/`.
 */
export function readPathPrefix(value: unknown): string {
  const text = optionalText(value, "apiPath");
  if (text === undefined) return "";
  if (!text.startsWith("/")) throw configError(PATH_PREFIX_NO_SLASH);
  if (/[%?#]/.test(text)) throw configError(PATH_PREFIX_NOT_PLAIN);
  if (text === "/") return "";
  const prefix = text.endsWith("/") ? text.slice(0, -1) : text;
  const segments = prefix.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    throw configError(PATH_PREFIX_DOT_SEGMENT);
  if (segments.some((segment) => !PLAIN_SEGMENT.test(segment))) throw configError(PATH_PREFIX_NOT_PLAIN);
  if (segments.includes("api")) throw configError(PATH_PREFIX_API_SEGMENT);
  return prefix;
}

/** The AMQP port rule: undefined or "" is null, otherwise digits 1 to 65535. */
export function readAmqpPort(value: unknown): number | null {
  const text = optionalText(value, "amqpPort");
  if (text === undefined) return null;
  const port = PORT_DIGITS.test(text) ? Number(text) : Number.NaN;
  if (!(port >= 1 && port <= 65_535)) throw configError(AMQP_PORT_SHAPE);
  return port;
}

/** Every refusal of the connection rules before any socket, each an own error from errors.ts. */
export function readConnectionOptions(config: DatabaseConnection): RabbitMQEndpoints {
  refuseTunnel(config as DatabaseConnection & WithTunnelFarEnd);
  if (optionalText(config.database, "database") !== undefined) throw configError(fieldNotOffered("database"));
  if (optionalText(config.namespaces, "namespaces") !== undefined) throw configError(fieldNotOffered("namespaces"));
  if (optionalText(config.tlsServerName, "tlsServerName") !== undefined)
    throw configError(fieldNotOffered("tlsServerName"));
  const username = usernameOf(config);
  const password = passwordOf(config);
  const pathPrefix = readPathPrefix(config.apiPath);
  const amqpPort = readAmqpPort(config.amqpPort);
  // One Host and one TLS setting for both endpoints: the identity is always the host.
  const probe = shared(() => httpOrigin("http", config.host, config.port ?? RABBITMQ_DEFAULT_MANAGEMENT_PORT));
  const host = unbracketed(probe.host);
  // One trailing dot of a DNS name is no part of the TLS identity, and Node 24.14.0, Bun 1.4.2 and Node
  // 26.10.0 all send it in SNI (measured), so it is taken off the identity of both endpoints here; the dialled host
  // and the display keep it. An IP literal never ends in a dot.
  const identity = host.endsWith(".") ? host.slice(0, -1) : host;
  const tls = shared(() => nodeTlsMaterial(config.ssl, identity));
  const allowInsecureAuth = optionalBoolean(config.allowInsecureAuth, "allowInsecureAuth") === true;
  // The two endpoints share the host and the TLS setting and neither is ever tunnelled, so one check answers for
  // both, and the one consent box covers both.
  const plaintext = plaintextSecretRefusal({ host, tunnelled: false, tls: tls !== null, hasSecret: true });
  if (plaintext !== undefined && !allowInsecureAuth) throw configError(PLAINTEXT_REFUSAL);
  const management: ManagementEndpoint = {
    origin: { scheme: tls === null ? "http" : "https", host: probe.host, port: probe.port },
    pathPrefix,
    tls,
    username,
    password,
    display: endpointText(host, probe.port),
  };
  const amqp: AmqpEndpoint | null =
    amqpPort === null ? null : { host, port: amqpPort, tls, username, password, display: endpointText(host, amqpPort) };
  return { management, amqp };
}

/** A tunnelled record is refused: one tunnel carries one port, and the two endpoints use two. */
function refuseTunnel(config: DatabaseConnection & WithTunnelFarEnd): void {
  const tunnel = optionalObject<keyof SSHTunnelConfig>(config.sshTunnel, "sshTunnel");
  const enabled = optionalBoolean(tunnel?.enabled, "sshTunnel.enabled") === true;
  if (enabled || config[TUNNEL_FAR_END] !== undefined) throw configError(TUNNEL_REFUSED);
}

function usernameOf(config: DatabaseConnection): string {
  const user = optionalText(config.user, "user");
  if (user === undefined) throw configError(USER_REQUIRED);
  if (CONTROL.test(user)) throw configError(credentialControl("Username"));
  if (user.includes(":")) throw configError(USER_COLON);
  return user;
}

function passwordOf(config: DatabaseConnection): string {
  const password = optionalText(config.password, "password");
  if (password === undefined) throw configError(PASSWORD_REQUIRED);
  if (CONTROL.test(password)) throw configError(credentialControl("Password"));
  return password;
}

function unbracketed(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** The shared validators refuse with an error that is not this provider's; re-raised as its own, same sentence. */
function shared<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw configError((error as Error).message);
  }
}

function optionalObject<Key extends string>(value: unknown, field: string): Partial<Record<Key, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw configError(fieldWrongType(field, "an object"));
  return value as Partial<Record<Key, unknown>>;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw configError(fieldWrongType(field, "a string"));
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw configError(fieldWrongType(field, "true or false"));
  return value;
}
