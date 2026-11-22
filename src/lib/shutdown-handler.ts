/**
 * The shutdown handler: what Studio does on SIGTERM and SIGINT (docs/DISTRIBUTION.md#stopping-the-server).
 *
 * - One owner of the exit. Next.js's `startServer` (`next/dist/server/lib/start-server.js`) installs its own SIGTERM
 *   and SIGINT listener, `cleanup`, which closes the HTTP server, waits for the requests in flight and exits with 143
 *   or 130, unless `NEXT_MANUAL_SIG_HANDLE` is set, in which case it installs none. Next.js 16.4.6 documents the
 *   variable only for the Pages Router (its self-hosting guide, "Manual Graceful Shutdowns"); that `startServer`
 *   installs no handler with it set holds for this App Router app too, as read in 16.4.6, and is not documented for
 *   it, so tests/live/shutdown-signal-live.ts must pass on every Next.js upgrade.
 *   So `NEXT_MANUAL_SIG_HANDLE=true` gives Studio the exit, and unset or empty leaves it to Next.js; any other value
 *   refuses the boot, so the owner is never in doubt, and so does `true` on Bun, where the request drain sees nothing
 *   (src/lib/shutdown-drain.ts). The variable must be set in the environment that starts the
 *   server, never in a `.env` file: Next.js reads it before it loads `.env`, and Studio reads it in `register()`
 *   after, so a `.env` value would give both handlers the exit.
 * - The drain. Where Studio owns the exit, the handler starts the request drain (src/lib/shutdown-drain.ts) at install,
 *   so it learns from boot, through node:diagnostics_channel, the HTTP servers and the requests in flight. Next.js
 *   drains them itself where it owns the exit, so there nothing subscribes.
 * - The steps. On the first signal it logs one line naming the signal and the owner. Where Studio owns the exit the
 *   line also counts the servers the drain closes and the responses in flight, and the drain runs first: it closes
 *   every server seen to new connections, answers with `Connection: close` the last request on each connection whose
 *   headers have not gone out, ends each kept-alive connection as its last response ends, and waits at most 5 s for
 *   the requests in flight, so their query events are queued before the flush. Then it runs the shutdown hooks
 *   (`runShutdownHooks()` in src/lib/shutdown.ts, at most 5 s), which insert the queued query events and close the
 *   governance pool. Where Studio owns the exit it then runs every registered provider cache close at once
 *   (`closeProviderCaches()`, at most 15 s), logs one end line and exits, 25 s at most after the signal. Where Next.js
 *   owns the exit it closes no server and no provider and never exits: Next.js may still be draining requests that
 *   use the providers, and its exit ends the process and the pools with it. There it attaches an `exit` listener at
 *   the signal, which Node.js runs inside `process.exit`, and logs one line as the process exits, counting the query
 *   events left unsent and naming the hooks still running.
 * - The exit code where Studio owns the exit: 0 when every request in flight ended within the drain's deadline, none
 *   is in flight at the exit and none went unanswered, every hook and every close settled without failing in time
 *   and no query event is left in the sink's queue (`queuedQueryEventCount()`, read without loading the sink);
 *   otherwise 128 plus the signal's number, 143 for SIGTERM and 130 for SIGINT, the codes Next.js's own handler exits
 *   with, and the end line names what was cut or failed and counts `responsesCut`, `responsesInFlightAtExit`,
 *   `requestsUnanswered` and `queryEventsLost`. A request in flight at the exit is one the drain's deadline cut, or
 *   one that started after the drain on a connection it could not end (src/lib/shutdown-drain.ts, "Limits"). An
 *   unanswered request is one pipelined behind an answer that ended its connection with the drain's
 *   `Connection: close`: its handler ran, and Node.js sent it no answer. A provider close fails when a provider did
 *   not close completely (`closeCachesAtShutdown` in src/lib/db/factory.ts). A step that rejects is logged and counts
 *   as incomplete; the exit runs anyway.
 * - Repeated signals start nothing, do not cut the run and do not change the code; the first is logged. `npx` delivers
 *   every Ctrl+C twice, once from the terminal and once from the launcher's forward, and so do `bun dev` and
 *   `bun start` through scripts/next-with-seed-assets.mjs, so a second signal must not force the exit. On Windows that
 *   launcher's forward ends the Next.js CLI at once instead, which no handler here can prevent.
 * - Installed once per process by `register()` at boot, right after the uncaught-exception exit: the installation is
 *   recorded in a global under a registered symbol, as src/lib/uncaught-exception.ts does, so another `register()`
 *   call or another bundled copy of this module attaches nothing. It never imports the provider factory: each bundle
 *   that loads the factory has its own copy with its own caches, and each copy registers its close with the registry
 *   in src/lib/shutdown.ts, which this module runs.
 * - The uncaught-exception exit stays separate: it listens to `uncaughtException` only, and an uncaught exception at
 *   any time, during a shutdown too, ends the process at once with 70.
 * - Limits: Windows delivers no SIGTERM, and Ctrl+C there is SIGINT; under `next dev` the parent kills the server
 *   `NEXT_EXIT_TIMEOUT_MS` after the signal, undocumented and 100 ms by default in Next.js 16.4.6, and manual signal
 *   handling is not available; a signal in the first fraction of a second, before `register()` runs, reaches no
 *   Studio handler (docs/DISTRIBUTION.md#stopping-the-server names the two windows).
 * - Test seam: `installShutdownHandler()` takes the process it attaches to, so a test hands it a stand-in whose exit
 *   records the code (tests/helpers/shutdown-stand-in.ts), and the source of request starts the drain reads
 *   (tests/helpers/request-starts-stand-in.ts); `resetShutdownHandler()` forgets the installation and unsubscribes
 *   the drain.
 */
