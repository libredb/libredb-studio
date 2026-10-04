/**
 * Maps a connection to the options the Oxia adapter opens its channels with (SB1-4), and decides the dial policy over
 * the leaders a shard map names (SB1-5.4). No socket opens here: every field refusal is a DatabaseConfigError raised
 * before any client exists, naming the field and never the value.
 *
 * The target is `dns:` and the validated host and port, the port always written, and the authority Studio sends is
 * exactly the text after `dns:` (C1), so the dial policy compares a leader against the string Studio built, never one
 * it read back. A leader is dialled only when it is byte-equal to that authority or listed under Data servers, so the
 * token goes to no address the connection does not name (C2 to C5).
 *
 * The endpoint host rule and the TLS panel are the shared gRPC transport's (src/lib/db/grpc/tls.ts), with no
 * client-certificate preflight (etcd's choice); `tunnelFarEnd`, `readOnlySource`, `callTimeout` and the optional readers
 * are written again from the Milvus provider's file under the isolation rule.
 *
 * The parameter is named `config` on purpose: tests/unit/lib/db-ui-config.test.ts finds which addressing fields a
 * provider reads by the `config.<field>` pattern.
 */
import { readOnlySeedRefusal } from "@/lib/db/credential-warnings";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  type GrpcConfigWords,
  type GrpcTlsMaterial,
  type GrpcTlsOptions,
  grpcEndpointHost,
  grpcTarget,
  grpcTlsIdentity,
  readGrpcTlsPanel,
} from "@/lib/db/grpc/tls";
import { plaintextSecretRefusal, validateHost, validatePort } from "@/lib/db/http/endpoint";
import { secretForms } from "@/lib/db/utils/server-text";
import {
  type DatabaseConnection,
  type SSHTunnelConfig,
  TUNNEL_FAR_END,
  type TunnelFarEnd,
  type WithTunnelFarEnd,
} from "@/lib/types";
import type { OxiaEndpoint, OxiaLeader } from "./client";
import {
  OXIA_DEFAULT_NAMESPACE,
  OXIA_DEFAULT_PORT,
  OXIA_IP_SERVER_NAME,
  OXIA_LEADER_MAX_BYTES,
  OXIA_MAX_DATA_SERVERS,
  OXIA_NAMESPACE_MAX_BYTES,
  OXIA_RECEIVE_CAP_BYTES,
  OXIA_TYPE,
} from "./constants";
import type { OxiaErrorConnection } from "./errors";
import { hasLoneSurrogate } from "./order";

export type OxiaReadOnlySource = "connection" | "seed" | "execution-profile";

export interface OxiaConnectionOptions {
  /** `dns:<host>:<port>` from validated parts: the local forward under a tunnel (C1). */
  readonly target: string;
  /** Exactly `<host>:<port>` of the target (C1, C2). */
  readonly sentAuthority: string;
  /** The endpoint as configured (the tunnel's far end when tunnelled): what sentences name. */
  readonly endpoint: OxiaEndpoint;
  readonly tunnelled: boolean;
  /** The validated TLS panel; undefined is plaintext. Identity is applied per channel. */
  readonly tlsMaterial?: GrpcTlsMaterial;
  /** The bootstrap channel's TLS options (identity: the far end under a tunnel, else the host). */
  readonly tls?: GrpcTlsOptions;
  readonly namespace: string;
  readonly token?: string;
  readonly allowInsecureAuth: boolean;
  /** Parsed Data servers, canonical `host:port`, at most 64, in typed order, duplicates dropped. */
  readonly dataServers: readonly OxiaEndpoint[];
  readonly readOnly?: OxiaReadOnlySource;
  readonly callTimeoutMs: number;
  readonly receiveCapBytes: number;
  readonly secretForms: readonly string[];
}

/** The facts the dial policy reads. */
type DialPolicyOptions = Pick<
  OxiaConnectionOptions,
  "sentAuthority" | "endpoint" | "tunnelled" | "dataServers" | "token" | "tlsMaterial" | "allowInsecureAuth"
>;

/** The policy's answer for one snapshot: every admitted leader by the server's raw string, and the refusal if any. */
interface AdmittedLeaders {
  readonly admitted: ReadonlyMap<string, OxiaLeader>;
  readonly refusal?: string;
}

/** The one claim of a token's payload Studio reads, locally, for the expired sentence. */
interface TokenPayload {
  readonly exp?: unknown;
}

/** What the shared TLS panel reader words its refusals with: Oxia's name and its own errors. */
const WORDS: GrpcConfigWords = { engine: "Oxia", refuse: configError, wrongType };

