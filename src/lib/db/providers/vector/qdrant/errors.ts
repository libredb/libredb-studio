/**
 * The Qdrant error table (vector-family spec 6.10, QE20): what an answer that is not a success is, and the
 * sentence a person reads for it and for a request that never completed.
 *
 * Two halves. `answerFailure` reads an answer's status and text into a `QdrantError` with a category, and keeps
 * the server's text as `detail`. `toProviderError` words that error, or the shared transport's, as one of the
 * repository's error classes: Studio's sentence first, the server's text after it, and every server text passes
 * `serverText` first, so a text that holds any form of the configured secret is withheld whole (VF9).
 *
 * The status decides, and the text only refines it, because the server's texts changed between versions: an
 * expired JWT is a 403 with a plain-text body, a missing or wrong key a 401 with one, a timeout a 500 or a 408,
 * and the rest JSON `{"status":{"error":"..."}}`. A body that is not JSON is read as text. Nothing here retries.
 */
import {
  AuthenticationError,
  ConnectionError,
  DatabaseError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { serverText } from "@/lib/db/utils/server-text";
import type { DatabaseType } from "@/lib/types";
import { type QdrantAnswer, QdrantError, type QdrantOp } from "./client";

const PROVIDER: DatabaseType = "qdrant";

/** The longest server text a sentence carries; a longer one is cut and says so. */
const MAX_SERVER_TEXT = 2000;
/** An error body longer than this is never parsed: a refusal's body is a sentence, not a result. */
const MAX_ERROR_BODY = 65_536;

export interface QdrantErrorContext {
  /** `connect` while the provider's two connect requests run, `request` after it. */
  readonly phase: "connect" | "request";
  readonly op: QdrantOp;
  /** The endpoint as configured: the far end under an SSH tunnel. */
  readonly endpoint: { readonly host: string; readonly port: number };
  readonly responseCapBytes: number;
  readonly timeoutMs: number;
  /** `secretForms` of the connection's secret (3.9). */
  readonly secretForms: readonly string[];
  /** The clock a Retry-After date is measured against; the system clock when absent. */
  readonly now?: () => Date;
}

/** The server's own words in an answer: `status.error` of a JSON body, else the body as text. */
function serverWords(text: string): string {
  if (text.length <= MAX_ERROR_BODY) {
    try {
      const parsed: unknown = JSON.parse(text);
      const status =
        typeof parsed === "object" && parsed !== null ? (parsed as { readonly status?: unknown }).status : undefined;
      const error =
        typeof status === "object" && status !== null ? (status as { readonly error?: unknown }).error : undefined;
      if (typeof error === "string") return error;
    } catch {
      // Not JSON: a 401, an expired or wrongly signed JWT and a proxy's page answer plain text, which is read as it is.
    }
  }
  return text.trim();
}

function categoryOf(status: number, words: string): QdrantError["category"] {
  if (status === 401) return "unauthenticated";
  if (status === 403) {
    if (words === "ExpiredSignature") return "jwt-expired";
    if (words === "InvalidSignature") return "jwt-signature";
    return "forbidden";
  }
  if (status === 404) return words.startsWith("Not found: Collection ") ? "collection-not-found" : "not-found";
  if (status === 408 && words.startsWith("Timeout:")) return "timeout";
  if (status === 429) return "rate-limited";
  if (status === 400) return words.startsWith("Bad request:") ? "strict-mode" : "input";
  if (status === 422) return "input";
  if (status === 503) return "unavailable";
  if (status >= 500) return words.includes("Timeout error: Operation") ? "timeout" : "server";
  return "unexpected-status";
}

/** What an answer that is not a 2xx is, or undefined for a success. The answer's text is kept, never shown here. */
export function answerFailure(answer: QdrantAnswer): QdrantError | undefined {
  if (answer.status >= 200 && answer.status <= 299) return undefined;
  const words = serverWords(answer.text);
  const category = categoryOf(answer.status, words);
  return new QdrantError(category, words, answer.status, category === "rate-limited" ? answer.retryAfter : null);
}

const DELAY_SECONDS = /^\d{1,9}$/;
/** An IMF-fixdate, the one HTTP date form a server may send (RFC 9110 5.6.7). */
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * The wait a Retry-After header names, in whole seconds: the value when it is 1 to 9 digits, or the seconds until
 * an IMF-fixdate, 0 when that date has passed. Undefined for an absent or malformed value, which is never echoed.
 */
export function retryAfterSeconds(retryAfter: string | null, now: Date): number | undefined {
  if (retryAfter === null) return undefined;
  if (DELAY_SECONDS.test(retryAfter)) return Number(retryAfter);
  if (!IMF_FIXDATE.test(retryAfter)) return undefined;
  const at = Date.parse(retryAfter);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

/** The server's words after Studio's, withheld whole when they hold any form of the secret (VF9). */
function after(detail: string, context: QdrantErrorContext): string {
  if (detail === "") return "";
  const text = serverText(detail, context.secretForms);
  const shown = text.length > MAX_SERVER_TEXT ? `${text.slice(0, MAX_SERVER_TEXT)} (cut)` : text;
  return ` (Qdrant: ${shown})`;
}

function endpointOf(context: QdrantErrorContext): string {
  const { host, port } = context.endpoint;
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function formatBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes.toLocaleString("en-US")} bytes`;
}

const EXACT_COUNT_LIMIT =
  ' An exact count keeps running on the server after its time limit, until it completes; send "exact": false for an approximate count.';

function timeoutSentence(context: QdrantErrorContext): string {
  // Without the server's elapsed figure, which need not equal the limit that was sent.
  return `Qdrant stopped the request at its time limit.${context.op === "count_points" ? EXACT_COUNT_LIMIT : ""}`;
}

function answerError(error: QdrantError, context: QdrantErrorContext): Error {
  const words = after(error.detail, context);
  switch (error.category) {
    case "unauthenticated":
      return new AuthenticationError(`Qdrant refused the API key or JWT.${words}`, PROVIDER);
    case "jwt-expired":
      return new AuthenticationError("The JWT has expired.", PROVIDER);
    case "jwt-signature":
      return new AuthenticationError("The JWT's signature does not match this server's key.", PROVIDER);
    case "forbidden":
      return context.phase === "connect"
        ? new AuthenticationError(`The credential is not allowed to list collections.${words}`, PROVIDER)
        : new QueryError(`The credential is not allowed to run this request.${words}`, PROVIDER);
    case "collection-not-found":
      return new QueryError("The collection does not exist or is not visible to this credential.", PROVIDER);
    case "not-found":
      return new QueryError(`Qdrant found nothing at the name or id the request gives.${words}`, PROVIDER);
    case "input":
      return new QueryError(`Qdrant did not accept the request as written.${words}`, PROVIDER);
    case "strict-mode": {
      const hint = error.detail.includes("Exact search disabled") ? ' Send "exact": false.' : "";
      return new QueryError(`This collection's strict mode refused the request.${hint}${words}`, PROVIDER);
    }
    case "rate-limited": {
      const wait = retryAfterSeconds(error.retryAfter, (context.now ?? (() => new Date()))());
      const again = wait === undefined ? "try again later" : `try again in ${wait} s`;
      return new QueryError(`Qdrant rate-limited the request; ${again}. It was not sent again.${words}`, PROVIDER);
    }
    case "timeout":
      return new TimeoutError(timeoutSentence(context), PROVIDER, context.timeoutMs);
    case "server":
      return new QueryError(`Qdrant failed to run the request (HTTP ${error.status}).${words}`, PROVIDER);
    case "unavailable":
      return new ConnectionError(
        `Qdrant is not ready to serve the request (HTTP ${error.status}).${words}`,
        PROVIDER,
        context.endpoint.host,
        context.endpoint.port,
      );
    case "unexpected-status":
      return new QueryError(`Qdrant answered HTTP ${error.status}, which Studio does not read.${words}`, PROVIDER);
  }
}

