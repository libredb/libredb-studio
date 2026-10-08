/**
 * Whether a failed Databend request is sent again, and after how long (design 3.11).
 *
 * The rule is the request kind against what came back: the gateway kind, the HTTP status, or the node transport's
 * failure kind, never message text. A statement POST the warehouse may have received is never resent, because
 * Databend could run it twice: only a gateway `ProvisionWarehouseTimeout`, which the gateway answers without
 * forwarding (databend-go issue 35), sends it again with the same ids. The query server never answers 503 itself and
 * turns its own 429 into an in-body error, so a 503 or 429 is an intermediary's of unmeasured timing, and only a GET
 * (a page, final or kill, each of which the server re-serves) is retried for it. ROLLBACK and logout are best effort
 * under their own 5 s and never retried.
 *
 * The backoff is 1, 2, 4, 8, 8 s with 20 percent jitter either way: at most six POST and three GET attempts, a
 * `Retry-After` in seconds honoured, and never a wait that reaches the time left. A page's attempt timer that expired
 * with time left re-requests the same page at once, one time, inside the three GET attempts [X15]; with no time left
 * it is the statement deadline, which is never retried.
 *
 * Pure: the time left and the random value are inputs.
 */
import type { TransportError } from "@/lib/db/http/node-transport";

/** What failed: the statement POST, a GET of the chain, or a best-effort close. */
export type RetryRequest = "query" | "page" | "final" | "kill" | "rollback" | "logout";

export interface RetryInput {
  readonly request: RetryRequest;
  /** The HTTP status of the answer; null when none arrived. */
  readonly status: number | null;
  /** The gateway's `kind`, read from the answer body; null when it has none. */
  readonly gatewayKind: string | null;
  /** The node transport's failure kind; null when an answer arrived. */
  readonly transportKind: TransportError["kind"] | null;
  /** The attempts already made, this failed one included, so 1 after the first. */
  readonly attempt: number;
  /** Time left before the request's deadline, in ms. */
  readonly msLeft: number;
  /** The `Retry-After` header as received; null when absent. */
  readonly retryAfter: string | null;
  /** One draw of `random()`, in [0, 1). */
  readonly random: number;
  /** True once this page was already requested again after its attempt timer expired. */
  readonly pageTimerRetried: boolean;
}

export type RetryDecision = { readonly retry: false } | { readonly retry: true; readonly delayMs: number };

const PROVISION_WAREHOUSE_TIMEOUT = "ProvisionWarehouseTimeout";

/** The statuses an intermediary may answer for a GET the server re-serves. */
const RETRIED_GET_STATUSES: ReadonlySet<number | null> = new Set([429, 502, 503, 504, 520]);

const BACKOFF_MS = [1000, 2000, 4000, 8000, 8000] as const;
const JITTER = 0.2;
const MAX_POST_ATTEMPTS = 6;
const MAX_GET_ATTEMPTS = 3;
const DELTA_SECONDS = /^[0-9]+$/;

const NO_RETRY: RetryDecision = Object.freeze({ retry: false });

/** How the failure is retried, or null when it is not: after the backoff, or the same page at once. */
function retryKind(input: RetryInput): "backoff" | "same-page" | null {
  if (input.request === "rollback" || input.request === "logout") return null;
  if (input.gatewayKind === PROVISION_WAREHOUSE_TIMEOUT) return "backoff";
  if (input.gatewayKind !== null) return null;

  const isGet = input.request !== "query";
  if (input.transportKind === "network") return isGet ? "backoff" : null;
  if (input.transportKind === "timeout") {
    return input.request === "page" && input.msLeft > 0 && !input.pageTimerRetried ? "same-page" : null;
  }
  if (input.transportKind !== null) return null;

  return isGet && RETRIED_GET_STATUSES.has(input.status) ? "backoff" : null;
}

/** The backoff step of this attempt, jittered by 20 percent either way, or longer when `Retry-After` asks for it. */
function backoffMs(input: RetryInput): number {
  const base = BACKOFF_MS[input.attempt - 1] as number;
  const jittered = Math.round(base * (1 - JITTER + 2 * JITTER * input.random));
  const retryAfterMs =
    input.retryAfter !== null && DELTA_SECONDS.test(input.retryAfter) ? Number(input.retryAfter) * 1000 : 0;
  return Math.max(jittered, retryAfterMs);
}

export function retryDecision(input: RetryInput): RetryDecision {
  const kind = retryKind(input);
  if (kind === null) return NO_RETRY;

  const maxAttempts = input.request === "query" ? MAX_POST_ATTEMPTS : MAX_GET_ATTEMPTS;
  if (input.attempt >= maxAttempts) return NO_RETRY;
  if (kind === "same-page") return { retry: true, delayMs: 0 };

  const delayMs = backoffMs(input);
  return delayMs < input.msLeft ? { retry: true, delayMs } : NO_RETRY;
}
