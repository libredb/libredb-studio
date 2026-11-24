/**
 * A stand-in for the part of Node's `process` that the shutdown handler uses (src/lib/shutdown-handler.ts).
 *
 * It records each listener attached to it by event and each exit code asked of it, and never touches the real
 * process. A test that runs `register()` installs the handler on a stand-in first, so `register()`'s own install
 * attaches nothing and the test process never gets a signal listener that calls the real `process.exit`.
 *
 * Its exit records the code, calls every `exit` listener with it, as Node.js's `process.exit` does, resolves `exited`
 * with the first code and returns, so a test awaits `exited` instead of a timer before it asserts, and sees whatever
 * the handler did after the exit too. A case calls its exit itself to stand for Next.js's handler ending the process.
 */
import type { ShutdownProcess, ShutdownSignal } from "@/lib/shutdown-handler";

/** A signal listener, called with the signal, or an `exit` listener, called with the code. */
type Listener = ((signal: ShutdownSignal) => void) | ((code: number) => void);

export interface ShutdownStandIn extends ShutdownProcess {
  /** Every listener attached, in order, with its event. */
  readonly registrations: { event: string; listener: Listener }[];
  /** Every exit code asked for, in order. */
  readonly exits: number[];
  /** Settles with the first exit code asked for. */
  readonly exited: Promise<number>;
  /** Calls every listener attached for `signal`, as Node.js does when the process receives it. */
  signal(signal: ShutdownSignal): void;
}

/** Returns a fresh stand-in process with nothing attached and nothing exited. */
export function shutdownStandIn(): ShutdownStandIn {
  const registrations: ShutdownStandIn["registrations"] = [];
  const exits: number[] = [];
  let resolveExited: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  return {
    registrations,
    exits,
    exited,
    on(event: string, listener: Listener) {
      registrations.push({ event, listener });
      return this;
    },
    exit(code) {
      exits.push(code);
      // An `exit` registration holds an exit listener, as a signal registration holds a signal listener.
      for (const each of registrations) if (each.event === "exit") (each.listener as (code: number) => void)(code);
      resolveExited(code);
    },
    signal(signal) {
      for (const each of registrations) {
        if (each.event === signal) (each.listener as (signal: ShutdownSignal) => void)(signal);
      }
    },
  };
}
