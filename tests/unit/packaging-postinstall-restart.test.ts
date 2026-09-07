/**
 * Unit tests for the deb/rpm postinstall service-restart contract
 * (packaging/linux/scripts/postinstall.sh, wired by packaging/linux/nfpm.yaml).
 *
 * The script is exercised as a real subprocess against a stub "systemctl"
 * placed first on PATH; the stub appends its own argv to a log file, so the
 * assertions are about the observable sequence of systemctl invocations
 * rather than about the script's text. LIBREDB_SYSTEMD_RUNTIME_DIR points the
 * systemd probe at a temp directory, so the outcome never depends on whether
 * the host running the tests is booted with systemd.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../packaging/linux/scripts/postinstall.sh");

function stubSystemctl(exitCode: number, logPath: string): string {
  return `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logPath)}\nexit ${exitCode}\n`;
}

describe("packaging/linux/scripts/postinstall.sh service restart", () => {
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function runPostinstall({
    systemd,
    systemctlExitCode = 0,
    arg = "configure",
  }: {
    systemd: boolean;
    systemctlExitCode?: number;
    arg?: string;
  }) {
    const root = mkdtempSync(join(tmpdir(), "libredb-postinstall-"));
    fixtureRoots.push(root);

    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const logPath = join(root, "systemctl.log");
    const stubPath = join(binDir, "systemctl");
    writeFileSync(stubPath, stubSystemctl(systemctlExitCode, logPath));
    chmodSync(stubPath, 0o755);

    const runtimeDir = join(root, "run-systemd-system");
    if (systemd) mkdirSync(runtimeDir, { recursive: true });

    const result = Bun.spawnSync(["sh", SCRIPT, arg], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        LIBREDB_SYSTEMD_RUNTIME_DIR: runtimeDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const calls = existsSync(logPath)
      ? readFileSync(logPath, "utf8")
          .split("\n")
          .filter((line) => line.length > 0)
      : [];
    return { exitCode: result.exitCode, calls };
  }

  test("reloads units and then try-restarts the service, in that order", () => {
    const { exitCode, calls } = runPostinstall({ systemd: true });
    expect(exitCode).toBe(0);
    expect(calls).toEqual(["daemon-reload", "try-restart libredb-studio.service"]);
  });

  test("never probes is-active and never issues a bare restart", () => {
    const { calls } = runPostinstall({ systemd: true });
    // Positive control first: the log is non-empty and carries the new
    // command, so the two negatives below cannot pass vacuously.
    expect(calls).toContain("try-restart libredb-studio.service");
    expect(calls.some((call) => call.includes("is-active"))).toBe(false);
    expect(calls.some((call) => /^restart\b/.test(call))).toBe(false);
  });

  test("invokes systemctl at all only when systemd is the init system", () => {
    // Control: with the probed directory present, systemctl is invoked.
    const withSystemd = runPostinstall({ systemd: true });
    expect(withSystemd.calls.length).toBeGreaterThan(0);

    const withoutSystemd = runPostinstall({ systemd: false });
    expect(withoutSystemd.calls).toEqual([]);
    expect(withoutSystemd.exitCode).toBe(0);
  });

  test("exits 0 even when systemctl fails", () => {
    const { exitCode, calls } = runPostinstall({ systemd: true, systemctlExitCode: 1 });
    expect(exitCode).toBe(0);
    // Control: both commands were still attempted despite the failures.
    expect(calls).toEqual(["daemon-reload", "try-restart libredb-studio.service"]);
  });

  test("behaves the same for the rpm %post upgrade argument", () => {
    const { exitCode, calls } = runPostinstall({ systemd: true, arg: "2" });
    expect(exitCode).toBe(0);
    expect(calls).toEqual(["daemon-reload", "try-restart libredb-studio.service"]);
  });
});
