/**
 * Prometheus errors in the repository's vocabulary (#1085, section 5.5)
 *
 * Classified by the transport's category and never by an HTTP status, the way the Druid and Trino
 * providers map from an engine category. A category is the engine's own `errorType` for a failure the
 * server reported, or the transport's word for one it observed: a refused credential, a TLS failure, a
 * body that was not the API, a request that did not finish. A redirect is not among them: `request.ts`
 * refuses a 3xx with the shared `rejectRedirect`, whose `ConnectionError` already names only the status and
 * the target's origin (#1085 S2), and it passes through here unchanged like any other `DatabaseError`.
 *
 * Every category keeps the message it arrived with, which for a failure the engine reported is the
 * engine's own sentence, except two whose message is built here because the rule is about what the
 * message may hold. A TLS failure is named by its Node error code (#1085 S8), because a `ConnectionError`
 * has no field for one. An answer past the byte cap names the cap and says how to ask for less (#1085 S5).
 * Both name the server rather than Prometheus, because a wire-compatible relative such as VictoriaMetrics
 * is reached through this provider too. A refused credential keeps its message unchanged: that message was
 * written never to hold the value (#1085 S3), and nothing here has the value to add.
 */
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  mapDatabaseError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import type { DatabaseType } from "@/lib/types";
import { type PrometheusErrorDetail, PrometheusTransportError } from "./transport";

/** What the provider knows about the call that failed. */
export interface ErrorContext {
  readonly provider: DatabaseType;
  /** The statement that failed, when the call ran one. */
  readonly query?: string;
  /** The deadline the call ran under, reported on a TimeoutError. */
  readonly timeoutMs: number;
  readonly host?: string;
  readonly port?: number;
}

/**
 * A PrometheusTransportError as the class of section 5.5, and anything else through `mapDatabaseError`,
 * which passes a DatabaseError through unchanged and classifies a raw Error by its message.
 */
export function toDatabaseError(error: unknown, context: ErrorContext): Error {
  if (!(error instanceof PrometheusTransportError)) return mapDatabaseError(error, context.provider, context.query);

  const { provider, query, host, port } = context;
  switch (error.category) {
    case "bad_data":
    case "execution":
    case "unmeasurable":
      return new QueryError(error.message, provider, query);
    case "timeout":
    case "deadline":
      return new TimeoutError(error.message, provider, context.timeoutMs, query);
    case "canceled":
    case "aborted":
      return new QueryCancelledError(error.message, provider, query);
    case "unavailable":
    case "internal":
    case "network":
    case "protocol":
      return new ConnectionError(error.message, provider, host, port);
    case "unauthorized":
      return new AuthenticationError(error.message, provider);
    case "tls":
      return new ConnectionError(tlsMessage(error.message, error.detail), provider, host, port);
    case "too_large":
      return new QueryError(tooLargeMessage(error.detail), provider, query);
    case "credential":
      return new DatabaseConfigError(error.message, provider);
    default:
      // An engine errorType this build does not know: `not_found` and `not_acceptable` at v3.13.3, or one a
      // later version adds. The engine refused the request, and its own sentence says why.
      return new QueryError(error.message, provider, query);
  }
}

/**
 * The Node error code is the one fact a TLS failure carries (#1085 S8), so the message is built from it:
 * request.ts already writes the code into its own message, and wrapping that message would name the code
 * twice. The transport's message stands in only where no code came with it.
 */
function tlsMessage(message: string, detail: PrometheusErrorDetail): string {
  const cause = detail.code === undefined ? `: ${message}` : ` (${detail.code})`;
  return `The TLS connection to the server failed${cause}. The request was not retried over plain HTTP.`;
}

/** The cap by name, and how to ask for less (#1085 S5). */
function tooLargeMessage(detail: PrometheusErrorDetail): string {
  const cap =
    detail.limitBytes === undefined
      ? "the response cap"
      : `the ${detail.limitBytes.toLocaleString("en-US")}-byte response cap`;
  return (
    `The server's answer passed ${cap} and was not read to the end. Ask for less: a narrower range, a larger ` +
    "step, or fewer series."
  );
}
