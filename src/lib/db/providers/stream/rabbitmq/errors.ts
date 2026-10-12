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
import { RABBITMQ_NAME_PROSE_CHARS, RABBITMQ_TYPE } from "./limits";

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
