/**
 * Replay of the Kubernetes captures under tests/fixtures/kubernetes/: the integration test hands `replayTransport` to
 * the provider at its transport seam, and the end-to-end stub API server answers its sockets with `replayAnswer`.
 *
 * An answer is found by its request key: the method, the path and the query with its pairs sorted, so a request is
 * matched whatever order it lists its query in, and for a POST its body too, because the six self access reviews of
 * one connect share a path and are sent at once. One key may have been recorded more than once (discovery read again,
 * a list read by two scenarios); its answers are given in the order they were recorded, and the last is repeated once
 * they run out. A request nobody recorded answers `404` with `text/plain`, as an API server answers a path it does not
 * serve, so a replay never invents an answer. The `Accept` is not part of the key but must match too: where the
 * recording holds one, a request that asks for another answers `406`, as the log endpoint answers an Accept it does
 * not serve, so a change in what the provider asks for is never answered from a recording of the old ask.
 *
 * `recordingTransport` is the other half: it wraps a real transport factory and keeps each exchange in the shape a
 * fixture holds, for the capture script. It imports nothing at run time, so the Playwright process can load it too.
 */
import { readFileSync } from "node:fs";
import type { NodeRequest, NodeResponse, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import type { KubernetesExchange } from "./kubernetes-evidence-scrub";

/** One capture file: the exchanges of one persona's scenarios, in the order they were sent. */
export interface KubernetesCapture {
  readonly persona: string;
  readonly exchanges: readonly KubernetesExchange[];
}

/** The answer to a request nobody recorded. */
export const UNRECORDED_ANSWER: NodeResponse = Object.freeze({
  status: 404,
  contentType: "text/plain; charset=utf-8",
  retryAfter: null,
  text: "404 page not found\n",
});

/** The answer to a recorded request that asks for another `Accept` than the recording did. */
export const NOT_ACCEPTABLE_ANSWER: NodeResponse = Object.freeze({
  status: 406,
  contentType: "application/json",
  retryAfter: null,
  text: JSON.stringify({
    kind: "Status",
    apiVersion: "v1",
    metadata: {},
    status: "Failure",
    message: "the Accept of the request differs from the recorded one",
    reason: "NotAcceptable",
    code: 406,
  }),
});

/**
 * The request key: `GET /api/v1/namespaces?limit=500`, the query pairs sorted by name, then by value; a POST's body
 * follows after one space.
 */
export function requestKey(method: string, pathAndQuery: string, body?: string): string {
  const at = pathAndQuery.indexOf("?");
  const pairs =
    at === -1
      ? undefined
      : [...new URLSearchParams(pathAndQuery.slice(at + 1))].sort(([a, x], [b, y]) =>
          a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1,
        );
  const line =
    pairs === undefined
      ? `${method} ${pathAndQuery}`
      : `${method} ${pathAndQuery.slice(0, at)}?${new URLSearchParams(pairs).toString()}`;
  return method === "POST" && body !== undefined ? `${line} ${body}` : line;
}

/** A capture file as written by tests/live/kubernetes-evidence.ts. */
export function readCapture(file: string): KubernetesCapture {
  return JSON.parse(readFileSync(file, "utf8")) as KubernetesCapture;
}

/**
 * An answer function over recorded exchanges, by request key, in recorded order, the last one repeated; a request
 * whose Accept differs from the one recorded for that answer gets `NOT_ACCEPTABLE_ANSWER` and uses up no answer.
 */
export function replayAnswer(
  exchanges: readonly KubernetesExchange[],
): (method: string, pathAndQuery: string, body?: string, accept?: string) => NodeResponse {
  const queues = new Map<string, KubernetesExchange[]>();
  for (const exchange of exchanges) {
    const key = requestKey(exchange.request.method, exchange.request.path, exchange.request.body);
    queues.set(key, [...(queues.get(key) ?? []), exchange]);
  }
  const served = new Map<string, number>();
  return (method, pathAndQuery, body, accept) => {
    const key = requestKey(method, pathAndQuery, body);
    const queue = queues.get(key);
    if (queue === undefined) return UNRECORDED_ANSWER;
    const index = served.get(key) ?? 0;
    const exchange = queue[Math.min(index, queue.length - 1)];
    if (exchange.request.accept !== undefined && exchange.request.accept !== accept) return NOT_ACCEPTABLE_ANSWER;
    served.set(key, index + 1);
    return exchange.response;
  };
}

/** What a replay transport offers a test: the factory the provider takes, the keys it was asked, those not recorded. */
export interface ReplayTransport {
  readonly factory: (options: NodeTransportOptions) => NodeTransport;
  readonly asked: string[];
  readonly missed: string[];
}

/**
 * A transport factory that answers every request from the exchanges, through the same key the stub server uses; a
 * request answered neither by a recording nor with its recorded Accept is kept in `missed`, the latter with the
 * Accept it sent.
 */
export function replayTransport(exchanges: readonly KubernetesExchange[]): ReplayTransport {
  const answer = replayAnswer(exchanges);
  const asked: string[] = [];
  const missed: string[] = [];
  const factory = (): NodeTransport => ({
    async request(request: NodeRequest) {
      const url = new URL(request.url);
      const pathAndQuery = `${url.pathname}${url.search}`;
      const key = requestKey(request.method, pathAndQuery, request.body);
      asked.push(key);
      const accept = request.headers?.accept;
      const response = answer(request.method, pathAndQuery, request.body, accept);
      if (response === UNRECORDED_ANSWER) missed.push(key);
      if (response === NOT_ACCEPTABLE_ANSWER) missed.push(`${key} accept: ${accept ?? "(none)"}`);
      return response;
    },
    close() {},
  });
  return { factory, asked, missed };
}

/** A transport factory that sends through `inner` and keeps every exchange in `sink`, in the order they finished. */
export function recordingTransport(
  inner: (options: NodeTransportOptions) => NodeTransport,
  sink: KubernetesExchange[],
): (options: NodeTransportOptions) => NodeTransport {
  return (options) => {
    const transport = inner(options);
    return {
      async request(request: NodeRequest) {
        const response = await transport.request(request);
        const url = new URL(request.url);
        sink.push({
          request: {
            method: request.method,
            path: `${url.pathname}${url.search}`,
            ...(request.headers?.accept === undefined ? {} : { accept: request.headers.accept }),
            ...(request.body === undefined ? {} : { body: request.body }),
          },
          response: {
            status: response.status,
            contentType: response.contentType,
            retryAfter: response.retryAfter,
            text: response.text,
          },
        });
        return response;
      },
      close() {
        transport.close();
      },
    };
  };
}
