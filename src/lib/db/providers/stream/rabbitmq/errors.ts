/**
 * Every error, warning and caution sentence of the RabbitMQ provider, with its Studio class, and the one boundary
 * every public method and every path of a read ends in.
 *
 * No broker text is ever quoted: a reply text or an HTTP body is only matched against a fixed pattern that picks a
 * sentence, and the code alone picks one when nothing matches. Names are free text that anyone with configure
 * permission writes, so a name in a sentence is a JSON string literal with every control and bidi character escaped,
 * and cut after 64 characters in prose. A name inside a request a sentence quotes is never cut, because a cut name
 * addresses another stream.
 *
 * An error built here is registered as the provider's own, and `rabbitmqBoundary` passes through only those and the
 * shared egress refusal; anything else becomes a fixed sentence and its original value is dropped, because the query
 * route sends an error's message to the client and history keeps it. docs/providers/rabbitmq.md prints the table.
 */
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { EGRESS_REFUSAL_SENTENCES } from "@/lib/db/http/egress-policy";
import { isTlsFailureCode, TransportError } from "@/lib/db/http/node-transport";
import {
  RABBITMQ_CAUTION_NAMED_QUEUES,
  RABBITMQ_LISTING_PAGE_SIZE,
  RABBITMQ_MGMT_DEPTH,
  RABBITMQ_NAME_PROSE_CHARS,
  RABBITMQ_TYPE,
} from "./limits";

// =====================================================================================================================
// Own errors
// =====================================================================================================================

/** Every error this module built, so the boundary can tell an own error from a value that only has the same class. */
const OWN = new WeakSet<Error>();

function own<E extends Error>(error: E): E {
  OWN.add(error);
  return error;
}

export function configError(sentence: string): DatabaseConfigError {
  return own(new DatabaseConfigError(sentence, RABBITMQ_TYPE));
}

export function connectionError(sentence: string): ConnectionError {
  return own(new ConnectionError(sentence, RABBITMQ_TYPE));
}

export function authenticationError(sentence: string): AuthenticationError {
  return own(new AuthenticationError(sentence, RABBITMQ_TYPE));
}

export function queryError(sentence: string): QueryError {
  return own(new QueryError(sentence, RABBITMQ_TYPE));
}

export function timeoutError(sentence: string, timeoutMs?: number): TimeoutError {
  return own(new TimeoutError(sentence, RABBITMQ_TYPE, timeoutMs));
}

export function cancelledError(sentence: string): QueryCancelledError {
  return own(new QueryCancelledError(sentence, RABBITMQ_TYPE));
}

/** Whether `error` was built by this module. */
export function isOwnError(error: unknown): boolean {
  return error instanceof Error && OWN.has(error);
}

// =====================================================================================================================
// Names and endpoints in sentences
// =====================================================================================================================

/**
 * Characters a JSON string literal leaves raw but a sentence must not: DEL, the C1 controls, the line and paragraph
 * separators and the bidi controls. JSON.stringify already escapes the C0 controls.
 */
