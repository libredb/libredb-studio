/**
 * The Qdrant REST client (vector-family spec 6.1): the one implementation of `QdrantClient`, and the only file of
 * the provider that builds a path.
 *
 * It is given the route table when it is built and sends through the shared transport of 3.7, one keep-alive Agent
 * per connection with the `api-key` header set once, so every rule of that transport holds for every request: no
 * proxy variable, no redirect followed, no global agent, no `fetch`, a byte cap on every answer and nothing sent
 * twice (QE2, QE3).
 *
 * What it can send is closed three ways (QE10, QE16). The table must name exactly the 17 operations, so there is no
 * operation for a health, telemetry, metrics or snapshot-download path. A request may fill only the parameters its
 * route's template declares and carry only the query keys its route declares, so a key can never ride in a query
 * string. And a `GET` takes no body, while a `POST` takes one or none, as the OpenAPI document declares its bodies
 * optional. Each refusal is raised before the wire.
 *
 * A path parameter is refused when it is empty, `.` or `..`, holds `/` or a NUL, or is longer than 255 characters:
 * the server's own read-path rule, checked here because URL parsing would turn a dot segment into another route.
 * The dot-segment, slash and NUL checks apply to the value once percent-decoded as well, so `%2e%2e` or `a%2fb` is
 * refused too and a proxy that decodes the path sees no dot segment (QE1). Every other character reaches the server
 * through `encodeURIComponent`, so a collection from before 1.5 named `a:b` still opens. The answer is handed back whatever its status: errors.ts reads it.
 *
 * It has no logger and logs nothing at any level (QE19).
 */
import { QueryError } from "@/lib/db/errors";
import { endpointUrl } from "@/lib/db/http/endpoint";
import { createNodeTransport, type NodeTransport, type NodeTransportOptions } from "@/lib/db/http/node-transport";
import type { DatabaseType } from "@/lib/types";
import {
  QDRANT_OPS,
  type QdrantAnswer,
  type QdrantClient,
  type QdrantOp,
  type QdrantRequest,
  type QdrantRouteTemplate,
  type QdrantRouteTemplates,
} from "./client";
import type { QdrantConnectionOptions } from "./connection-options";

/** How the client gets its transport; a test hands in a recording one. */
export type QdrantTransportFactory = (options: NodeTransportOptions) => NodeTransport;

const PROVIDER: DatabaseType = "qdrant";
const MAX_NAME_LENGTH = 255;
const PARAMETER = /^\{([a-z_]+)\}$/;
const QUERY_KEY = /^[a-z_]+$/;

const INVALID_NAME =
  "A collection name or point id in the request path is empty, `.` or `..`, holds `/` or a NUL character, as written or once percent-decoded, or is longer than 255 characters, so nothing was sent.";

const MALFORMED_NAME =
  "A collection name or point id in the request path is not well-formed Unicode text, so nothing was sent.";

/** One piece of a path template: a literal segment, or the name of the parameter that fills it. */
type Segment = { readonly literal: string } | { readonly parameter: string };

interface Route {
  readonly method: "GET" | "POST";
  readonly segments: readonly Segment[];
  readonly parameters: ReadonlySet<string>;
  readonly query: ReadonlySet<string>;
}

function compile(op: string, template: QdrantRouteTemplate): Route {
  if (template.method !== "GET" && template.method !== "POST") {
    throw new TypeError(`The Qdrant route table gives ${op} a method that is neither GET nor POST`);
  }
  if (!template.path.startsWith("/"))
    throw new TypeError(`The Qdrant route table gives ${op} a path that is not absolute`);
  const segments = template.path
    .split("/")
    .slice(1)
    .map((segment): Segment => {
      const parameter = PARAMETER.exec(segment)?.[1];
      if (parameter !== undefined) return { parameter };
      // A literal segment is a plain word: anything else (a brace, a dot, an encoded byte) is a template this client cannot read.
      if (segment !== "" && !/^[a-z]+$/.test(segment)) {
        throw new TypeError(`The Qdrant route table gives ${op} a path segment this client cannot read`);
      }
      return { literal: segment };
    });
  for (const key of template.query) {
    if (!QUERY_KEY.test(key))
      throw new TypeError(`The Qdrant route table gives ${op} a query key this client cannot read`);
  }
  return {
    method: template.method,
    segments,
    parameters: new Set(segments.flatMap((segment) => ("parameter" in segment ? [segment.parameter] : []))),
    query: new Set(template.query),
  };
}

