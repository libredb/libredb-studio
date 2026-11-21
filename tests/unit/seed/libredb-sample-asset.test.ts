/**
 * The committed LibreDB sample, seed-assets/libredb/sample.libredb, is exactly what scripts/generate-libredb-sample.mjs
 * builds with the engine this repository installs.
 *
 * The engine writes no time, host or process into the data file (those reach only its `.lock` sidecar), so a rebuild
 * gives the same bytes. An engine bump that changes them fails the first test here, and the fix is a rerun of the
 * script and a new pin in SAMPLES. The CLI runs in a node child process that writes only into a temporary directory.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { catalog, kv, open } from "@libredb/libredb";
import { SAMPLES } from "@/lib/seed/samples";
import { buildLibreDbSample, LIBREDB_SAMPLE_FILE } from "../../../scripts/generate-libredb-sample.mjs";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SCRIPT = path.join(ROOT, "scripts", "generate-libredb-sample.mjs");
const COMMITTED = path.join(ROOT, "seed-assets", "libredb", "sample.libredb");

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "libredb-sample-asset-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("the committed LibreDB sample", () => {
  test("the script names the committed file", () => {
    expect(LIBREDB_SAMPLE_FILE).toBe(COMMITTED);
  });

  test("rebuilding with the installed engine gives the committed bytes and the SAMPLES pin", () => {
    const file = path.join(temporaryDirectory(), "sample.libredb");
    buildLibreDbSample(file);
    const rebuilt = readFileSync(file);
    expect(rebuilt.equals(readFileSync(COMMITTED))).toBe(true);
    const spec = SAMPLES.get("libredb");
    expect(spec?.asset).toBe("libredb/sample.libredb");
    expect({ sha256: sha256(rebuilt), bytes: rebuilt.length }).toEqual({
      sha256: spec?.sha256 ?? "",
      bytes: spec?.bytes ?? -1,
    });
    expect(readdirSync(path.dirname(file))).toEqual(["sample.libredb"]);
  });

  test("a rebuild replaces an existing output and a stale build temp with its lock", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "sample.libredb");
    buildLibreDbSample(file);
    // A crashed earlier build of this pid (the build runs in this process): a half-built temp, and the lock the engine
    // writes beside it, naming this pid and host.
    const building = `${file}.${process.pid}.building`;
    writeFileSync(building, readFileSync(COMMITTED).subarray(0, 300));
    const token = randomUUID().replaceAll("-", "").slice(0, 16);
    writeFileSync(`${building}.lock`, `libredb-lock\n${process.pid}\n${hostname()}\n${token}\n`);
    buildLibreDbSample(file);
    expect(readFileSync(file).equals(readFileSync(COMMITTED))).toBe(true);
    expect(readdirSync(directory)).toEqual(["sample.libredb"]);
  });

  test("the committed file opens with users relational, articles document and two config keys", () => {
    const file = path.join(temporaryDirectory(), "sample.libredb");
    copyFileSync(COMMITTED, file);
    const db = open({ path: file });
    try {
      const registry = catalog(db);
      expect(registry.get("users")?.kind).toBe("relational");
      expect(registry.get("articles")?.kind).toBe("document");
      expect(
        kv(db)
          .prefix("config:")
          .toArray()
          .map((entry) => entry.key),
      ).toEqual(["config:locale", "config:theme"]);
    } finally {
      db.close();
    }
  });

  test("the CLI with --out writes the same bytes into a temp dir only, and leaves no .lock", () => {
    // Read before any stat, so nothing reads the committed file after checking it.
    const committed = readFileSync(COMMITTED);
    const committedModified = statSync(COMMITTED).mtimeMs;
    const directory = temporaryDirectory();
    const child = Bun.spawnSync(["node", SCRIPT, "--out", "out.libredb"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe("Wrote out.libredb\n");
    expect(readdirSync(directory)).toEqual(["out.libredb"]);
    expect(readFileSync(path.join(directory, "out.libredb")).equals(committed)).toBe(true);
    expect(statSync(COMMITTED).mtimeMs).toBe(committedModified);
  });

  test("the CLI refuses any other argument list with its usage line and writes nothing", () => {
    const directory = temporaryDirectory();
    for (const args of [["--out"], ["--out", "-x"], ["--output", "a"], ["a"], ["--out", "a", "b"]]) {
      const child = Bun.spawnSync(["node", SCRIPT, ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
      expect({ args, exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({
        args,
        exitCode: 2,
        stderr: "Usage: node scripts/generate-libredb-sample.mjs [--out <file>]\n",
      });
    }
    expect(readdirSync(directory)).toEqual([]);
  });
});