/** The characters a bearer token can carry (C7); nothing is trimmed. */
const BEARER_TOKEN = /^[A-Za-z0-9._~+/=-]+$/;
const MAX_QUERY_TIMEOUT_MS = 2_147_483_647;

/** The consent box's label as the dialog draws it (src/components/ConnectionModal.tsx), and what it covers. */
const CONSENT_CLAUSE =
  ' Or tick "Send the password without TLS", which then also covers every address under Data servers.';
const TUNNEL_NOT_OPENED =
  "This connection's SSH tunnel is on, but the connection arrived without its tunnel, so Oxia was not dialled directly: the tunnel opens only when both Host and Port are set.";
const NO_USER = "Oxia has no user name: clear User. A bearer token goes under Token.";
const TOKEN_CHARACTERS =
  "The Token holds a character a bearer token cannot carry: only letters, digits and . _ ~ + / = - are allowed, with no space, tab or line break. Paste the token again; nothing was sent.";
const NAMESPACE_RULE = `The Namespace must be at most ${OXIA_NAMESPACE_MAX_BYTES} bytes of text with no control characters; empty means default. Nothing was sent.`;
const TUNNEL_WITH_DATA_SERVERS =
  "Data servers cannot be used with an SSH tunnel: the tunnel carries one address, and Studio would dial the data servers directly, outside it. Clear Data servers, or turn the tunnel off.";
const DATA_SERVERS_WILDCARD =
  "Data servers entries name exact addresses: a wildcard (*) is not accepted, because it would match any service a tenant can create, and the token would follow.";
const DATA_SERVERS_TRAILING_DOT =
  "Data servers entries must not end the host with a dot: write the name without the final dot.";
const DATA_SERVERS_TOO_MANY = `Data servers holds more than ${OXIA_MAX_DATA_SERVERS} addresses; list only the cluster's data servers.`;
const SEED_REFUSED =
  "This read-only seed connection is refused with this credential, because the mode would promise a boundary the server does not keep; nothing was sent.";
const READ_ONLY_NOT_BOOLEAN = "readOnly must be true or false.";
const QUERY_TIMEOUT_RANGE = `Query timeout must be a whole number between 1 and ${MAX_QUERY_TIMEOUT_MS} milliseconds.`;
const UNPARSED_LEADER = "an address that is not host:port";

/** Throws DatabaseConfigError for every refusal of SB1-4.2, in its order; never echoes a value. */
export function buildOxiaConnectionOptions(
  config: DatabaseConnection & WithTunnelFarEnd,
  context: { readonly executionReadOnly: boolean; readonly queryTimeout: number },
): OxiaConnectionOptions {
  const farEnd = tunnelFarEnd(config);
  const targetHost = grpcEndpointHost(config.host, WORDS);
  const targetPort = shared(() => validatePort(config.port ?? OXIA_DEFAULT_PORT));
  const endpoint: OxiaEndpoint =
    farEnd === undefined
      ? { host: canonicalHost(targetHost), port: targetPort }
      : {
          host: canonicalHost(grpcEndpointHost(farEnd.host, WORDS)),
          port: shared(() => validatePort(farEnd.port)),
        };
  if (optionalText(config.user, "user") !== undefined) throw configError(NO_USER);
  const token = optionalText(config.password, "password");
  if (token !== undefined && !BEARER_TOKEN.test(token)) throw configError(TOKEN_CHARACTERS);
  const namespace = namespaceOf(config.database);
  const tlsMaterial = readGrpcTlsPanel(config.ssl, WORDS);
  const tls =
    tlsMaterial === undefined
      ? undefined
      : grpcTlsIdentity(tlsMaterial, unbracketed(endpoint.host), OXIA_IP_SERVER_NAME);
  const allowInsecureAuth = optionalBoolean(config.allowInsecureAuth, "allowInsecureAuth") === true;
  const dataServers = parseDataServers(optionalText(config.dataServers, "dataServers") ?? "");
  if (farEnd !== undefined && dataServers.length > 0) throw configError(TUNNEL_WITH_DATA_SERVERS);
  const plaintext = plaintextSecretRefusal({
    host: endpoint.host,
    tunnelled: farEnd !== undefined,
    tls: tlsMaterial !== undefined,
    hasSecret: token !== undefined,
    secretLabel: "token",
  });
  if (!allowInsecureAuth && plaintext !== undefined) throw configError(`${plaintext}${CONSENT_CLAUSE}`);
  const readOnly = readOnlySource(config, context.executionReadOnly);
  if (readOnly === "seed") {
    const refusal = readOnlySeedRefusal(OXIA_TYPE, token === undefined ? {} : { password: token });
    if (refusal !== undefined) throw configError(`${refusal} ${SEED_REFUSED}`);
  }
  const callTimeoutMs = callTimeout(context.queryTimeout);
  const target = grpcTarget(targetHost, targetPort);
  return {
    target,
    sentAuthority: target.slice("dns:".length),
    endpoint,
    tunnelled: farEnd !== undefined,
    ...(tlsMaterial === undefined ? {} : { tlsMaterial }),
    ...(tls === undefined ? {} : { tls }),
    namespace,
    ...(token === undefined ? {} : { token }),
    allowInsecureAuth,
    dataServers,
    ...(readOnly === undefined ? {} : { readOnly }),
    callTimeoutMs,
    receiveCapBytes: OXIA_RECEIVE_CAP_BYTES,
    secretForms: secretForms(token === undefined ? [] : [token]),
  };
}

