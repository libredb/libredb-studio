import { describe, expect, test } from "bun:test";
import { missingPosixShell, testIf } from "../helpers/posix-tools";
import { howItFailed } from "../helpers/spawn-outcome";

/**
 * The sentence every spawning test now reports a failure with (B20).
 *
 * Two cases here spawn a child, kill it, and hold what the runtime reports - rather than trusting
 * the docblock's table. Without them this file would pass just as well for a helper whose premise
 * about `signalCode` was wrong.
 *
 * THOSE TWO ARE POSIX-ONLY, and a third holds the other platform. MEASURED on the Windows runner
 * of this repository's cross-platform job: a child killed there reports `exitCode` 0 and no signal
 * at all, because Windows has no POSIX signals to report. So the premise is true where signals
 * exist and false where they do not, and a case that asserts it everywhere is asserting the
 * platform rather than the helper.
 */

/**
 * Null on Linux and macOS, a reason on Windows. Platform rather than a probe, for the reason
 * `MISSING_POSIX_FILE_MODES` gives in `tests/helpers/posix-tools.ts`: a probe that answered "no"
 * on Linux would turn a real regression into a skip. Local to this file while it has one reader;
 * it belongs beside its siblings in posix-tools the day a second test needs it.
 */
const MISSING_POSIX_SIGNALS: string | null =
  process.platform === "win32"
    ? "POSIX signals: Windows reports a killed child as exit 0 with no signal, so there is no signal to name"
    : null;

/**
 * The mirror of the above: null on Windows WHERE `sh` exists, a reason everywhere else.
 *
 * The same command the POSIX cases use, because that is the one the Windows runner actually ran:
 * the red that started this reached `expect(killed.exitCode).toBeNull()` and read 0, which means
 * `sh -c "kill -9 $$"` executed there (Git for Windows ships `sh`). A runner without it has
 * nothing to spawn, so the reason says so instead of failing.
 */
const WINDOWS_KILL_CASE: string | null =
  process.platform === "win32"
    ? missingPosixShell("sh")
    : "this holds the Windows path, where a kill carries no signal";
describe("how a spawned child failed", () => {
  test("a child that exited non-zero is named by its exit code", () => {
    expect(howItFailed({ exitCode: 1 })).toBe("failed with exit 1");
    expect(howItFailed({ exitCode: 2, signalCode: null })).toBe("failed with exit 2");
    // bun reports `undefined` rather than null for a child that was not signalled.
    expect(howItFailed({ exitCode: 127, signalCode: undefined })).toBe("failed with exit 127");
  });

  test("a child that was killed is named by its signal, not by a null exit code", () => {
    expect(howItFailed({ exitCode: null, signalCode: "SIGKILL" })).toBe("was killed by SIGKILL");
    // node:child_process calls the field `signal`; both are read, so a helper caller does not
    // have to know which spawn it holds.
    expect(howItFailed({ exitCode: null, signal: "SIGTERM" })).toBe("was killed by SIGTERM");
  });

  test("the exit code is still named when it is null and nothing was signalled", () => {
    // Not a case to be proud of, but the honest one: `exit null` with no signal is all the
    // runtime gave, and inventing a cause here would be worse than printing what arrived.
    expect(howItFailed({ exitCode: null })).toBe("failed with exit null");
  });

  testIf(
    MISSING_POSIX_SIGNALS,
    "a real killed child reports a signal, which is the premise the docblock rests on",
    () => {
      const killed = Bun.spawnSync(["sh", "-c", "kill -9 $$"], { stdout: "ignore", stderr: "pipe" });
      // The three halves of the measurement, asserted rather than quoted: no exit code, a signal,
      // and an EMPTY stderr - which is why a message built from stderr alone said nothing.
      expect(killed.exitCode).toBeNull();
      expect(killed.signalCode).toBe("SIGKILL");
      expect(killed.stderr.toString()).toBe("");
      expect(howItFailed(killed)).toBe("was killed by SIGKILL");
    },
  );

  test("node:child_process spells the same two facts status and signal, and both are read", () => {
    expect(howItFailed({ status: 1 })).toBe("failed with exit 1");
    expect(howItFailed({ status: null, signal: "SIGKILL" })).toBe("was killed by SIGKILL");
  });

  test("a node child that could not run names its error, because it has neither a status nor a signal", () => {
    // What a `timeout` leaves behind: status null, signal null, the reason in `error`.
    // tests/integration/db/sqlite-provider.test.ts:3800 records meeting this one.
    expect(howItFailed({ status: null, signal: null, error: new Error("spawnSync /bin/x ETIMEDOUT") })).toBe(
      "could not run (spawnSync /bin/x ETIMEDOUT)",
    );
    // A signal still wins: a kill is more specific than "could not run".
    expect(howItFailed({ status: null, signal: "SIGTERM", error: new Error("ignored") })).toBe("was killed by SIGTERM");
  });

  testIf(MISSING_POSIX_SIGNALS, "a real node child killed by a signal reports it the node way", async () => {
    const { spawnSync } = await import("node:child_process");
    const killed = spawnSync("sh", ["-c", "kill -9 $$"]);
    expect(killed.status).toBeNull();
    expect(killed.signal).toBe("SIGKILL");
    expect(howItFailed(killed)).toBe("was killed by SIGKILL");
  });

  testIf(
    WINDOWS_KILL_CASE,
    "where there are no signals, the same kill is named by the exit code the platform does report",
    () => {
      // The Windows half of the premise, held where it is true, with the SAME command the POSIX
      // case uses - so the two together say what each platform makes of one kill rather than
      // comparing two different spawns. MEASURED on the Windows runner (#1800): `exitCode` came
      // back 0 rather than null. The helper is not asked to invent a signal the platform never
      // reports; it names the code, which is the whole of what arrived.
      const killed = Bun.spawnSync(["sh", "-c", "kill -9 $$"], { stdout: "ignore", stderr: "pipe" });
      expect(killed.signalCode ?? null).toBeNull();
      expect(killed.exitCode).not.toBeNull();
      expect(howItFailed(killed)).toBe(`failed with exit ${killed.exitCode}`);
    },
  );

  test("an ordinary refusal writes to stderr, which is the control for the case above", () => {
    const refused = Bun.spawnSync(["sh", "-c", "echo nope 1>&2; exit 3"], { stdout: "ignore", stderr: "pipe" });
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr.toString()).toContain("nope");
    expect(howItFailed(refused)).toBe("failed with exit 3");
  });
});
