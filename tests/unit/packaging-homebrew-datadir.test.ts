/**
 * Unit tests for the Homebrew direct-run wrapper's data/state directory
 * default (issue #135). Exercises the real packaged wrapper script (the
 * `bin/"libredb-studio"` heredoc in the .rb.tmpl) as a subprocess against a
 * stub "node" that only echoes STORAGE_SQLITE_PATH - no real server starts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB_NODE_SCRIPT = '#!/bin/sh\necho "STORAGE_SQLITE_PATH=$STORAGE_SQLITE_PATH"\n';

function writeStubNode(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const nodePath = join(binDir, "node");
  writeFileSync(nodePath, STUB_NODE_SCRIPT);
  chmodSync(nodePath, 0o755);
  return nodePath;
}

describe("packaging/homebrew/libredb-studio.rb.tmpl data dir (#135)", () => {
  const template = readFileSync(join(import.meta.dir, "../../packaging/homebrew/libredb-studio.rb.tmpl"), "utf8");
  const heredocMatch = /\(bin\/"libredb-studio"\)\.write <<~SCRIPT\n([\s\S]*?)\n\s*SCRIPT\b/.exec(template);
  if (!heredocMatch) throw new Error('could not locate the bin/"libredb-studio" heredoc in the Homebrew template');
  const rawScript = heredocMatch[1];

  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function runWrapper(env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "libredb-brew-datadir-"));
    fixtureRoots.push(dir);
    const nodePath = writeStubNode(join(dir, "keg-libexec"));
    const serverPath = join(dir, "keg-libexec", "server.js");
    writeFileSync(serverPath, "");
    // Simulates $(brew --prefix)/var - a sibling of the versioned Cellar keg,
    // not a path under it.
    const brewVar = join(dir, "brew-var");
    const script = rawScript
      .replaceAll('#{Formula["node@24"].opt_bin}/node', nodePath)
      .replaceAll("#{libexec}/server.js", serverPath)
      .replaceAll("#{var}/libredb-studio/libredb-storage.db", join(brewVar, "libredb-studio/libredb-storage.db"));
    const result = Bun.spawnSync(["bash", "-c", script], {
      env: { ...process.env, HOME: dir, HOSTNAME: "", LIBREDB_BIND: "", STORAGE_SQLITE_PATH: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { result, brewVar };
  }

  test("defaults STORAGE_SQLITE_PATH outside the versioned Cellar keg", () => {
    const { result, brewVar } = runWrapper();
    const output = result.stdout.toString();
    expect(output).toContain(`STORAGE_SQLITE_PATH=${join(brewVar, "libredb-studio/libredb-storage.db")}`);
    expect(output).not.toContain("keg-libexec");
  });

  test("honors an explicitly set STORAGE_SQLITE_PATH", () => {
    const { result } = runWrapper({ STORAGE_SQLITE_PATH: "/custom/path/db.sqlite" });
    expect(result.stdout.toString()).toContain("STORAGE_SQLITE_PATH=/custom/path/db.sqlite");
  });
});