/** Why one `host:port` entry does not parse, or its canonical form. */
type EntryProblem = "shape" | "wildcard" | "trailing-dot";

/**
 * One `host:port` with an explicit port: an IPv6 host in brackets, else the text before the last colon. The host is
 * `validateHost`'s, lower case, an IPv6 address bracketed and RFC 5952 compressed; the port is `validatePort`'s.
 */
function parseEntry(piece: string): OxiaEndpoint | EntryProblem {
  let hostText: string;
  let portText: string;
  if (piece.startsWith("[")) {
    const close = piece.indexOf("]:");
    if (close < 0) return "shape";
    hostText = piece.slice(0, close + 1);
    portText = piece.slice(close + 2);
  } else {
    const colon = piece.lastIndexOf(":");
    // No port, or a colon left in the host: an unbracketed IPv6 address or a URL.
    if (colon < 0 || piece.slice(0, colon).includes(":")) return "shape";
    hostText = piece.slice(0, colon);
    portText = piece.slice(colon + 1);
  }
  // Before validateHost, which would refuse it in the shared words.
  if (hostText.includes("*")) return "wildcard";
  let host: string;
  let port: number;
  try {
    host = validateHost(hostText);
    port = validatePort(portText);
  } catch {
    return "shape";
  }
  if (host.endsWith(".")) return "trailing-dot";
  return { host: canonicalHost(unbracketed(host)), port };
}

/** C4: one Data servers text to canonical entries, or a DatabaseConfigError naming the field and the entry's position. */
export function parseDataServers(text: string): readonly OxiaEndpoint[] {
  const pieces = text.split(/[\s,]+/).filter((piece) => piece !== "");
  const entries = new Map<string, OxiaEndpoint>();
  pieces.forEach((piece, index) => {
    const entry = parseEntry(piece);
    if (entry === "wildcard") throw configError(DATA_SERVERS_WILDCARD);
    if (entry === "trailing-dot") throw configError(DATA_SERVERS_TRAILING_DOT);
    if (entry === "shape") {
      throw configError(
        `Each Data servers entry must be host:port with a port, separated by commas or spaces: the ${ordinal(index + 1)} entry is not.`,
      );
    }
    const address = `${entry.host}:${entry.port}`;
    if (!entries.has(address)) entries.set(address, entry);
  });
  if (entries.size > OXIA_MAX_DATA_SERVERS) throw configError(DATA_SERVERS_TOO_MANY);
  return [...entries.values()];
}

/** C3, C4: a server-sent leader string to its parsed form, or undefined when it is not host:port within 300 bytes. */
export function parseLeaderAddress(raw: string): OxiaEndpoint | undefined {
  if (Buffer.byteLength(raw, "utf8") > OXIA_LEADER_MAX_BYTES) return undefined;
  const entry = parseEntry(raw);
  return typeof entry === "string" ? undefined : entry;
}

/**
 * The leader parser the snapshot check runs (routing.ts takes it as a parameter, decision D1): the sent authority, byte
 * for byte, is its own endpoint (SB1-5.4 rule 1), so a Host with a trailing dot, which no leader parse accepts, still
 * reaches its standalone echo; every other leader is parsed by parseLeaderAddress.
 */
export function oxiaLeaderParser(options: OxiaConnectionOptions): (raw: string) => OxiaEndpoint | undefined {
  const own = authorityLeader(options.sentAuthority);
  return (raw) => (raw === options.sentAuthority ? { host: own.host, port: own.port } : parseLeaderAddress(raw));
}

