/**
 * The thin Kubernetes client on the shared node transport: one transport per connection, every request planned and
 * admitted by `request-policy.ts` before the transport is reached, the URL built under the connection's API path,
 * Studio's own `accept` header, a byte cap and a deadline on every request, and every non-2xx answer turned into a
 * Studio sentence by `errors.ts`.
 *
 * The token is the transport's fixed `authorization` connection header and the user-agent its other one; `accept`
 * is the one header a request may add. The transport refuses a link-local address and a 101 answer, follows no
 * redirect and retries nothing. The client itself sends a request again in one case only: a 429 whose Retry-After
 * asks for at most 5 s, waited once with a little random jitter. A 401 is never retried.
 *
 * Clock, sleep, randomness and the transport factory are seams, so a test drives every wait without a timer.
 */
import { QueryError } from "@/lib/db/errors";
import { endpointUrl } from "@/lib/db/http/endpoint";
import {
  createNodeTransport,
  type NodeResponse,
  type NodeTransport,
  type NodeTransportOptions,
} from "@/lib/db/http/node-transport";
import type { ClusterEndpoint } from "./connection-options";
import { answerFailure, requestWords, transportFailure } from "./errors";
import {
  KUBERNETES_MAX_RESPONSE_BYTES,
  KUBERNETES_RETRY_AFTER_DEFAULT_MS,
  KUBERNETES_RETRY_AFTER_MAX_MS,
  KUBERNETES_RETRY_JITTER_MS,
  KUBERNETES_TYPE,
} from "./limits";
import { admitRequest, finalPathRefusal, type KubernetesRequest, planRequest } from "./request-policy";

/** How the client gets its transport; a test hands in a recording one. */
export type KubernetesTransportFactory = (options: NodeTransportOptions) => NodeTransport;

/** The seams every timed or random step goes through. */
export interface KubernetesSeams {
  readonly createTransport: KubernetesTransportFactory;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  /** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A number in [0, 1). */
  readonly random: () => number;
}

/** The real clock, timer and randomness, and the shared node transport. */
export const DEFAULT_KUBERNETES_SEAMS: KubernetesSeams = Object.freeze({
  createTransport: createNodeTransport,
  now: () => Date.now(),
  sleep: (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  random: () => Math.random(),
});

/** The Accept of a JSON read: plain JSON. */
export const ACCEPT_JSON = "application/json";
/** The Accept of a Table read, falling back to plain JSON where a server cannot render a Table (no 406). */
export const ACCEPT_TABLE = "application/json;as=Table;v=v1;g=meta.k8s.io,application/json";
/** The Accept of aggregated discovery: v2, then v2beta1, then plain JSON, as kubectl asks. */
export const ACCEPT_DISCOVERY =
  "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,application/json;g=apidiscovery.k8s.io;v=v2beta1;as=APIGroupDiscoveryList,application/json";

/** One request's caller side: its cancel, its deadline, its Accept and its byte cap. */
export interface KubernetesCall {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** ACCEPT_JSON when absent. */
  readonly accept?: string;
  /** KUBERNETES_MAX_RESPONSE_BYTES when absent; never above it. */
  readonly maxResponseBytes?: number;
}

/** A 2xx answer. */
export interface KubernetesResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly text: string;
}

export interface KubernetesClient {
  /** Sends one request; resolves with a 2xx answer, rejects with a provider error otherwise. */
  send(request: KubernetesRequest, call: KubernetesCall): Promise<KubernetesResponse>;
  /** `send`, then the body parsed as JSON, whatever the answer's content type. */
  json(request: KubernetesRequest, call: KubernetesCall): Promise<unknown>;
  close(): void;
}

/** The wait a Retry-After asks for, in milliseconds: seconds or an HTTP date; the default when absent or unreadable. */
export function retryAfterMs(value: string | null, now: number): number {
  if (value === null) return KUBERNETES_RETRY_AFTER_DEFAULT_MS;
  const text = value.trim();
  if (/^[0-9]{1,9}$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  if (Number.isNaN(date)) return KUBERNETES_RETRY_AFTER_DEFAULT_MS;
  return Math.max(0, date - now);
}

export function createKubernetesClient(
  endpoint: ClusterEndpoint,
  seams: KubernetesSeams = DEFAULT_KUBERNETES_SEAMS,
): KubernetesClient {
  const transport = seams.createTransport({
    origin: endpoint.origin,
    tls: endpoint.tls,
    maxSockets: endpoint.maxSockets,
    headers: endpoint.headers,
    requestHeaderNames: ["accept"],
    refusesLinkLocal: true,
    refusesUpgrade: true,
  });

  const once = async (request: KubernetesRequest, call: KubernetesCall): Promise<NodeResponse> => {
    const planned = planRequest(request);
    const fullPath = `${endpoint.apiPath}${planned.path}`;
    const pathRefusal = finalPathRefusal(fullPath);
    if (pathRefusal !== undefined) throw new QueryError(pathRefusal, KUBERNETES_TYPE);
    // The gate the transport is never reached without: the final method, path and query.
    admitRequest(planned.method, planned.path, planned.query);
    const params = new URLSearchParams();
    for (const [key, value] of planned.query) params.append(key, value);
    const maxResponseBytes = Math.min(
      call.maxResponseBytes ?? KUBERNETES_MAX_RESPONSE_BYTES,
      KUBERNETES_MAX_RESPONSE_BYTES,
    );
    try {
      return await transport.request({
        method: planned.method,
        url: endpointUrl(endpoint.origin, fullPath, planned.query.length === 0 ? undefined : params),
        ...(planned.body === undefined ? {} : { body: planned.body }),
        headers: { accept: call.accept ?? ACCEPT_JSON },
        signal: AbortSignal.any([call.signal, AbortSignal.timeout(call.timeoutMs)]),
        maxResponseBytes,
      });
    } catch (error) {
      throw transportFailure(planned.context, error, { maxResponseBytes, timeoutMs: call.timeoutMs });
    }
  };

  const send = async (request: KubernetesRequest, call: KubernetesCall): Promise<KubernetesResponse> => {
    let answer = await once(request, call);
    if (answer.status === 429) {
      const wait = retryAfterMs(answer.retryAfter, seams.now());
      const context = planRequest(request).context;
      if (wait > KUBERNETES_RETRY_AFTER_MAX_MS) {
        throw new QueryError(
          `The API server is limiting requests and asked Studio to wait ${Math.ceil(wait / 1000)} s before it would ${requestWords(context)}, longer than the ${KUBERNETES_RETRY_AFTER_MAX_MS / 1000} s Studio waits; run it again later.`,
          KUBERNETES_TYPE,
        );
      }
      const jitter = Math.floor(seams.random() * KUBERNETES_RETRY_JITTER_MS);
      await seams.sleep(Math.min(wait + jitter, KUBERNETES_RETRY_AFTER_MAX_MS), call.signal);
      answer = await once(request, call);
    }
    if (answer.status < 200 || answer.status > 299) throw answerFailure(planRequest(request).context, answer);
    return { status: answer.status, contentType: answer.contentType, text: answer.text };
  };

  return {
    send,
    async json(request: KubernetesRequest, call: KubernetesCall): Promise<unknown> {
      const answer = await send(request, call);
      try {
        return JSON.parse(answer.text);
      } catch {
        throw new QueryError(
          `The API server answered the request to ${requestWords(planRequest(request).context)} with a body that is not JSON.`,
          KUBERNETES_TYPE,
        );
      }
    },
    close(): void {
      transport.close();
    },
  };
}
