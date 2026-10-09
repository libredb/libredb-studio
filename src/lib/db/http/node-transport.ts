/**
 * The shared REST transport for driver-free providers (vector-family design 3.7; docs/BACKLOG.md D37)
 *
 * A provider hands it a validated origin, the TLS material of its SSL / TLS panel, its in-flight bound and the headers
 * its connection sends, and gets back `request` and `close`. Nothing here knows about an engine, and no provider is
 * imported. Server-only: it imports Node built-ins, so nothing browser-side may import it.
 *
 * - One `node:http` or `node:https` Agent per connection, `keepAlive: true`, at most `maxSockets` sockets, an idle
 *   socket closed after IDLE_SOCKET_MS so a server's keep-alive timeout never closes one under a request, destroyed by
 *   close(). Never the global agent, which routes through a proxy variable (HTTP_PROXY under NODE_USE_ENV_PROXY=1 on
 *   Node, and under Bun), and never `globalThis.fetch`, so no proxy variable can carry a request or its credential.
 * - With DB_HTTP_BLOCK_PRIVATE_HOSTS on, the guard's literal check runs when the transport is built, before any socket,
 *   because an IP literal never reaches a lookup, and the guard's lookup goes on this connection's own Agent in place of
 *   the `agent: false` of guardedNodeOptions. The Agent never carries an unguarded request, so every socket it pools was
 *   opened through the guarded lookup, and a pooled socket costs one lookup rather than one per request.
 * - No redirect is followed: every 3xx goes to the shared rejectRedirect, and its body is released unread.
 * - Every request asks for `accept-encoding: identity`, and nothing is decompressed: an answer with any other
 *   content-encoding is refused before its body is read, so the byte cap always counts the bytes that are parsed.
 * - The body is counted as it streams, and the socket is destroyed the moment it passes `maxResponseBytes`.
 * - A deadline or a cancel destroys the socket; the signal's reason tells the two apart.
 * - Nothing is retried: an answer that never arrived is reported as lost, and the request is never sent again.
 * - No message carries a header, the key, a URL query string or a body: a failure names its kind, a runtime code, an
 *   origin or a number.
 *
 * `nodeTlsMaterial` is the TLS mapping D37 counts, shared here so that a new REST provider takes it instead of
 * writing another copy.
 *
 * A measured limit, not worked around: the first request on a new keep-alive TLS socket costs about 40 ms more than on
 * a socket that is closed after one request, with no cause found.
 */
