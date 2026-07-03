import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as path from "path";
import { DEFAULT_STORAGE_SQLITE_PATH, getDataDir } from "@/lib/data-dir";

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
