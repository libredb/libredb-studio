/**
 * Maps a connection to the one `ClusterEndpoint` every request is built from, after every refusal of the connect
 * rules: the address, the API path, the TLS identity, the token, the TLS material, the namespace list and the default
 * namespace. No socket opens here: every refusal is a DatabaseConfigError raised before any client exists, and none
 * repeats the value it refuses, so a token never reaches a sentence.
 *
 * A connection sent to the API arrives as the caller wrote it, so every field is checked for its type before it is
 * read. Server code: it imports the node transport and the egress policy, so the browser never imports it. The dialog
 * checks only the default namespace and the Namespaces list, with copies of these patterns in `KUBERNETES_FIELD_RULES`
 * that tests/unit/lib/db-ui-config.test.ts holds to this module; the API path, the TLS server name and the token are
 * checked here alone, at Test Connection, and a seed or an API call never passes the dialog.
 *
 * The parameter is named `config` on purpose: tests/unit/lib/db-ui-config.test.ts finds which addressing fields a
 * provider reads by the `config.<field>` pattern.
 */
import { getAppVersion } from "@/lib/app-version";
import { DatabaseConfigError } from "@/lib/db/errors";
import { assertNotLinkLocalLiteral } from "@/lib/db/http/egress-policy";
import { type HttpOrigin, httpOrigin, isLoopbackHost, validateHost, validatePort } from "@/lib/db/http/endpoint";
import { type NodeTlsMaterial, nodeTlsMaterial } from "@/lib/db/http/node-transport";
import { secretForms } from "@/lib/db/utils/server-text";
import {
  type DatabaseConnection,
  type SSHTunnelConfig,
  type SSLConfig,
  TUNNEL_FAR_END,
  type TunnelFarEnd,
  type WithTunnelFarEnd,
} from "@/lib/types";
import {
  KUBERNETES_DEFAULT_PORT,
  KUBERNETES_MAX_IN_FLIGHT,
  KUBERNETES_TREE_OBJECT_CAP,
  KUBERNETES_TYPE,
} from "./limits";

/** Everything a request of this connection is built from, validated. */
export interface ClusterEndpoint {
  /** What is dialled: the validated host and port, the local forward under a tunnel; `https` exactly when TLS is on. */
  readonly origin: HttpOrigin;
  /** The API server as configured (the far end under a tunnel), an IPv6 literal without brackets; what sentences name. */
  readonly endpoint: { readonly host: string; readonly port: number };
  /** The server path prefix, "" for none; never ends in `/`. */
  readonly apiPath: string;
  /** The SSL / TLS panel as the transport takes it, its identity the TLS server name or the endpoint host; null for plain HTTP. */
  readonly tls: NodeTlsMaterial | null;
  /** The headers set once per connection: `authorization` when a token is set, and `user-agent`. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * TLS with neither a token nor a client certificate: the API server reads every request as the anonymous user.
   * False over plain HTTP, where the address is kubectl proxy on this machine, which signs in as the kubectl user.
   */
  readonly anonymous: boolean;
  /** The namespaces the tree lists, when the connection names them; undefined means the provider lists them. */
  readonly namespaces: readonly string[] | undefined;
  /** The session-default namespace: the Default namespace field, else `default`, as kubectl reads no context namespace. */
  readonly defaultNamespace: string;
  /** The provider's in-flight bound, which is the transport's socket bound. */
  readonly maxSockets: number;
  /** The connection's query timeout, which caps every request's deadline. */
  readonly callTimeoutMs: number;
  /** `secretForms` of the token: empty with none. */
  readonly secretForms: readonly string[];
}

export interface ClusterEndpointContext {
  readonly queryTimeout: number;
  /** The build's version for the user-agent; undefined reads `getAppVersion()`, null writes no version. */
  readonly appVersion?: string | null;
}

/** The two operator flags this provider reads, both off unless set to true, on or 1. */
export const KUBERNETES_ALLOW_INSECURE_TLS = "KUBERNETES_ALLOW_INSECURE_TLS";
export const KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT = "KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT";

/** A DNS-1123 label: what a namespace name is. */
export const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
/** One segment of an API path: the characters the final-path rule allows, and no `.` or `..`. */
const API_PATH_SEGMENT = /^[A-Za-z0-9._~:@-]+$/;
/** Segments that would route a request through the server's own API or a proxy subresource. */
const RESERVED_API_PATH_SEGMENTS: readonly string[] = Object.freeze([
  "api",
  "apis",
  "proxy",
  "namespaces",
  "nodes",
  "services",
  "pods",
  "openapi",
  "version",
]);
/** Visible ASCII: what an `authorization` header carries unchanged. */
const VISIBLE_ASCII = /^[\x21-\x7E]+$/;
const MAX_QUERY_TIMEOUT_MS = 2_147_483_647;