/**
 * The dial policy for one snapshot (SB1-5.4); pure. A leader byte-equal to the sent authority is the bootstrap; one
 * whose parsed form is listed under Data servers is admitted, then held to the plaintext-token rule; every other is
 * refused, and a refused leader is reported before a plaintext one.
 */
export function admitLeaders(options: DialPolicyOptions, leaders: readonly string[]): AdmittedLeaders {
  const admitted = new Map<string, OxiaLeader>();
  const refused = new Map<string, OxiaEndpoint>();
  let unparsed = false;
  let plaintext: string | undefined;
  const plainToken = options.token !== undefined && options.tlsMaterial === undefined && !options.allowInsecureAuth;
  for (const raw of new Set(leaders)) {
    if (raw === options.sentAuthority) {
      admitted.set(raw, authorityLeader(raw));
      continue;
    }
    const parsed = parseLeaderAddress(raw);
    if (parsed === undefined) {
      unparsed = true;
    } else {
      const address = `${parsed.host}:${parsed.port}`;
      if (options.dataServers.some((entry) => entry.host === parsed.host && entry.port === parsed.port)) {
        admitted.set(raw, { host: parsed.host, port: parsed.port, address, bootstrap: false });
        if (plaintext === undefined && plainToken && !isLoopback(parsed.host)) {
          plaintext = leaderPlaintextTokenRefusal(address);
        }
      } else if (!refused.has(address)) {
        refused.set(address, parsed);
      }
    }
  }
  const refusal = policyRefusal(options, [...refused.values()], unparsed) ?? plaintext;
  return refusal === undefined ? { admitted } : { admitted, refusal };
}

/**
 * The bootstrap leader from the sent authority itself, which is built from validated parts: split at its last colon,
 * not parsed again, because Host accepts a trailing dot that no leader parse does (SB1-5.4 rule 1: byte equality alone).
 */
function authorityLeader(authority: string): OxiaLeader {
  const colon = authority.lastIndexOf(":");
  const host = canonicalHost(unbracketed(authority.slice(0, colon)));
  const port = Number(authority.slice(colon + 1));
  return { host, port, address: `${host}:${port}`, bootstrap: true };
}

/** SB1-5.4's sentences, the first that fits: more than 64, (a), (b), (c); undefined when nothing was refused. */
function policyRefusal(
  options: DialPolicyOptions,
  refused: readonly OxiaEndpoint[],
  unparsed: boolean,
): string | undefined {
  if (refused.length === 0 && !unparsed) return undefined;
  if (refused.length > OXIA_MAX_DATA_SERVERS) {
    return `The cluster sends clients to ${refused.length} data servers this connection does not list, more than the ${OXIA_MAX_DATA_SERVERS} that Data servers can hold, so Studio cannot reach this namespace's shards and nothing was read.`;
  }
  const away = refused.find((leader) => leader.host !== options.endpoint.host);
  // Under a tunnel Studio reaches only the local forward and Data servers cannot be set, so every refused leader is
  // (a), the far end's own host included: (b) and (c) would offer a remedy the builder refuses (ruling R21).
  const unreachable = options.tunnelled ? (away ?? refused[0]) : away;
  const [only] = refused;
  const renamed =
    refused.length === 1 && !unparsed && only.port === options.endpoint.port && only.host !== options.endpoint.host;
  // Without a tunnel a loopback leader on the endpoint's port is this machine under another name, so (b) (ruling R35).
  const loopbackRename = renamed && !options.tunnelled && isLoopback(only.host);
  if (
    !loopbackRename &&
    (isLoopback(options.endpoint.host) || options.tunnelled) &&
    (unreachable !== undefined || unparsed)
  ) {
    const leader = unreachable === undefined ? UNPARSED_LEADER : `${unreachable.host}:${unreachable.port}`;
    return `This connection reaches Oxia through a port-forward or tunnel at ${options.sentAuthority}, but the cluster sends clients to ${leader} for its shards, which this machine cannot be assumed to reach. Run Studio where ${leader} resolves and is reachable; the Oxia provider doc shows the hosts-file and per-pod port-forward workaround.`;
  }
  if (renamed) {
    const leader = `${only.host}:${only.port}`;
    return `This server calls itself ${leader}: type ${only.host} in Host, or add ${leader} to Data servers.`;
  }
  const list = refused.map((leader) => `${leader.host}:${leader.port}`).join(", ");
  const tail = unparsed ? " One shard's leader is an address that is not host:port, which Studio never dials." : "";
  return `The cluster sends clients to data servers this connection does not list: ${list}. Studio dials only the endpoint and the addresses under Data servers, and sends the token to no other. To allow them, list under Data servers these addresses and every other data server of the cluster: ${list}${tail}`;
}