import {
  Agent as HttpAgent,
  type AgentOptions,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
  request as httpRequest,
} from "node:http";
import { Agent as HttpsAgent, type AgentOptions as HttpsAgentOptions, request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { urlToHttpOptions } from "node:url";
import { ConnectionError, DatabaseConfigError } from "@/lib/db/errors";
import { guardedNodeOptions } from "@/lib/db/http/egress-policy";
import { endpointUrl, type HttpOrigin, originHost, rejectRedirect } from "@/lib/db/http/endpoint";
import type { SSLConfig, SSLMode } from "@/lib/types";

/** The SSL / TLS panel as node:https takes it. */
export interface NodeTlsMaterial {
  readonly rejectUnauthorized: boolean;
  readonly ca?: Buffer;
  readonly cert?: Buffer;
  readonly key?: Buffer;
  /** The connection's host, or TUNNEL_FAR_END's host through an SSH tunnel; an IPv6 literal without its brackets. */
  readonly identity: string;
}

export interface NodeTransportOptions {
  /** From httpOrigin(): host and port already validated. */
  readonly origin: HttpOrigin;
  /** null for plaintext. */
  readonly tls: NodeTlsMaterial | null;
  /** The provider's in-flight bound. */
  readonly maxSockets: number;
  /** Set once per connection, the credential header among them. */
  readonly headers: Readonly<Record<string, string>>;
  /** How long a pooled socket may sit idle before the transport closes it; IDLE_SOCKET_MS when absent. */
  readonly idleSocketMs?: number;
  /**
   * The lower-case names a request may carry in `NodeRequest.headers`, a closed list; none when absent. A name the
   * transport or the connection sets is refused when the transport is built.
   */
  readonly requestHeaderNames?: readonly string[];
}

export interface NodeRequest {
  readonly method: "GET" | "POST";
  /** From endpointUrl(); a URL whose origin is not the connection's is refused. */
  readonly url: string;
  /** UTF-8 JSON text, already serialised. */
  readonly body?: string;
  /**
   * Form fields, serialised by the transport with URLSearchParams and sent under
   * `content-type: application/x-www-form-urlencoded` with its byte length; a request with both `body` and `form` is
   * refused before any socket, never sent with one of them dropped.
   */
  readonly form?: Readonly<Record<string, string>>;
  /**
   * Headers of this request alone, each named in the transport's `requestHeaderNames` in the same spelling, each value
   * visible ASCII or space and at most 1024 bytes; anything else is refused before any socket. Never kept for the next.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Carries the caller's cancel and the deadline. */
  readonly signal: AbortSignal;
  readonly maxResponseBytes: number;
}

export interface NodeResponse {
  readonly status: number;
  readonly contentType: string | null;
  /** The Retry-After header as received, cut to 64 characters; null when absent. */
  readonly retryAfter: string | null;
  readonly text: string;
}

/** One response header as received: the name lower-cased by the transport, the value as the runtime decoded it (latin1). */
export type ResponseHeader = readonly [name: string, value: string];

/** A request that did not complete. Its message never carries a header, the key, a URL query string or a body. */
export class TransportError extends ConnectionError {
  /** True only with kind "network": the response callback had run and the body had not ended when the request failed. */
  readonly truncated: boolean;
  /** On kind "redirect" from a byte transport: the refused status and the selected headers. Undefined everywhere else. */
  readonly redirect?: {
    readonly status: number;
    readonly headers: readonly ResponseHeader[];
    readonly headersTruncated: boolean;
  };

  constructor(
    readonly kind: "timeout" | "aborted" | "too-large" | "redirect" | "encoding" | "tls" | "network",
    message: string,
    options?: {
      readonly truncated?: boolean;
      readonly redirect?: {
        readonly status: number;
        readonly headers: readonly ResponseHeader[];
        readonly headersTruncated: boolean;
      };
    },
  ) {
    super(message);
    this.truncated = options?.truncated ?? false;
    this.redirect = options?.redirect;
    this.name = "TransportError";
    Object.setPrototypeOf(this, TransportError.prototype);
  }
}

export interface NodeTransport {
  request(request: NodeRequest): Promise<NodeResponse>;
  close(): void;
}

/** Which response headers a byte transport hands back; checked once when the transport is built. */
export interface ResponseHeaderSelection {
  /** Exact lower-case names, at most 32. */
  readonly names: readonly string[];
  /** Lower-case name prefixes such as "x-amz-meta-", at most 8, each at least 3 characters and ending in "-". */
  readonly prefixes?: readonly string[];
}

/**
 * What the signer is given: the method, Host, target and every header the transport sets, before the signer's own.
 * The runtime also appends `Connection: keep-alive` after these, which is not in `headers` and must not be signed.
 */
export interface SigningInput {
  readonly method: "GET" | "HEAD";
  /** The Host header value the transport sends, from originHost(origin). */
  readonly host: string;
  /** The request-target path, byte for byte as sent; for SigV4 it is the canonical URI unchanged. */
  readonly path: string;
  /**
   * The query without "?", byte for byte as sent, in the caller's order; "" when there is none.
   * It is NOT a SigV4 canonical query: that is the same encoded pairs sorted by encoded name, which the signer builds.
   * The transport never reorders a query.
   */
  readonly query: string;
  /**
   * Every header the transport sets, except the signer's: connection headers, per-request headers, `host` and
   * `accept-encoding`, with lower-case names. A frozen copy: a signer cannot add to what is sent through it.
   */
  readonly headers: Readonly<Record<string, string>>;
}

export interface RequestSigner {
  /** The lower-case names `sign` may return, a closed list; "authorization" is the one owned name it may hold. */
  readonly headerNames: readonly string[];
  /** Called once per request, synchronously, when a socket is free and just before the request is written. */
  sign(input: SigningInput): Readonly<Record<string, string>>;
}

export interface NodeByteTransportOptions extends NodeTransportOptions {
  /** Absent: no response header is returned and `headers` is []. */
  readonly responseHeaders?: ResponseHeaderSelection;
  /** Absent: the request is sent unsigned, with no credential the connection headers do not carry. */
  readonly signer?: RequestSigner;
}

export interface RequestTarget {
  /** Absolute; only A-Z a-z 0-9 - . _ ~ / and upper-case %XX escapes; never starting with "//". */
  readonly path: string;
  /** name=value pairs of the same characters (no "/"), joined by "&"; "" for none. */
  readonly query: string;
}

export interface NodeByteRequest {
  readonly method: "GET" | "HEAD";
  readonly target: RequestTarget;
  /** As NodeRequest.headers: names from requestHeaderNames only, values visible ASCII or space, at most 1024 bytes. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly maxResponseBytes: number;
  /** Keep at most this many body bytes and report the cut instead of failing; at most maxResponseBytes. */
  readonly truncateAt?: number;
}

export interface NodeByteResponse {
  readonly status: number;
  /** The content-type header read as the text path reads it (answer.headers, so the first of repeated values), cut to 1024 characters; null when absent. */
  readonly contentType: string | null;
  /** The content-encoding header read the same way, cut to 64 characters; null when absent. The body is never decoded. */
  readonly contentEncoding: string | null;
  /** The Retry-After header through the text path's retryAfterOf, cut to 64 characters; null when absent. */
  readonly retryAfter: string | null;
  /** The selected headers in received order, duplicates kept. */
  readonly headers: readonly ResponseHeader[];
  /** True when a header was dropped or a value cut by the limits of the response-header selection. */
  readonly headersTruncated: boolean;
  readonly bytes: Buffer;
  /** True only when truncateAt stopped the body; a server that ends early is still TransportError "network" with truncated. */
  readonly truncated: boolean;
}

export interface NodeByteTransport {
  request(request: NodeByteRequest): Promise<NodeByteResponse>;
  close(): void;
}

/**
 * The default `rejectUnauthorized` of each SSL mode, null for plaintext: the repository's one rule,
 * rejectUnauthorized = ssl.rejectUnauthorized ?? ssl.mode !== "require". `require` encrypts without checking, because a
 * self-hosted server ordinarily presents a self-signed certificate; `verify-ca` and `verify-full` come out the same,
 * because Node checks the identity whenever it verifies (SSLMode in src/lib/types.ts says the same).
 */
const VERIFY_BY_MODE: Readonly<Record<SSLMode, boolean | null>> = Object.freeze({
  disable: null,
  require: false,
  "verify-system": true,
  "verify-ca": true,
  "verify-full": true,
});

const INVALID_SSL = "Invalid ssl: expected an object";
const INVALID_SSL_MODE = "Invalid ssl.mode: expected disable, require, verify-system, verify-ca or verify-full";
const INVALID_REJECT_UNAUTHORIZED = "Invalid ssl.rejectUnauthorized: expected true or false";
const CLIENT_PAIR = "Invalid ssl.clientCert and ssl.clientKey: give both or neither";

/** A PEM field as bytes; an empty or absent field is left out, because a cleared form field is not a certificate. */
function pem(value: unknown, field: string): Buffer | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new DatabaseConfigError(`Invalid ${field}: expected PEM text`);
  return Buffer.from(value, "utf8");
}

