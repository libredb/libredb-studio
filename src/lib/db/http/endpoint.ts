/**
 * Endpoints for the HTTP-based database transports
 *
 * The host and port of an HTTP-based connection must only ever address the
 * configured server and the transport's own fixed paths. A string template such
 * as `${scheme}://${host}:${port}/path` gives no such guarantee: a host carrying
 * a slash, a question mark, a hash or an at sign rewrites the URL around it, and
 * the request then goes to a different path or a different server with the
 * connection's credential attached.
 *
 * So the host and port are validated before any URL exists, every URL is built
 * with `URL` and `URLSearchParams`, and the built URL is checked against the
 * intended hostname, port and path before it is handed back. A refusal is a
 * `DatabaseConfigError` that names the field and never repeats the value, since
 * the value may be exactly what somebody wanted to smuggle into a log or a toast.
 *
 * Nothing here knows about a particular engine; each transport supplies its own
 * scheme, default port and paths.
 */

import { isIPv6 } from "node:net";
import { ConnectionError, DatabaseConfigError } from "@/lib/db/errors";
import { assertPublicLiteralHost } from "./egress-policy";

export type HttpScheme = "http" | "https";

/** A validated scheme, host and port. `host` is in URL form: lower case, IPv6 in brackets. */
export interface HttpOrigin {
  readonly scheme: HttpScheme;
  readonly host: string;
  readonly port: number;
}

/** The port a URL leaves out of its serialization for each scheme. */
const DEFAULT_PORTS: Record<HttpScheme, number> = { http: 80, https: 443 };

const MAX_PORT = 65535;
const MAX_HOSTNAME_LENGTH = 253;

/**
 * One DNS label: letters, digits, hyphens and the underscore a Docker Compose
 * service name may carry, with no hyphen at either end.
 */
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i;

/**
 * A final label a URL parser reads as a number, which turns the whole name into
 * an IPv4 address: `127.1` becomes `127.0.0.1` and `0x7f` becomes `0.0.0.127`.
 */
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/i;

/** A dotted quad with no leading zeros, which a URL parser would read as octal. */
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

const PORT_DIGITS = /^\d{1,5}$/;

const INVALID_HOST = "Invalid host: expected a hostname, an IPv4 address or an IPv6 address";
const INVALID_PORT = `Invalid port: expected an integer from 1 to ${MAX_PORT}`;

function isHostname(host: string): boolean {
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (name.length === 0 || name.length > MAX_HOSTNAME_LENGTH) return false;

  const labels = name.split(".");
  return labels.every((label) => LABEL.test(label)) && !NUMERIC_LABEL.test(labels[labels.length - 1]);
}

/**
 * An IPv6 literal without its brackets, or null. A zone (`fe80::1%eth0`) is
 * refused: a URL cannot carry one, and the percent sign is a smuggling vector.
 */
function ipv6Literal(host: string): string | null {
  const bracketed = host.startsWith("[") && host.endsWith("]");
  const address = bracketed ? host.slice(1, -1) : host;
  return !address.includes("%") && isIPv6(address) ? address : null;
}

/** The host in URL form, or a refusal. */
function validateHost(host: unknown): string {
  if (typeof host !== "string") throw new DatabaseConfigError(INVALID_HOST);

  const ipv6 = ipv6Literal(host);
  if (ipv6 !== null) {
    assertPublicLiteralHost(ipv6);
    return `[${ipv6.toLowerCase()}]`;
  }
  if (IPV4.test(host) || isHostname(host)) {
    assertPublicLiteralHost(host);
    return host.toLowerCase();
  }

  throw new DatabaseConfigError(INVALID_HOST);
}

/** An integer port from 1 to 65535, from a number or a string of digits alone. */
function validatePort(port: unknown): number {
  const value = typeof port === "string" && PORT_DIGITS.test(port) ? Number(port) : port;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PORT) return value;

  throw new DatabaseConfigError(INVALID_PORT);
}

/** Validate a connection's host and port for one scheme. */
export function httpOrigin(scheme: HttpScheme, host: unknown, port: unknown): HttpOrigin {
  return { scheme, host: validateHost(host), port: validatePort(port) };
}

/**
 * An IPv6 address as eight four-digit groups, so two spellings of one address
 * compare equal: a URL rewrites `::ffff:127.0.0.1` as `::ffff:7f00:1`. The input
 * has already passed `isIPv6`.
 */