/** Every fixed sentence this module throws, so the dialog and the provider doc can be held to the same words. */
export const KUBERNETES_CONNECTION_SENTENCES = Object.freeze({
  userNotTaken:
    "Kubernetes connections take no user name: basic authentication is refused. Clear User, and put a bearer token under Token or a client certificate under SSL / TLS. Nothing was sent.",
  bearerPrefix: 'The Token starts with "Bearer": remove that word, because Studio adds it. Nothing was sent.',
  tokenNotVisible:
    "The Token holds a space, a line break or another character outside visible ASCII; paste the token alone. Nothing was sent.",
  apiPathShape:
    "API path must start with / and name segments of letters, digits, dots, hyphens, underscores, tildes, colons or @, with no //, . or .. segment, %, ? or #, such as /k8s/clusters/c-1. Nothing was sent.",
  apiPathReserved:
    "API path may not hold the segment api, apis, proxy, namespaces, nodes, services, pods, openapi or version: a prefix with one would route requests through the server's own API. Nothing was sent.",
  tlsServerName: "TLS server name must be a host name such as kubernetes.default.svc. Nothing was sent.",
  defaultNamespace:
    "Default namespace must be a DNS-1123 label: at most 63 lower-case letters, digits or hyphens, starting and ending with a letter or digit. Nothing was sent.",
  namespacesShape:
    "Namespaces must list DNS-1123 labels separated by commas or spaces: at most 63 lower-case letters, digits or hyphens each, starting and ending with a letter or digit. Nothing was sent.",
  namespacesRepeat: "Namespaces lists one namespace twice; remove the repeat. Nothing was sent.",
  namespacesTooMany:
    "Namespaces lists more than 1,000 namespaces, the most the tree shows; list fewer. Nothing was sent.",
  defaultOutsideList:
    "The default namespace is not in the Namespaces list: add it to the list, or set Default namespace to a listed one (an empty Default namespace means default). Nothing was sent.",
  plaintextRemote:
    "SSL mode disable sends Kubernetes requests in cleartext, which Studio allows only to this machine, for kubectl proxy. Choose an SSL mode under SSL / TLS. Nothing was sent.",
  plaintextLoopbackOff:
    "Plain HTTP to this machine (kubectl proxy) is off on this server: the operator turns it on with KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT=true, which the npx and desktop launchers set when Studio listens on this machine only. Nothing was sent.",
  insecureTlsOff:
    "SSL mode require, or a certificate check turned off, would send the token to a server whose certificate is not checked, which this server refuses unless the operator sets KUBERNETES_ALLOW_INSECURE_TLS=true. Choose verify-full with the cluster's CA, or verify-system. Nothing was sent.",
  tunnelNotOpened:
    "This connection's SSH tunnel is on, but the connection arrived without its tunnel, so the API server was not dialled directly. Nothing was sent.",
  tunnelLinkLocal:
    "The SSH tunnel's far end is a link-local or instance metadata address, which Studio never reaches. Nothing was sent.",
  queryTimeout: "Query timeout must be a whole number between 1 and 2147483647 milliseconds.",
});

const S = KUBERNETES_CONNECTION_SENTENCES;

/**
 * The API path's refusal sentence, or undefined when it may be used; the dialog has no rule for this field. One
 * trailing `/` is removed, so `/` alone is the empty prefix.
 */
export function apiPathRefusal(value: string): string | undefined {
  if (!value.startsWith("/") || /[%?#]/.test(value)) return S.apiPathShape;
  if (value === "/") return undefined;
  const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
  const segments = trimmed.slice(1).split("/");
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === ".." || !API_PATH_SEGMENT.test(segment))
  )
    return S.apiPathShape;
  if (segments.some((segment) => RESERVED_API_PATH_SEGMENTS.includes(segment.toLowerCase()))) return S.apiPathReserved;
  return undefined;
}

/**
 * The namespace list's entries, or the refusal sentence; the dialog's rule is a pinned copy of this pattern. The
 * count is checked here alone: the tree lists at most 1,000 namespaces, so a longer list is refused, never cut.
 */
export function parseNamespaceList(value: string): readonly string[] | { readonly refusal: string } {
  const entries = value.split(/[\s,]+/).filter((entry) => entry !== "");
  if (entries.some((entry) => !DNS1123_LABEL.test(entry))) return { refusal: S.namespacesShape };
  if (new Set(entries).size !== entries.length) return { refusal: S.namespacesRepeat };
  if (entries.length > KUBERNETES_TREE_OBJECT_CAP) return { refusal: S.namespacesTooMany };
  return entries;
}

/** Reads a flag the way DB_HTTP_BLOCK_PRIVATE_HOSTS is read: off when unset, refused when it is neither on nor off. */
function flag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "false" || value === "off" || value === "0") return false;
  if (value === "true" || value === "on" || value === "1") return true;
  throw configError(`Invalid ${name}: expected true or false.`);
}