/** A host without the brackets an IPv6 literal is written in; any other host unchanged. */
function unbracketed(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * The connection's SSL / TLS panel as node:https takes it, or null for plaintext: an absent or null panel, or the mode
 * `disable`. A panel with no mode verifies, as every provider with this rule reads it, since a seed file's panel may
 * omit the mode (src/lib/seed/types.ts). The panel arrives as the caller wrote it, so a field of the wrong kind is
 * refused by name, never read as plaintext or as "do not verify", and never repeated.
 *
 * `identity` is the connection's host, or the tunnel's far end when an SSH tunnel carries the connection, so the
 * certificate is checked against the server Studio means and never against the local forward.
 */
export function nodeTlsMaterial(ssl: SSLConfig | null | undefined, identity: string): NodeTlsMaterial | null {
  if (ssl === null || ssl === undefined) return null;
  // `false` or "disable" for the whole panel is not a panel: refused, never read as one with no mode, which verifies.
  if (typeof ssl !== "object" || Array.isArray(ssl)) throw new DatabaseConfigError(INVALID_SSL);
  const panel = ssl as { readonly [field in keyof SSLConfig]?: unknown };
  const mode = panel.mode ?? "verify-full";
  if (typeof mode !== "string" || !Object.hasOwn(VERIFY_BY_MODE, mode)) throw new DatabaseConfigError(INVALID_SSL_MODE);
  const verify = VERIFY_BY_MODE[mode as SSLMode];
  if (verify === null) return null;
  const rejectUnauthorized = panel.rejectUnauthorized ?? verify;
  if (typeof rejectUnauthorized !== "boolean") throw new DatabaseConfigError(INVALID_REJECT_UNAUTHORIZED);
  const ca = pem(panel.caCert, "ssl.caCert");
  const cert = pem(panel.clientCert, "ssl.clientCert");
  const key = pem(panel.clientKey, "ssl.clientKey");
  if ((cert === undefined) !== (key === undefined)) throw new DatabaseConfigError(CLIENT_PAIR);
  return {
    rejectUnauthorized,
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    identity: unbracketed(identity),
  };
}

/** The longest Retry-After value kept: an HTTP date is 29 characters, and a longer value is no wait a client can read. */
const MAX_RETRY_AFTER_LENGTH = 64;

/**
 * How long a pooled socket may sit idle before this side closes it (#1419): below the keep-alive of the servers this
 * transport talks to, so the client, never the server, ends an idle socket. Qdrant 1.19.1 (actix-web) closes an idle
 * keep-alive connection after 5 s (measured 4.8 s after its answer), and a request written on a pooled socket as the
 * server closed it failed with
 * ECONNRESET: measured on 2026-10-03/04, 1 of 16 requests separated by 4.93 s pauses, none with 1 s pauses. Node and Bun
 * both apply the Agent's `timeout` to a free socket only; a request in flight longer than this is not cut by it.
 */
export const IDLE_SOCKET_MS = 4000;

const FOREIGN_URL = "Invalid host: the request URL would not address the configured host, so it was not sent";
const INVALID_MAX_SOCKETS = "Invalid maxSockets: expected a positive integer";
const INVALID_MAX_RESPONSE_BYTES = "Invalid maxResponseBytes: expected a positive integer";
const SCHEME_MISMATCH = "Invalid TLS settings: an https origin needs TLS material, and an http origin takes none";
const CLOSED = "The connection was closed, so the request did not complete";
const NETWORK_FAILURE = "The request failed before a complete response arrived";
const TRUNCATED = "The server ended the response before it was complete";
const BODY_AND_FORM = "Invalid request: give a body or form fields, not both";
const INVALID_HEADER_NAMES = "Invalid requestHeaderNames: expected lower-case header names";
const UNLISTED_HEADER = "Invalid request headers: a header this transport does not list was given";
const NOT_A_RECORD = "Invalid request headers: expected a plain record of header names and values";
const INVALID_METHOD = "Invalid method: this transport sends GET and HEAD only";
const INVALID_TRUNCATE_AT = "Invalid truncateAt: expected a positive integer no greater than maxResponseBytes";
const INVALID_TARGET = "Invalid request target: expected a path and a query";
const INVALID_TARGET_PATH =
  "Invalid request path: expected an absolute path of unreserved characters, slashes and upper-case percent escapes";
const INVALID_TARGET_QUERY =
  "Invalid request query: expected name=value pairs of unreserved characters and upper-case percent escapes, joined by &";
const TARGET_TOO_LONG = "Invalid request target: the path and query exceed 16384 bytes";

/**
 * The byte request target grammar (byte transport design 3.4): exactly the output alphabet of rfc3986Path and
 * rfc3986Query, which is SigV4's UriEncode alphabet with upper-case hex. ASCII 0x21 to 0x7E only, so node:http's
 * latin1 rewrite and its unescaped-character refusal are never reached.
 */
const TARGET_PATH = /^\/(?!\/)(?:[A-Za-z0-9._~/-]|%[0-9A-F]{2})*$/;
const TARGET_QUERY_CHARACTER = "(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})";
const TARGET_QUERY = new RegExp(
  `^(?:${TARGET_QUERY_CHARACTER}+=${TARGET_QUERY_CHARACTER}*(?:&${TARGET_QUERY_CHARACTER}+=${TARGET_QUERY_CHARACTER}*)*)?$`,
);
/** A fully escaped 1,024-byte key or prefix plus a long continuation token fits; MinIO caps a path at 32 KiB. */
const MAX_TARGET_LENGTH = 16384;
const MAX_CONTENT_TYPE_LENGTH = 1024;
const MAX_CONTENT_ENCODING_LENGTH = 64;
const INVALID_RESPONSE_HEADERS =
  "Invalid responseHeaders: expected at most 32 lower-case names and 8 lower-case prefixes ending in a hyphen";
const NEVER_RETURNED_LISTED = "Invalid responseHeaders: location and set-cookie are never returned";
/**
 * Never handed back, even through a prefix: a Location path or query can carry a token and its userinfo a password,
 * which is why the redirect refusal names only its origin, and Set-Cookie is session material no caller needs.
 */
const NEVER_RETURNED: ReadonlySet<string> = new Set(["location", "set-cookie"]);
const MAX_SELECTED_NAMES = 32;
const MAX_SELECTED_PREFIXES = 8;
const MIN_SELECTED_PREFIX_LENGTH = 3;
/** The caps on what is returned, applied whatever header limit the runtime has (byte transport design 3.5). */
const MAX_RETURNED_HEADERS = 64;
const MAX_RETURNED_VALUE_LENGTH = 1024;
const MAX_RETURNED_TOTAL_LENGTH = 16384;

/** A runtime error code named in a failure; any other value is left out of the message. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The names both runtimes give OpenSSL's certificate verification results, X509_V_ERR_* without the prefix, the list
 * the Prometheus transport measured on Node and on Bun 1.4.2. Written again here because a shared module imports no
 * provider; D37 names this file as the copy later providers take.
 */
const CERTIFICATE_VERIFICATION_CODES: ReadonlySet<string> = new Set([
  "CERT_CHAIN_TOO_LONG",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REJECTED",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "CRL_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_SIGNATURE_FAILURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "HOSTNAME_MISMATCH",
  "INVALID_CA",
  "INVALID_PURPOSE",
  "PATH_LENGTH_EXCEEDED",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/**
 * Handshake, identity and key-material failures: OpenSSL's reasons (ERR_SSL_), Node's TLS layer (ERR_TLS_), OpenSSL 3's
 * decoders (ERR_OSSL_), and BoringSSL on Bun (ERR_BORINGSSL).
 */
const TLS_CODE_PREFIXES: readonly string[] = ["ERR_SSL_", "ERR_TLS_", "ERR_OSSL_", "ERR_BORINGSSL"];

/**
 * Node names an OpenSSL record-layer failure, such as a TLS request answered by a plaintext server ("wrong version
 * number"), with the errno EPROTO and no TLS code, where Bun says ERR_SSL_WRONG_VERSION_NUMBER. Only a TLS socket
 * raises it, so it is a TLS failure on a TLS connection and a network failure on any other.
 */
function isTlsCode(code: string, overTls: boolean): boolean {
  return (
    (overTls && code === "EPROTO") ||
    CERTIFICATE_VERIFICATION_CODES.has(code) ||
    TLS_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))
  );
}

/** Whether a runtime error code is a TLS failure on a TLS connection; shared with `fetch-failure.ts` (#1431). */
export function isTlsFailureCode(code: string): boolean {
  return isTlsCode(code, true);
}

function ownCode(value: unknown): string | undefined {
  const code = typeof value === "object" && value !== null ? (value as { code?: unknown }).code : undefined;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : undefined;
}

/** A code on the error itself, or on its cause. */
function errorCode(error: unknown): string | undefined {
  return ownCode(error) ?? (error instanceof Error ? ownCode(error.cause) : undefined);
}

/** A deadline when an AbortSignal.timeout() fired, a cancellation for any other reason. */
function abortFailure(signal: AbortSignal): TransportError {
  const reason: unknown = signal.reason;
  return reason instanceof DOMException && reason.name === "TimeoutError"
    ? new TransportError("timeout", "The request did not finish within its time limit")
    : new TransportError("aborted", "The request was cancelled");
}

/**
 * Whatever the runtime raised, as a failure whose message holds a code at most. `responded` is true once the response
 * callback has run and until the body ends: a network failure then is the server ending the answer early, by a FIN or
 * an RST, whichever object emits it (R20), and is never read as the answer it cut short. A TLS code stays kind "tls".
 */
function failureFrom(error: unknown, signal: AbortSignal, overTls: boolean, responded: boolean): Error {
  // The egress guard's refusal from the Agent's lookup: already worded, and naming no address.
  if (error instanceof DatabaseConfigError) return error;
  // Whatever the runtime threw once the signal fired, the signal says which kind of stop it was.
  if (signal.aborted) return abortFailure(signal);
  const code = errorCode(error);
  // A TLS failure stays a failure: nothing is retried over plain HTTP or with weaker verification.
  if (code !== undefined && isTlsCode(code, overTls)) {
    return new TransportError("tls", `The TLS connection failed (${code})`);
  }
  // A cut body never emits `end` on either runtime, so the network branch is the only place a truncation shows.
  if (responded) return new TransportError("network", TRUNCATED, { truncated: true });
  return new TransportError("network", code === undefined ? NETWORK_FAILURE : `${NETWORK_FAILURE} (${code})`);
}

function tooLarge(limit: number): TransportError {
  return new TransportError(
    "too-large",
    `The response exceeded the ${limit}-byte limit for one response, so it was not read to the end`,
  );
}

/** A content-encoding token named in a refusal; anything else is described, never echoed. */
const ENCODING_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;

function encodingRefusal(encoding: string): TransportError {
  const name = encoding.trim();
  const named = ENCODING_TOKEN.test(name) ? name : "that is not a single token";
  return new TransportError(
    "encoding",
    `The server answered with content-encoding ${named}, and this transport reads identity only, so the response was not read`,
  );
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function retryAfterOf(value: string | undefined): string | null {
  return value === undefined ? null : value.slice(0, MAX_RETRY_AFTER_LENGTH);
}

/**
 * Headers that frame or address a request, which node:http sets from the body and the URL. Set once per connection
 * they would apply to every request: a content-length on a GET with no body makes the server wait for bytes that never
 * come, and a host sends the request to another virtual host than the origin names.
 */
const TRANSPORT_HEADERS: ReadonlySet<string> = new Set(["content-length", "transfer-encoding", "host"]);

/**
 * Header names in lower case, so the transport's own headers below replace a caller's whatever its spelling; a header
 * the transport sets for each request is refused by name, never its value.
 */
function lowerCased(headers: Readonly<Record<string, string>>): Record<string, string> {
  const lowered = Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value] as const);
  for (const [name] of lowered) {
    if (TRANSPORT_HEADERS.has(name)) {
      throw new DatabaseConfigError(`Invalid headers: ${name} is set by the transport for each request`);
    }
  }
  return Object.fromEntries(lowered);
}