function transportError(error: TransportError, context: QdrantErrorContext): Error {
  const { host, port } = context.endpoint;
  const connection = (sentence: string) => new ConnectionError(sentence, PROVIDER, host, port);
  switch (error.kind) {
    case "timeout":
      return new TimeoutError(
        `The request to Qdrant did not finish within ${context.timeoutMs} ms, so Studio stopped waiting.${context.op === "count_points" ? EXACT_COUNT_LIMIT : ""}`,
        PROVIDER,
        context.timeoutMs,
      );
    case "aborted":
      return new QueryCancelledError("The request to Qdrant was cancelled.", PROVIDER);
    case "too-large":
      return new QueryError(
        `Qdrant's answer is larger than the ${formatBytes(context.responseCapBytes)} Studio reads for one response, so it was not read. Ask for fewer points, or leave the vectors out.`,
        PROVIDER,
      );
    case "redirect":
      return connection(
        `Qdrant at ${endpointOf(context)} answered with a redirect, which Studio never follows. ${error.message}`,
      );
    case "encoding":
      return connection(
        `Qdrant at ${endpointOf(context)} answered in an encoding Studio does not read. ${error.message}`,
      );
    case "tls":
      return connection(
        `The TLS connection to Qdrant at ${endpointOf(context)} failed: check the SSL mode, the CA and the client certificate under SSL / TLS. ${error.message}`,
      );
    case "network":
      return connection(
        `No complete answer arrived from Qdrant at ${endpointOf(context)}, and the request was not sent again. ${error.message}`,
      );
  }
}

/**
 * What a person reads for a failure. A `QdrantError` and a `TransportError` are worded by the table; any other
 * error of the repository's own classes (a refusal raised before the wire) is returned as it is; anything else is
 * a failure this provider did not expect, reported without its text.
 */
export function toProviderError(error: unknown, context: QdrantErrorContext): Error {
  if (error instanceof QdrantError) return answerError(error, context);
  if (error instanceof TransportError) return transportError(error, context);
  if (error instanceof DatabaseError) return error;
  return new QueryError("The request to Qdrant failed in a way Studio does not recognise.", PROVIDER);
}

/** The answer when it is a success; otherwise its failure, worded, is thrown. */
export function expectOk(answer: QdrantAnswer, context: QdrantErrorContext): QdrantAnswer {
  const failure = answerFailure(answer);
  if (failure !== undefined) throw toProviderError(failure, context);
  return answer;
}
