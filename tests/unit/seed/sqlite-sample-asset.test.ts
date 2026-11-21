/**
 * The committed SQLite sample, seed-assets/sqlite/employee.db, is the vendored template in WAL journal mode, and it is
 * exactly what scripts/generate-sqlite-sample.mjs makes of it.
 *
 * The script sets bytes 18 and 19 of the file header (the file format write and read versions) from 1, rollback
 * journalling, to 2, WAL, and changes nothing else: the SQLite file format defines those two bytes, so the result is
 * the same on every platform and every SQLite version, which `PRAGMA journal_mode = WAL` is not (it also stamps the
 * change counter and the writing library's version number). This file holds the committed bytes to the pin in SAMPLES,
 * holds the script to be a fixed point on them, proves that only the two bytes changed, opens a copy, and runs the
 * script's command in a node child process that writes only into a temporary directory.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SAMPLES } from "@/lib/seed/samples";
import { SQLITE_SAMPLE_FILE, walHeader } from "../../../scripts/generate-sqlite-sample.mjs";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SCRIPT = path.join(ROOT, "scripts", "generate-sqlite-sample.mjs");
const COMMITTED = path.join(ROOT, "seed-assets", "sqlite", "employee.db");

/** The vendored template as it was committed before the WAL change, in rollback journal mode. */
const ROLLBACK_TEMPLATE_SHA256 = "67c8c566f0a9f85801ec3f3b3b1eb0ec5bc48bc65cf7f7d0de2a3fe1e3750bb6";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-sample-asset-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** A copy of the committed file in a temporary directory, so an open never writes a sidecar into the tree. */
function committedCopy(): string {
  const file = path.join(temporaryDirectory(), "employee.db");
  copyFileSync(COMMITTED, file);
  return file;
}

describe("the committed SQLite sample", () => {
  test("the committed template is in WAL mode (bytes 18 and 19 are 2) and matches the SAMPLES pin", () => {
    const bytes = readFileSync(COMMITTED);
    expect([...bytes.subarray(18, 20)]).toEqual([2, 2]);
    const spec = SAMPLES.get("sqlite");
    expect(spec?.asset).toBe("sqlite/employee.db");
    expect({ sha256: sha256(bytes), bytes: bytes.length }).toEqual({
      sha256: spec?.sha256 ?? "",
      bytes: spec?.bytes ?? -1,
    });
  });

  test("the script names the committed file", () => {
    expect(SQLITE_SAMPLE_FILE).toBe(COMMITTED);
  });

  test("the script is a fixed point on the committed file, so a change is a rerun", () => {
    const bytes = readFileSync(COMMITTED);
    expect(Buffer.from(walHeader(bytes)).equals(bytes)).toBe(true);
  });

  test("the script changed only the two header bytes: with them set back to 1 the file is the rollback template of ab45843d9", () => {
    const rollback = Buffer.from(readFileSync(COMMITTED));
    rollback[18] = 1;
    rollback[19] = 1;
    expect(sha256(rollback)).toBe(ROLLBACK_TEMPLATE_SHA256);
    // And the script turns that rollback template into the committed bytes.
    expect(Buffer.from(walHeader(rollback)).equals(readFileSync(COMMITTED))).toBe(true);
  });

  test("a copy opens in WAL mode with integrity ok and 1000 employees", () => {
    // Writable: Apple's system SQLite, which bun:sqlite uses on macOS, cannot open a WAL file read-only without its
    // -shm file.
    const db = new Database(committedCopy());
    try {
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(db.query("SELECT COUNT(*) AS n FROM employee").get()).toEqual({ n: 1000 });
    } finally {
      db.close();
    }
  });

  test("a second open switches to WAL while another connection reads", () => {
    // The race a rollback template lost: with a reader in a read transaction, a second open's switch to WAL needs the
    // write lock and fails "database is locked". A file already in WAL mode has no switch to make.
    const file = committedCopy();
    const reader = new Database(file);
    try {
      reader.exec("BEGIN");
      reader.query("SELECT COUNT(*) AS n FROM employee").get();
      const second = new Database(file);
      try {
        expect(second.query("PRAGMA journal_mode = WAL").get()).toEqual({ journal_mode: "wal" });
      } finally {
        second.close();
      }
      reader.exec("COMMIT");
    } finally {
      reader.close();
    }
  });

  test("the script refuses a file that is not SQLite 3 and a header version it does not know", () => {
    expect(() => walHeader(Buffer.from("not a database at all, just some text"))).toThrow("is not a SQLite 3 database");
    const unknown = Buffer.from(readFileSync(COMMITTED));
    unknown[18] = 1;
    unknown[19] = 2;
    expect(() => walHeader(unknown)).toThrow("header bytes 18 and 19 are 1 and 2");
    unknown[18] = 3;
    unknown[19] = 3;
    expect(() => walHeader(unknown)).toThrow("header bytes 18 and 19 are 3 and 3");
  });

  test("the script returns a copy and leaves its input alone", () => {
    const rollback = Buffer.from(readFileSync(COMMITTED));
    rollback[18] = 1;
    rollback[19] = 1;
    const out = walHeader(rollback);
    expect(out).not.toBe(rollback);
    expect([...rollback.subarray(18, 20)]).toEqual([1, 1]);
  });

  test("the CLI with --out writes the same bytes into a temp dir only", () => {
    const committedModified = statSync(COMMITTED).mtimeMs;
    const directory = temporaryDirectory();
    const child = Bun.spawnSync(["node", SCRIPT, "--out", "out.db"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe("Wrote out.db\n");
    expect(readdirSync(directory)).toEqual(["out.db"]);
    expect(readFileSync(path.join(directory, "out.db")).equals(readFileSync(COMMITTED))).toBe(true);
    expect(statSync(COMMITTED).mtimeMs).toBe(committedModified);
  });

  test("the CLI refuses any other argument list with its usage line and writes nothing", () => {
    const directory = temporaryDirectory();
    for (const args of [["--out"], ["--out", "-x"], ["--output", "a.db"], ["a.db"], ["--out", "a.db", "b.db"]]) {
      const child = Bun.spawnSync(["node", SCRIPT, ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
      expect({ args, exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({
        args,
        exitCode: 2,
        stderr: "Usage: node scripts/generate-sqlite-sample.mjs [--out <file>]\n",
      });
    }
    expect(readdirSync(directory)).toEqual([]);
  });
});
