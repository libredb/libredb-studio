/**
 * The Weaviate REST client (#1566 spec 3.2): the one implementation of `WeaviateClient`, and the only file of the
 * provider that builds a path (spec W7).
 *
 * It is given the route table when it is built and sends through the shared transport, one keep-alive Agent per
 * connection with the `Authorization` header set once, so every rule of that transport holds for every request: no
 * proxy variable, no redirect followed, no global agent, no `fetch`, a byte cap on every answer and nothing sent
 * twice. The transport closes a pooled socket after 4 s idle, below Weaviate's 10 s idle close (spec A.7).
 *
 * What it can send is closed three ways. The table must name exactly the operations of `WEAVIATE_OPS`, so there is
 * no operation for a write, a backup or a user route. A request may fill only the parameters its route's template
 * declares and carry only the query keys its route declares. And a `GET` takes no body, while a `POST` takes one.
 * Each refusal is raised before the wire.
 *
 * A path parameter is refused when it is empty, `.` or `..`, holds `/` or a NUL, or is longer than 255 characters,
 * as written or once percent-decoded, because URL parsing would turn a dot segment into another route; phase 0 has
 * already held every name to Weaviate's own rule (spec W1), so this is the last line, not the first. It logs nothing.
 */
import { QueryError } from "@/lib/db/errors";
import { endpointUrl } from "@/lib/db/http/endpoint";
import { createNodeTransport, type NodeTransport, type NodeTransportOptions } from "@/lib/db/http/node-transport";
import type { DatabaseType } from "@/lib/types";
import {
  WEAVIATE_OPS,
  type WeaviateAnswer,
  type WeaviateClient,
  type WeaviateOp,
  type WeaviateRequest,
  type WeaviateRouteTemplate,
  type WeaviateRouteTemplates,
} from "./client";
import type { WeaviateConnectionOptions } from "./connection-options";

/** How the client gets its transport; a test hands in a recording one. */
export type WeaviateTransportFactory = (options: NodeTransportOptions) => NodeTransport;

const PROVIDER: DatabaseType = "weaviate";
const MAX_NAME_LENGTH = 255;
const PARAMETER = /^\{([a-z_]+)\}$/;
/** A literal segment: `v1`, `schema`, `near-vector`, `.well-known`. */
const LITERAL = /^[a-z0-9.-]+$/;
const QUERY_KEY = /^[a-z_]+$/;

const INVALID_NAME =
  "A name in the request path is empty, `.` or `..`, holds `/` or a NUL character, as written or once percent-decoded, or is longer than 255 characters, so nothing was sent.";

const MALFORMED_NAME = "A name in the request path is not well-formed Unicode text, so nothing was sent.";

type Segment = { readonly literal: string } | { readonly parameter: string };

interface Route {
  readonly method: "GET" | "POST";
  readonly segments: readonly Segment[];
  readonly parameters: ReadonlySet<string>;
  readonly query: ReadonlySet<string>;
}

function compile(op: string, template: WeaviateRouteTemplate): Route {
  if (template.method !== "GET" && template.method !== "POST") {
    throw new TypeError(`The Weaviate route table gives ${op} a method that is neither GET nor POST`);
  }
  if (!template.path.startsWith("/"))
    throw new TypeError(`The Weaviate route table gives ${op} a path that is not absolute`);
  const segments = template.path
    .split("/")
    .slice(1)
    .map((segment): Segment => {
      const parameter = PARAMETER.exec(segment)?.[1];
      if (parameter !== undefined) return { parameter };
      if (!LITERAL.test(segment) || segment === "." || segment === "..") {
        throw new TypeError(`The Weaviate route table gives ${op} a path segment this client cannot read`);
      }
      return { literal: segment };
    });
  for (const key of template.query) {
    if (!QUERY_KEY.test(key))
      throw new TypeError(`The Weaviate route table gives ${op} a query key this client cannot read`);
  }
  return {
    method: template.method,
    segments,
    parameters: new Set(segments.flatMap((segment) => ("parameter" in segment ? [segment.parameter] : []))),
    query: new Set(template.query),
  };
}

/** The route table, held to exactly the operations of `WEAVIATE_OPS`: one more or one fewer is a programming error. */
function compileRoutes(routes: WeaviateRouteTemplates): ReadonlyMap<string, Route> {
  const given = new Set(Object.keys(routes));
  if (given.size !== WEAVIATE_OPS.length || WEAVIATE_OPS.some((op) => !given.has(op))) {
    throw new TypeError(`The Weaviate route table must name exactly the ${WEAVIATE_OPS.length} operations`);
  }
  return new Map(WEAVIATE_OPS.map((op) => [op, compile(op, routes[op])]));
}

function refuse(message: string): never {
  throw new QueryError(message, PROVIDER);
}

function escapesItsSegment(value: string): boolean {
  return value === "." || value === ".." || value.includes("/") || value.includes("\0");
}

function percentDecoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

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
    refuse(MALFORMED_NAME);
  }
}

function pathOf(route: Route, request: WeaviateRequest): string {
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

function queryOf(route: Route, request: WeaviateRequest): URLSearchParams | undefined {
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

export function createRestWeaviateClient(
  options: WeaviateConnectionOptions,
  routes: WeaviateRouteTemplates,
  createTransport: WeaviateTransportFactory = createNodeTransport,
): WeaviateClient {
  const table = compileRoutes(routes);
  const transport = createTransport({
    origin: options.origin,
    tls: options.tls,
    maxSockets: options.maxSockets,
    headers: options.headers,
    // A connect that never completes names the host, the port and the seconds waited, as a ConnectionError.
    reportsUnreachable: true,
  });
  return {
    async send(request: WeaviateRequest, signal: AbortSignal): Promise<WeaviateAnswer> {
      const route = table.get(request.op as WeaviateOp);
      if (route === undefined) refuse("The request names an operation this client does not send, so nothing was sent.");
      if (route.method === "GET" && request.body !== undefined) {
        refuse("The request gives a body to a route that takes none, so nothing was sent.");
      }
      if (route.method === "POST" && typeof request.body !== "string") {
        refuse("The request gives a POST route no JSON text, so nothing was sent.");
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
