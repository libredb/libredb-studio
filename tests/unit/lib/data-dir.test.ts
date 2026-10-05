import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as path from "path";
import {
  DEFAULT_STORAGE_SQLITE_PATH,
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
    process.env.STORAGE_SQLITE_PATH = "/var/lib/libredb/storage.db";
    expect(reservedStoragePaths()).toEqual([
      "/var/lib/libredb/storage.db",
      "/var/lib/libredb/storage.db-wal",
      "/var/lib/libredb/storage.db-shm",
    ]);
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
});
