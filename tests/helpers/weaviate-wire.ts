/**
 * Wire stand-ins for the Weaviate unit tests (#1566 spec 7.3): a recording transport `createRestWeaviateClient`
 * takes in place of the shared `createNodeTransport`, so a test sees every request the client would have put on the
 * wire with no socket and no `mock.module()`, and the answers live servers gave, read from the captures under
 * tests/fixtures/weaviate/.
 *
 * `calls` is the `LoggedCall` log `expectCalls` reads (tests/helpers/call-log.ts): the method is the request line
 * without the origin, `GET /v1/schema/Article`, and the one argument is the body, or null where there is none.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeRequest, NodeResponse, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import type { WeaviateAnswer } from "@/lib/db/providers/vector/weaviate/client";
import type { WeaviateTransportFactory } from "@/lib/db/providers/vector/weaviate/rest-client";
import type { LoggedCall } from "./call-log";

export type RecordedAnswer = (request: NodeRequest, line: string) => NodeResponse | Promise<NodeResponse>;

export interface RecordingWeaviateTransport {
  readonly factory: WeaviateTransportFactory;
  /** One entry per request, in order: `{ method: "POST /v1/search/Article/bm25", args: [body] }`. */
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

function requestLine(request: NodeRequest): string {
  const url = new URL(request.url);
  return `${request.method} ${url.pathname}${url.search}`;
}

export function recordingWeaviateTransport(answer: RecordedAnswer = () => okAnswer("{}")): RecordingWeaviateTransport {
  const calls: LoggedCall[] = [];
  const requests: NodeRequest[] = [];
  const built: NodeTransportOptions[] = [];
  let closed = 0;
  const factory: WeaviateTransportFactory = (options): NodeTransport => {
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

const FIXTURES = join(import.meta.dir, "..", "fixtures", "weaviate");

interface CapturedExchange {
  readonly method: string;
  readonly path: string;
  readonly answer: WeaviateAnswer | null;
}

/** The answer a live server gave to `line` (`GET /v1/meta`) in the capture `file`, as it crossed the seam. */
export function capturedAnswer(file: string, line: string): WeaviateAnswer {
  const capture = JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as {
    readonly exchanges: readonly CapturedExchange[];
  };
  const found = capture.exchanges.find((exchange) => `${exchange.method} ${exchange.path}` === line)?.answer;
  if (found === undefined || found === null) throw new Error(`${file} holds no answer to ${line}`);
  return { status: found.status, contentType: found.contentType, retryAfter: found.retryAfter, text: found.text };
}
