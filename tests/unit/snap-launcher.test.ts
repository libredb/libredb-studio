/**
 * Unit tests for the snap daemon's configuration defaults (issue #807).
 *
 * snap-exec applies an app's manifest `environment:` over the caller's
 * environment, so any key set there can never be overridden by the systemd
 * drop-in the docs recommend. The defaults therefore live in the launcher,
 * which is exercised here as a real subprocess against a stub "node" binary
 * that only echoes its environment - no real server ever starts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MISSING_POSIX_FILE_MODES, describeIf, missingPosixShell, posixShell } from "../helpers/posix-tools";

const REPO_ROOT = join(import.meta.dir, "../..");
const LAUNCHER = join(REPO_ROOT, "snap/local/launch.sh");
/*
  Only the second describe runs anything: it executes the snap's own launcher against a stub `node`
  that is a `#!/bin/sh` file made runnable with chmod 0755. snapd is Linux-only, Windows has no exec
  bit and cannot exec an extension-less #! file, and `Bun.spawnSync(["sh", ...])` THROWS there
  ("Executable not found in $PATH", measured in this worktree). The manifest describe above it is
  YAML parsing and keeps running everywhere.
*/
const SHELL = posixShell("sh");
const CANNOT_RUN = missingPosixShell("sh") ?? MISSING_POSIX_FILE_MODES;

/** Every key the launcher defaults, and so an operator must be able to override. */
const DEFAULTED_KEYS = [
  "NODE_ENV",
  "NEXT_TELEMETRY_DISABLED",
  "STORAGE_PROVIDER",
  "STORAGE_SQLITE_PATH",
  "PORT",
  "HOSTNAME",
] as const;

const SYSTEMD_INVOCATION_ID = "e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2";
/** Looks like what Docker exports as HOSTNAME for every container process. */
const CONTAINER_ID = "3f9a1c2b4d5e";

describe("snap/snapcraft.yaml app environment (#807)", () => {
  const manifest = Bun.YAML.parse(readFileSync(join(REPO_ROOT, "snap/snapcraft.yaml"), "utf8")) as {
    apps: Record<string, { command: string; environment?: Record<string, string> }>;
  };
  const app = manifest.apps["libredb-studio"];

  test("the parsed app is the daemon the launcher serves", () => {
    expect(app.command).toBe("bin/libredb-studio-launch");
  });

  test.each([...DEFAULTED_KEYS])("does not set %s, which would shadow a systemd override", (key) => {
    expect(Object.keys(app.environment ?? {})).not.toContain(key);
  });
});

describeIf(CANNOT_RUN, "snap/local/launch.sh defaults (#807)", () => {
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function runLauncher(env: Record<string, string> = {}): Record<string, string> {
    const root = mkdtempSync(join(tmpdir(), "libredb-snap-launcher-"));
    fixtureRoots.push(root);
    const snap = join(root, "snap");
    mkdirSync(join(snap, "node/bin"), { recursive: true });
    const stubNode = join(snap, "node/bin/node");
    writeFileSync(stubNode, `#!/bin/sh\n${DEFAULTED_KEYS.map((k) => `echo "${k}=$${k}"`).join("\n")}\n`);
    chmodSync(stubNode, 0o755);
    writeFileSync(join(snap, "server.js"), "");

    const cleared = Object.fromEntries([...DEFAULTED_KEYS, "INVOCATION_ID", "LIBREDB_BIND"].map((k) => [k, ""]));
    const result = Bun.spawnSync([SHELL!, LAUNCHER], {
      env: { ...process.env, ...cleared, SNAP: snap, SNAP_DATA: join(root, "data"), ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    return Object.fromEntries(
      result.stdout
        .toString()
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
  }

  test("applies the local-first defaults when systemd passes nothing", () => {
    const env = runLauncher({ INVOCATION_ID: SYSTEMD_INVOCATION_ID, SNAP_DATA: "/var/snap/libredb-studio/69" });
    expect(env).toEqual({
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      STORAGE_PROVIDER: "sqlite",
      STORAGE_SQLITE_PATH: "/var/snap/libredb-studio/69/libredb-storage.db",
      PORT: "3000",
      HOSTNAME: "127.0.0.1",
    });
  });

  test("honours every value a systemd drop-in sets", () => {
    const overrides = {
      NODE_ENV: "test",
      NEXT_TELEMETRY_DISABLED: "0",
      STORAGE_PROVIDER: "postgres",
      STORAGE_SQLITE_PATH: "/var/snap/libredb-studio/common/other.db",
      PORT: "3999",
      HOSTNAME: "0.0.0.0",
    };
    expect(runLauncher({ INVOCATION_ID: SYSTEMD_INVOCATION_ID, ...overrides })).toEqual(overrides);
  });

  test("forces loopback on a direct run that inherits HOSTNAME (e.g. Docker container ID)", () => {
    expect(runLauncher({ HOSTNAME: CONTAINER_ID }).HOSTNAME).toBe("127.0.0.1");
  });

  test("honours LIBREDB_BIND as the opt-in on a direct run", () => {
    expect(runLauncher({ HOSTNAME: CONTAINER_ID, LIBREDB_BIND: "0.0.0.0" }).HOSTNAME).toBe("0.0.0.0");
  });
});
