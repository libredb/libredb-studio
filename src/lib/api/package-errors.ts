/**
 * A provider package's own errors and warnings as Studio answers them (docs/providers/CONTRACT.md, clause C-112).
 *
 * The client never receives a package's own words in this Studio: a package's error is answered with Studio's sentence
 * naming its code, and the error itself is logged once under the route, its words through core's scrub of the
 * connection. A package's error is any value one of its calls rejects with that is not Studio's own `DatabaseError`: the
 * SDK gives a package no error class to raise, and Studio's classes are outside a package's closure, so a package cannot
 * construct one. A value the host core builds about a package's answer it cannot read is answered the same way, since
 * it is the package's defect too, and its log line names the package as the author (`PACKAGE_DEFECT_PREFIX`), where
 * the accessor's message names Studio; a `HostDefectError` whose refusals are each about Studio's own request is Studio's
 * defect, and is answered as Studio's own internal error. A package's warnings reach the client only as Studio's
 * sentence naming their count, each logged once through the same scrub.
 */
import { type CallRefusalRule, callRefusalSentence } from "@libredb/provider-sdk/calls";
import { errorCode } from "@/lib/db/error-record";
import { ConnectionError, DatabaseError, markNotSent } from "@/lib/db/errors";
import {
  type ProviderTextScrub,
  scrubProviderWarnings,
  withholdProviderError,
} from "@/lib/db/operations/provider-text";
import { logger } from "@/lib/logger";
import { HostDefectError } from "@/lib/provider-host/access";
import type { QueryWarning } from "@/lib/types";

/**
 * Whose defect a refusal of each rule is on a provider package's session: Studio's, for what Studio sent or when it
 * called, or the package's, for what the package answered. Typed over every rule, so a new rule cannot go unread.
 */
const REFUSAL_AUTHOR: Readonly<Record<CallRefusalRule, "studio" | "package">> = Object.freeze({
  "request-field-not-honoured": "studio",
  "request-scope-not-offered": "studio",
  "request-transaction-not-offered": "studio",
  "request-scope-in-transaction": "studio",
  "request-read-only-not-opened": "studio",
  "request-read-only-missing": "studio",
  "request-operation-not-offered": "studio",
  "request-field-empty": "studio",
  "request-placement-not-offered": "studio",
  "request-preview-not-offered": "studio",
  "request-panel-not-offered": "studio",
  "facet-not-offered": "studio",
  "call-deadline-passed": "studio",
  "call-signal-aborted": "studio",
  "refinement-key-unknown": "package",
  "refinement-unreadable": "package",
  "refinement-widens": "package",
  "batch-malformed": "package",
  "batch-over-rows": "package",
  "batch-over-bytes": "package",
  "row-not-positional": "package",
  "row-over-page": "package",
  "batch-empty-not-done": "package",
  "transaction-answer-unreadable": "package",
});

/** The words that open the message of the error logged for a refusal of what a provider package answered. */
export const PACKAGE_DEFECT_PREFIX =
  "The provider host refused what a provider package answered, which is a defect of the package:";

/** Whether `error` is a defect of Studio's own: a `HostDefectError` none of whose refusals is about the package's answer. */
function isStudioDefect(error: unknown): error is HostDefectError {
  return (
    error instanceof HostDefectError && error.refusals.every((refusal) => REFUSAL_AUTHOR[refusal.rule] === "studio")
  );
}

/**
 * The error logged for `error`, a host defect with a refusal of what the package answered: the same refusals' sentences
 * under `PACKAGE_DEFECT_PREFIX`, so the log names the package as the author, where the accessor's message names Studio.
 */
function packageDefect(error: HostDefectError): Error {
  return new Error(
    `${PACKAGE_DEFECT_PREFIX} ${error.refusals.map((refusal) => callRefusalSentence(refusal)).join(" ")}`,
  );
}

/** Studio's sentence for a provider package's error of `call`, which names its code; its words go to the log only. */
export function packageErrorSentence(call: string, error: unknown): string {
  return `The provider package's ${call} failed (${errorCode(error)}); the server's log holds its words.`;
}

/** Logs a provider package's error of `call` once, its words through core's scrub of the connection, under `route`. */
export function logPackageError(call: string, error: unknown, scrub: ProviderTextScrub, route: string): void {
  logger.error(`A provider package's ${call} failed`, withholdProviderError(scrub, error), { route });
}

/**
 * The warnings a client receives for `warnings`, the ones a provider package's `call` answered: none for none, and
 * otherwise Studio's one sentence naming their count, each warning logged once under `route`, its words through core's
 * scrub of the connection.
 */
export function packageWarnings(
  call: string,
  warnings: readonly QueryWarning[],
  scrub: ProviderTextScrub,
  route: string,
): QueryWarning[] {
  if (warnings.length === 0) return [];
  for (const warning of scrubProviderWarnings(scrub, warnings)) {
    logger.warn(`A provider package's ${call} returned a warning`, { route, warning });
  }
  const count = warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`;
  return [{ message: `The provider package returned ${count}; the server's log holds their words.` }];
}

/**
 * The error a request answers for `error`, a failure of a provider package's `call` on its query route: Studio's own
 * `DatabaseError`, and a host defect of Studio's own (`isStudioDefect`), as itself, and any other value logged once
 * (`logPackageError`), a host defect with a refusal of what the package answered as `packageDefect`, and answered with Studio's sentence naming its code: a `ConnectionError` marked not-sent for the
 * open, since nothing was sent, and a plain `Error`, kind internal and outcome unknown, for the execute, since the
 * statement may have run.
 */
export function packageCallError(
  call: "open" | "execute",
  error: unknown,
  scrub: ProviderTextScrub,
  route: string,
): unknown {
  if (error instanceof DatabaseError || isStudioDefect(error)) return error;
  logPackageError(call, error instanceof HostDefectError ? packageDefect(error) : error, scrub, route);
  if (call === "execute") return new Error(packageErrorSentence(call, error));
  const failed = new ConnectionError(packageErrorSentence(call, error));
  markNotSent(failed);
  return failed;
}
