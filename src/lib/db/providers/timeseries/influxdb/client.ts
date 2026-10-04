/**
 * The InfluxDB route-table client (InfluxDB spec 3.3; I4, I5, E8): the one thing in this directory that sends, and
 * the only file that imports the shared transport's factory.
 *
 * It is given a route table when it is built and sends through the shared `node:http(s)` transport, one keep-alive
 * Agent per connection with the connection's one `authorization` header set once, so every rule of that transport
 * holds for every request: no proxy variable, no redirect followed, no global agent, no `fetch`, a byte cap on
 * every answer and nothing sent twice.
 *
 * What it can send is closed by the table. A request names a route and fills only the keys that route declares as
 * `fill`; a key the route does not declare, a key the table fixes, a missing required key and a value that is not
 * text are each refused before the transport is called, naming the key and never a value. A route's `query` keys
 * go into the URL through `URLSearchParams`, its `body` keys into `JSON.stringify` of exactly those keys, and its
 * `form` keys into `NodeRequest.form`, which the transport serialises: no form text is built here. A table row
 * that declares both a body and form fields, a GET with either, or a POST with a URL query key is refused too, so a
 * table edited wrongly sends nothing.
 *
 * The answer is handed back whatever its status, without a header (R2): errors.ts reads it. It has no logger and
 * logs nothing at any level.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { endpointUrl } from "@/lib/db/http/endpoint";
import { createNodeTransport, type NodeTransport, type NodeTransportOptions } from "@/lib/db/http/node-transport";
import type { InfluxConnectionOptions } from "./connection-options";
import type { InfluxRoute, InfluxRouteTable, RouteValue } from "./routes";

export interface InfluxRequest<Id extends string> {
  readonly route: Id;
  /** Only keys the route declares as `fill`; a missing required key or an undeclared key is refused before the wire. */
  readonly values: Readonly<Record<string, string>>;
}

export interface InfluxAnswer {
  readonly status: number;
  readonly contentType: string | null;
  /** No response header is handed back (R2): the version comes from the `/ping` and `/health` bodies. */
  readonly text: string;
}

export interface InfluxClient<Id extends string> {
  send(request: InfluxRequest<Id>, signal: AbortSignal): Promise<InfluxAnswer>;
  close(): void;
}

/** A consumer receives only the routes it calls. */
export type InfluxSend<Id extends string> = (request: InfluxRequest<Id>, signal: AbortSignal) => Promise<InfluxAnswer>;

/** How the client gets its transport; a test hands in a recording one. */
export type InfluxTransportFactory = (options: NodeTransportOptions) => NodeTransport;

type KeyTable = Readonly<Record<string, RouteValue>>;

const NO_KEYS: KeyTable = Object.freeze({});

/** The fault of a row no request may be built from, or undefined for a row the client sends. */
function routeFault(id: string, route: InfluxRoute): string | undefined {
  if (route.body !== undefined && route.form !== undefined) {
    return `The route "${id}" declares both a JSON body and form fields, so nothing was sent.`;
  }
  const hasBody = route.body !== undefined || route.form !== undefined;
  if (route.method === "GET" && hasBody) return `The route "${id}" is a GET that declares a body, so nothing was sent.`;
  if (route.method === "POST" && Object.keys(route.query).length > 0) {
    return `The route "${id}" is a POST that declares a URL query key, so nothing was sent.`;
  }
  return undefined;
}

/** The fault of the values a request gives: a key no part of the route lets it fill, or a value that is not text. */
function valuesFault(route: InfluxRoute, values: Readonly<Record<string, unknown>>): string | undefined {
  const parts = [route.query, route.body ?? NO_KEYS, route.form ?? NO_KEYS];
  for (const key of Object.keys(values)) {
    const fillable = parts.some((part) => Object.hasOwn(part, key) && "fill" in part[key]);
    if (!fillable) {
      return `The request fills the key "${key}", which its route does not let a request fill, so nothing was sent.`;
    }
    if (typeof values[key] !== "string") {
      return `The request gives the key "${key}" a value that is not text, so nothing was sent.`;
    }
  }
  return undefined;
}

export function createInfluxClient<Id extends string>(
  options: InfluxConnectionOptions,
  routes: InfluxRouteTable<Id>,
  createTransport: InfluxTransportFactory = createNodeTransport,
): InfluxClient<Id> {
  const transport = createTransport({
    origin: options.origin,
    tls: options.tls,
    maxSockets: options.maxSockets,
    headers: options.headers,
  });

  function refuse(message: string): never {
    throw new DatabaseConfigError(message, options.type);
  }

  /** One part of a route as the pairs it sends, in the table's order: fixed values, then what the request filled. */
  function filled(table: KeyTable, values: Readonly<Record<string, string>>): [string, string][] {
    const pairs: [string, string][] = [];
    for (const [key, value] of Object.entries(table)) {
      if ("fixed" in value) pairs.push([key, value.fixed]);
      else if (Object.hasOwn(values, key)) pairs.push([key, values[key]]);
      else if (value.fill === "required") {
        refuse(`The request is missing the key "${key}", which its route requires, so nothing was sent.`);
      }
    }
    return pairs;
  }

  return {
    async send(request: InfluxRequest<Id>, signal: AbortSignal): Promise<InfluxAnswer> {
      if (!Object.hasOwn(routes, request.route)) {
        refuse("The request names a route this client does not send, so nothing was sent.");
      }
      const route = routes[request.route];
      const fault = routeFault(request.route, route) ?? valuesFault(route, request.values);
      if (fault !== undefined) refuse(fault);

      const query = filled(route.query, request.values);
      const url = endpointUrl(options.origin, route.path, query.length === 0 ? undefined : new URLSearchParams(query));
      const answer = await transport.request({
        method: route.method,
        url,
        ...(route.body === undefined
          ? {}
          : { body: JSON.stringify(Object.fromEntries(filled(route.body, request.values))) }),
        ...(route.form === undefined ? {} : { form: Object.fromEntries(filled(route.form, request.values)) }),
        signal,
        maxResponseBytes: options.responseCapBytes,
      });
      return { status: answer.status, contentType: answer.contentType, text: answer.text };
    },
    close(): void {
      transport.close();
    },
  };
}

export type InfluxClientFactory = typeof createInfluxClient;
