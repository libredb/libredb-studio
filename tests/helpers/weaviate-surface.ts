/**
 * What the Weaviate unit tests share (#1566 spec 3.1, 7.3): the answers the captures under tests/fixtures/weaviate/
 * hold, looked up by the request Studio would put on the wire, and a fake client that records every request it is
 * sent and answers from a function a test writes.
 *
 * A captured answer is found by method, path and body through the real REST client, so a request is matched as
 * `rest-client.ts` spells it; unlike the replay transport of weaviate-scenario.ts, an exchange may be asked for
 * again, and a request the capture does not hold throws by name.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeTransport } from "@/lib/db/http/node-transport";
import type {
  WeaviateAnswer,
  WeaviateClient,
  WeaviateOp,
  WeaviateRequest,
} from "@/lib/db/providers/vector/weaviate/client";
import {
  buildWeaviateConnectionOptions,
  type WeaviateConnectionOptions,
} from "@/lib/db/providers/vector/weaviate/connection-options";
import type { WeaviatePathState } from "@/lib/db/providers/vector/weaviate/execute";
import type { WeaviateClientFactory } from "@/lib/db/providers/vector/weaviate/index";
import type { WeaviateSurfaceContext } from "@/lib/db/providers/vector/weaviate/objects";
import { createRestWeaviateClient } from "@/lib/db/providers/vector/weaviate/rest-client";
import { WEAVIATE_CLIENT_ROUTES } from "@/lib/db/providers/vector/weaviate/routes";
import {
  readWeaviateVersion,
  type WeaviatePath,
  type WeaviatePathKind,
  type WeaviateVersion,
} from "@/lib/db/providers/vector/weaviate/versions";
import type { ObjectSourcePart } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import type { LoggedCall } from "./call-log";
import type { WeaviateExchange } from "./weaviate-scenario";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "weaviate");

export const WEAVIATE_TEST_CONNECTION: DatabaseConnection = {
  id: "weaviate-unit",
  name: "Weaviate",
  type: "weaviate",
  host: "127.0.0.1",
  port: 8080,
  createdAt: new Date(0),
};

/** The options a plain connection to 127.0.0.1:8080 is built with. */
export function testOptions(): WeaviateConnectionOptions {
  return buildWeaviateConnectionOptions(WEAVIATE_TEST_CONNECTION, { executionReadOnly: false, queryTimeout: 30_000 });
}

/** A version as `GET /v1/meta` reports it. */
export function version(text: string): WeaviateVersion {
  return readWeaviateVersion(JSON.stringify({ version: text }));
}

export function answer(status: number, text: string, contentType: string | null = "application/json"): WeaviateAnswer {
  return { status, contentType, retryAfter: null, text };
}

export function json(value: unknown, status = 200): WeaviateAnswer {
  return answer(status, JSON.stringify(value));
}

/** The words Weaviate answers when a path is switched off, in the shapes measured on 1.37.4 and 1.40.2. */
export const GRAPHQL_DISABLED = json({ error: [{ message: "graphql api is disabled" }] }, 422);
export const REST_SEARCH_DISABLED = json(
  { error: [{ message: "rest search api is experimental and not enabled" }] },
  422,
);
export const routeAbsent = (path: string): WeaviateAnswer =>
  json({ code: 404, message: `path ${path} was not found` }, 404);

export function captureExchanges(file: string): readonly WeaviateExchange[] {
  return (JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as { exchanges: WeaviateExchange[] }).exchanges;
}

/** One captured answer's text, by method and path (and body, where given). */
export function capturedText(file: string, method: string, path: string, body: string | null = null): string {
  const found = captureExchanges(file).find(
    (exchange) => exchange.method === method && exchange.path === path && exchange.body === body,
  );
  if (found?.answer == null) throw new Error(`${file} holds no answer to ${method} ${path}`);
  return found.answer.text;
}

