/**
 * The signals that stop a run, and the exit code each one ends it with.
 *
 * SIGINT is Ctrl+C. SIGTERM is `timeout(1)`, `docker stop`, Kubernetes and systemd,
 * and it is what `bun run test` forwards. SIGHUP is a closed terminal, and on Windows
 * a closed console window. SIGBREAK is Ctrl+Break, which GitHub Actions on Windows
 * sends 7.5 seconds after Ctrl+C; it is delivered only there, and naming it here is
 * valid on every platform. Handling only SIGINT, as this did, meant a run stopped any
 * other way printed nothing and left its scratch directory behind (measured 1.4.2).
 *
 * A signalled run exits 128 + the signal's number, which is what a shell reports. The
 * number comes from the platform's own table where the platform has it, because that
 * is the number the shell will use; the table below carries it where it does not.
 * That second case is real, not defensive: `os.constants.signals` has no SIGBREAK on
 * Linux or macOS (measured on bun 1.4.2), so `128 + constants.signals.SIGBREAK` is
 * NaN, and `process.exit(NaN)` throws RangeError ERR_OUT_OF_RANGE from inside the
 * signal listener, which is the one place a throw must not happen: measured on 1.4.2,
 * a throw from inside a SIGINT listener left the process RUNNING and the queue
 * started the next file. @types/node types every signal as present, so the compiler
 * cannot see it either.
 *
 * This lives beside the runner rather than inside it so the mapping can be tested on
 * every platform: SIGBREAK exists only on Windows, and Windows delivers none of these
 * to a piped child, so no end-to-end case can reach that arm anywhere.
 */
import { constants } from "node:os";

export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

export type StopSignal = (typeof STOP_SIGNALS)[number];

/**
 * The POSIX numbers, plus Windows's SIGBREAK, written out because no single platform's
 * table carries all four. A test pins these against the platform's own numbers for the
 * signals it does name, so a wrong one here cannot pass unnoticed.
 */
export const STOP_SIGNAL_NUMBERS: Record<StopSignal, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
  SIGBREAK: 21,
};

export function exitCodeForSignal(
  signal: StopSignal,
  platformSignals: Partial<Record<StopSignal, number>> = constants.signals,
): number {
  return 128 + (platformSignals[signal] ?? STOP_SIGNAL_NUMBERS[signal]);
}
