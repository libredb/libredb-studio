import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as path from "path";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import {
  DEFAULT_STORAGE_SQLITE_PATH,
  foldPathKey,
  getDataDir,
  getStorageSqlitePath,
  isReservedStoragePath,
  reservedStoragePaths,
} from "@/lib/data-dir";

describe("data-dir getDataDir()", () => {
  let origStoragePath: string | undefined;

  beforeEach(() => {
    origStoragePath = process.env.STORAGE_SQLITE_PATH;
  });

  afterEach(() => {
    if (origStoragePath === undefined) delete process.env.STORAGE_SQLITE_PATH;
    else process.env.STORAGE_SQLITE_PATH = origStoragePath;
  });

  test("defaults to the directory of the default SQLite storage path", () => {
    delete process.env.STORAGE_SQLITE_PATH;
    expect(getDataDir()).toBe(path.dirname(DEFAULT_STORAGE_SQLITE_PATH));
  });

  test("derives the data dir from STORAGE_SQLITE_PATH when set", () => {
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    expect(getDataDir()).toBe("/var/lib/libredb");
  });

  test("treats an empty STORAGE_SQLITE_PATH as unset", () => {
    process.env.STORAGE_SQLITE_PATH = "";
    expect(getDataDir()).toBe(path.dirname(DEFAULT_STORAGE_SQLITE_PATH));
  });
});

describe("data-dir reserved storage paths", () => {
  let origStoragePath: string | undefined;

  beforeEach(() => {
    origStoragePath = process.env.STORAGE_SQLITE_PATH;
  });

  afterEach(() => {
    if (origStoragePath === undefined) delete process.env.STORAGE_SQLITE_PATH;
    else process.env.STORAGE_SQLITE_PATH = origStoragePath;
  });

  test("getStorageSqlitePath returns the default when unset", () => {
    delete process.env.STORAGE_SQLITE_PATH;
    expect(getStorageSqlitePath()).toBe(DEFAULT_STORAGE_SQLITE_PATH);
  });

  test("getStorageSqlitePath returns the configured path when set", () => {
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    expect(getStorageSqlitePath()).toBe("/var/lib/libredb/storage.db");
  });

  test("getStorageSqlitePath treats an empty value as unset", () => {
    process.env.STORAGE_SQLITE_PATH = "";
    expect(getStorageSqlitePath()).toBe(DEFAULT_STORAGE_SQLITE_PATH);
  });

  test("reservedStoragePaths lists the storage file and its WAL/SHM sidecars, resolved", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "libredb-storage-path-"));
    try {
      process.env.STORAGE_SQLITE_PATH = path.join(dir, "storage.db");
      const base = path.join(fs.realpathSync(dir), "storage.db");
      expect(reservedStoragePaths()).toEqual([base, `${base}-wal`, `${base}-shm`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reservedStoragePaths resolves a relative configured path against the cwd", () => {
    process.env.STORAGE_SQLITE_PATH = "data/libredb-storage.db";
    const base = path.resolve("data/libredb-storage.db");
    expect(reservedStoragePaths()).toEqual([base, `${base}-wal`, `${base}-shm`]);
  });

  test("isReservedStoragePath matches the storage file however it is spelled", () => {
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    expect(isReservedStoragePath("/var/lib/libredb/storage.db")).toBe(true);
    expect(isReservedStoragePath("/var/lib/libredb/../libredb/storage.db")).toBe(true);
  });

  test("isReservedStoragePath matches the WAL and SHM sidecars", () => {
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    expect(isReservedStoragePath("/var/lib/libredb/storage.db-wal")).toBe(true);
    expect(isReservedStoragePath("/var/lib/libredb/storage.db-shm")).toBe(true);
  });

  test("isReservedStoragePath does not match an unrelated path", () => {
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    expect(isReservedStoragePath("/var/lib/libredb/other.db")).toBe(false);
    expect(isReservedStoragePath("/tmp/user-data.db")).toBe(false);
  });

  test("isReservedStoragePath matches each storage file and bootstrap file in another letter case, none of them existing", () => {
    // On macOS and Windows each spelling names the reserved file itself.
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    for (const name of [
      "STORAGE.DB",
      "Storage.db",
      "storage.DB-WAL",
      "Storage.db-Shm",
      "Auth-Bootstrap.json",
      "AUTH-BOOTSTRAP.JSON.BAK",
      "auth-bootstrap.json.1234.TMP",
      "Auth-Bootstrap.JSON.1234.tmp",
    ]) {
      expect([name, isReservedStoragePath(`/var/lib/libredb/${name}`)]).toEqual([name, true]);
    }
    expect(isReservedStoragePath("/VAR/Lib/LibreDB/storage.db")).toBe(true);
  });

  test("isReservedStoragePath matches each storage file and bootstrap file in another Unicode normalization form", () => {
    const composed = "/var/lib/libr\u00e9db";
    const decomposed = "/var/lib/libre\u0301db";
    for (const [configured, candidate] of [
      [composed, decomposed],
      [decomposed, composed],
    ]) {
      process.env.STORAGE_SQLITE_PATH = `${configured}/storage.db`;
      for (const name of [
        "storage.db",
        "storage.db-wal",
        "storage.db-shm",
        "auth-bootstrap.json",
        "auth-bootstrap.json.bak",
        "auth-bootstrap.json.1234.tmp",
      ]) {
        expect([name, isReservedStoragePath(`${candidate}/${name}`)]).toEqual([name, true]);
      }
      expect(isReservedStoragePath(`${candidate.toUpperCase()}/STORAGE.DB-WAL`)).toBe(true);
    }
  });

  test("isReservedStoragePath still allows a name that differs in more than letter case or normalization", () => {
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    for (const name of [
      "STORAGE2.DB",
      "storage.db-journal",
      "Storage.db.bak",
      "AUTH-BOOTSTRAP.JSON.BAK2",
      "auth-bootstrap.json.1234.tmp2",
      "auth-bootstrap.jsonx.tmp",
      "auth-bootstrap.tmp",
    ]) {
      expect([name, isReservedStoragePath(`/var/lib/libredb/${name}`)]).toEqual([name, false]);
    }
    expect(isReservedStoragePath("/var/lib/libredb-other/STORAGE.DB")).toBe(false);
  });
});

describe("data-dir foldPathKey()", () => {
  test("folds letter case and Unicode normalization to one key", () => {
    expect(foldPathKey("/Data/LibreDB-Storage.DB")).toBe(foldPathKey("/data/libredb-storage.db"));
    expect(foldPathKey("/data/d\u00fcsseldorf")).toBe(foldPathKey("/DATA/Du\u0308sseldorf"));
  });

  test("folds letter case one code point at a time, so the two lower-case sigmas are one letter and sharp s is not SS", () => {
    // NTFS upcases both lower-case sigmas to the capital, and APFS folds the final sigma to the other.
    expect(foldPathKey("\u03bf\u03b4\u03bf\u03c3.db")).toBe(foldPathKey("\u03bf\u03b4\u03bf\u03c2.db"));
    expect(foldPathKey("\u03bf\u03b4\u03bf\u03c3.db")).toBe(foldPathKey("\u039f\u0394\u039f\u03a3.DB"));
    expect(foldPathKey("stra\u00dfe.db")).toBe(foldPathKey("STRA\u1e9eE.db"));
    expect(foldPathKey("stra\u00dfe.db")).not.toBe(foldPathKey("STRASSE.db"));
  });
});
