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
 * words, and as raised, through core's scrub, where one does; a tree read, a health read, a panel read, a pool
 * statistics read, a maintenance run, a maintenance preview and a cancel that fail are answered as an execute is.
 *
 * A value the host core builds about a package's answer it cannot read, a `HostDefectError` with a refusal of a rule
 * `REFUSAL_AUTHOR` names the package's, is the package's defect: on both grants it is answered and logged in Studio's
 * words under `PACKAGE_DEFECT_PREFIX`, where the accessor's message names Studio, as a not-sent `ConnectionError` for
 * an open and a plain `Error` for any other call, a tree, panel, pool statistics, health, maintenance run,
 * maintenance preview, cancel or end of scope answer the core refused (`checkTreeAnswer`, `checkPanelAnswer`,
 * `checkPoolStatsAnswer`, `checkHealthAnswer`, `checkMaintenanceRunAnswer`, `checkMaintenancePreviewAnswer`,
 * `checkCancelAnswer`, `checkEndScopeAnswer`) included; an end of scope's under the call whose run it ended. Its one
 * log line names each rule and pointer, and the words of each close that failed after the refused answer, through core's scrub (`loggedDefect`). The client is answered each rule and
 * pointer where a register row grants the package's words, each refusal's sentence through core's scrub, since its
 * pointer and the key it names may hold a key the package chose, and each rule alone where none does
 * (`packageDefectAnswer`). A `HostDefectError` whose refusals are
 * each about Studio's own request is Studio's defect, and is answered as Studio's own internal error. A legacy record's
 * provider is Studio's own code, so its failure is answered as raised.
 *
 * Every failure `packageFailureAnswer` answers as the package's (`isPackageFailure`) it logs, once; the query route and
 * the Test Connection route (through `testConnection`'s `failure`, src/lib/api/test-connection.ts), which render the
 * answer, pass `logged` to `createErrorResponse` (src/lib/api/errors.ts), so they write no second line. A request whose
 * facades answer its failures inside (`providerMonitoring`, `providerMaintenance`) holds one `packageAnswers` record,
 * which answers each failure through `packageFailureAnswer` and tells its route which errors it already logged.
 *
 * A package's warnings reach the route as the host core checked and rebuilt them (`checkExecuteAnswer`); where no row
 * grants its own words they reach the client only as Studio's sentence naming their count, each logged once through
 * the same scrub (`packageWarnings`).
 */
import { type CallRefusal, type CallRefusalRule, callRefusalSentence, type Warning } from "@libredb/provider-sdk/calls";
import { errorCode } from "@/lib/db/error-record";
import { ConnectionError, DatabaseError, markNotSent } from "@/lib/db/errors";
import {
  PROVIDER_TEXT_WITHHELD,
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
  "request-limit-out-of-range": "studio",
  "request-level-not-stated": "studio",
  "request-kind-not-stated": "studio",
  "request-source-not-stated": "studio",
  "request-path-not-admitted": "studio",
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
  "tree-answer-unreadable": "package",
  "source-answer-unreadable": "package",
  "panel-answer-unreadable": "package",
  "pool-stats-answer-unreadable": "package",
  "health-answer-unreadable": "package",
  "maintenance-run-answer-unreadable": "package",
  "maintenance-preview-answer-unreadable": "package",
  "cancel-answer-unreadable": "package",
  "end-scope-answer-unreadable": "package",
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
 * The sentence of `refusal`, a refusal of what the package answered, through core's scrub of the connection: its
 * pointer and its name may hold a key the package chose, so the sentence is withheld whole (`PROVIDER_TEXT_WITHHELD`)
 * where it, or a reference token of its pointer as the package wrote the key, holds a credential of the connection. A
 * pointer writes `/` and `~` in a key as `~1` and `~0` (RFC 6901), which the scrub's readings do not undo, so each
 * token is read unescaped too.
 */
function scrubbedRefusalSentence(scrub: ProviderTextScrub, refusal: CallRefusal): string {
  const sentence = callRefusalSentence(refusal);
  const keys = refusal.pointer
    .split("/")
    .slice(1)
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  const withheld = [sentence, ...keys].some((text) => scrubProviderText(scrub, text) === PROVIDER_TEXT_WITHHELD);
  return withheld ? PROVIDER_TEXT_WITHHELD : sentence;
}

/**
 * The words of `error`, a host defect with a refusal of what the package answered: the same refusals' sentences, each
 * naming its rule's place by its pointer and each through core's scrub (`scrubbedRefusalSentence`), under
 * `PACKAGE_DEFECT_PREFIX`, so they name the package as the author, where the accessor's message names Studio.
 */
function packageDefectWords(error: HostDefectError, scrub: ProviderTextScrub): string {
  return `${PACKAGE_DEFECT_PREFIX} ${error.refusals.map((refusal) => scrubbedRefusalSentence(scrub, refusal)).join(" ")}`;
}

/**
 * The error logged for `error`, a host defect with a refusal of what the package answered: `packageDefectWords`, then
 * the words of each close that failed after the refused answer, each through core's scrub of the connection.
 */
function loggedDefect(error: HostDefectError, scrub: ProviderTextScrub): Error {
  const words = packageDefectWords(error, scrub);
  if (error.closeFailures.length === 0) return new Error(words);
  const closes = error.closeFailures.map((failure) =>
    scrubProviderText(scrub, failure instanceof Error ? failure.message : String(failure)),
  );
  return new Error(`${words} Closing the result sources it handed over failed too: ${closes.join("; ")}.`);
}

/**
 * The words a client is answered for `error`, a host defect with a refusal of what the package answered, by `engine`'s
 * grant: `packageDefectWords`, through core's scrub, where its words are `"scrubbed"`, and otherwise each rule once, in
 * Studio's sentence, with no pointer, since a pointer may hold a key the package chose.
 */
function packageDefectAnswer(engine: EngineRecord, error: HostDefectError, scrub: ProviderTextScrub): string {
  if (engine.grants.ownWords === "scrubbed") return packageDefectWords(error, scrub);
  const rules = [...new Set(error.refusals.map((refusal) => refusal.rule))];
  return `${PACKAGE_DEFECT_PREFIX} it broke the ${rules.length === 1 ? "rule" : "rules"} ${rules.join(", ")}; the server's log names where.`;
}

/** Studio's sentence for a provider package's error of `call`, which names its code; its words go to the log only. */
function packageErrorSentence(call: string, error: unknown): string {
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

/** The call a provider package's failure is answered for: the noun Studio's sentence and the log line name it by. */
export type PackageCall =
  | "open"
  | "execute"
  | "tree read"
  | "health"
  | "panel read"
  | "pool statistics read"
  | "maintenance run"
  | "maintenance preview"
  | "cancel";

/**
 * The error a route answers for `error`, a failure of the `call` of `engine`'s session, the one answer of a provider
 * package's failure on every route: a legacy record's failure (`offers.legacyProvider`) and Studio's own failure
 * (`isStudioFailure`) as raised; a host defect with a refusal of what the package answered logged once as
 * `loggedDefect` and answered in `packageDefectAnswer`'s words, on both grants, as a `ConnectionError` marked not-sent
 * for an open; and any other value logged once as the package's (`logPackageError`), on both grants, then answered by
 * the record's `grants.ownWords`. What it logs is exactly what `isPackageFailure` holds for. An open's is a
 * `ConnectionError` marked not-sent, since an open sends no statement: its message the error's own through core's scrub where the words are `"scrubbed"`, and
 * Studio's sentence naming its code where they are `"code-only"` or the value is no `Error` and has no words. An
 * execute's is the error as raised where the words are `"scrubbed"`, answered through core's scrub by the route, and a
 * plain `Error` with Studio's sentence, kind internal and outcome unknown, where they are `"code-only"`, since the
 * statement may have run. A tree read's, a health read's, a panel read's, a pool statistics read's, a maintenance
 * run's, a maintenance preview's and a cancel's are answered as an execute's. `call` is the noun Studio's sentence and the log
 * line name the call by.
 */
export function packageFailureAnswer(
  engine: EngineRecord,
  call: PackageCall,
  error: unknown,
  scrub: ProviderTextScrub,
  route: string,
): unknown {
  if (!isPackageFailure(engine, error)) return error;
  if (error instanceof HostDefectError) {
    logPackageError(call, loggedDefect(error, scrub), scrub, route);
    const answer = packageDefectAnswer(engine, error, scrub);
    return call === "open" ? notSentConnectionError(answer) : new Error(answer);
  }
  logPackageError(call, error, scrub, route);
  const granted = engine.grants.ownWords === "scrubbed";
  if (call !== "open") return granted ? error : new Error(packageErrorSentence(call, error));
  return notSentConnectionError(
    granted && error instanceof Error ? scrubProviderText(scrub, error.message) : packageErrorSentence(call, error),
  );
}

/**
 * What one request answers of `engine`'s failures: each through `packageFailureAnswer` under core's scrub of the
 * connection and the request's route, and which answers it gave for a failure it logged as the package's, so the route
 * answers each with no second log line (`logged` of `createErrorResponse` in src/lib/api/errors.ts). The facades of a
 * request (`providerMonitoring`, `providerMaintenance`) and its route share one, so a route reads by identity which
 * error was already logged, never by the error's class: a plain `Error` Studio raised outside the answered calls, such
 * as a read before the host core's install, is logged by the route as Studio's own.
 */
export interface PackageAnswers {
  readonly engine: EngineRecord;
  readonly route: string;
  /** `packageFailureAnswer(engine, call, error, scrub, route)`, remembered when it logged `error` as the package's. */
  answer(call: PackageCall, error: unknown): unknown;
  /** Whether `error` is an answer `answer` gave for a failure it logged as the package's (`isPackageFailure`). */
  logged(error: unknown): boolean;
}

/**
 * The record of one request's answers of `engine`'s failures, under core's scrub `scrub` and `route`. Its remembered
 * answers are a `Set`, not a `WeakSet`, since a granted package's failure is answered as the value it raised, which may
 * be a primitive; it lives as long as the request that holds it.
 */
export function packageAnswers(engine: EngineRecord, scrub: ProviderTextScrub, route: string): PackageAnswers {
  const logged = new Set<unknown>();
  return {
    engine,
    route,
    answer: (call, error) => {
      const answer = packageFailureAnswer(engine, call, error, scrub, route);
      if (isPackageFailure(engine, error)) logged.add(answer);
      return answer;
    },
    logged: (error) => logged.has(error),
  };
}

/** A `ConnectionError` of `message` marked not-sent: the answer of a failed open, which sends no statement. */
function notSentConnectionError(message: string): ConnectionError {
  const failed = new ConnectionError(message);
  markNotSent(failed);
  return failed;
}
