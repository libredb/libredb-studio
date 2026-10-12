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
  RABBITMQ_BODY_CEILING_BYTES,
  RABBITMQ_BODY_PREFIX_BYTES,
  RABBITMQ_CAUTION_NAMED_QUEUES,
  RABBITMQ_CELL_CHARS,
  RABBITMQ_FRAME_MIN_BYTES,
  RABBITMQ_IDLE_MS,
  RABBITMQ_LAST_HINT_BACKSTEP,
  RABBITMQ_LISTING_PAGE_SIZE,
  RABBITMQ_MGMT_DEPTH,
  RABBITMQ_MIN_VERSION,
  RABBITMQ_NAME_MAX_BYTES,
  RABBITMQ_NAME_PROSE_CHARS,
  RABBITMQ_PAYLOAD_JSON_DEPTH,
  RABBITMQ_READ_MAX_ROWS,
  RABBITMQ_READ_WIRE_BYTES,
  RABBITMQ_RESULT_BUDGET_BYTES,
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

/** The floor as a person reads it: "4.2.0" is "4.2", while a floor with a patch of its own keeps it. */
function floorText(floor: string): string {
  return floor.endsWith(".0") ? floor.slice(0, -2) : floor;
}

/** A broker below the supported floor. `version` has passed the shape check of `connect()`. */
export function versionTooOld(version: string, floor = RABBITMQ_MIN_VERSION): DatabaseConfigError {
  return configError(`This broker runs RabbitMQ ${version}; Studio supports ${floorText(floor)} and later.`);
}

/** A `rabbitmq_version` that fails the shape check, never shown. */
export function versionUnreadable(floor = RABBITMQ_MIN_VERSION): DatabaseConfigError {
  return configError(
    `This server's management API reports a version Studio cannot read; Studio supports RabbitMQ ${floorText(floor)} and later.`,
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

/** The code the shared transport puts in brackets at the end of its own sentence; the management client reads it too. */
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
    `${endpoint} does not speak TLS: choose SSL mode disable under SSL / TLS, or use the TLS port (15671 for management, 5671 for AMQP).`,
  );
}

/** Both endpoints: the certificate failed verification for this host (unknown CA, self-signed, name). */
export function tlsCertificateUntrusted(endpoint: string): ConnectionError {
  return connectionError(
    `${endpoint} presented a certificate Studio does not trust for this host: check the CA certificate under SSL / TLS, and that the certificate names the host set in Host.`,
  );
}

