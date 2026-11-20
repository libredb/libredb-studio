/**
 * The uncaught-exception exit: an exception that no code catches ends the server with a named exit code
 * (docs/DISTRIBUTION.md#uncaught-errors-and-restarts).
 *
 * - The owner's decision: a process that met an exception nobody caught is in a state nobody can describe, so Studio
 *   logs it and exits, and whatever started the server (the kubelet, a restart policy, systemd, Snap, the desktop
 *   shell) starts a fresh one. Without this, Next.js 16 only logs such an exception and the server goes on serving.
 * - The code is 70, `EX_SOFTWARE` in `sysexits.h`, "internal software error". No launcher or framework the server runs
 *   under gives it another meaning: 0 is a clean stop on a signal, 1 a boot preflight refusal and Node.js's own exit
 *   for an uncaught exception, 7 Node.js's exit for a listener that throws, 77 and 78 are Next.js's own.
 * - One line, and no stack: Next.js 16.4.6 registers its own `uncaughtException` logger in the NextNodeServer
 *   constructor, before `register()` runs, and that logger prints the error as thrown, with its stack, before this
 *   listener runs. That order was measured on 16.4.6 and is not documented by Next.js; if a release changes it, the
 *   line and the exit stay and only the stack is missing from the log. The line is redacted with
 *   `redactErrorMessage`; the error Next.js prints is not.
 * - The exit is synchronous: nothing else should run in a process whose state is unknown, so the shutdown hooks and
 *   pool closes of the SIGTERM path are not run either. The governance query events still queued are therefore lost,
 *   and the line counts them as `queryEventsLost`, read synchronously by `queuedQueryEventCount()`. That count includes
 *   an insert under way, whose rows may have landed, so it is at most what was lost. It is read from
 *   `src/lib/query-events/queued.ts`, which imports nothing, so this first boot step does not load the sink and its
 *   governance and storage modules.
 * - The exit runs even when building or writing the line throws, so the process ends with the named code and not with
 *   Node.js's 7 for a listener that throws; that line is then missing, and Next.js's print of the error is not.
 * - Unhandled promise rejections are left alone: Next.js keeps them non-fatal on purpose, and whether Studio stops on
 *   them too is open until they have been counted. Node.js started with `--unhandled-rejections=strict` raises each
 *   one as an uncaught exception with the origin "unhandledRejection", before any rejection listener runs; the exit
 *   then stops the server for it too, and the line names it as an unhandled rejection.
 * - Installed once per process: the installation is recorded in a global under a registered symbol, as
 *   `src/lib/shutdown.ts` keeps its hooks, so another `register()` call or another bundled copy of this module
 *   attaches nothing.
 * - Test seam: `installUncaughtExceptionExit()` takes the process it attaches to, so a test hands it a stand-in whose
 *   exit records the code and then throws `StandInExit` (tests/helpers/uncaught-exception-stand-in.ts), and `resetUncaughtExceptionExit()`
 *   forgets the installation. A test that runs `register()` installs on a stand-in first, so `register()`'s own install
 *   attaches nothing and the real `process.exit` is never bound in a test process.
 */
import { inspect } from "node:util";
import { logger } from "@/lib/logger";
import { redactErrorMessage } from "@/lib/mcp/serializer";
import { queuedQueryEventCount } from "@/lib/query-events/queued";

/** sysexits.h EX_SOFTWARE: the server stopped on an uncaught exception, and a fresh process is the recovery. */
export const UNCAUGHT_EXCEPTION_EXIT_CODE = 70;

/** The part of Node's `process` the exit uses, so a test hands it a stand-in whose exit records the code and throws. */
export interface UncaughtExceptionProcess {
  on(event: "uncaughtException", listener: (error: unknown, origin: NodeJS.UncaughtExceptionOrigin) => void): unknown;
  exit(code: number): void;
}

const REGISTRY_KEY = Symbol.for("libredb-studio.uncaught-exception-exit");

type RegistryHolder = { [REGISTRY_KEY]?: true };

/** An Error of this realm or of another one, such as an Error made by `node:vm`, which `instanceof` misses. */
function isError(value: unknown): value is Error {
  return value instanceof Error || Error.isError(value);
}

