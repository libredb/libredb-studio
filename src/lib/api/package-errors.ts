/**
 * A provider package's own errors as Studio answers them (docs/providers/CONTRACT.md, clauses C-112 and C-113).
 *
 * The client never receives a package's own words in this Studio: a package's error is answered with Studio's sentence
 * naming its code, and the error itself is logged once under the route, its words through core's scrub of the
 * connection. A package's error is any value one of its calls rejects with that is not Studio's own `DatabaseError`: the
 * SDK gives a package no error class to raise, and Studio's classes are outside a package's closure, so a package cannot
 * construct one. A value the host core builds about a package's answer it cannot read is answered the same way, since
 * it is the package's defect too.
 */
import { errorCode } from "@/lib/db/error-record";
import { ConnectionError, DatabaseError, markNotSent } from "@/lib/db/errors";
import { type ProviderTextScrub, withholdProviderError } from "@/lib/db/operations/provider-text";
import { logger } from "@/lib/logger";

/** Studio's sentence for a provider package's error of `call`, which names its code; its words go to the log only. */
export function packageErrorSentence(call: string, error: unknown): string {
  return `The provider package's ${call} failed (${errorCode(error)}); the server's log holds its words.`;
}

/** Logs a provider package's error of `call` once, its words through core's scrub of the connection, under `route`. */
export function logPackageError(call: string, error: unknown, scrub: ProviderTextScrub, route: string): void {
  logger.error(`A provider package's ${call} failed`, withholdProviderError(scrub, error), { route });
}

/**
 * The error a request answers for `error`, a failure of a provider package's `call` on its query route: Studio's own
 * `DatabaseError` as itself, and any other value logged once (`logPackageError`) and answered with Studio's sentence
 * naming its code: a `ConnectionError` marked not-sent for the open, since nothing was sent, and a plain `Error`, kind
 * internal and outcome unknown, for the execute, since the statement may have run.
 */
export function packageCallError(
  call: "open" | "execute",
  error: unknown,
  scrub: ProviderTextScrub,
  route: string,
): unknown {
  if (error instanceof DatabaseError) return error;
  logPackageError(call, error, scrub, route);
  if (call === "execute") return new Error(packageErrorSentence(call, error));
  const failed = new ConnectionError(packageErrorSentence(call, error));
  markNotSent(failed);
  return failed;
}
