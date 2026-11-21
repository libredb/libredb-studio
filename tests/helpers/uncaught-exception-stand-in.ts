/**
 * A stand-in for the part of Node's `process` that the uncaught-exception exit uses (src/lib/uncaught-exception.ts).
 *
 * It records each listener attached to it and each exit code asked of it, and never touches the real process. A test
 * that runs `register()` installs the exit on a stand-in first, so `register()`'s own install attaches nothing and the
 * test process never gets a listener that calls the real `process.exit`.
 *
 * Its exit records the code and then throws `StandInExit`, because the real `process.exit` never returns: nothing the
 * listener would do after the exit runs here either, so a test sees what happened before it.
 */
import type { UncaughtExceptionProcess } from "@/lib/uncaught-exception";

/** What the stand-in's exit throws, so the rest of the listener does not run, as with the real exit. */
export class StandInExit extends Error {
  constructor(readonly code: number) {
    super(`stand-in process exited with ${code}`);
    this.name = "StandInExit";
  }
}

type Listener = Parameters<UncaughtExceptionProcess["on"]>[1];

export interface StandInProcess extends UncaughtExceptionProcess {
  /** Every listener attached, in order, with its event. */
  readonly registrations: { event: string; listener: Listener }[];
  /** Every exit code asked for, in order. */
  readonly exits: number[];
}

/** Returns a fresh stand-in process with nothing attached and nothing exited. */
export function standInProcess(): StandInProcess {
  const registrations: StandInProcess["registrations"] = [];
  const exits: number[] = [];
  return {
    registrations,
    exits,
    on(event, listener) {
      registrations.push({ event, listener });
      return this;
    },
    exit(code) {
      exits.push(code);
      throw new StandInExit(code);
    },
  };
}
