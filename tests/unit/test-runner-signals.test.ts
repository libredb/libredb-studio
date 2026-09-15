import { constants } from "node:os";
import { describe, expect, test } from "bun:test";
import { exitCodeForSignal, STOP_SIGNAL_NUMBERS, STOP_SIGNALS } from "../runner/signals";

// The end-to-end signal cases in tests/unit/test-runner-cli.test.ts can only drive the
// signals the running platform delivers, and they are skipped altogether on Windows.
// SIGBREAK is therefore untestable end to end everywhere: it exists only on Windows,
// and Windows delivers none of these to a piped child. So the mapping is pinned here,
// against injected tables, where every arm runs on every platform.
describe("the signals that stop a run", () => {
  test("the four signals are named, and each has a number written out", () => {
    expect([...STOP_SIGNALS]).toEqual(["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]);
    expect(STOP_SIGNAL_NUMBERS).toEqual({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGBREAK: 21 });
  });

  test("a signal the platform names takes its exit code from the platform's own number", () => {
    const platform = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGBREAK: 21 };

    expect(exitCodeForSignal("SIGINT", platform)).toBe(130);
    expect(exitCodeForSignal("SIGTERM", platform)).toBe(143);
    expect(exitCodeForSignal("SIGHUP", platform)).toBe(129);
    expect(exitCodeForSignal("SIGBREAK", platform)).toBe(149);
  });

  test("the platform's number is used rather than the written-out one, where they differ", () => {
    // The control for the case above: if the table were ignored, both would answer 130.
    expect(exitCodeForSignal("SIGINT", { SIGINT: 3 })).toBe(131);
  });

  test("a signal the platform does not name falls back to the written-out number, never NaN", () => {
    // This is the live case: os.constants.signals has no SIGBREAK on Linux or macOS,
    // so `128 + constants.signals.SIGBREAK` is NaN, and process.exit(NaN) throws
    // RangeError from inside the signal listener, where a throw leaves bun running.
    expect(exitCodeForSignal("SIGBREAK", {})).toBe(149);
    expect(exitCodeForSignal("SIGINT", {})).toBe(130);
    expect(exitCodeForSignal("SIGTERM", {})).toBe(143);
    expect(exitCodeForSignal("SIGHUP", {})).toBe(129);
  });

  test("on this platform, every stop signal resolves to a code process.exit accepts", () => {
    for (const signal of STOP_SIGNALS) {
      const code = exitCodeForSignal(signal);
      // process.exit refuses anything that is not a whole number in range, and the
      // whole point of the fallback is that no arm can reach it with NaN.
      expect({ signal, integer: Number.isInteger(code), inRange: code >= 128 && code <= 255 }).toEqual({
        signal,
        integer: true,
        inRange: true,
      });
    }
  });

  test("the written-out numbers agree with this platform's own table wherever it has them", () => {
    // Paired control for the fallback: if the written-out numbers were wrong, the
    // fallback would quietly report a different code from the one the shell reports.
    const platform = constants.signals as Partial<Record<(typeof STOP_SIGNALS)[number], number>>;
    const named = STOP_SIGNALS.filter((signal) => platform[signal] !== undefined);

    // On POSIX that is SIGINT, SIGTERM and SIGHUP; naming them proves the loop is not empty.
    expect(named.length).toBeGreaterThan(0);
    for (const signal of named)
      expect({ signal, number: platform[signal] }).toEqual({ signal, number: STOP_SIGNAL_NUMBERS[signal] });
  });
});
