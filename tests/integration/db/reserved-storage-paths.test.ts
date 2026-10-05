import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";
import { DuckDBProvider } from "@/lib/db/providers/sql/duckdb";
import { LibreDBProvider } from "@/lib/db/providers/embedded/libredb";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { isReservedStoragePath } from "@/lib/data-dir";
import type { DatabaseConnection } from "@/lib/types";

let dir: string;
let original: string | undefined;
beforeEach(() => {
  original = process.env.STORAGE_SQLITE_PATH;
  dir = fs.mkdtempSync(path.join(tmpdir(), "libredb-reserved-"));
  process.env.STORAGE_SQLITE_PATH = path.join(dir, "storage.db");
});
afterEach(() => {
  if (original === undefined) delete process.env.STORAGE_SQLITE_PATH;
  else process.env.STORAGE_SQLITE_PATH = original;
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const [type, Provider] of [
  ["sqlite", SQLiteProvider],
  ["duckdb", DuckDBProvider],
  ["libredb", LibreDBProvider],
] as const) {
  describe(`${type} reserved server files`, () => {
    for (const name of [
      "storage.db",
      "storage.db-wal",
      "storage.db-shm",
      "auth-bootstrap.json",
      "auth-bootstrap.json.bak",
      "auth-bootstrap.json.123.tmp",
    ]) {
      test(`refuses ${name} before opening or creating it`, async () => {
        const target = path.join(dir, name);
        const config: DatabaseConnection = {
          id: "reserved",
          name: "reserved",
          type,
          database: target,
          createdAt: new Date(),
        };
        const provider = new Provider(config);
        await expect(provider.connect()).rejects.toThrow("reserved");
        expect(provider.isConnected()).toBe(false);
        expect(fs.existsSync(target)).toBe(false);
      });
    }
  });
}

test("SQLite file: connection strings are refused too", async () => {
  const provider = new SQLiteProvider({
    id: "reserved",
    name: "reserved",
    type: "sqlite",
    database: ":memory:",
    connectionString: `file:${process.env.STORAGE_SQLITE_PATH}`,
    createdAt: new Date(),
  });
  await expect(provider.connect()).rejects.toThrow("reserved");
});

test("resolves existing file and parent directory symlinks, including missing sidecars", () => {
  const storage = process.env.STORAGE_SQLITE_PATH!;
  fs.writeFileSync(storage, "server state");
  fs.symlinkSync(storage, path.join(dir, "alias.db"));
  fs.symlinkSync(dir, path.join(dir, "directory-alias"), "junction");
  expect(isReservedStoragePath(path.join(dir, "alias.db"))).toBe(true);
  expect(isReservedStoragePath(path.join(dir, "directory-alias", "storage.db-wal"))).toBe(true);
  expect(isReservedStoragePath(path.join(dir, "directory-alias", "auth-bootstrap.json"))).toBe(true);
  fs.linkSync(storage, path.join(dir, "hardlink.db"));
  expect(isReservedStoragePath(path.join(dir, "hardlink.db"))).toBe(true);
  expect(isReservedStoragePath(path.join(dir, "user.db"))).toBe(false);
});

test("a symlink in the configured storage path is canonicalized", () => {
  fs.mkdirSync(path.join(dir, "real"));
  fs.symlinkSync(path.join(dir, "real"), path.join(dir, "alias"), "junction");
  process.env.STORAGE_SQLITE_PATH = path.join(dir, "alias", "storage.db");
  expect(isReservedStoragePath(path.join(dir, "real", "storage.db"))).toBe(true);
  expect(isReservedStoragePath(path.join(dir, "real", "storage.db-shm"))).toBe(true);
});

for (const readOnly of [false, true]) {
  test(`SQLite refuses denied file access before opening, readOnly=${readOnly}`, async () => {
    const provider = new SQLiteProvider(
      { id: "denied", name: "denied", type: "sqlite", database: ":memory:", createdAt: new Date() },
      {},
      { allowExternalFileAccess: false, readOnly },
    );
    await expect(provider.connect()).rejects.toThrow("require an administrator");
    expect(provider.isConnected()).toBe(false);
  });
}

test("filesystem identity failures fail closed", () => {
  const error = Object.assign(new Error("unavailable"), { code: "EACCES" });
  const fail = () => {
    throw error;
  };
  const realpath = spyOn(fs, "realpathSync").mockImplementation(Object.assign(fail, { native: fail }));
  try {
    expect(() => isReservedStoragePath(path.join(dir, "user.db"))).toThrow("unavailable");
  } finally {
    realpath.mockRestore();
  }
  const stat = spyOn(fs, "statSync").mockImplementation(() => {
    throw error;
  });
  try {
    expect(() => isReservedStoragePath(path.join(dir, "user.db"))).toThrow("unavailable");
  } finally {
    stat.mockRestore();
  }
});

test("administrator SQLite connections to user data remain writable", async () => {
  const target = path.join(dir, "user.db");
  const provider = new SQLiteProvider(
    { id: "user-data", name: "User data", type: "sqlite", database: target, createdAt: new Date() },
    {},
    { allowExternalFileAccess: true },
  );
  try {
    await provider.connect();
    await provider.query("CREATE TABLE example (value INTEGER)");
    await provider.query("INSERT INTO example VALUES (1)");
    expect((await provider.query("SELECT value FROM example")).rows).toEqual([{ value: 1 }]);
  } finally {
    await provider.disconnect();
  }
});

for (const [role, id, roles] of [
  ["user", "inline", []],
  ["admin", "seed:shared", ["*"]],
  ["user", "seed:shared", ["user"]],
] as const) {
  test(`SQLite denies server-derived posture for ${role} on ${id}`, async () => {
    const connection = {
      id,
      name: "SQLite",
      type: "sqlite" as const,
      database: ":memory:",
      roles: [...roles],
      createdAt: new Date(),
    };
    const context = editorExecutionContext({ role }, connection);
    const provider = new SQLiteProvider(connection, {}, context);
    await expect(provider.connect()).rejects.toThrow("require an administrator");
  });
}

test("dangling symbolic links cannot create reserved files", () => {
  fs.symlinkSync("storage.db", path.join(dir, "dangling.db"));
  expect(isReservedStoragePath(path.join(dir, "dangling.db"))).toBe(true);
  expect(fs.existsSync(process.env.STORAGE_SQLITE_PATH!)).toBe(false);
});