/**
 * Names a per-request header may never take: those node:http or this transport set for each request, those that frame
 * or govern the connection rather than one request, and the Authorization credential, which belongs to the connection's
 * own headers. Every `content-` and `proxy-` name is refused by its prefix.
 */
const OWNED_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "transfer-encoding",
  "accept-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "authorization",
]);
const OWNED_HEADER_PREFIXES: readonly string[] = ["content-", "proxy-"];

/** An HTTP field name (RFC 9110 token) in lower case. */
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
/** Visible ASCII and space: no CR or LF to split a header, no control and nothing node:http would re-encode. */
const HEADER_VALUE = /^[\x20-\x7e]*$/;
const MAX_HEADER_VALUE_BYTES = 1024;

/**
 * The closed list of per-request header names, checked once when the transport is built: a name that is not a
 * lower-case token is refused without being repeated, and one the transport or the connection owns is refused by name,
 * so a request can never replace a credential, a framing header or a header every request of the connection carries.
 */
function requestHeaderNamesOf(
  names: readonly string[] | undefined,
  connection: Readonly<Record<string, string>>,
): ReadonlySet<string> {
  // A string would list its characters and a hole or a number would reach the name check as something else.
  if (names !== undefined && (!Array.isArray(names) || !Array.from(names).every((name) => typeof name === "string"))) {
    throw new DatabaseConfigError(INVALID_HEADER_NAMES);
  }
  const listed = new Set(names);
  for (const name of listed) {
    if (!HEADER_NAME.test(name)) throw new DatabaseConfigError(INVALID_HEADER_NAMES);
    if (
      OWNED_HEADERS.has(name) ||
      OWNED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
      Object.hasOwn(connection, name)
    ) {
      throw new DatabaseConfigError(`Invalid requestHeaderNames: ${name} is set by the transport or the connection`);
    }
  }
  return listed;
}