/** A value that is not an Error, on one line. */
function shown(value: unknown): string {
  return inspect(value, { breakLength: Number.POSITIVE_INFINITY });
}

/** The error's class, with its `code` in brackets when that is a string, as Node.js's inspect heads such an error. */
function errorHeading(error: Error): string {
  const name = String(error.name);
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" ? `${name} [${code}]` : name;
}

/**
 * The error's message, then the message of each error in its `errors` array, as an AggregateError carries them,
 * joined by "; " with empty ones left out. A dual-stack connection refusal is an AggregateError with an empty message,
 * whose inner errors name the addresses.
 */
function errorDetail(error: Error): string {
  const parts = [String(error.message)];
  const inner: unknown = (error as { errors?: unknown }).errors;
  if (Array.isArray(inner)) {
    for (const each of inner) parts.push(isError(each) ? String(each.message) : shown(each));
  }
  return parts.filter((part) => part !== "").join("; ");
}

/**
 * The line logged for `error`: the exit code, then the error's class with its string `code`, and its redacted message
 * with those of its inner errors, or the type and the redacted inspection of a thrown value that is not an Error. The
 * message is logged as it is: one that quotes an inner error's stack, as Node.js's ERR_UNHANDLED_ERROR does, keeps it.
 * `origin` is Node.js's: "unhandledRejection" when it raised an unhandled rejection as an uncaught exception, which
 * `--unhandled-rejections=strict` does for every one.
 *
 * A name or a message that is not a string is converted, so a Symbol name does not throw. A value whose conversion to a
 * string throws still makes it throw: a revoked Proxy, a `name` or `message` getter that throws, a name or message
 * that is a null-prototype object, a custom inspection that throws. The listener exits with the code anyway, when it
 * runs: Next.js's own print of the error runs first and may throw on such a value, and Node.js then exits with 7.
 */
export function uncaughtExceptionLine(
  error: unknown,
  origin: NodeJS.UncaughtExceptionOrigin = "uncaughtException",
): string {
  const what =
    origin === "unhandledRejection" ? "Unhandled rejection raised as an uncaught exception" : "Uncaught exception";
  const prefix = `${what}, exiting with code ${UNCAUGHT_EXCEPTION_EXIT_CODE}`;
  if (isError(error)) {
    const heading = errorHeading(error);
    const detail = errorDetail(error);
    // The heading alone for an empty detail, as Error.prototype.toString prints it: the redactor would say "Unknown error".
    return detail === "" ? `${prefix}: ${heading}` : `${prefix}: ${heading}: ${redactErrorMessage(detail)}`;
  }
  return `${prefix}: ${typeof error}: ${redactErrorMessage(shown(error))}`;
}

/**
 * Attaches the exit to `proc` once per process: it logs the line and exits with `UNCAUGHT_EXCEPTION_EXIT_CODE`.
 * The line carries `queryEventsLost` when governance query events were still queued, since the exit inserts none; an
 * insert under way is counted too, so it is at most what was lost. The exit runs even when building or writing the
 * line throws, so the code is the named one in every case that reaches this listener.
 */
export function installUncaughtExceptionExit(proc: UncaughtExceptionProcess): void {
  const holder = globalThis as RegistryHolder;
  if (holder[REGISTRY_KEY]) return;
  holder[REGISTRY_KEY] = true;
  proc.on("uncaughtException", (error, origin) => {
    try {
      const queued = queuedQueryEventCount();
      // No error object: Next.js has printed the error with its stack already, and the logger would print it again.
      logger.error(uncaughtExceptionLine(error, origin), undefined, {
        route: "uncaught-exception",
        queryEventsLost: queued > 0 ? queued : undefined,
      });
    } finally {
      proc.exit(UNCAUGHT_EXCEPTION_EXIT_CODE);
    }
  });
}

/** Test seam: forgets the installation, as a new process would; the listener stays on the process it was given. */
export function resetUncaughtExceptionExit(): void {
  delete (globalThis as RegistryHolder)[REGISTRY_KEY];
}