function expandIPv6(host: string): string {
  let address = host.replace(/^\[|\]$/g, "").toLowerCase();

  const ipv4Tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (ipv4Tail) {
    const [a, b, c, d] = ipv4Tail.slice(1).map(Number);
    address = `${address.slice(0, ipv4Tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head, tail] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");

  return [...left, ...zeros, ...right].map((group) => group.padStart(4, "0")).join(":");
}

function sameHost(actual: string, intended: string): boolean {
  if (!intended.startsWith("[")) return actual === intended;
  return actual.startsWith("[") && expandIPv6(actual) === expandIPv6(intended);
}

function refuse(field: "host" | "port" | "path"): never {
  throw new DatabaseConfigError(
    `Invalid ${field}: the request URL would not address the configured ${field}, so it was not sent`,
  );
}

/**
 * The URL of one fixed path on a validated origin, with optional query
 * parameters.
 *
 * The path must already be in the form a URL keeps: absolute, with every dynamic
 * segment passed through `encodeURIComponent`. A path the URL would rewrite, a
 * dot segment or a raw `?` for instance, is refused rather than sent somewhere
 * else.
 */
export function endpointUrl(origin: HttpOrigin, pathname: string, params?: URLSearchParams): string {
  let url: URL;
  try {
    url = new URL(`${origin.scheme}://${origin.host}`);
  } catch {
    refuse("host");
  }

  // The setters are used for everything after the host, so no part can reach
  // another: a path cannot introduce a host, and a query cannot introduce a path.
  url.port = String(origin.port);
  url.pathname = pathname;
  if (params) url.search = params.toString();

  if (!sameHost(url.hostname, origin.host)) refuse("host");
  if (Number(url.port || DEFAULT_PORTS[origin.scheme]) !== origin.port) refuse("port");
  if (url.pathname !== pathname) refuse("path");

  return url.toString();
}

/** The origin as a URL serializes it: scheme and host, with the port only when it is not the scheme's default. */
function originString(origin: HttpOrigin): string {
  const url = new URL(`${origin.scheme}://${origin.host}`);
  url.port = String(origin.port);
  return url.origin;
}

/**
 * Refuse a link the server handed back unless it sits on the configured origin.
 *
 * A transport that follows links from a response body (a `nextUri` chain) would
 * otherwise send the connection's credential wherever the body points. The
 * refusal names only the two origins: a link's path and query can identify a
 * running query or carry a token.
 */
export function rejectForeignLink(link: string, origin: HttpOrigin): void {
  let target: URL;
  try {
    target = new URL(link);
  } catch {
    throw new ConnectionError("The server advertised a link that is not a URL, so it was not followed");
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new ConnectionError("The server advertised a link that is not an http or https URL, so it was not followed");
  }

  const port = Number(target.port || DEFAULT_PORTS[target.protocol === "https:" ? "https" : "http"]);
  if (target.protocol === `${origin.scheme}:` && sameHost(target.hostname, origin.host) && port === origin.port) return;

  throw new ConnectionError(
    `The server advertised a link on ${target.origin}, not on ${originString(origin)}, the address the connection uses, so it was not followed. A proxy that rewrites the Host header can cause this`,
  );
}

/** Where a redirect points, reduced to its origin, or null when that is no http(s) URL. */
function redirectOrigin(location: string, requestUrl: string): string | null {
  try {
    const target = new URL(location, requestUrl);
    return target.protocol === "http:" || target.protocol === "https:" ? target.origin : null;
  } catch {
    return null;
  }
}

function redirectTarget(location: string | null, requestUrl: string): string {
  if (location === null) return "with no Location header";

  const origin = redirectOrigin(location, requestUrl);
  return origin === null ? "to a Location that is not an http or https URL" : `to ${origin}`;
}

/**
 * Refuse a 3xx response.
 *
 * Every transport requests with `redirect: "manual"`, because a followed redirect
 * would carry the connection's credential to wherever the server pointed. The
 * refusal names the status and only the ORIGIN of the target: a Location path or
 * query can hold a token, and userinfo can hold a password.
 */
export function rejectRedirect(response: Pick<Response, "status" | "headers">, requestUrl: string): void {
  if (response.status < 300 || response.status > 399) return;

  const target = redirectTarget(response.headers.get("location"), requestUrl);
  throw new ConnectionError(
    `The server answered HTTP ${response.status}, a redirect ${target}, and redirects are not followed`,
  );
}