/**
 * A request's own headers, checked before any socket: an unlisted name is refused without being repeated, and a value
 * of the wrong kind is refused by its listed name, never its value.
 */
function perRequestHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  listed: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  // One read, checked and then sent, so a record whose keys or values change between reads cannot pass one set.
  const record = headers ?? {};
  const entries = Object.entries(record);
  // What that read cannot see, a Map's entries, a Symbol or a non-enumerable key, is refused rather than dropped; the
  // second key read only ever refuses, it never adds to what is sent.
  const prototype: unknown = Object.getPrototypeOf(record);
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(record).length !== entries.length) {
    throw new DatabaseConfigError(NOT_A_RECORD);
  }
  for (const [name, value] of entries) {
    if (!listed.has(name)) throw new DatabaseConfigError(UNLISTED_HEADER);
    if (typeof value !== "string" || value.length > MAX_HEADER_VALUE_BYTES || !HEADER_VALUE.test(value)) {
      throw new DatabaseConfigError(
        `Invalid request headers: the value of ${name} must be visible ASCII or space, at most ${MAX_HEADER_VALUE_BYTES} bytes`,
      );
    }
  }
  return Object.fromEntries(entries);
}

/** What a request sends: its text and the content type the transport sets for it. */
interface Payload {
  readonly text: string;
  readonly contentType: string;
}

/** The request's payload: a form serialised here, a JSON body as given, or undefined for neither. */
function payloadOf(request: NodeRequest): Payload | undefined {
  if (request.form !== undefined) {
    return { text: new URLSearchParams(request.form).toString(), contentType: "application/x-www-form-urlencoded" };
  }
  return request.body === undefined ? undefined : { text: request.body, contentType: "application/json" };
}

/** The connection's headers, then the request's own, then the transport's, which no earlier one can replace. */
function requestHeaders(
  connection: Readonly<Record<string, string>>,
  perRequest: Readonly<Record<string, string>>,
  payload: Payload | undefined,
): Record<string, string> {
  return {
    ...connection,
    ...perRequest,
    "accept-encoding": "identity",
    ...(payload === undefined
      ? {}
      : {
          "content-type": payload.contentType,
          "content-length": String(Buffer.byteLength(payload.text, "utf8")),
        }),
  };
}

function parsedUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/**
 * The request target, read once and checked before any socket (byte transport design 3.4 and 3.8). Only a plain
 * object is read, as perRequestHeaders reads a record, so a getter on a class or a Map's entries never stand in for it.
 */
function requestTargetOf(target: unknown): RequestTarget {
  if (typeof target !== "object" || target === null) throw new DatabaseConfigError(INVALID_TARGET);
  const prototype: unknown = Object.getPrototypeOf(target);
  if (prototype !== Object.prototype && prototype !== null) throw new DatabaseConfigError(INVALID_TARGET);
  const { path, query } = target as { readonly path?: unknown; readonly query?: unknown };
  if (typeof path !== "string" || typeof query !== "string") throw new DatabaseConfigError(INVALID_TARGET);
  if (!TARGET_PATH.test(path)) throw new DatabaseConfigError(INVALID_TARGET_PATH);
  if (!TARGET_QUERY.test(query)) throw new DatabaseConfigError(INVALID_TARGET_QUERY);
  // The bytes written as the request target: the "?" only when there is a query.
  if ((query === "" ? path.length : path.length + 1 + query.length) > MAX_TARGET_LENGTH) {
    throw new DatabaseConfigError(TARGET_TOO_LONG);
  }
  return { path, query };
}

/** A header value cut to `limit` characters, or null when absent. */
function cut(value: string | undefined, limit: number): string | null {
  return value === undefined ? null : value.slice(0, limit);
}

/** A response-header selection as checked: exact names and name prefixes, all lower case. */
interface HeaderSelection {
  readonly names: ReadonlySet<string>;
  readonly prefixes: readonly string[];
}

/** The selection, checked once when the transport is built; absent selects nothing (byte transport design 3.5). */
function responseHeaderSelectionOf(selection: ResponseHeaderSelection | undefined): HeaderSelection {
  if (selection === undefined) return { names: new Set(), prefixes: [] };
  const names: unknown = selection.names;
  const prefixes: unknown = selection.prefixes ?? [];
  if (
    !Array.isArray(names) ||
    !Array.isArray(prefixes) ||
    names.length > MAX_SELECTED_NAMES ||
    prefixes.length > MAX_SELECTED_PREFIXES ||
    !names.every((name) => typeof name === "string" && HEADER_NAME.test(name)) ||
    !prefixes.every(
      (prefix) =>
        typeof prefix === "string" &&
        HEADER_NAME.test(prefix) &&
        prefix.length >= MIN_SELECTED_PREFIX_LENGTH &&
        prefix.endsWith("-"),
    )
  ) {
    throw new DatabaseConfigError(INVALID_RESPONSE_HEADERS);
  }
  const listed = names as string[];
  if (listed.some((name) => NEVER_RETURNED.has(name))) throw new DatabaseConfigError(NEVER_RETURNED_LISTED);
  return { names: new Set(listed), prefixes: [...(prefixes as string[])] };
}