/** The route table, held to exactly the 17 operations: one more or one fewer is a programming error, raised at once. */
function compileRoutes(routes: QdrantRouteTemplates): ReadonlyMap<string, Route> {
  const given = new Set(Object.keys(routes));
  if (given.size !== QDRANT_OPS.length || QDRANT_OPS.some((op) => !given.has(op))) {
    throw new TypeError("The Qdrant route table must name exactly the 17 operations of the v1 console");
  }
  return new Map(QDRANT_OPS.map((op) => [op, compile(op, routes[op])]));
}

function refuse(message: string): never {
  throw new QueryError(message, PROVIDER);
}

/** A dot segment, or a value holding `/` or a NUL: what would take a path out of its one segment. */
function escapesItsSegment(value: string): boolean {
  return value === "." || value === ".." || value.includes("/") || value.includes("\0");
}

/**
 * The value percent-decoded once, so a proxy that decodes it sees no dot segment. A value that is not valid
 * percent-encoding is checked as written.
 */
function percentDecoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** QE1's read-path rule for one path parameter, then its encoding. The server counts the 255 in characters, as this does. */
function segmentOf(value: unknown): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    [...value].length > MAX_NAME_LENGTH ||
    escapesItsSegment(value) ||
    escapesItsSegment(percentDecoded(value))
  ) {
    refuse(INVALID_NAME);
  }
  try {
    return encodeURIComponent(value);
  } catch {
    // A lone surrogate: text no URL can carry.
    refuse(MALFORMED_NAME);
  }
}

function pathOf(route: Route, request: QdrantRequest): string {
  for (const name of Object.keys(request.params)) {
    if (!route.parameters.has(name))
      refuse("The request names a path parameter its route does not declare, so nothing was sent.");
  }
  const segments = route.segments.map((segment) =>
    "literal" in segment
      ? segment.literal
      : segmentOf(Object.hasOwn(request.params, segment.parameter) ? request.params[segment.parameter] : undefined),
  );
  return `/${segments.join("/")}`;
}

function queryOf(route: Route, request: QdrantRequest): URLSearchParams | undefined {
  const entries = Object.entries(request.query);
  if (entries.length === 0) return undefined;
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (!route.query.has(key))
      refuse("The request carries a query key its route does not declare, so nothing was sent.");
    if (typeof value !== "string") refuse("The request carries a query value that is not text, so nothing was sent.");
    params.set(key, value);
  }
  return params;
}

export function createRestQdrantClient(
  options: QdrantConnectionOptions,
  routes: QdrantRouteTemplates,
  createTransport: QdrantTransportFactory = createNodeTransport,
): QdrantClient {
  const table = compileRoutes(routes);
  const transport = createTransport({
    origin: options.origin,
    tls: options.tls,
    maxSockets: options.maxSockets,
    headers: options.headers,
  });
  return {
    async send(request: QdrantRequest, signal: AbortSignal): Promise<QdrantAnswer> {
      const route = table.get(request.op as QdrantOp);
      if (route === undefined) refuse("The request names an operation this client does not send, so nothing was sent.");
      if (route.method === "GET" && request.body !== undefined) {
        refuse("The request gives a body to a route that takes none, so nothing was sent.");
      }
      if (request.body !== undefined && typeof request.body !== "string") {
        refuse("The request gives a body that is not JSON text, so nothing was sent.");
      }
      const url = endpointUrl(options.origin, pathOf(route, request), queryOf(route, request));
      const answer = await transport.request({
        method: route.method,
        url,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal,
        maxResponseBytes: options.responseCapBytes,
      });
      return {
        status: answer.status,
        contentType: answer.contentType,
        retryAfter: answer.retryAfter,
        text: answer.text,
      };
    },
    close(): void {
      transport.close();
    },
  };
}