/** Both endpoints: the broker refused the TLS connection, in practice Studio's client certificate. */
export function tlsClientCertificateRefused(endpoint: string): ConnectionError {
  return connectionError(
    `${endpoint} refused the TLS connection: check the client certificate and key under SSL / TLS (shown in verify-ca and verify-full).`,
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
  return `This account can read classic or quorum ${found === 1 ? "queue" : "queues"} ${listed} in virtual host ${quoteName(vhost)}: a client using it could take ${found === 1 ? "its" : "their"} messages. Studio never does; narrow the read permission to stream names.${unchecked}`;
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

// =====================================================================================================================
// The read request
// =====================================================================================================================

/** A key outside the four, named escaped and cut like any user text. */
export function repeatedRequestKey(key: string): string {
  return `The read request names ${quoteName(key)} more than once; write each key once.`;
}

export function unknownRequestKey(key: string): string {
  return `Unknown key ${quoteName(key)} in the read request; the keys are vhost, stream, from and limit.`;
}

export const FROM_FORMS =
  '"from" is "first", "last", "next", {"offset": n}, {"timestamp": "<ISO-8601 with a zone>"} or {"age": "<n><unit>"}, with unit Y, M (months), D, h, m (minutes) or s.';
export const LIMIT_RANGE = `"limit" must be a whole number from 1 to ${RABBITMQ_READ_MAX_ROWS}.`;
export const NAMES_REQUIRED = `"vhost" and "stream" are required strings of 1 to ${RABBITMQ_NAME_MAX_BYTES} bytes, without NUL, and not . or ..`;
export const OFFSET_NOT_WHOLE =
  "The offset must be a non-negative whole number; above 9007199254740991 write it as a digit string.";
export const OFFSET_TOO_LARGE = "The offset must be at most 9223372036854775807.";
export const TIMESTAMP_BEFORE_EPOCH = "The timestamp must be at or after 1970-01-01T00:00:00Z.";
export const TIMESTAMP_FORM =
  'The timestamp must be ISO-8601 with a zone, as YYYY-MM-DDThh:mm with optional seconds of at most three decimals, then Z, +hh:mm or -hh:mm, such as "2026-09-23T00:00:00Z" or "2026-09-23T03:00:00+03:00", because RabbitMQ would otherwise read it in the Studio server\'s time zone.';
export const TIMESTAMP_DAY = "The timestamp names a day of a month that does not have it.";
export const REQUEST_NOT_OBJECT =
  'A RabbitMQ read request is one JSON object, such as {"vhost": "/", "stream": "orders", "from": "last", "limit": 50}.';
export const REQUEST_EMPTY = 'The editor is empty: write a read request such as {"vhost": "/", "stream": "orders"}.';
export const REQUEST_PARAMS = "Bound params are not supported: a RabbitMQ read request has no placeholders.";

// =====================================================================================================================
// The type check
// =====================================================================================================================

/** The type check's refusal: the type is named only when it is classic or quorum, never another broker value. */
export function notAStream(name: string, type: string): QueryError {
  if (type === "classic" || type === "quorum")
    return queryError(
      `${quoteName(name)} is a ${type} queue; Studio reads streams only, because reading a queue removes messages.`,
    );
  return queryError(`${quoteName(name)} is not a stream; Studio reads streams only.`);
}

// =====================================================================================================================
// Read failures before consume-ok
// =====================================================================================================================

export type ProtocolFact =
  | "frame-too-large"
  | "frame-end"
  | "unknown-field"
  | "body-ceiling"
  | "header-too-large"
  | "unexpected-frame"
  | "unknown-frame-type"
  | "missing-offset"
  | "malformed-frame";

const PROTOCOL_FACTS: Readonly<Record<ProtocolFact, string>> = Object.freeze({
  "frame-too-large": "a frame larger than the negotiated size",
  "frame-end": "a frame without its end marker",
  "unknown-field": "an unknown field type",
  "body-ceiling": `a message body above ${capText(RABBITMQ_BODY_CEILING_BYTES)}`,
  "header-too-large": "a content header above its limit",
  "unexpected-frame": "a frame out of sequence",
  "unknown-frame-type": "a frame of an unknown type",
  "missing-offset": "a message without its stream offset",
  "malformed-frame": "a frame whose fields do not fit its size",
});

/** A protocol violation: a fixed phrase per case, never the peer's bytes. */
export function amqpProtocolError(endpoint: string, fact: ProtocolFact): ConnectionError {
  return connectionError(
    `The server at ${endpoint} broke the AMQP 0-9-1 protocol (${PROTOCOL_FACTS[fact]}); the read was stopped.`,
  );
}

export interface AmqpCloseInfo {
  readonly replyCode: number;
  /** Matched only against fixed patterns; never quoted. */
  readonly replyText: string;
  readonly classId: number;
  readonly methodId: number;
  readonly scope: "connection" | "channel";
}

export interface ReadFailureContext {
  readonly endpoint: string;
  readonly vhost: string;
  readonly stream: string;
  /** The type check's `online` and `members`, for the no-replica sentences. */
  readonly online: readonly string[];
  readonly members: readonly string[];
}

const NO_LOCAL_REPLICA = /does not have a running replica on the local node/;

/** Which no-replica sentence the type check's node lists select. */
function noReplica(context: ReadFailureContext): QueryError {
  const name = quoteName(context.stream);
  if (context.online.length === 0) return queryError(`No replica of stream ${name} is reported online.`);
  const online = new Set(context.online);
  if (context.members.length > 0 && context.members.every((member) => online.has(member)))
    return queryError(
      `The node behind AMQP port may still be starting its replica of stream ${name}: read again in a few seconds.`,
    );
  return queryError(
    `The node behind AMQP port holds no running replica of stream ${name}; replicas are reported online on other nodes: point AMQP port at one of them.`,
  );
}

/** A connection.close or channel.close before consume-ok, by reply code and the fixed patterns; the text is never quoted. */
export function amqpCloseError(close: AmqpCloseInfo, context: ReadFailureContext): Error {
  const vhost = quoteName(context.vhost);
  switch (close.replyCode) {
    case 403:
      return close.scope === "connection"
        ? authenticationError("The broker refused this username and password on the AMQP port.")
        : queryError(
            `This user may not read stream ${quoteName(context.stream)}: its read permission pattern on ${vhost} does not match the name.`,
          );
    case 530:
      if (/^NOT_ALLOWED - vhost .* not found$/.test(close.replyText))
        return queryError(`The broker has no virtual host ${vhost}.`);
      if (/^NOT_ALLOWED - access to vhost /.test(close.replyText))
        return authenticationError(
          `This user may not open virtual host ${vhost} over AMQP: grant it permissions there.`,
        );
      return authenticationError(
        `Virtual host ${vhost} does not exist, or this user may not open it over AMQP: check both in the management UI.`,
      );
    case 404:
      return missingObject(context.vhost, context.stream);
    case 406:
      if (NO_LOCAL_REPLICA.test(close.replyText)) return noReplica(context);
      // The broker refuses x-stream-offset on anything but a stream: the type changed after the type check.
      return notAStream(context.stream, "");
    case 541:
      return conversionAtConsume(context.stream);
    default:
      return unexpected("the stream read");
  }
}

/** Nothing listens on the AMQP port. */
export function amqpUnreachable(endpoint: string): ConnectionError {
  return connectionError(`Nothing listens on ${endpoint}: check the address and AMQP port.`);
}

/** TLS to a plain AMQP listener, and only that: the AMQP mapping picks it with `tlsFailureKind`, as the management side does. */
export function amqpNotTls(endpoint: string): ConnectionError {
  return notTls(endpoint);
}

/** Plain AMQP to a TLS port. */
export function amqpExpectsTls(endpoint: string): ConnectionError {
  return connectionError(`${endpoint} expects TLS: choose an SSL mode under SSL / TLS, or use 5672.`);
}

/** No AMQP session started: another service on the port, or silence. */
export function amqpNoSession(endpoint: string): ConnectionError {
  return connectionError(`${endpoint} did not start an AMQP session: check that AMQP port is 5672 (5671 with TLS).`);
}

/** A protocol header other than 0-9-1 in answer to Studio's. */
export function amqpOtherProtocol(endpoint: string): ConnectionError {
  return connectionError(
    `${endpoint} speaks another protocol version than AMQP 0-9-1: check that AMQP port is 5672 or 5671, not 5552 or 15672.`,
  );
}

/** A server that offers no PLAIN mechanism. */
export function amqpNoPlain(endpoint: string): ConnectionError {
  return connectionError(`The server at ${endpoint} offers no PLAIN login, the only one Studio uses.`);
}

/** A frame size below RabbitMQ's own floor, not the protocol's. */
export function frameMaxTooSmall(bytes: number): ConnectionError {
  return connectionError(
    `The broker proposed a frame size of ${bytes.toLocaleString("en-US")} bytes, below the ${grouped(RABBITMQ_FRAME_MIN_BYTES)} RabbitMQ requires.`,
  );
}

/** Missed heartbeats before the read started. */
export function heartbeatsMissed(endpoint: string): ConnectionError {
  return connectionError(`${endpoint} stopped answering during the AMQP handshake.`);
}

export type ReadPhase = "queued" | "connecting" | "tls" | "handshake";

/** A read's deadline before consume-ok, naming the phase it was in; nothing is returned. */
export function readPhaseTimeout(
  phase: ReadPhase,
  context: { readonly seconds: number; readonly endpoint: string; readonly stream: string },
): TimeoutError {
  const n = context.seconds;
  const sentences: Readonly<Record<ReadPhase, string>> = {
    queued: `Waited ${n} s for a read slot; the stream was not read.`,
    connecting: `No answer from ${context.endpoint} within ${n} s.`,
    tls: `${context.endpoint} accepted the connection but did not finish the TLS handshake within ${n} s.`,
    handshake: `Waited ${n} s for the broker to start the read of stream ${quoteName(context.stream)}; nothing was read.`,
  };
  return timeoutError(sentences[phase], n * 1_000);
}

export const READ_SLOTS_FULL = "Too many stream reads are running on this Studio server; try again when one ends.";

/** A 541 before consume-ok. */
export function conversionAtConsume(stream: string): QueryError {
  return queryError(
    `The broker closed the connection (541 INTERNAL_ERROR) while starting the read of stream ${quoteName(stream)}; this can happen when the stream is deleted at that moment. Refresh the tree and read again.`,
  );
}

// =====================================================================================================================
// Stop warnings and conversion sentences; offsets are bigint and printed as decimal strings
// =====================================================================================================================

export const IDLE_WARNING = `No further message arrived within ${RABBITMQ_IDLE_MS / 1_000} s; this is not proof that the stream ends here.`;
export const NEXT_EMPTY_WARNING = `A read from "next" reads only messages published after the read started, and none arrived within ${RABBITMQ_IDLE_MS / 1_000} s.`;

/** A request a sentence quotes, its names whole and escaped, so the request parser reads it back. */
function quotedRequest(vhost: string, stream: string, from: string, limit?: number): string {
  const tail = limit === undefined ? "" : `, "limit": ${limit}`;
  return `{"vhost": ${quoteNameInRequest(vhost)}, "stream": ${quoteNameInRequest(stream)}, "from": ${from}${tail}}`;
}

/** A "last" read that stopped idle with rows: where older messages start. */
export function lastIdleWarning(vhost: string, stream: string, rows: number, firstOffset: bigint): string {
  const back = BigInt(RABBITMQ_LAST_HINT_BACKSTEP);
  const earlier = firstOffset > back ? firstOffset - back : BigInt(0);
  return `Read from "last" starts at the broker's last stored chunk, here ${counted(rows, "message", "messages")}; for older messages read ${quotedRequest(vhost, stream, `{"offset": "${earlier}"}`)}.`;
}

export function budgetWarning(offset: bigint): string {
  return `The result reached its ${capText(RABBITMQ_RESULT_BUDGET_BYTES)} limit before offset ${offset}; read again from offset ${offset}.`;
}

export function wireWarning(offset: bigint): string {
  return `The read transferred ${capText(RABBITMQ_READ_WIRE_BYTES)} before offset ${offset}, mostly bodies longer than ${grouped(RABBITMQ_BODY_PREFIX_BYTES)} bytes; read again from offset ${offset} with a smaller limit.`;
}

/** A message whose declared size alone exceeds the wire cap, its offset decoded: the read can only step past it. */
export function wireOversizeAtOffset(offset: bigint): string {
  return `The message at offset ${offset} is larger than the ${capText(RABBITMQ_READ_WIRE_BYTES)} one read may transfer, so Studio cannot show it; read from offset ${offset + BigInt(1)} to continue past it.`;
}

/** The same before its offset was decoded; null when no row was kept, so the message may be the first. */
export function wireOversizeUnknown(afterOffset: bigint | null): string {
  const where = afterOffset === null ? "at the read's start" : `after offset ${afterOffset}`;
  return `A message ${where} is larger than the ${capText(RABBITMQ_READ_WIRE_BYTES)} one read may transfer, so Studio cannot show it or name its offset.`;
}

export function serverCancelWarning(offset: bigint | null): string {
  return offset === null
    ? "The broker ended the read before delivering any message: the stream may have been deleted."
    : `The broker ended the read after offset ${offset}: the stream may have been deleted.`;
}

export function closedWarning(offset: bigint | null): string {
  return offset === null
    ? "The broker closed the connection before delivering any message."
    : `The broker closed the connection after offset ${offset}; the rows read so far are shown.`;
}

export function deadlineWarning(seconds: number, offset: bigint | null): string {
  return offset === null
    ? `The read stopped at its time limit of ${seconds} s before any message arrived.`
    : `The read stopped at its time limit of ${seconds} s after offset ${offset}; rows read so far are shown; read again from offset ${offset}.`;
}

export function cancelWarning(offset: bigint | null): string {
  return offset === null
    ? "The read was stopped before any message arrived."
    : `The read was stopped after offset ${offset}; rows read so far are shown.`;
}

export const TIMESTAMP_START_WARNING =
  "A timestamp read starts at the chunk that holds that second, so messages published shortly before it can appear. The start uses the time the broker stored the messages; the timestamp column is the publisher's own property, which can be empty or differ.";

/** A 541 after consume-ok with rows: the bad message is within the next P after the last offset delivered. */
export function conversionAfter(offset: bigint, prefetch: number, vhost: string, stream: string): string {
  const lead = `The broker closed the connection (541 INTERNAL_ERROR) after offset ${offset}: it could not convert the next message`;
  const bound =
    prefetch > 1
      ? ` to AMQP 0-9-1. The message is within the next ${prefetch} messages after offset ${offset}, and messages between may not have been delivered.`
      : ` after offset ${offset} to AMQP 0-9-1.`;
  return `${lead}${bound} Read ${quotedRequest(vhost, stream, `{"offset": "${offset + BigInt(1)}"}`, 1)} and step one offset at a time to find it; a read that returns no row stops on it.`;
}

/** A 541 after consume-ok with no row, from a numeric start S. */
export function conversionNoRowNumeric(start: bigint, prefetch: number, vhost: string, stream: string): string {
  const which = prefetch > 1 ? `one of the first ${prefetch} messages` : "the first message";
  return `The broker closed the connection (541 INTERNAL_ERROR) before delivering any message: it could not convert ${which} it would deliver from offset ${start} to AMQP 0-9-1. Offsets inside compressed batches and before the retention start are not delivered, so that message can be later than ${start}. Read ${quotedRequest(vhost, stream, `{"offset": "${start}"}`, 1)} and step forward one offset at a time: a read that ends with this note started at or before the message, and the first read that returns a row started past it.`;
}

/** A 541 after consume-ok with no row, from a keyword, `next`, timestamp or age start; `start` as Studio re-serialises it. */
export function conversionNoRowKeyword(start: string, isLast: boolean, vhost: string, stream: string): string {
  const lastHint = isLast
    ? " The stream's message count in its detail, read as an offset, is at or past the end while retention has removed nothing; a read from it ends with the 'no further message' note."
    : "";
  return `The broker closed the connection (541 INTERNAL_ERROR) before delivering any message: one of the first messages from ${start} cannot be converted to AMQP 0-9-1. Studio cannot name its offset. Read ${quotedRequest(vhost, stream, '"first"', 1)} to learn the first offset; if that read also ends with this note, the first retained message cannot be converted, and Studio cannot read past it until retention removes it, while a stream protocol client can. Then read numeric offsets with "limit": ${RABBITMQ_READ_MAX_ROWS}: a read that ends with the 541 note started at or before the message, and the note names the offset after which it stopped; a read that ends with the 'no further message' note probably started after it; a read that returns all ${RABBITMQ_READ_MAX_ROWS} rows started more than ${RABBITMQ_READ_MAX_ROWS} messages before it.${lastHint} Halve the range until the note names the message.`;
}

// =====================================================================================================================
// Rendering warnings
// =====================================================================================================================

export function timestampsOutOfRange(count: number): string {
  return count === 1
    ? "1 timestamp is outside the range a date can show and is shown as seconds since the epoch."
    : `${count} timestamps are outside the range a date can show and are shown as seconds since the epoch.`;
}

export function cellsCut(count: number): string {
  return `${counted(count, "cell was", "cells were")} cut at ${grouped(RABBITMQ_CELL_CHARS)} characters.`;
}

export function amqp10Bodies(count: number): string {
  return `${counted(count, "message was", "messages were")} published over AMQP 1.0; Studio shows their encoded bytes.`;
}

export function deepPayloads(count: number): string {
  return count === 1
    ? `1 payload nests deeper than ${RABBITMQ_PAYLOAD_JSON_DEPTH} levels and is shown as base64.`
    : `${count} payloads nest deeper than ${RABBITMQ_PAYLOAD_JSON_DEPTH} levels and are shown as base64.`;
}

export function cutBodies(count: number): string {
  return count === 1
    ? `1 payload longer than ${grouped(RABBITMQ_BODY_PREFIX_BYTES)} bytes shows its first bytes only; payload_bytes has the full size.`
    : `${count} payloads longer than ${grouped(RABBITMQ_BODY_PREFIX_BYTES)} bytes show their first bytes only; payload_bytes has the full size.`;
}