/**
 * The selected headers of an answer, from its raw header list: answer.headers joins repeated x-amz-meta-* values and
 * drops repeated etag, content-type and others, where rawHeaders keeps every name, value and order on both runtimes.
 * Names are lower-cased here; values stay as the runtime decoded them (latin1). Location and Set-Cookie are skipped
 * whatever the selection says. Past 64 headers, or past 16384 characters of names and values, later headers are
 * dropped; a value past 1024 characters is cut; either sets the flag. Exported so the 16384 total, which no runtime
 * lets through its own header-block limit, can be tested directly.
 */
export function selectedHeaders(
  raw: readonly string[],
  selection: HeaderSelection,
): { readonly headers: ResponseHeader[]; readonly truncated: boolean } {
  const headers: ResponseHeader[] = [];
  let truncated = false;
  let total = 0;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index].toLowerCase();
    if (NEVER_RETURNED.has(name)) continue;
    if (!selection.names.has(name) && !selection.prefixes.some((prefix) => name.startsWith(prefix))) continue;
    if (headers.length === MAX_RETURNED_HEADERS) {
      truncated = true;
      break;
    }
    const received = raw[index + 1];
    const value = received.slice(0, MAX_RETURNED_VALUE_LENGTH);
    if (value.length < received.length) truncated = true;
    if (total + name.length + value.length > MAX_RETURNED_TOTAL_LENGTH) {
      truncated = true;
      break;
    }
    total += name.length + value.length;
    headers.push([name, value]);
  }
  return { headers, truncated };
}

/**
 * The TLS options of node:https under its own names, set once on the connection's Agent. The server name is the
 * identity when it is a DNS name; for an IP literal none is sent. Every certificate is checked against the identity,
 * which through an SSH tunnel is the far end, never the local forward the socket dials; for an IP identity Node's own
 * check reads the certificate's IP SAN.
 */
function tlsAgentOptions(tls: NodeTlsMaterial): HttpsAgentOptions {
  const { identity } = tls;
  return {
    rejectUnauthorized: tls.rejectUnauthorized,
    ...(tls.ca === undefined ? {} : { ca: tls.ca }),
    ...(tls.cert === undefined ? {} : { cert: tls.cert }),
    ...(tls.key === undefined ? {} : { key: tls.key }),
    ...(isIP(identity) === 0 ? { servername: identity } : {}),
    checkServerIdentity: (_dialled: string, certificate: PeerCertificate) => checkServerIdentity(identity, certificate),
  };
}

/**
 * How one request is settled, handed to the code that writes it once a socket slot is free. Every method is safe to
 * call after the request has settled: a second settlement is ignored.
 */
interface Exchange<T> {
  /** The request node:http is writing, destroyed by a failure. */
  sent(outgoing: ClientRequest): void;
  /** The answer has arrived: from here until ended(), a network failure is a truncation. */
  answered(incoming: IncomingMessage): void;
  /** The body has ended. */
  ended(): void;
  /** Settles with `value` and frees the socket slot; false, with nothing resolved, when the request had settled. */
  resolve(value: T): boolean;
  /** Settles with `failure`, destroys the request and its answer, and frees the socket slot. */
  fail(failure: Error): void;
  /** fail() with whatever the runtime raised, read by failureFrom. */
  failWith(error: unknown): void;
  /** Whether the request has settled: answered, failed, cancelled or stopped by close(). */
  settled(): boolean;
}

interface CoreSettings {
  readonly tls: NodeTlsMaterial | null;
  readonly maxSockets: number;
  readonly idleSocketMs: number | undefined;
  /** The guard's lookup, the byte transport's link-local lookup, or undefined for the runtime's own. */
  readonly lookup: LookupFunction | undefined;
}

/** What both factories share: the connection's Agent, its socket queue, close() and the failure mapping. */
interface TransportCore {
  readonly agent: HttpAgent;
  readonly send: typeof httpRequest | typeof httpsRequest;
  isClosed(): boolean;
  /** Runs `begin` once a socket slot is free, or never when the request is stopped while it waits. */
  queue<T>(signal: AbortSignal, begin: (pending: Exchange<T>) => void): Promise<T>;
  close(): void;
}

/**
 * One connection's Agent and queue: its own keep-alive Agent, never the global one. Nothing is opened here; the first
 * request opens the first socket.
 */