import { constants } from "node:os";
import { logger } from "@/lib/logger";
import { queuedQueryEventCount } from "@/lib/query-events/queued";
import {
  closeProviderCaches,
  type ProviderCacheClosesOutcome,
  runShutdownHooks,
  type ShutdownHooksOutcome,
  shutdownHooksRunning,
} from "@/lib/shutdown";
import {
  type DrainOutcome,
  nodeRequestStarts,
  type RequestDrain,
  type RequestStarts,
  trackRequests,
} from "@/lib/shutdown-drain";

/** The environment variable that, set to `true`, makes Next.js install no signal handler and Studio own the exit. */
export const MANUAL_SIGNAL_HANDLING_VARIABLE = "NEXT_MANUAL_SIG_HANDLE";

/** The signals the handler listens to, the two Next.js's own handler listens to. */
export type ShutdownSignal = "SIGTERM" | "SIGINT";

/** Who ends the process on a signal: Studio's handler, or Next.js's. */
export type ExitOwner = "studio" | "nextjs";

/** The part of Node's `process` the handler uses, so a test hands it a stand-in whose exit records the code. */
export interface ShutdownProcess {
  on(event: ShutdownSignal, listener: (signal: ShutdownSignal) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  exit(code: number): void;
}

const REGISTRY_KEY = Symbol.for("libredb-studio.shutdown-handler");

interface HandlerState {
  /** The signal that started the shutdown, once one has. */
  started?: ShutdownSignal;
  /** Whether a later signal has been logged. */
  repeatLogged: boolean;
  /** The request drain, where Studio owns the exit. */
  requests?: RequestDrain;
}

type RegistryHolder = { [REGISTRY_KEY]?: HandlerState };

function refuse(problem: string, accepted: readonly string[]): undefined {
  console.error(
    [
      "",
      "============================================================",
      ` LibreDB Studio cannot start: ${MANUAL_SIGNAL_HANDLING_VARIABLE} is set to ${problem}`,
      " It decides who ends the server on SIGTERM and SIGINT, and only these",
      " states are accepted:",
      ...accepted,
      " Set it in the environment that starts the server, never in a .env file.",
      " See docs/DISTRIBUTION.md#stopping-the-server",
      "============================================================",
      "",
    ].join("\n"),
  );
  process.exit(1);
  return undefined;
}

/**
 * Who owns the exit, from `NEXT_MANUAL_SIG_HANDLE`: Studio for `true`, Next.js when it is unset or empty. Any other
 * value, and `true` on Bun, whose node:http publishes nothing the request drain reads, prints a banner, exits with
 * status 1 and returns undefined. `versions` is the runtime's `process.versions`, a test seam.
 */
export function exitOwnerAtBoot(
  versions: { readonly node: string; readonly bun?: string } = process.versions,
): ExitOwner | undefined {
  const value = process.env[MANUAL_SIGNAL_HANDLING_VARIABLE];
  if (value === undefined || value === "") return "nextjs";
  if (value === "true" && typeof versions.bun === "string") {
    return refuse(`"true" on Bun ${versions.bun}`, [
      `   1. ${MANUAL_SIGNAL_HANDLING_VARIABLE}=true, with the server on Node.js: Studio's shutdown`,
      "      handler ends it; on Bun its request drain sees no request",
      `   2. ${MANUAL_SIGNAL_HANDLING_VARIABLE} unset or empty: Next.js's handler ends it`,
    ]);
  }
  if (value === "true") return "studio";
  return refuse(`"${value}"`, [
    `   1. ${MANUAL_SIGNAL_HANDLING_VARIABLE}=true: Studio's shutdown handler ends it`,
    `   2. ${MANUAL_SIGNAL_HANDLING_VARIABLE} unset or empty: Next.js's handler ends it`,
  ]);
}

/** Runs one step, and answers the step's name when it rejected, which is then logged. */
async function step<T>(name: string, run: () => Promise<T>, fallback: T): Promise<{ value: T; failed?: string }> {
  try {
    return { value: await run() };
  } catch (error) {
    logger.error("Shutdown step failed", error, { route: "shutdown", step: name });
    return { value: fallback, failed: name };
  }
}

const NOTHING_DRAINED: DrainOutcome = { servers: 0, cut: 0 };
const NONE_CUT: ShutdownHooksOutcome = { cut: [], failed: [] };
const NO_CLOSE_CUT: ProviderCacheClosesOutcome = { cut: 0, failed: 0 };

/** A list or a count for the end line, or undefined when there is nothing to name. */
const named = <T>(value: readonly T[]): readonly T[] | undefined => (value.length > 0 ? value : undefined);
const counted = (value: number): number | undefined => (value > 0 ? value : undefined);

async function shutDown(
  proc: ShutdownProcess,
  requests: RequestDrain | undefined,
  signal: ShutdownSignal,
): Promise<void> {
  if (requests === undefined) {
    await step("hooks", runShutdownHooks, NONE_CUT);
    return;
  }
  const drain = await step("drain", () => requests.drain(), NOTHING_DRAINED);
  const hooks = await step("hooks", runShutdownHooks, NONE_CUT);
  const closes = await step("provider cache closes", closeProviderCaches, NO_CLOSE_CUT);

  const stepsFailed = [drain.failed, hooks.failed, closes.failed].filter((name): name is string => name !== undefined);
  // Events still queued now are never sent: the flush, which ran if an event was recorded before the hooks started,
  // has ended.
  const queryEventsLost = queuedQueryEventCount();
  // Responses the exit cuts: those the drain's deadline cut, and those that started after the drain on a connection it
  // could not end, such as one whose next request had begun.
  const responsesInFlightAtExit = requests.tracked().inFlight;
  // Requests whose handlers ran with no answer to send, behind an answer that ended their connection.
  const requestsUnanswered = requests.unanswered();
  const complete =
    stepsFailed.length === 0 &&
    drain.value.cut === 0 &&
    responsesInFlightAtExit === 0 &&
    requestsUnanswered === 0 &&
    hooks.value.cut.length === 0 &&
    hooks.value.failed.length === 0 &&
    closes.value.cut === 0 &&
    closes.value.failed === 0 &&
    queryEventsLost === 0;
  const code = complete ? 0 : 128 + constants.signals[signal];
  if (complete) {
    logger.info(`Shutdown complete, exiting with ${code}`, { route: "shutdown", signal });
  } else {
    logger.warn(`Shutdown incomplete, exiting with ${code}`, {
      route: "shutdown",
      signal,
      responsesCut: counted(drain.value.cut),
      responsesInFlightAtExit: counted(responsesInFlightAtExit),
      requestsUnanswered: counted(requestsUnanswered),
      hooksCut: named(hooks.value.cut),
      hooksFailed: named(hooks.value.failed),
      cacheClosesCut: counted(closes.value.cut),
      cacheClosesFailed: counted(closes.value.failed),
      stepsFailed: named(stepsFailed),
      queryEventsLost: counted(queryEventsLost),
    });
  }
  proc.exit(code);
}

/**
 * Where Next.js owns the exit: logs, as the process exits, the query events it leaves unsent and the hooks it cuts.
 * Node.js runs an `exit` listener synchronously inside `process.exit`, so the line is written by whatever ends the
 * process, Next.js's handler included.
 */
function logExit(signal: ShutdownSignal, code: number): void {
  const queryEventsLost = queuedQueryEventCount();
  const hooksRunning = shutdownHooksRunning();
  if (queryEventsLost === 0 && hooksRunning.length === 0) {
    logger.info(`Exiting with ${code} after ${signal}`, { route: "shutdown", signal });
    return;
  }
  logger.warn(`Exiting with ${code} after ${signal}`, {
    route: "shutdown",
    signal,
    queryEventsLost: counted(queryEventsLost),
    hooksRunning: named(hooksRunning),
  });
}

/**
 * Attaches one SIGTERM and one SIGINT listener to `proc` once per process. Where `owner` is Studio, it first starts
 * the request drain on `starts`, and the shutdown drains the requests in flight and ends with `proc.exit`.
 */
export function installShutdownHandler(
  proc: ShutdownProcess,
  owner: ExitOwner,
  starts: RequestStarts = nodeRequestStarts,
): void {
  const holder = globalThis as RegistryHolder;
  if (holder[REGISTRY_KEY]) return;
  const state: HandlerState = { repeatLogged: false };
  holder[REGISTRY_KEY] = state;
  const requests = owner === "studio" ? trackRequests(starts) : undefined;
  state.requests = requests;
  const onSignal = (signal: ShutdownSignal): void => {
    if (state.started !== undefined) {
      if (!state.repeatLogged) {
        state.repeatLogged = true;
        logger.info(`Received ${signal} during the shutdown already under way; it goes on`, { route: "shutdown" });
      }
      return;
    }
    state.started = signal;
    if (requests === undefined) {
      logger.info(`Received ${signal}: running the shutdown hooks; Next.js's handler ends the process`, {
        route: "shutdown",
        owner,
      });
      proc.on("exit", (code) => logExit(signal, code));
    } else {
      logger.info(
        `Received ${signal}: closing the HTTP server and waiting for the requests in flight, then running the shutdown hooks, then closing the providers, then exiting`,
        { route: "shutdown", owner, ...requests.tracked() },
      );
    }
    void shutDown(proc, requests, signal);
  };
  proc.on("SIGTERM", onSignal);
  proc.on("SIGINT", onSignal);
}

/**
 * Test seam: forgets the installation, as a new process would, and unsubscribes its request drain; the listeners stay
 * on the process they were given.
 */
export function resetShutdownHandler(): void {
  const holder = globalThis as RegistryHolder;
  holder[REGISTRY_KEY]?.requests?.stop();
  delete holder[REGISTRY_KEY];
}
