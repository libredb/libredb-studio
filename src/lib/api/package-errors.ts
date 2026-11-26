/**
 * A provider package's own errors and warnings as Studio answers them (docs/providers/CONTRACT.md, clause C-112).
 *
 * Where no register row grants an engine its own words (docs/providers/CONTRACT.md, clause M-84), the client never
 * receives them: a package's error is answered with Studio's sentence naming its code, and the error itself is logged
 * once under the route, its words through core's scrub of the connection. An engine whose row grants them, its record's
 * `grants.ownWords` `"scrubbed"`, is answered by its reader through core's scrub instead, as a legacy engine is. A package's error is any value one of its calls rejects with that is not Studio's own `DatabaseError`: the
 * SDK gives a package no error class to raise, and Studio's classes are outside a package's closure, so a package cannot
 * construct one. A value the host core builds about a package's answer it cannot read is answered the same way, since
 * it is the package's defect too, and its log line names the package as the author (`PACKAGE_DEFECT_PREFIX`), where
 * the accessor's message names Studio; a `HostDefectError` whose refusals are each about Studio's own request is Studio's
 * defect, and is answered as Studio's own internal error. A package's warnings, where no row grants its own words,
 * reach the client only as Studio's sentence naming their count, each logged once through the same scrub, or as the
 * package's defect where it is not the contract's `Warning` (`packageWarnings`); warnings that are not a list are the
 * package's defect on either path (`packageWarningList`).
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
 * package's (`logPackageError`): a host defect with a refusal of what the package answered as `packageDefect`, so the
 * log names the package as its author.
 */
export function logPackageFailure(call: string, error: unknown, scrub: ProviderTextScrub, route: string): void {
  logPackageError(call, error instanceof HostDefectError ? packageDefect(error) : error, scrub, route);
}

/** Studio's sentence for a warning a provider package answered that is not the contract's `Warning` (`packageWarning`). */
export const PACKAGE_WARNING_DEFECT =
  "The provider package answered a warning that is not a message with an optional code and severity; this is its defect.";

/** Studio's sentence for a provider package's warnings that are not a list, the contract's `readonly Warning[]`. */
const PACKAGE_WARNINGS_DEFECT = "The provider package answered warnings that are not a list; this is its defect.";

/**
 * `warnings`, the warnings a provider package answered, where they are a list (`Array.isArray`).
 *
 * @throws {Error} `PACKAGE_WARNINGS_DEFECT`, for warnings that are not a list: none of them is walked.
 */
export function packageWarningList(warnings: unknown): readonly unknown[] {
  if (!Array.isArray(warnings)) throw new Error(PACKAGE_WARNINGS_DEFECT);
  return warnings;
}

/** The members a warning of the contract's `Warning` has: its message, and its optional code and severity. */
const WARNING_MEMBERS: ReadonlySet<string> = new Set(["message", "code", "severity"]);

/**
 * A warning a provider package answered, rebuilt from its own data members, or null where it is not the contract's
 * `Warning`: not an object, a member outside `WARNING_MEMBERS` or one read through a getter, a message that is not
 * text, a code that is neither text nor a number, or a severity that is not text. The host core passes a package's
 * warnings on as the package answered them, so only the members read here can reach the client or the server's log, and
 * no getter of the package runs while Studio builds its answer or its log line.
 */
export function packageWarning(warning: unknown): QueryWarning | null {
  if (typeof warning !== "object" || warning === null) return null;
  const read: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(warning)) {
    const descriptor = Object.getOwnPropertyDescriptor(warning, key);
    if (typeof key !== "string" || !WARNING_MEMBERS.has(key) || descriptor === undefined || !("value" in descriptor)) {
      return null;
    }
    read[key] = descriptor.value;
  }
  const { message, code, severity } = read;
  if (typeof message !== "string") return null;
  if (code !== undefined && typeof code !== "string" && typeof code !== "number") return null;
  if (severity !== undefined && typeof severity !== "string") return null;
  return { message, ...(code !== undefined && { code }), ...(severity !== undefined && { severity }) };
}

/**
 * The warnings a client receives for `warnings`, the ones a provider package's `call` answered: none for none, and
 * otherwise Studio's one sentence naming their count, the number of warnings Studio walked, never a length the package
 * answers. Each warning is logged once under `route`: rebuilt from the contract's members by `packageWarning` and its
 * words through core's scrub of the connection, or, where it is not the contract's `Warning`, as the package's defect
 * in Studio's own words, none of its members read.
 *
 * @throws {Error} `PACKAGE_WARNINGS_DEFECT`, for warnings that are not a list (`packageWarningList`).
 */
export function packageWarnings(
  call: string,
  warnings: unknown,
  scrub: ProviderTextScrub,
  route: string,
): QueryWarning[] {
  let walked = 0;
  for (const answered of packageWarningList(warnings)) {
    walked += 1;
    const rebuilt = packageWarning(answered);
    if (rebuilt === null) {
      logger.warn(
        `A provider package's ${call} returned a warning that is not a message with an optional code and severity; this is its defect.`,
        { route },
      );
      continue;
    }
    const [warning] = scrubProviderWarnings(scrub, [rebuilt]);
    logger.warn(`A provider package's ${call} returned a warning`, { route, warning });
  }
  if (walked === 0) return [];
  const count = walked === 1 ? "1 warning" : `${walked} warnings`;
  return [{ message: `The provider package returned ${count}; the server's log holds their words.` }];
}

/**
 * The error a request answers for `error`, a failure of a provider package's `call` on its query route or Test
 * Connection: Studio's own failure (`isStudioFailure`) as itself, and any other value logged once as the package's
 * (`logPackageFailure`) and answered with Studio's sentence naming its code: a `ConnectionError` marked not-sent for the
 * open, since nothing was sent, and a plain `Error`, kind internal and outcome unknown, for the execute, since the
 * statement may have run.
 */
export function packageCallError(
  call: "open" | "execute",
  error: unknown,
  scrub: ProviderTextScrub,
  route: string,
): unknown {
  if (isStudioFailure(error)) return error;
  logPackageFailure(call, error, scrub, route);
  if (call === "execute") return new Error(packageErrorSentence(call, error));
  const failed = new ConnectionError(packageErrorSentence(call, error));
  markNotSent(failed);
  return failed;
}