function transportCore(settings: CoreSettings): TransportCore {
  const { tls, maxSockets, lookup } = settings;
  const shared: AgentOptions = {
    keepAlive: true,
    timeout: settings.idleSocketMs ?? IDLE_SOCKET_MS,
    maxSockets,
    ...(lookup === undefined ? {} : { lookup }),
  };
  const agent = tls === null ? new HttpAgent(shared) : new HttpsAgent({ ...shared, ...tlsAgentOptions(tls) });
  const send = tls === null ? httpRequest : httpsRequest;
  /**
   * Each request in flight or waiting for a socket, by the function that stops it. close() stops them all before it
   * destroys the Agent: destroying the Agent alone hands a queued request a new socket and sends it after the close.
   */
  const active = new Set<(failure: Error) => void>();
  let closed = false;
  /**
   * The transport holds the requests beyond maxSockets itself and hands one to the Agent only when a socket is free,
   * because the Agent keeps a request destroyed in its own queue and later dials a socket for it, so a cancel would
   * still cost a lookup and a handshake. A request stopped while it waits here never reaches the Agent.
   */
  let sending = 0;
  const waiting: Array<() => void> = [];
  const release = (): void => {
    sending -= 1;
    // After close() nothing more starts: close() stops every waiting request itself.
    if (!closed) waiting.shift()?.();
  };

  const queue = <T>(signal: AbortSignal, begin: (pending: Exchange<T>) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let outgoing: ClientRequest | undefined;
      let incoming: IncomingMessage | undefined;
      let settled = false;
      let started = false;
      // Set when the response callback runs and cleared when the body ends: a failure in between is a truncation.
      let responded = false;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        active.delete(fail);
        signal.removeEventListener("abort", onAbort);
        if (started) release();
        else waiting.splice(waiting.indexOf(start), 1);
        return true;
      };
      const fail = (failure: Error): void => {
        if (!settle()) return;
        // Destroying the socket stops a server that keeps writing, and a destroyed socket never returns to the pool.
        incoming?.destroy();
        outgoing?.destroy();
        reject(failure);
      };
      const failWith = (error: unknown): void => fail(failureFrom(error, signal, tls !== null, responded));
      const onAbort = (): void => fail(abortFailure(signal));
      const pending: Exchange<T> = {
        sent: (request) => {
          outgoing = request;
        },
        answered: (answer) => {
          incoming = answer;
          responded = true;
        },
        ended: () => {
          responded = false;
        },
        resolve: (value) => {
          if (!settle()) return false;
          resolve(value);
          return true;
        },
        fail,
        failWith,
        settled: () => settled,
      };
      const start = (): void => {
        started = true;
        sending += 1;
        begin(pending);
      };
      active.add(fail);
      signal.addEventListener("abort", onAbort, { once: true });
      if (sending < maxSockets) start();
      else waiting.push(start);
    });

  return {
    agent,
    send,
    isClosed: () => closed,
    queue,
    close() {
      closed = true;
      for (const stop of [...active]) stop(new TransportError("aborted", CLOSED));
      agent.destroy();
    },
  };
}

/** What both factories build from their options: the origin's address as each reads it, the headers and the core. */
interface Connection<A> {
  readonly address: A;
  readonly connectionHeaders: Readonly<Record<string, string>>;
  readonly requestHeaderNames: ReadonlySet<string>;
  readonly core: TransportCore;
}

/**
 * The checks both factories run when a transport is built, in this order, and the core they then share. `address`
 * reads the origin once the guard has passed it: the text factory's origin string, the byte factory's Host. The byte
 * factory checks its response-header selection before calling this, so a refused selection builds no Agent.
 */
function connectionOf<A>(options: NodeTransportOptions, address: (origin: HttpOrigin) => A): Connection<A> {
  const { origin, tls, maxSockets } = options;
  if (!isPositiveInteger(maxSockets)) throw new DatabaseConfigError(INVALID_MAX_SOCKETS);
  if ((origin.scheme === "https") !== (tls !== null)) throw new DatabaseConfigError(SCHEME_MISMATCH);
  // With DB_HTTP_BLOCK_PRIVATE_HOSTS on, this refuses a blocked IP literal now, before any socket, because a literal
  // never reaches a lookup, and hands back the guard's lookup for this connection's own Agent. Its `agent: false` is not
  // taken: the Agent below belongs to this connection alone and never carries an unguarded request (R44 QM1).
  const { lookup } = guardedNodeOptions(origin.host);
  const addressed = address(origin);
  const connectionHeaders = lowerCased(options.headers);
  const requestHeaderNames = requestHeaderNamesOf(options.requestHeaderNames, connectionHeaders);
  const core = transportCore({ tls, maxSockets, idleSocketMs: options.idleSocketMs, lookup });
  return { address: addressed, connectionHeaders, requestHeaderNames, core };
}

/** The refusals every request meets first, in this order: a closed transport, then a signal already aborted. */
function admit(core: TransportCore, signal: AbortSignal): void {
  if (core.isClosed()) throw new TransportError("aborted", CLOSED);
  // An already-aborted signal never fires "abort" again, and node:http would send the request regardless.
  if (signal.aborted) throw abortFailure(signal);
}

/** What one request writes: node:http's options without the Agent, which is always the core's, and its body. */
interface Prepared {
  readonly options: Omit<RequestOptions, "agent">;
  readonly body?: string;
}

/**
 * Writes one request on the core's Agent, once its socket slot is free. `prepare` runs inside the same try as the
 * write, so whatever throws there or in node:http fails this request alone and frees its slot. `answered` is handed the
 * answer, its status and the request that carried it once the answer's own errors are wired to the exchange.
 */
function dispatch<T>(
  core: TransportCore,
  pending: Exchange<T>,
  prepare: () => Prepared,
  answered: (answer: IncomingMessage, status: number, outgoing: ClientRequest) => void,
): void {
  try {
    const { options, body } = prepare();
    const outgoing = core.send({ ...options, agent: core.agent }, (answer) => {
      pending.answered(answer);
      answer.on("error", pending.failWith);
      // Set on every answer a ClientRequest receives; the type is shared with server-side requests.
      answered(answer, answer.statusCode ?? 0, outgoing);
    });
    pending.sent(outgoing);
    outgoing.on("error", pending.failWith);
    outgoing.end(body);
  } catch (error) {
    // node:http refuses some requests by throwing before anything is sent: a header value with a line feed.
    pending.failWith(error);
  }
}

/**
 * One connection's text transport: GET and POST to a URL on the connection's origin, the answer decoded as UTF-8.
 * The constructor opens nothing; the first request opens the first socket.
 */
