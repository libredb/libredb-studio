/**
 * Every failure of a Kubernetes request as a sentence Studio composes from the request (verb, resource, namespace,
 * name) and the answer's status code and `reason`.
 *
 * The server's `Status.message` and an in-band watch `ERROR` event's message are never read: they name the identity
 * the request ran as and can echo a value the request carried. A `reason` is kept only when it is one CamelCase word,
 * the shape every Kubernetes reason has, so no other text of the answer reaches a sentence.
 */
import { AuthenticationError, type DatabaseError, QueryError, TimeoutError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { KUBERNETES_TYPE } from "./limits";

/** The request a sentence names: the RBAC verb, the resource (with its group) and where it was asked. */
export interface KubernetesRequestContext {
  readonly verb: "list" | "get" | "watch" | "create";
  /** The plural resource, or `pods/log` for a log read. */
  readonly resource: string;
  /** The API group, "" for the core group. */
  readonly group: string;
  readonly namespace?: string;
  readonly name?: string;
}

/** The parts of an answer a sentence may read: the status, the content type and the body (for `reason` only). */
export interface KubernetesAnswer {
  readonly status: number;
  readonly contentType: string | null;
  readonly text: string;
}

/** A refused or failed request, with the facts a caller acts on: the status, the reason and a missing type. */
export class KubernetesRequestError extends QueryError {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | undefined,
    /** A `text/plain` 404: the path names a resource type the server does not serve. */
    readonly typeMissing: boolean,
  ) {
    super(message, KUBERNETES_TYPE);
    this.name = "KubernetesRequestError";
    Object.setPrototypeOf(this, KubernetesRequestError.prototype);
  }
}

/** A response past its byte cap, so a reader that can ask for less (a smaller page) knows to. */
export class KubernetesResponseTooLargeError extends QueryError {
  constructor(message: string) {
    super(message, KUBERNETES_TYPE);
    this.name = "KubernetesResponseTooLargeError";
    Object.setPrototypeOf(this, KubernetesResponseTooLargeError.prototype);
  }
}

/** The 401 sentence: one request was sent, and nothing is retried. */
export const UNAUTHORIZED_SENTENCE =
  "The API server rejected the token or certificate (401 Unauthorized); a ServiceAccount token may have expired. Create a new token and paste it in the connection's Token field.";

const REASON = /^[A-Za-z]{1,64}$/;