/** Throws DatabaseConfigError for every refusal of the connect rules; never echoes a value. */
export function readClusterEndpoint(
  config: DatabaseConnection & WithTunnelFarEnd,
  context: ClusterEndpointContext,
): ClusterEndpoint {
  const farEnd = tunnelFarEnd(config);
  const dialled = shared(() => httpOrigin("http", config.host, config.port ?? KUBERNETES_DEFAULT_PORT));
  const endpoint =
    farEnd === undefined
      ? { host: unbracketed(dialled.host), port: dialled.port }
      : { host: unbracketed(shared(() => validateHost(farEnd.host))), port: shared(() => validatePort(farEnd.port)) };
  if (farEnd !== undefined) {
    try {
      assertNotLinkLocalLiteral(endpoint.host);
    } catch {
      throw configError(S.tunnelLinkLocal);
    }
  }
  if (optionalText(config.user, "user") !== undefined) throw configError(S.userNotTaken);
  const token = tokenOf(config);
  const apiPath = apiPathOf(config);
  const tlsServerName = tlsServerNameOf(config);
  const tls = tlsOf(config, endpoint.host, tlsServerName);
  const defaultNamespace = defaultNamespaceOf(config);
  const namespaces = namespacesOf(config);
  if (namespaces !== undefined && !namespaces.includes(defaultNamespace)) throw configError(S.defaultOutsideList);
  const version = context.appVersion === undefined ? getAppVersion() : context.appVersion;
  return {
    origin: { scheme: tls === null ? "http" : "https", host: dialled.host, port: dialled.port },
    endpoint,
    apiPath,
    tls,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      "user-agent": version === null ? "libredb-studio (kubernetes)" : `libredb-studio/${version} (kubernetes)`,
    },
    anonymous: tls !== null && token === undefined && tls.cert === undefined,
    namespaces,
    defaultNamespace,
    maxSockets: KUBERNETES_MAX_IN_FLIGHT,
    callTimeoutMs: callTimeout(context.queryTimeout),
    secretForms: secretForms(token === undefined ? [] : [token]),
  };
}

function tunnelFarEnd(config: DatabaseConnection & WithTunnelFarEnd): TunnelFarEnd | undefined {
  const tunnel = optionalObject<keyof SSHTunnelConfig>(config.sshTunnel, "sshTunnel");
  const enabled = optionalBoolean(tunnel?.enabled, "sshTunnel.enabled") === true;
  const farEnd = config[TUNNEL_FAR_END];
  if (enabled && farEnd === undefined) throw configError(S.tunnelNotOpened);
  return farEnd;
}

function tokenOf(config: DatabaseConnection): string | undefined {
  const token = optionalText(config.password, "password");
  if (token === undefined) return undefined;
  if (/^bearer\s/i.test(token)) throw configError(S.bearerPrefix);
  if (!VISIBLE_ASCII.test(token)) throw configError(S.tokenNotVisible);
  return token;
}

function apiPathOf(config: DatabaseConnection): string {
  const value = optionalText(config.apiPath, "apiPath");
  if (value === undefined) return "";
  const refusal = apiPathRefusal(value);
  if (refusal !== undefined) throw configError(refusal);
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function tlsServerNameOf(config: DatabaseConnection): string | undefined {
  const value = optionalText(config.tlsServerName, "tlsServerName");
  if (value === undefined) return undefined;
  try {
    return unbracketed(validateHost(value));
  } catch {
    throw configError(S.tlsServerName);
  }
}

/**
 * The TLS material, or null for plain HTTP. An absent panel and the mode `disable` are plain HTTP, which is accepted
 * only to this machine under KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT; a panel that does not verify the certificate is
 * accepted only under KUBERNETES_ALLOW_INSECURE_TLS.
 */
function tlsOf(config: DatabaseConnection, host: string, tlsServerName: string | undefined): NodeTlsMaterial | null {
  const tls = shared(() => nodeTlsMaterial(config.ssl, tlsServerName ?? host));
  if (tls === null) {
    if (!isLoopbackHost(host)) throw configError(S.plaintextRemote);
    if (!flag(KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT)) throw configError(S.plaintextLoopbackOff);
    return null;
  }
  const mode = (config.ssl as SSLConfig).mode;
  if ((!tls.rejectUnauthorized || mode === "require") && !flag(KUBERNETES_ALLOW_INSECURE_TLS))
    throw configError(S.insecureTlsOff);
  return tls;
}

function defaultNamespaceOf(config: DatabaseConnection): string {
  const value = optionalText(config.database, "database");
  if (value === undefined) return "default";
  if (!DNS1123_LABEL.test(value)) throw configError(S.defaultNamespace);
  return value;
}

function namespacesOf(config: DatabaseConnection): readonly string[] | undefined {
  const value = optionalText(config.namespaces, "namespaces");
  if (value === undefined) return undefined;
  const parsed = parseNamespaceList(value);
  if ("refusal" in parsed) throw configError(parsed.refusal);
  return parsed.length === 0 ? undefined : parsed;
}

function callTimeout(queryTimeout: number): number {
  if (!Number.isInteger(queryTimeout) || queryTimeout < 1 || queryTimeout > MAX_QUERY_TIMEOUT_MS)
    throw configError(S.queryTimeout);
  return queryTimeout;
}

function unbracketed(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** The shared validators refuse with a DatabaseConfigError that names no provider; re-raised as this provider's. */
function shared<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw configError((error as Error).message);
  }
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
  return new DatabaseConfigError(message, KUBERNETES_TYPE);
}