export function createNodeTransport(options: NodeTransportOptions): NodeTransport {
  const {
    address: connectionOrigin,
    connectionHeaders,
    requestHeaderNames,
    core,
  } = connectionOf(options, (origin) => new URL(endpointUrl(origin, "/")).origin);

  const exchange = (
    request: NodeRequest,
    target: URL,
    perRequest: Readonly<Record<string, string>>,
  ): Promise<NodeResponse> =>
    core.queue<NodeResponse>(request.signal, (pending) => {
      const { hostname, port, path } = urlToHttpOptions(target);
      const payload = payloadOf(request);
      dispatch(
        core,
        pending,
        () => ({
          options: {
            hostname,
            port,
            path,
            method: request.method,
            headers: requestHeaders(connectionHeaders, perRequest, payload),
          },
          body: payload?.text,
        }),
        (answer, status) => {
          try {
            // The shared refusal reads a fetch-shaped status and Location, so the adapter hands it those two.
            const location = answer.headers.location;
            rejectRedirect({ status, headers: new Headers(location === undefined ? {} : { location }) }, request.url);
          } catch (refusal) {
            // Released unread: fail() destroys the answer, so no redirect is followed and no body is read.
            pending.fail(new TransportError("redirect", (refusal as Error).message));
            return;
          }
          const encoding = answer.headers["content-encoding"];
          if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
            // Refused before a byte of the body is read, so maxResponseBytes always counts the bytes that are parsed.
            pending.fail(encodingRefusal(encoding));
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          answer.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > request.maxResponseBytes) {
              pending.fail(tooLarge(request.maxResponseBytes));
              return;
            }
            chunks.push(chunk);
          });
          answer.on("end", () => {
            pending.ended();
            pending.resolve({
              status,
              contentType: answer.headers["content-type"] ?? null,
              retryAfter: retryAfterOf(answer.headers["retry-after"]),
              text: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
    });

  return {
    async request(request) {
      admit(core, request.signal);
      if (!isPositiveInteger(request.maxResponseBytes)) throw new DatabaseConfigError(INVALID_MAX_RESPONSE_BYTES);
      // Neither is dropped silently: a request naming both is refused before any socket.
      if (request.body !== undefined && request.form !== undefined) throw new DatabaseConfigError(BODY_AND_FORM);
      const perRequest = perRequestHeaders(request.headers, requestHeaderNames);
      const target = parsedUrl(request.url);
      // A URL carrying userinfo would send it as an Authorization header, so it is refused like another origin.
      if (target === null || target.origin !== connectionOrigin || target.username !== "" || target.password !== "") {
        throw new DatabaseConfigError(FOREIGN_URL);
      }
      return exchange(request, target, perRequest);
    },
    close() {
      core.close();
    },
  };
}

/**
 * One connection's byte transport (byte transport design 3): GET and HEAD to an exact request target on the
 * connection's origin, the body returned as bytes. It shares the text transport's core, so the socket, proxy, TLS,
 * cap, cancel and egress rules exist once. The constructor opens nothing; the first request opens the first socket.
 */
export function createNodeByteTransport(options: NodeByteTransportOptions): NodeByteTransport {
  const { port } = options.origin;
  // Checked before connectionOf builds the Agent, so a refused selection leaves nothing behind.
  const selection = responseHeaderSelectionOf(options.responseHeaders);
  const { address, connectionHeaders, requestHeaderNames, core } = connectionOf(options, (origin) => ({
    hostname: unbracketed(origin.host),
    // Set by the transport on every request, so the Host a signer signs is the Host on the wire (byte transport design 3.3).
    host: originHost(origin),
  }));

  const exchange = (
    request: NodeByteRequest,
    target: RequestTarget,
    perRequest: Readonly<Record<string, string>>,
  ): Promise<NodeByteResponse> =>
    core.queue<NodeByteResponse>(request.signal, (pending) => {
      dispatch(
        core,
        pending,
        () => ({
          options: {
            hostname: address.hostname,
            port,
            // Written by node:http byte for byte, never parsed, so dot segments reach the server as given.
            path: target.query === "" ? target.path : `${target.path}?${target.query}`,
            method: request.method,
            headers: { ...connectionHeaders, ...perRequest, host: address.host, "accept-encoding": "identity" },
          },
        }),
        (answer, status, outgoing) => {
          const selected = selectedHeaders(answer.rawHeaders, selection);
          const chunks: Buffer[] = [];
          let received = 0;
          const respond = (truncated: boolean): NodeByteResponse => ({
            status,
            contentType: cut(answer.headers["content-type"], MAX_CONTENT_TYPE_LENGTH),
            contentEncoding: cut(answer.headers["content-encoding"], MAX_CONTENT_ENCODING_LENGTH),
            retryAfter: retryAfterOf(answer.headers["retry-after"]),
            headers: selected.headers,
            headersTruncated: selected.truncated,
            bytes: Buffer.concat(chunks),
            truncated,
          });
          // One bound governs memory: truncateAt when given, which is never above maxResponseBytes.
          const limit = request.truncateAt ?? request.maxResponseBytes;
          answer.on("data", (chunk: Buffer) => {
            if (received + chunk.length <= limit) {
              received += chunk.length;
              chunks.push(chunk);
              return;
            }
            if (request.truncateAt === undefined) {
              pending.fail(tooLarge(request.maxResponseBytes));
              return;
            }
            // The runtime picks the chunk size (Bun handed 393,110 bytes at once for a stop at 100,000), so the cut
            // is a slice of the chunk that crosses the bound.
            chunks.push(chunk.subarray(0, limit - received));
            received = limit;
            // Resolve first and destroy second: after destroy neither end nor error fires, and a late event finds the
            // request settled. A destroyed socket is never reused, so the next request opens a new one.
            if (pending.resolve(respond(true))) {
              answer.destroy();
              outgoing.destroy();
            }
          });
          answer.on("end", () => {
            pending.ended();
            // An end after a failure, a cancel or close() builds no answer: nothing would receive it.
            if (pending.settled()) return;
            pending.resolve(respond(false));
          });
        },
      );
    });

  return {
    async request(request) {
      admit(core, request.signal);
      if (request.method !== "GET" && request.method !== "HEAD") throw new DatabaseConfigError(INVALID_METHOD);
      if (!isPositiveInteger(request.maxResponseBytes)) throw new DatabaseConfigError(INVALID_MAX_RESPONSE_BYTES);
      const { truncateAt } = request;
      if (truncateAt !== undefined && (!isPositiveInteger(truncateAt) || truncateAt > request.maxResponseBytes)) {
        throw new DatabaseConfigError(INVALID_TRUNCATE_AT);
      }
      const perRequest = perRequestHeaders(request.headers, requestHeaderNames);
      const target = requestTargetOf(request.target);
      return exchange(request, target, perRequest);
    },
    close() {
      core.close();
    },
  };
}