/** The answer's `reason` when it is a JSON Status whose reason is one CamelCase word; undefined otherwise. */
export function statusReason(answer: KubernetesAnswer): string | undefined {
  if (!(answer.contentType ?? "").toLowerCase().startsWith("application/json")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const reason = (parsed as { readonly reason?: unknown }).reason;
  return typeof reason === "string" && REASON.test(reason) ? reason : undefined;
}

/** `deployments.apps`, `pods`: the resource as kubectl names it. */
export function resourceName(context: Pick<KubernetesRequestContext, "resource" | "group">): string {
  return context.group === "" ? context.resource : `${context.resource}.${context.group}`;
}

/** Where the request was asked: ` in the namespace shop`, or ` in the cluster`. */
function scopeWords(context: KubernetesRequestContext): string {
  return context.namespace === undefined ? " in the cluster" : ` in the namespace ${context.namespace}`;
}

/** `list deployments.apps in the namespace shop`, `get pods web in the namespace shop`. */
export function requestWords(context: KubernetesRequestContext): string {
  const name = context.name === undefined ? "" : ` ${context.name}`;
  return `${context.verb} ${resourceName(context)}${name}${scopeWords(context)}`;
}

/** The sentence for an identity that may not make this request: the tree's lock and the agent's `unavailable`. */
export function forbiddenSentence(context: KubernetesRequestContext): string {
  return `This connection's identity may not ${requestWords(context)} (403 Forbidden).`;
}

/** The sentence for a type the server does not serve, as kubectl says it after one discovery refresh. */
export function typeMissingSentence(resource: string): string {
  return `the server doesn't have a resource type "${resource}"`;
}

/** The sentence for a built-in kind whose API group or version this server does not serve. */
export function notServedSentence(
  labelPlural: string,
  context: Pick<KubernetesRequestContext, "resource" | "group">,
): string {
  return `This server does not serve ${labelPlural}: discovery lists no ${resourceName(context)}.`;
}

/** A non-2xx answer as a provider error. A 2xx answer is the caller's to read, never handed here. */
export function answerFailure(context: KubernetesRequestContext, answer: KubernetesAnswer): DatabaseError {
  const { status } = answer;
  if (status === 401) return new AuthenticationError(UNAUTHORIZED_SENTENCE, KUBERNETES_TYPE);
  const reason = statusReason(answer);
  const because = reason === undefined ? `HTTP ${status}` : `HTTP ${status}, reason ${reason}`;
  const words = requestWords(context);
  if (status === 403) return new KubernetesRequestError(forbiddenSentence(context), status, reason, false);
  if (status === 404) {
    const plain = (answer.contentType ?? "").toLowerCase().startsWith("text/plain");
    if (plain) return new KubernetesRequestError(typeMissingSentence(resourceName(context)), status, reason, true);
    const missing =
      context.name === undefined
        ? `The API server found nothing to ${words} (404 Not Found).`
        : `${resourceName(context)} ${context.name} was not found${scopeWords(context)} (404 Not Found).`;
    return new KubernetesRequestError(missing, status, reason, false);
  }
  if (status === 400 || status === 422)
    return new KubernetesRequestError(
      `The API server refused to ${words} as invalid (${because}).`,
      status,
      reason,
      false,
    );
  if (status === 410)
    return new KubernetesRequestError(
      `The list changed on the server while Studio read it page by page, so it cannot ${words} from where it stopped (${because}).`,
      status,
      reason,
      false,
    );
  if (status === 429)
    return new KubernetesRequestError(
      `The API server is limiting requests and did not ${words} (${because}); run it again in a few seconds.`,
      status,
      reason,
      false,
    );
  if (status >= 500)
    return new KubernetesRequestError(`The API server failed to ${words} (${because}).`, status, reason, false);
  return new KubernetesRequestError(`The API server did not ${words} (${because}).`, status, reason, false);
}

/** A transport failure as a provider error: the byte cap and the deadline in Studio's words, the rest as raised. */
export function transportFailure(
  context: KubernetesRequestContext,
  error: unknown,
  caps: { readonly maxResponseBytes: number; readonly timeoutMs: number },
): unknown {
  if (!(error instanceof TransportError)) return error;
  const words = requestWords(context);
  if (error.kind === "too-large") {
    const mib = caps.maxResponseBytes / (1024 * 1024);
    return new KubernetesResponseTooLargeError(
      `The answer to ${words} is larger than ${mib} MiB, the most Studio reads in one response; narrow it with -l or --field-selector.`,
    );
  }
  if (error.kind === "timeout")
    return new TimeoutError(
      `The API server did not answer the request to ${words} within ${caps.timeoutMs / 1000} s.`,
      KUBERNETES_TYPE,
      caps.timeoutMs,
    );
  return error;
}

/** The in-band `ERROR` event of a watch as a sentence from its code and reason; its message is never read. */
export function watchEventFailure(
  context: KubernetesRequestContext,
  event: { readonly code?: unknown; readonly reason?: unknown },
): QueryError {
  const code = typeof event.code === "number" && Number.isInteger(event.code) ? event.code : undefined;
  const reason = typeof event.reason === "string" && REASON.test(event.reason) ? event.reason : undefined;
  const parts = [
    code === undefined ? undefined : `code ${code}`,
    reason === undefined ? undefined : `reason ${reason}`,
  ];
  const detail = parts.filter((part): part is string => part !== undefined).join(", ");
  const because = detail === "" ? "" : ` (${detail})`;
  return new QueryError(
    `The watch to ${requestWords(context)} ended with an error event from the API server${because}; run it again to read from now.`,
    KUBERNETES_TYPE,
  );
}