/** The server a capture recorded, answering any request it holds, as often as it is asked. */
export function capturedServer(file: string): (request: WeaviateRequest) => Promise<WeaviateAnswer> {
  const exchanges = captureExchanges(file);
  const transport: NodeTransport = {
    async request(request) {
      const url = new URL(request.url);
      const path = `${url.pathname}${url.search}`;
      const body = request.body ?? null;
      const found = exchanges.find(
        (exchange) => exchange.method === request.method && exchange.path === path && exchange.body === body,
      );
      if (found?.answer == null) throw new Error(`${file} holds no answer to ${request.method} ${path} ${body ?? ""}`);
      return found.answer;
    },
    close() {},
  };
  const client = createRestWeaviateClient(testOptions(), WEAVIATE_CLIENT_ROUTES, () => transport);
  return (request) => client.send(request, new AbortController().signal);
}

export type Answering = (request: WeaviateRequest, signal: AbortSignal) => WeaviateAnswer | Promise<WeaviateAnswer>;

/** The capture's server with some operations answered otherwise. */
export function overriding(base: Answering, answers: Partial<Record<WeaviateRequest["op"], Answering>>): Answering {
  return (request, signal) => (answers[request.op] ?? base)(request, signal);
}

export interface FakeClients {
  readonly factory: WeaviateClientFactory;
  /** The options each client was built with, in order. */
  readonly built: WeaviateConnectionOptions[];
  /** Every request sent, as `{ method: op, args: [request] }`. */
  readonly calls: LoggedCall[];
  readonly signals: AbortSignal[];
  closed: number;
  inFlight: number;
  maxInFlight: number;
}

/** A client factory whose clients record every request and answer through `answering`. */
export function fakeClients(answering: Answering): FakeClients {
  const record: FakeClients = {
    factory: undefined as unknown as WeaviateClientFactory,
    built: [],
    calls: [],
    signals: [],
    closed: 0,
    inFlight: 0,
    maxInFlight: 0,
  };
  (record as { factory: WeaviateClientFactory }).factory = (options) => {
    record.built.push(options);
    const client: WeaviateClient = {
      async send(request, signal) {
        record.calls.push({ method: request.op, args: [request] });
        record.signals.push(signal);
        record.inFlight += 1;
        record.maxInFlight = Math.max(record.maxInFlight, record.inFlight);
        try {
          return await answering(request, signal);
        } finally {
          record.inFlight -= 1;
        }
      },
      close() {
        record.closed += 1;
      },
    };
    return client;
  };
  return record;
}

/** An answer that never comes: it rejects with the signal's reason once the signal aborts. */
export function hanging(_request: WeaviateRequest, signal: AbortSignal): Promise<WeaviateAnswer> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("resolved");
}

/** The session's path memory, as index.ts keeps it, with what it holds visible to a test. */
export function pathMemory(initial: Partial<Record<WeaviatePathKind, WeaviatePath>> = {}): WeaviatePathState & {
  readonly known: Map<WeaviatePathKind, WeaviatePath>;
} {
  const known = new Map(Object.entries(initial) as [WeaviatePathKind, WeaviatePath][]);
  return {
    known,
    get: (kind) => known.get(kind),
    set: (kind, path) => {
      known.set(kind, path);
    },
  };
}

/** A surface context over `answering`, recording every request it sends. */
export function surfaceContext(
  answering: Answering,
  over: { readonly version?: string; readonly scoped?: boolean; readonly paths?: WeaviatePathState } = {},
): { readonly context: WeaviateSurfaceContext<WeaviateOp>; readonly calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  const signal = new AbortController().signal;
  return {
    calls,
    context: {
      send: async (request, given) => {
        calls.push({ method: request.op, args: [request] });
        return answering(request, given);
      },
      signal,
      version: version(over.version ?? "1.40.2"),
      paths: over.paths ?? pathMemory(),
      scoped: over.scoped ?? false,
    },
  };
}

/** A Source part with its text: what every Weaviate part is, since none is ever unavailable. */
export function renderedPart(part: ObjectSourcePart): Extract<ObjectSourcePart, { readonly text: string }> {
  if (!("text" in part)) throw new Error(`the part ${part.id} has no text`);
  return part;
}