/** The facts errors.ts words its sentences with: the configured endpoint, the TLS identity, the runtime, the token's expiry. */
export function oxiaErrorConnection(options: OxiaConnectionOptions): OxiaErrorConnection {
  const { tls } = options;
  const expiry = options.token === undefined ? undefined : tokenExpiry(options.token);
  return {
    host: options.endpoint.host,
    port: options.endpoint.port,
    sentAuthority: options.sentAuthority,
    loopback: isLoopback(options.endpoint.host),
    tunnelled: options.tunnelled,
    ...(tls === undefined
      ? {}
      : { tls: { serverName: tls.identity, clientCertificate: tls.clientCertificate !== undefined } }),
    runtimeReportsTlsCause: typeof Bun === "undefined",
    receiveCapBytes: options.receiveCapBytes,
    timeoutMs: options.callTimeoutMs,
    namespace: options.namespace,
    ...(expiry === undefined ? {} : { tokenExpiry: expiry }),
    listsDataServers: options.dataServers.length > 0,
  };
}

/** SB1-4.5: the refusal of a token that would reach a listed data server without TLS; it names no tunnel. */
export function leaderPlaintextTokenRefusal(address: string): string {
  return `This connection would send its token without TLS to the data server ${address}, where anyone on the path can read it. Choose an SSL mode under SSL / TLS, or, if authentication is off on this server, clear the token.${CONSENT_CLAUSE}`;
}

/** The configured endpoint as `host:port`: the far end under a tunnel, lower case, IPv6 bracketed and compressed. */
export function oxiaEndpointText(options: OxiaConnectionOptions): string {
  return `${options.endpoint.host}:${options.endpoint.port}`;
}

/** The token's own `exp` claim as ISO 8601, read from its payload; absent when it is not a JWT with a whole `exp`. */
function tokenExpiry(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as TokenPayload;
    return Number.isSafeInteger(payload.exp) ? new Date((payload.exp as number) * 1000).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a host is this machine, by the exported plaintext rule itself (`isLoopbackHost` is not exported). */
function isLoopback(host: string): boolean {
  return plaintextSecretRefusal({ host, tunnelled: false, tls: false, hasSecret: true }) === undefined;
}

/** A bare host as an endpoint host: an IPv6 address bracketed and RFC 5952 compressed by the WHATWG serializer. */
function canonicalHost(bare: string): string {
  return bare.includes(":") ? new URL(`http://[${bare}]`).hostname : bare;
}

/** A host without the brackets an IPv6 literal is written in; any other host unchanged (decision D6). */
function unbracketed(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 101st. */
function ordinal(position: number): string {
  const lastTwo = position % 100;
  const last = position % 10;
  const suffix = lastTwo >= 11 && lastTwo <= 13 ? "th" : (["th", "st", "nd", "rd"][last] ?? "th");
  return `${position}${suffix}`;
}

/** SB1-4.3: empty is `default`; anything else exactly as typed, at most 300 bytes, no control character or lone surrogate. */
function namespaceOf(value: unknown): string {
  const namespace = optionalText(value, "database") ?? OXIA_DEFAULT_NAMESPACE;
  const control = Array.from(namespace).some((char) => char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f);
  if (Buffer.byteLength(namespace, "utf8") > OXIA_NAMESPACE_MAX_BYTES || control || hasLoneSurrogate(namespace)) {
    throw configError(NAMESPACE_RULE);
  }
  return namespace;
}

function tunnelFarEnd(config: DatabaseConnection & WithTunnelFarEnd): TunnelFarEnd | undefined {
  const tunnel = optionalObject<keyof SSHTunnelConfig>(config.sshTunnel, "sshTunnel");
  const enabled = optionalBoolean(tunnel?.enabled, "sshTunnel.enabled") === true;
  const farEnd = config[TUNNEL_FAR_END];
  if (enabled && farEnd === undefined) throw configError(TUNNEL_NOT_OPENED);
  return farEnd;
}

/** The shared validators refuse with a DatabaseConfigError that names no provider; re-raised as Oxia's. */
function shared<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw configError((error as Error).message);
  }
}

/** The connection's own `readOnly` first (a seed's when it carries `seedId`), then the execution profile's. */
function readOnlySource(config: DatabaseConnection, executionReadOnly: boolean): OxiaReadOnlySource | undefined {
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
  return new DatabaseConfigError(message, OXIA_TYPE);
}
