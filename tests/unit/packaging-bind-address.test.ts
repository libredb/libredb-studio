/**
 * Unit tests for the local-first bind-address fix in the deb/rpm and
 * Homebrew direct-run wrappers (issue #134). Each wrapper is exercised as a
 * real subprocess against a stub "node" binary that only echoes the
 * HOSTNAME it was started with - no real server ever starts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB_NODE_SCRIPT = '#!/bin/sh\necho "HOSTNAME=$HOSTNAME"\n';
/** Looks like what Docker exports as HOSTNAME for every container process. */
const CONTAINER_ID = "3f9a1c2b4d5e";

function writeStubNode(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const nodePath = join(binDir, "node");
  writeFileSync(nodePath, STUB_NODE_SCRIPT);
  chmodSync(nodePath, 0o755);
  return nodePath;
}

describe("packaging/linux/libredb-studio bind address (#134)", () => {
  const WRAPPER = join(import.meta.dir, "../../packaging/linux/libredb-studio");
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function runWrapper(env: Record<string, string> = {}) {
    const home = mkdtempSync(join(tmpdir(), "libredb-deb-wrapper-"));
    fixtureRoots.push(home);
    writeStubNode(join(home, "node/bin"));
    writeFileSync(join(home, "server.js"), "");
    return Bun.spawnSync(["sh", WRAPPER], {
      env: {
        ...process.env,
        LIBREDB_STUDIO_HOME: home,
        HOME: home,
        HOSTNAME: "",
        INVOCATION_ID: "",
        LIBREDB_BIND: "",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("defaults to loopback when HOSTNAME is unset", () => {
    const result = runWrapper();
    expect(result.stdout.toString()).toContain("HOSTNAME=127.0.0.1");
  });

  test("forces loopback even when HOSTNAME is inherited (e.g. Docker container ID)", () => {
    const result = runWrapper({ HOSTNAME: CONTAINER_ID });
    expect(result.stdout.toString()).toContain("HOSTNAME=127.0.0.1");
  });

  test("honors LIBREDB_BIND as an explicit opt-in", () => {
    const result = runWrapper({ HOSTNAME: CONTAINER_ID, LIBREDB_BIND: "0.0.0.0" });
    expect(result.stdout.toString()).toContain("HOSTNAME=0.0.0.0");
  });

  test("leaves HOSTNAME untouched when invoked by systemd (INVOCATION_ID set)", () => {
    // The unit's own Environment=/EnvironmentFile= lines already resolved
    // HOSTNAME correctly (default or an operator override) before exec'ing
    // this wrapper; INVOCATION_ID is set for every systemd unit process.
    const result = runWrapper({ HOSTNAME: "0.0.0.0", INVOCATION_ID: "e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2" });
    expect(result.stdout.toString()).toContain("HOSTNAME=0.0.0.0");
  });
});

describe("packaging/homebrew/libredb-studio.rb.tmpl bind address (#134)", () => {
  const template = readFileSync(join(import.meta.dir, "../../packaging/homebrew/libredb-studio.rb.tmpl"), "utf8");
  const heredocMatch = /\(bin\/"libredb-studio"\)\.write <<~SCRIPT\n([\s\S]*?)\n\s*SCRIPT\b/.exec(template);
  if (!heredocMatch) throw new Error('could not locate the bin/"libredb-studio" heredoc in the Homebrew template');
  const rawScript = heredocMatch[1];

  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function runWrapper(env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "libredb-brew-wrapper-"));
    fixtureRoots.push(dir);
    const nodePath = writeStubNode(dir);
    const serverPath = join(dir, "server.js");
    writeFileSync(serverPath, "");
    const script = rawScript
      .replaceAll('#{Formula["node@24"].opt_bin}/node', nodePath)
      .replaceAll("#{libexec}/server.js", serverPath);
    return Bun.spawnSync(["bash", "-c", script], {
      env: { ...process.env, HOME: dir, HOSTNAME: "", LIBREDB_BIND: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("defaults to loopback when HOSTNAME is unset", () => {
    const result = runWrapper();
    expect(result.stdout.toString()).toContain("HOSTNAME=127.0.0.1");
  });

  test("forces loopback even when HOSTNAME is inherited (e.g. Docker container ID)", () => {
    const result = runWrapper({ HOSTNAME: CONTAINER_ID });
    expect(result.stdout.toString()).toContain("HOSTNAME=127.0.0.1");
  });

  test("honors LIBREDB_BIND as an explicit opt-in", () => {
    const result = runWrapper({ HOSTNAME: CONTAINER_ID, LIBREDB_BIND: "0.0.0.0" });
    expect(result.stdout.toString()).toContain("HOSTNAME=0.0.0.0");
  });
});
