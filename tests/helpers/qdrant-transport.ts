/**
 * A recording transport for the Qdrant REST client (vector-family spec 6.1): what `createRestQdrantClient` takes in
 * place of the shared `createNodeTransport`, so a test sees every request the client would have put on the wire and
 * answers it from memory, with no socket and no `mock.module()`.
 *
 * `calls` is the `LoggedCall` log `expectCalls` reads (tests/helpers/call-log.ts): the method is the request line
 * without the origin, `GET /collections/docs`, and the one argument is the body, or null where there is none.
 */
import type { NodeRequest, NodeResponse, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import type { QdrantTransportFactory } from "@/lib/db/providers/vector/qdrant/rest-client";
import type { LoggedCall } from "./call-log";

export type RecordedAnswer = (request: NodeRequest, line: string) => NodeResponse | Promise<NodeResponse>;

export interface RecordingQdrantTransport {
  readonly factory: QdrantTransportFactory;
  /** One entry per request, in order: `{ method: "POST /collections/docs/points/scroll", args: [body] }`. */
  readonly calls: LoggedCall[];
  /** Every request as the client handed it to the transport. */
  readonly requests: NodeRequest[];
  /** The options of every transport the factory built: one per client. */
  readonly built: NodeTransportOptions[];
  /** How many times a transport was closed. */
  closed(): number;
}

/** A 200 JSON answer with the text `text`. */
export function okAnswer(text: string): NodeResponse {
  return { status: 200, contentType: "application/json", retryAfter: null, text };
}

/** The request line of a transport request: its method, path and query, without the origin. */
function requestLine(request: NodeRequest): string {
  const url = new URL(request.url);
  return `${request.method} ${url.pathname}${url.search}`;
}

export function recordingQdrantTransport(
  answer: RecordedAnswer = () => okAnswer('{"result":null,"status":"ok","time":0}'),
): RecordingQdrantTransport {
  const calls: LoggedCall[] = [];
  const requests: NodeRequest[] = [];
  const built: NodeTransportOptions[] = [];
  let closed = 0;
  const factory: QdrantTransportFactory = (options): NodeTransport => {
    built.push(options);
    return {
      async request(request) {
        const line = requestLine(request);
        requests.push(request);
        calls.push({ method: line, args: [request.body ?? null] });
        return answer(request, line);
      },
      close() {
        closed += 1;
      },
    };
  };
  return { factory, calls, requests, built, closed: () => closed };
}
