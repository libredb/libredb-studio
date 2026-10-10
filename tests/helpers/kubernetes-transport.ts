/**
 * A recording transport for the Kubernetes client: what `createKubernetesClient` takes in place of the shared
 * `createNodeTransport`, so a test sees every request the client would have put on the wire and answers it from
 * memory, with no socket and no `mock.module()`.
 *
 * `calls` is the `LoggedCall` log `expectCalls` reads (tests/helpers/call-log.ts): the method is the request line
 * without the origin, `GET /api/v1/namespaces/shop/pods?limit=500`, and the one argument is the body, or null.
 */
import type { NodeRequest, NodeResponse, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import type { KubernetesSeams, KubernetesTransportFactory } from "@/lib/db/providers/platform/kubernetes/client";
import type { LoggedCall } from "./call-log";

export type KubernetesAnswerFn = (request: NodeRequest, line: string) => NodeResponse | Promise<NodeResponse>;

export interface RecordingKubernetesTransport {
  readonly factory: KubernetesTransportFactory;
  readonly calls: LoggedCall[];
  readonly requests: NodeRequest[];
  readonly built: NodeTransportOptions[];
  closed(): number;
}

/** A 2xx answer with a JSON body. */
export function jsonAnswer(body: unknown, status = 200, retryAfter: string | null = null): NodeResponse {
  return { status, contentType: "application/json", retryAfter, text: JSON.stringify(body) };
}

/** A failure answer whose body is a Status with `reason` and a message no sentence may carry. */
export function statusAnswer(code: number, reason: string, retryAfter: string | null = null): NodeResponse {
  return jsonAnswer(
    { kind: "Status", apiVersion: "v1", status: "Failure", message: "leaked-status-message", reason, code },
    code,
    retryAfter,
  );
}

/** The request line of a transport request: its method, path and query, without the origin. */
export function requestLine(request: NodeRequest): string {
  const url = new URL(request.url);
  return `${request.method} ${url.pathname}${url.search}`;
}

export function recordingKubernetesTransport(
  answer: KubernetesAnswerFn = () => jsonAnswer({}),
): RecordingKubernetesTransport {
  const calls: LoggedCall[] = [];
  const requests: NodeRequest[] = [];
  const built: NodeTransportOptions[] = [];
  let closed = 0;
  const factory: KubernetesTransportFactory = (options): NodeTransport => {
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

/** Seams over a recording transport and a fixed clock; `sleeps` records every wait the client asked for. */
export function testSeams(
  transport: RecordingKubernetesTransport,
  options: { readonly now?: number; readonly random?: number } = {},
): KubernetesSeams & { readonly sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    createTransport: transport.factory,
    now: () => options.now ?? Date.UTC(2026, 9, 10, 12, 0, 0),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => options.random ?? 0,
    sleeps,
  };
}
