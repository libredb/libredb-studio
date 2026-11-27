/**
 * A provider package's own errors and warnings as Studio answers them (docs/providers/CONTRACT.md, clause C-112).
 *
 * One function, `packageFailureAnswer`, answers every failure of a provider package's call on every route, whatever its
 * record grants. A package's error is any value one of its calls rejects with that is not Studio's own `DatabaseError`:
 * the SDK gives a package no error class to raise, and Studio's classes are outside a package's closure, so a package
 * cannot construct one. It is logged once under the route, its words through core's scrub of the connection, on both
 * grants. An open that fails sent no statement, so it is answered as a `ConnectionError` marked not-sent: in Studio's
 * sentence naming its code where no register row grants the engine its own words (docs/providers/CONTRACT.md, clause
 * M-84), in the error's own words through core's scrub where one does, its record's `grants.ownWords` `"scrubbed"`,
 * and in the package-defect words below for a refusal of what the package's open answered. An execute that fails may have run, so it is answered in Studio's sentence where no row grants the
 * words, and as raised, through core's scrub, where one does.
 *
 * A value the host core builds about a package's answer it cannot read, a `HostDefectError` with a refusal of a rule
 * `REFUSAL_AUTHOR` names the package's, is the package's defect: on both grants it is answered and logged in Studio's
 * words under `PACKAGE_DEFECT_PREFIX`, where the accessor's message names Studio, as a not-sent `ConnectionError` for
 * an open and a plain `Error` for an execute. Its one log line names each rule and pointer, and the words of each close
 * that failed after the refused answer, through core's scrub (`loggedDefect`). The client is answered each rule and
 * pointer where a register row grants the package's words, and each rule alone where none does
 * (`packageDefectAnswer`), since a pointer may hold a key the package chose. A `HostDefectError` whose refusals are
 * each about Studio's own request is Studio's defect, and is answered as Studio's own internal error. A legacy record's
 * provider is Studio's own code, so its failure is answered as raised.
 *
 * Every failure `packageFailureAnswer` answers as the package's (`isPackageFailure`) it logs, once; the query route and
 * the Test Connection route (through `testConnection`'s `failure`, src/lib/api/test-connection.ts), which render the
 * answer, pass `logged` to `createErrorResponse` (src/lib/api/errors.ts), so they write no second line.
 *
 * A package's warnings reach the route as the host core checked and rebuilt them (`checkExecuteAnswer`); where no row
 * grants its own words they reach the client only as Studio's sentence naming their count, each logged once through
 * the same scrub (`packageWarnings`).
 */
import { type CallRefusalRule, callRefusalSentence, type Warning } from "@libredb/provider-sdk/calls";
import { errorCode } from "@/lib/db/error-record";
import { ConnectionError, DatabaseError, markNotSent } from "@/lib/db/errors";
import {
  type ProviderTextScrub,
  scrubProviderText,
  scrubProviderWarnings,
  withholdProviderError,
} from "@/lib/db/operations/provider-text";
import type { EngineRecord } from "@/lib/db/server-catalog";
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
  "request-level-not-stated": "studio",
  "request-kind-not-stated": "studio",
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
  "execute-answer-unreadable": "package",
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
 * The words of `error`, a host defect with a refusal of what the package answered: the same refusals' sentences, each
 * naming its rule's place by its pointer, under `PACKAGE_DEFECT_PREFIX`, so they name the package as the author, where
 * the accessor's message names Studio.
 */
function packageDefectWords(error: HostDefectError): string {
  return `${PACKAGE_DEFECT_PREFIX} ${error.refusals.map((refusal) => callRefusalSentence(refusal)).join(" ")}`;
}

/**
 * The error logged for `error`, a host defect with a refusal of what the package answered: `packageDefectWords`, then
 * the words of each close that failed after the refused answer, each through core's scrub of the connection.
 */
function loggedDefect(error: HostDefectError, scrub: ProviderTextScrub): Error {
  const words = packageDefectWords(error);
  if (error.closeFailures.length === 0) return new Error(words);
  const closes = error.closeFailures.map((failure) =>
    scrubProviderText(scrub, failure instanceof Error ? failure.message : String(failure)),
  );
  return new Error(`${words} Closing the result sources it handed over failed too: ${closes.join("; ")}.`);
}

/**
 * The words a client is answered for `error`, a host defect with a refusal of what the package answered, by `engine`'s
 * grant: `packageDefectWords` where its words are `"scrubbed"`, and otherwise each rule once, in Studio's sentence, with
 * no pointer, since a pointer may hold a key the package chose.
 */
function packageDefectAnswer(engine: EngineRecord, error: HostDefectError): string {
  if (engine.grants.ownWords === "scrubbed") return packageDefectWords(error);
  const rules = [...new Set(error.refusals.map((refusal) => refusal.rule))];
  return `${PACKAGE_DEFECT_PREFIX} it broke the ${rules.length === 1 ? "rule" : "rules"} ${rules.join(", ")}; the server's log names where.`;
}

