/**
 * Unit tests for scripts/ci-install.sh - the retrying `bun install` every CI
 * job goes through.
 *
 * `bun install` has no retry of its own, and "error: Fail extracting tarball
 * for <package>" killed three runs on 2026-07-29, one of them the 0.9.61 npm
 * publish. The script is exercised against a stub `bun` on PATH that fails a
 * chosen number of times, so the retry policy is verified without a network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../scripts/ci-install.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A fake `bun` that records every invocation and fails the first
 * `failuresBeforeSuccess` of them. `never` makes it fail every time.
 */
function stubBun(failuresBeforeSuccess: number | "never") {
  const root = mkdtempSync(join(tmpdir(), "ci-install-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(root, "calls.log");
  const fail = failuresBeforeSuccess === "never" ? "always" : String(failuresBeforeSuccess);
  writeFileSync(
    join(bin, "bun"),
    `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(log)}
calls=$(wc -l < ${JSON.stringify(log)})
if [ "${fail}" = "always" ]; then exit 1; fi
if [ "$calls" -le "${fail}" ]; then echo "error: Fail extracting tarball for next" >&2; exit 1; fi
exit 0
`,
  );
  chmodSync(join(bin, "bun"), 0o755);
  /*
    A fake `sleep` beside it, recording how long it was asked to wait.

    The backoff used to be checked by timing the script: two attempts with a 1s backoff had
    to finish under 1900ms, on the reasoning that a second backoff would push it past 2000.
    That is a proxy for the claim, and it measures the MACHINE as much as the script -- it
    failed at 1907ms on a loaded laptop, with nothing wrong. `bin` is first on the replaced
    PATH, so stubbing `sleep` the same way `bun` is stubbed turns the claim into something
    counted rather than timed: exact, instant, and true regardless of load.
  */
  const sleeps = join(root, "sleeps.log");
  writeFileSync(
    join(bin, "sleep"),
    `#!/usr/bin/env bash
echo "$1" >> ${JSON.stringify(sleeps)}
exit 0
`,
  );
  chmodSync(join(bin, "sleep"), 0o755);
  return { bin, log, sleeps };
}

function run(bin: string, env: Record<string, string> = {}) {
  return Bun.spawnSync(["bash", SCRIPT], {
    // PATH is replaced, not prepended: the stub must be the only bun in reach.
    env: { PATH: `${bin}:/usr/bin:/bin`, CI_INSTALL_BACKOFF_SECONDS: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function callCount(log: string): number {
  try {
    return readFileSync(log, "utf8").trimEnd().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

describe("scripts/ci-install.sh", () => {
  test("installs once when the first attempt succeeds", () => {
    const { bin, log } = stubBun(0);
    const result = run(bin);
    expect(result.exitCode).toBe(0);
    expect(callCount(log)).toBe(1);
    expect(readFileSync(log, "utf8")).toContain("install --frozen-lockfile");
  });

  test("retries and succeeds after a transient failure", () => {
    const { bin, log } = stubBun(1);
    const result = run(bin);
    expect(result.exitCode).toBe(0);
    expect(callCount(log)).toBe(2);
    // The retry is visible in the job log; a silent retry would hide a
    // registry that is degrading rather than broken.
    expect(result.stdout.toString()).toContain("::warning::");
  });

  test("gives up after the configured attempts and fails the step", () => {
    const { bin, log } = stubBun("never");
    const result = run(bin, { CI_INSTALL_ATTEMPTS: "3" });
    expect(result.exitCode).toBe(1);
    expect(callCount(log)).toBe(3);
    expect(result.stdout.toString()).toContain("::error::");
  });

  test("honours a custom attempt count", () => {
    const { bin, log } = stubBun("never");
    expect(run(bin, { CI_INSTALL_ATTEMPTS: "5" }).exitCode).toBe(1);
    expect(callCount(log)).toBe(5);
  });

  test("does not sleep after the final attempt", () => {
    // A backoff after the last failure is pure dead time in a red job.
    const { bin, sleeps } = stubBun("never");

    run(bin, { CI_INSTALL_ATTEMPTS: "2", CI_INSTALL_BACKOFF_SECONDS: "1" });

    // One backoff BETWEEN the two attempts and none after the second: the waits are read
    // off the stub rather than inferred from how long the run took.
    expect(readFileSync(sleeps, "utf8").trimEnd().split("\n").filter(Boolean)).toEqual(["1"]);
  });
});