const UNSAFE_IN_PROSE = /[\u007F-\u009F\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function escapedLiteral(text: string): string {
  return JSON.stringify(text).replace(
    UNSAFE_IN_PROSE,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** A name in prose: the escaped JSON string literal of its first 64 code points, and "..." after it when cut. */
export function quoteName(name: string): string {
  const codePoints = [...name];
  if (codePoints.length <= RABBITMQ_NAME_PROSE_CHARS) return escapedLiteral(name);
  return `${escapedLiteral(codePoints.slice(0, RABBITMQ_NAME_PROSE_CHARS).join(""))}...`;
}

/** A name inside a quoted request: the same escaping, never cut, so JSON.parse gives the name back. */
export function quoteNameInRequest(name: string): string {
  return escapedLiteral(name);
}

/** quoteName of each, joined by ", ". */
export function quoteNames(names: readonly string[]): string {
  return names.map(quoteName).join(", ");
}

/** "{host}:{port}", an IPv6 literal in brackets. */
export function endpointText(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

// =====================================================================================================================
// Connection: fields, TLS and what is refused before any socket
// =====================================================================================================================

export const TUNNEL_REFUSED =
  "RabbitMQ connections cannot use an SSH tunnel: one tunnel carries one port, and the management API and AMQP use two.";

const FIELD_LABELS = { database: "Database", namespaces: "Namespaces", tlsServerName: "TLS server name" } as const;

/** The refusal of a field RabbitMQ does not offer, set from a seed or the API, naming the field and never its value. */
export function fieldNotOffered(field: "database" | "namespaces" | "tlsServerName"): string {
  const reason =
    field === "tlsServerName"
      ? "the certificate is always checked against Host"
      : "Studio discovers the virtual hosts from the management API";
  return `RabbitMQ connections take no ${FIELD_LABELS[field]}: ${reason}. Clear the field; nothing was sent.`;
}

export const PATH_PREFIX_NO_SLASH = "Path prefix starts with /, for example /rabbitmq.";
export const PATH_PREFIX_DOT_SEGMENT = "Path prefix may not contain an empty, . or .. segment.";
export const PATH_PREFIX_NOT_PLAIN = "Path prefix takes a plain path: no %, ? or #.";
export const PATH_PREFIX_API_SEGMENT =
  "Path prefix may not contain a segment named api, which Studio reserves for the management API's own paths.";

export const PLAINTEXT_REFUSAL =
  'This connection would send its password without TLS to a host that is not this machine, where anyone on the path can read it. Choose an SSL mode under SSL / TLS and use the TLS ports (15671 for management, 5671 for AMQP). Or tick "Send the password without TLS", which this connection then does on every management request and read.';

export const USER_REQUIRED =
  "Username is required: RabbitMQ checks a user on the management API and on AMQP, such as studio-reader. Nothing was sent.";
export const PASSWORD_REQUIRED =
  "Password is required: RabbitMQ checks one on the management API and on AMQP. Nothing was sent.";
export const USER_COLON =
  "Username holds a colon, which Basic authentication cannot carry; check the user name. Nothing was sent.";

/** A credential holding a C0 control or DEL, naming the field and never the value. */
export function credentialControl(field: "Username" | "Password"): string {
  return `${field} holds a control character, which the management API and AMQP cannot carry; re-enter it. Nothing was sent.`;
}

export const AMQP_PORT_SHAPE = "AMQP port must be a whole number from 1 to 65535, such as 5672. Nothing was sent.";

/** A connection field of the wrong JSON type, from a seed or the API. */
export function fieldWrongType(field: string, expected: string): string {
  return `The connection's ${field} must be ${expected}; nothing was sent.`;
}

export const AMQP_PORT_REQUIRED =
  "Reading a stream needs AMQP port: set it on the connection (5672, or 5671 with TLS).";
export const AMQP_PORT_EMPTY_CAUTION =
  "AMQP port is empty, so this connection browses streams but cannot read their messages; set AMQP port to read them.";
export const PROVIDER_CLOSED = "This connection was closed while Studio was using it, so nothing more was read.";
export const MAINTENANCE_REFUSED =
  "RabbitMQ offers no maintenance operation in Studio: Studio reads the broker and never changes it.";

/** A broker below the supported floor. `version` has passed the shape check of `connect()`. */
export function versionTooOld(version: string): DatabaseConfigError {
  return configError(`This broker runs RabbitMQ ${version}; Studio supports 4.2 and later.`);
}

/** A `rabbitmq_version` that fails the shape check, never shown. */
export function versionUnreadable(): DatabaseConfigError {
  return configError(
    "This server's management API reports a version Studio cannot read; Studio supports RabbitMQ 4.2 and later.",
  );
}

// =====================================================================================================================
// Management API failures
// =====================================================================================================================

/** "1 message" or "3 messages". */
function counted(count: number | bigint, singular: string, plural: string): string {
  return `${count} ${count === 1 || count === BigInt(1) ? singular : plural}`;
}

/** A byte cap as the sentences name it: whole MiB or KiB, else bytes. */
function capText(bytes: number): string {
  if (bytes % 1_048_576 === 0) return `${bytes / 1_048_576} MiB`;
  if (bytes % 1_024 === 0) return `${bytes / 1_024} KiB`;
  return `${bytes} bytes`;
}

export type ErrorSite = "connect" | "browse" | "test-connection" | "read";

export interface ManagementFailureContext {
  /** endpointText of the management endpoint. */
  readonly endpoint: string;
  /** The route's fixed label, such as "the queue listing"; never a URL or a name. */
  readonly route: string;
  /** whoami: `/api/whoami`; server: overview, alarms, extensions, vhosts; vhost: listings and policies; object: details, bindings, type check, tracking. */
  readonly scope: "whoami" | "server" | "vhost" | "object";
  readonly site: ErrorSite;
  readonly vhost?: string;
  readonly name?: string;
}

/** A listed vhost the account may not read: the folder's unavailable count. */
export function vhostUnavailableSentence(vhost: string): string {
  return `This user has no permissions on virtual host ${quoteName(vhost)}: grant them to show its queues and exchanges.`;
}

/**
 * A 404 not_found or a 401 on a vhost-scoped route; objects.ts turns it into the folder's unavailable count. Built as
 * `new VhostAccessError(vhostUnavailableSentence(vhost), vhost)`, and registered as own like every builder's error.
 */
export class VhostAccessError extends QueryError {
  constructor(
    message: string,
    readonly vhost: string,
  ) {
    super(message, RABBITMQ_TYPE);
    this.name = "VhostAccessError";
    Object.setPrototypeOf(this, VhostAccessError.prototype);
    OWN.add(this);
  }
}

/** The vhost-access refusal of a vhost-scoped route. */
function vhostAccess(vhost: string): VhostAccessError {
  return new VhostAccessError(vhostUnavailableSentence(vhost), vhost);
}

/** A missing vhost or object, over HTTP or AMQP. */
function missingObject(vhost: string, name: string): QueryError {
  return queryError(
    `Virtual host ${quoteName(vhost)} has no queue, stream or exchange ${quoteName(name)}, or the virtual host does not exist: refresh the tree.`,
  );
}

/** RabbitMQ's own 404 body for a vhost it does not know or this user may not see: `{"error":"not_found",...}`. */
const RABBITMQ_NOT_FOUND = /"error"\s*:\s*"not_found"/;

/**
 * A 404 on a vhost or object route whose body is not RabbitMQ's (no not_found, no Object Not Found): the vhost was
 * deleted, or a proxy in front of the management API answered for it, such as one that decodes %2F.
 */
export function vhostOrProxyNotFound(vhost: string): QueryError {
  return queryError(
    `Virtual host ${quoteName(vhost)} does not exist, or a proxy in front of the management API answered for it: refresh the tree.`,
  );
}

/** Any value the boundary does not recognise. */
function unexpected(route: string): QueryError {
  return queryError(`Studio could not read the broker's answer for ${route}.`);
}

/** A 401 by its answer's fixed patterns: localhost-only, no management tag, else the credential sentence. */
function whoamiRefusal(bodyText: string): AuthenticationError {
  if (/User can only log in via localhost/.test(bodyText))
    return authenticationError(
      "This broker accepts this user only from its own host: create a dedicated user for Studio.",
    );
  if (/Not management user/.test(bodyText))
    return authenticationError("This user may not use the management API: give it the management tag.");
  return authenticationError("The broker refused this username and password on the management API.");
}

/** An HTTP status other than 2xx; `bodyText` is matched only against fixed patterns, never quoted. */
export function managementStatusError(status: number, bodyText: string, context: ManagementFailureContext): Error {
  if (status >= 500) return serverError(context, status);
  if (context.scope === "whoami") {
    if (status === 401) return whoamiRefusal(bodyText);
    if (status === 404)
      return connectionError(
        `${context.endpoint} has no RabbitMQ management API at /api/whoami: check Management port (15672, or 15671 with TLS) and Path prefix.`,
      );
  }
  if (context.scope === "server" && status === 401) return whoamiRefusal(bodyText);
  if (context.scope !== "vhost" && context.scope !== "object") return unexpected(context.route);
  if (status === 401) return vhostAccess(context.vhost ?? "");
  if (status === 404) {
    const objectNotFound = /Object Not Found/.test(bodyText);
    // A 404 RabbitMQ did not write, such as a proxy's HTML page for a decoded %2F.
    if (!objectNotFound && !RABBITMQ_NOT_FOUND.test(bodyText)) return vhostOrProxyNotFound(context.vhost ?? "");
    if (context.scope === "object" && objectNotFound) return missingObject(context.vhost ?? "", context.name ?? "");
    return vhostAccess(context.vhost ?? "");
  }
  return unexpected(context.route);
}

/** A 5xx answer. */
function serverError(context: ManagementFailureContext, status: number): ConnectionError {
  return connectionError(`The management API at ${context.endpoint} answered with a server error (${status}).`);
}

/** The code the shared transport puts in brackets at the end of its own sentence; P2's client reads it too. */
export function transportCode(error: TransportError): string | undefined {
  return /\(([A-Z][A-Z0-9_]*)\)$/.exec(error.message)?.[1];
}

/** A connection that failed before the answer was complete. */
function connectionFailed(endpoint: string): ConnectionError {
  return connectionError(`The connection to ${endpoint} failed before the management API answered completely.`);
}

/** At connect, a refused, reset or non-HTTP answer by the transport's code; the generic failure otherwise. */
function networkFailure(error: TransportError, context: ManagementFailureContext): ConnectionError {
  if (context.site === "connect" && !error.truncated) {
    const code = transportCode(error);
    if (code === "ECONNREFUSED")
      return connectionError(
        `Nothing listens on ${context.endpoint}: check Management port and that the rabbitmq_management plugin is enabled.`,
      );
    if (code === "ECONNRESET")
      return connectionError(
        `${context.endpoint} closed the connection without an HTTP answer: check that Management port is the management API (15672, or 15671 with TLS).`,
      );
    if (code === "HPE_INVALID_CONSTANT")
      return connectionError(
        `${context.endpoint} answered with something that is not HTTP: this looks like an AMQP port, or this port needs TLS; Management port is usually 15672 (15671 with TLS).`,
      );
  }
  return connectionFailed(context.endpoint);
}

/** TLS to a plain listener, for both endpoints, and only for that. */
function notTls(endpoint: string): ConnectionError {
  return connectionError(
    `${endpoint} does not speak TLS: turn TLS off, or use the TLS port (15671 for management, 5671 for AMQP).`,
  );
}

/** Both endpoints: the certificate failed verification for this host (unknown CA, self-signed, name). */
export function tlsCertificateUntrusted(endpoint: string): ConnectionError {
  return connectionError(
    `${endpoint} presented a certificate Studio does not trust for this host: check the CA and the host name under SSL / TLS.`,
  );
}

/** Both endpoints: the broker refused the TLS connection, in practice Studio's client certificate. */
export function tlsClientCertificateRefused(endpoint: string): ConnectionError {
  return connectionError(
    `${endpoint} refused the TLS connection: check the client certificate and key under SSL / TLS.`,
  );
}

export type TlsFailureKind = "not-tls" | "certificate" | "client-certificate";

/**
 * What a plain listener answers a TLS hello with, measured on Node 24.14.0, Bun 1.4.2 and Node 26.10.0: an HTTP
 * listener gives EPROTO on Node and ERR_SSL_WRONG_VERSION_NUMBER on Bun, an AMQP listener's protocol header
 * ERR_SSL_PACKET_LENGTH_TOO_LONG on Node 24.
 */
const PLAIN_LISTENER_CODES: ReadonlySet<string> = new Set([
  "EPROTO",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_PACKET_LENGTH_TOO_LONG",
]);

/**
 * A TLS failure by the runtime's code, for both endpoints. A certificate verification result is one of the shared
 * transport's TLS codes without an ERR_ prefix (OpenSSL's X509_V_ERR_* names), and ERR_TLS_CERT_ALTNAME_INVALID is the
 * host name check. Anything else that ends a TLS connection is the broker refusing it: an alert such as
 * ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED, or a reset or close with no code, which is how Bun, and Node for a
 * certificate from another CA, report a TLS 1.3 client-certificate refusal (measured).
 */
export function tlsFailureKind(code: string | undefined): TlsFailureKind {
  if (code === undefined) return "client-certificate";
  if (PLAIN_LISTENER_CODES.has(code)) return "not-tls";
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID" || (isTlsFailureCode(code) && !code.startsWith("ERR_"))) {
    return "certificate";
  }
  return "client-certificate";
}

/** The sentence of a TLS failure by its code. */
function tlsFailure(endpoint: string, code: string | undefined): ConnectionError {
  const kind = tlsFailureKind(code);
  if (kind === "not-tls") return notTls(endpoint);
  return kind === "certificate" ? tlsCertificateUntrusted(endpoint) : tlsClientCertificateRefused(endpoint);
}

/** A redirect: the Location, its origin included, is never shown. */
function redirected(endpoint: string): ConnectionError {
  return connectionError(
    `${endpoint} answered with a redirect, which Studio does not follow: set Host, Management port and Path prefix to the management API itself.`,
  );
}

/** An encoded body: the transport's own sentence names the server's token, so it is never passed on. */
function encoded(endpoint: string): ConnectionError {
  return connectionError(
    `${endpoint} answered with a compressed or encoded body, which Studio does not read: check Path prefix and any proxy in front of the management API.`,
  );
}

/** A read cancelled before consume-ok: nothing was read. */
export const READ_CANCELLED_BEFORE_START = "The read was stopped before it started; nothing was read.";

/** The cancel of a GET: a read's before it started, anything else's because the connection closed. */
function cancelledAt(site: ErrorSite): QueryCancelledError {
  return cancelledError(site === "read" ? READ_CANCELLED_BEFORE_START : PROVIDER_CLOSED);
}

/**
 * A failure of the shared node transport on a management GET, by kind; its message is never passed on. A deadline
 * and a byte cap carry numbers only the client knows, so the client maps them with `managementTimeout` and
 * `managementTooLarge` first, and either reaching this is the unexpected-answer sentence.
 */
export function managementTransportError(error: TransportError, context: ManagementFailureContext): Error {
  switch (error.kind) {
    case "timeout":
    case "too-large":
      return unexpected(context.route);
    case "aborted":
      return cancelledAt(context.site);
    case "tls":
      return tlsFailure(context.endpoint, transportCode(error));
    case "redirect":
      return redirected(context.endpoint);
    case "encoding":
      return encoded(context.endpoint);
    case "unreachable":
      return connectionFailed(context.endpoint);
    case "network":
      return networkFailure(error, context);
  }
}

/** An answer larger than the route's cap. */
export function managementTooLarge(context: ManagementFailureContext, capBytes: number): QueryError {
  return queryError(`The broker's answer for ${context.route} is larger than the ${capText(capBytes)} Studio accepts.`);
}

/** An answer nested deeper than the management depth limit. */
export function managementTooDeep(context: ManagementFailureContext): QueryError {
  return queryError(
    `The broker's answer for ${context.route} nests deeper than ${RABBITMQ_MGMT_DEPTH} levels, which Studio does not accept.`,
  );
}

/** A 200 whose body does not parse as JSON. */
export function managementNotJson(context: ManagementFailureContext): ConnectionError {
  return connectionError(
    `${context.endpoint} answered with something that is not the management API's JSON: check Management port and Path prefix.`,
  );
}

/** An answer the route's typed decoder refuses. */
export function managementWrongShape(context: ManagementFailureContext): QueryError {
  return queryError(`The broker's answer for ${context.route} is not in the shape Studio reads.`);
}

/** A GET that ran past its deadline. */
export function managementTimeout(context: ManagementFailureContext, seconds: number): TimeoutError {
  return timeoutError(
    `The management API at ${context.endpoint} did not answer ${context.route} within ${seconds} s.`,
    seconds * 1_000,
  );
}

/** The refusal of a path segment `.` or `..` built from a name, which RFC 3986 dot-segment removal would drop. */
export function dotSegmentRefusal(): QueryError {
  return queryError(
    "Studio cannot address a virtual host, queue, stream or exchange named . or .. over the management API.",
  );
}

/** The refusal of an empty name in a path segment that cannot address the default exchange. */
export function emptyNameRefusal(): QueryError {
  return queryError(
    "Studio cannot address a virtual host, queue, stream or exchange with an empty name over the management API.",
  );
}

/** A kind this provider does not declare, named escaped. */
export function unknownKind(kind: string): QueryError {
  return queryError(`RabbitMQ declares no object kind ${quoteName(kind)}.`);
}

/** The base class's sentence for a call before `connect()`, as an own error. */
export const NOT_CONNECTED = "Provider is not connected. Call connect() first.";
/** A full management or bindings limiter queue. */
export const MANAGEMENT_SLOTS_FULL =
  "Too many management requests are waiting on this Studio server; try again when one ends.";
/** The overview's alarm status when the broker reports none. */
export const NO_ALARM_STATUS = "No resource alarm";
/** The overview size card's `sampledFrom`: the overview reads no listing. */
export const OVERVIEW_COUNT_NOT_READ =
  "no listing, because the overview reads only the version and the alarms; the tree counts each virtual host's streams";

// =====================================================================================================================
// The boundary
// =====================================================================================================================

export interface BoundaryContext {
  readonly site: ErrorSite;
  /** endpointText of the endpoint the failing step addressed. */
  readonly endpoint: string;
  /** A route's fixed label, or "the stream read" on a read. */
  readonly route: string;
}

/**
 * The one boundary every public method and every path of a read ends in. An own error and the shared egress
 * refusal pass through unchanged; a TransportError the client did not map becomes its row by kind; anything else,
 * a SyntaxError, a TypeError or a DOMException included, becomes the unexpected-answer sentence. The original value is never the message,
 * the detail or the cause.
 */
export function rabbitmqBoundary(error: unknown, context: BoundaryContext): Error {
  if (isOwnError(error)) return error as Error;
  if (error instanceof DatabaseConfigError && EGRESS_REFUSAL_SENTENCES.has(error.message)) return error;
  if (error instanceof TransportError) {
    switch (error.kind) {
      case "aborted":
        return cancelledAt(context.site);
      case "tls":
        return tlsFailure(context.endpoint, transportCode(error));
      case "redirect":
        return redirected(context.endpoint);
      case "encoding":
        return encoded(context.endpoint);
      case "unreachable":
      case "network":
        return connectionFailed(context.endpoint);
      // A deadline and a byte cap carry numbers only the management client knows, so it maps them itself.
      case "timeout":
      case "too-large":
        return unexpected(context.route);
    }
  }
  return unexpected(context.route);
}

// =====================================================================================================================
// Test Connection cautions
// =====================================================================================================================

export const ALARM_CAUTION =
  "The broker reports an active resource alarm, so publishers are blocked; reads still work.";
export const NO_VHOSTS_CAUTION =
  "This user has no permissions on any virtual host, so there is nothing to show: grant it permissions on each virtual host it should browse.";

/**
 * One vhost's readable-queue caution: at most five names in listing order, "and N more" for the rest found, and
 * "N more were not checked" when a bound, the deadline or an unclassified answer cut the check.
 */
export function readableQueuesCaution(
  vhost: string,
  names: readonly string[],
  moreFound: number,
  notChecked: number,
): string {
  const shown = names.slice(0, RABBITMQ_CAUTION_NAMED_QUEUES);
  const more = moreFound + names.length - shown.length;
  const found = shown.length + more;
  const listed = more > 0 ? `${quoteNames(shown)} and ${more} more` : quoteNames(shown);
  const unchecked = notChecked > 0 ? ` ${notChecked} more ${notChecked === 1 ? "was" : "were"} not checked.` : "";
  return `This account can read classic or quorum ${found === 1 ? "queue" : "queues"} ${listed} in virtual host ${quoteName(vhost)}: a client using it could take their messages. Studio never does; narrow the read permission to stream names.${unchecked}`;
}

/** The summary after three vhosts' cautions. */
export function readableQueuesInMoreVhosts(count: number): string {
  return `Readable classic or quorum queues were also found in ${counted(count, "more virtual host", "more virtual hosts")}.`;
}

// =====================================================================================================================
// Tree and details
// =====================================================================================================================

export const STREAMS_HIDDEN_SENTENCE =
  "Other queue types fill this virtual host's listing page, so Studio cannot list its streams; a stream is still readable by a typed read.";

const grouped = (count: number): string => count.toLocaleString("en-US");

/**
 * The `sampledFrom` of a full Streams folder; `held` is the number of streams the page held, below 500 when other
 * queue types sort into the same page.
 */
export function streamsSampledFrom(filteredCount: number, held: number): string {
  const streams = held === 1 ? "the 1 stream that sorts" : `the ${grouped(held)} streams that sort`;
  return `one page of ${grouped(filteredCount)} queues and streams sorted by type, which holds ${streams} last by name`;
}

/** The `sampledFrom` of a Queues folder above 500; the count of classic or quorum queues is approximate when known. */
export function queuesSampledFrom(filteredCount: number, approximateQueues: number | null): string {
  const about =
    approximateQueues === null ? "" : `, about ${grouped(approximateQueues)} of them classic or quorum queues`;
  return `one ${RABBITMQ_LISTING_PAGE_SIZE}-name page of ${grouped(filteredCount)} queues and streams, by name${about}`;
}

/** The `sampledFrom` of an Exchanges folder above 500. */
export function exchangesSampledFrom(filteredCount: number): string {
  return `one ${RABBITMQ_LISTING_PAGE_SIZE}-name page of ${grouped(filteredCount)} exchanges, by name`;
}

export const QUEUE_MESSAGES_STATEMENT =
  "RabbitMQ cannot show a queue's messages without taking them, so Studio does not read classic or quorum queues.";
export const QUEUE_COUNTS_NOTE = "The broker samples these counts; they can lag by up to about 10 seconds.";
export const STREAM_COUNTS_NOTE =
  "A stream's message count is sampled every 5 seconds and can include compressed batches that no AMQP reader receives.";

/** The title of a detail's counts part. */
export function countsLabel(sampledAt: string): string {
  return `Counts (sampled at ${sampledAt})`;
}