/** Studio's sentence for a provider package's error of `call`, which names its code; its words go to the log only. */
export function packageErrorSentence(call: string, error: unknown): string {
  return `The provider package's ${call} failed (${errorCode(error)}); the server's log holds its words.`;
}

/** Logs a provider package's error of `call` once, its words through core's scrub of the connection, under `route`. */
function logPackageError(call: string, error: unknown, scrub: ProviderTextScrub, route: string): void {
  logger.error(`A provider package's ${call} failed`, withholdProviderError(scrub, error), { route });
}

/**
 * Whether `error`, a failure of a provider package's call, is Studio's own: Studio's `DatabaseError`, which a package
 * cannot construct, or a host defect of Studio's own (`isStudioDefect`). A caller answers it as itself, never as the
 * package's.
 */
export function isStudioFailure(error: unknown): boolean {
  return error instanceof DatabaseError || isStudioDefect(error);
}

/**
 * Logs `error`, a failure of a provider package's `call` that is not Studio's own (`isStudioFailure`), once as the
 * package's (`logPackageError`): a host defect with a refusal of what the package answered as `loggedDefect`, so the
 * log names the package as its author.
 */
export function logPackageFailure(call: string, error: unknown, scrub: ProviderTextScrub, route: string): void {
  logPackageError(call, error instanceof HostDefectError ? loggedDefect(error, scrub) : error, scrub, route);
}

/**
 * Whether `packageFailureAnswer` answers `error`, a failure of `engine`'s call, as the package's, and so logs it once:
 * any failure of a record no legacy provider serves that is not Studio's own (`isStudioFailure`).
 */
export function isPackageFailure(engine: EngineRecord, error: unknown): boolean {
  return !engine.offers.legacyProvider && !isStudioFailure(error);
}

/**
 * The warnings a client receives for `warnings`, the ones a provider package's `call` answered, as the host core
 * checked and rebuilt them: none for none, and otherwise Studio's one sentence naming their count. Each warning is
 * logged once under `route`, its words through core's scrub of the connection.
 */
export function packageWarnings(
  call: string,
  warnings: readonly Warning[],
  scrub: ProviderTextScrub,
  route: string,
): QueryWarning[] {
  for (const warning of scrubProviderWarnings(scrub, warnings)) {
    logger.warn(`A provider package's ${call} returned a warning`, { route, warning });
  }
  if (warnings.length === 0) return [];
  const count = warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`;
  return [{ message: `The provider package returned ${count}; the server's log holds their words.` }];
}

/**
 * The error a route answers for `error`, a failure of the `call` of `engine`'s session, the one answer of a provider
 * package's failure on every route: a legacy record's failure (`offers.legacyProvider`) and Studio's own failure
 * (`isStudioFailure`) as raised; a host defect with a refusal of what the package answered logged once as
 * `loggedDefect` and answered in `packageDefectAnswer`'s words, on both grants, as a `ConnectionError` marked not-sent
 * for an open; and any other value logged once as the package's (`logPackageError`), on both grants, then answered by
 * the record's `grants.ownWords`. What it logs is exactly what `isPackageFailure` holds for. An open's is a `ConnectionError` marked not-sent, since an
 * open sends no statement: its message the error's own through core's scrub where the words are `"scrubbed"`, and
 * Studio's sentence naming its code where they are `"code-only"` or the value is no `Error` and has no words. An
 * execute's is the error as raised where the words are `"scrubbed"`, answered through core's scrub by the route, and a
 * plain `Error` with Studio's sentence, kind internal and outcome unknown, where they are `"code-only"`, since the
 * statement may have run.
 */
export function packageFailureAnswer(
  engine: EngineRecord,
  call: "open" | "execute",
  error: unknown,
  scrub: ProviderTextScrub,
  route: string,
): unknown {
  if (!isPackageFailure(engine, error)) return error;
  if (error instanceof HostDefectError) {
    logPackageError(call, loggedDefect(error, scrub), scrub, route);
    const answer = packageDefectAnswer(engine, error);
    return call === "open" ? notSentConnectionError(answer) : new Error(answer);
  }
  logPackageError(call, error, scrub, route);
  const granted = engine.grants.ownWords === "scrubbed";
  if (call === "execute") return granted ? error : new Error(packageErrorSentence(call, error));
  return notSentConnectionError(
    granted && error instanceof Error ? scrubProviderText(scrub, error.message) : packageErrorSentence(call, error),
  );
}

/** A `ConnectionError` of `message` marked not-sent: the answer of a failed open, which sends no statement. */
function notSentConnectionError(message: string): ConnectionError {
  const failed = new ConnectionError(message);
  markNotSent(failed);
  return failed;
}
