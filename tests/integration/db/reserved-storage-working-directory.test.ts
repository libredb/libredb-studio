import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { forgetStorageLocation, storageLocation } from "@/lib/data-dir";
import { createDatabaseProvider } from "@/lib/db/factory";
import { RESERVED_STORAGE_PATH } from "@/lib/db/provider-files";
import type { DatabaseConnection } from "@/lib/types";
import { markersReachableFrom } from "../../helpers/reachable-markers";

/**
 * The files Studio protects, and the file a provider opens, are decided against what this process held when they were
 * taken, not against whatever the working directory is when a provider connects (FND-2 slice 3, docs/SECURITY.md
 * control 3.45). This file changes its own working directory: it takes Studio's storage location in a scratch
 * directory T, as a boot does, then moves to another, U, as a module loaded into Studio's process could. Everything it
 * changes is restored in `afterAll`. Both directories are real paths, since on macOS the temporary directory is a
 * symbolic link.
 */
const originalDirectory = process.cwd();
const originalStoragePath = process.env.STORAGE_SQLITE_PATH;
const originalPkiRoot = process.env.LIBREDB_OPCUA_PKI_ROOT;
let first: string;
let later: string;

beforeAll(() => {
  first = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "libredb-cwd-first-")));
  later = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "libredb-cwd-later-")));
  delete process.env.STORAGE_SQLITE_PATH;
  delete process.env.LIBREDB_OPCUA_PKI_ROOT;
  process.chdir(first);
  forgetStorageLocation();
  // A real storage database holding a row of the server's own, which a connection that reached it could read.
  fs.mkdirSync(path.join(first, "data"));
  const own = new Database(path.join(first, "data", "libredb-storage.db"));
  own.run("CREATE TABLE own (secret TEXT)");
  own.run("INSERT INTO own VALUES ('server-own-row')");
  own.close();
  storageLocation();
});

afterAll(() => {
  process.chdir(originalDirectory);
  if (originalStoragePath === undefined) delete process.env.STORAGE_SQLITE_PATH;
  else process.env.STORAGE_SQLITE_PATH = originalStoragePath;
  if (originalPkiRoot === undefined) delete process.env.LIBREDB_OPCUA_PKI_ROOT;
  else process.env.LIBREDB_OPCUA_PKI_ROOT = originalPkiRoot;
  forgetStorageLocation();
  fs.rmSync(first, { recursive: true, force: true });
  fs.rmSync(later, { recursive: true, force: true });
});

function connection(type: DatabaseConnection["type"], fields: Partial<DatabaseConnection>): DatabaseConnection {
  return { id: `cwd-${type}`, name: `cwd ${type}`, type, createdAt: new Date(0), ...fields } as DatabaseConnection;
}

describe("the files Studio protects and the file a provider opens do not move with the working directory (FND-2 slice 3)", () => {
  test("after the working directory changes, SQLite, DuckDB and LibreDB connections to Studio's storage database, its sidecars and the bootstrap file are refused by absolute path before the provider is built", async () => {
    process.chdir(later);
    const answers: [string, string, string | null][] = [];
    for (const type of ["sqlite", "duckdb", "libredb"] as const) {
      for (const name of [
        "libredb-storage.db",
        "libredb-storage.db-wal",
        "libredb-storage.db-shm",
        "auth-bootstrap.json",
      ]) {
        const database = path.join(first, "data", name);
        // oxlint-disable-next-line no-await-in-loop -- each refusal is read before the next build.
        const refused = await createDatabaseProvider(connection(type, { database })).then(
          () => null,
          (error: unknown) => (error as Error).message,
        );
        answers.push([type, name, refused]);
      }
    }
    expect(answers.filter(([, , refused]) => refused !== RESERVED_STORAGE_PATH)).toEqual([]);
    expect(fs.existsSync(path.join(first, "data", "auth-bootstrap.json"))).toBe(false);
  });

  test("a SQLite connection built with a relative path opens the file it named when it was built, after the working directory changes", async () => {
    process.chdir(first);
    const provider = await createDatabaseProvider(connection("sqlite", { database: "user.db" }));
    process.chdir(later);
    try {
      await provider.connect();
      await provider.query("CREATE TABLE t (value INTEGER)");
    } finally {
      await provider.disconnect();
    }
    expect(fs.existsSync(path.join(first, "user.db"))).toBe(true);
    expect(fs.existsSync(path.join(later, "user.db"))).toBe(false);
  });

  test("an OPC UA provider keeps the PKI root core decided when it was built, after the working directory and LIBREDB_OPCUA_PKI_ROOT change", async () => {
    process.chdir(first);
    const provider = await createDatabaseProvider(
      connection("opcua", { host: "opc.tcp://127.0.0.1:1", securityMode: "None" } as Partial<DatabaseConnection>),
    );
    process.chdir(later);
    process.env.LIBREDB_OPCUA_PKI_ROOT = path.join(later, "moved-pki");
    try {
      const decided = path.join(first, "data", "opcua-pki");
      expect(markersReachableFrom(provider, [decided])).not.toEqual([]);
      expect(markersReachableFrom(provider, [later])).toEqual([]);
    } finally {
      delete process.env.LIBREDB_OPCUA_PKI_ROOT;
    }
  });

  test("an OPC UA provider built after the working directory changed, with LIBREDB_OPCUA_PKI_ROOT unset, takes its default root from the storage location, not from the new working directory", async () => {
    process.chdir(later);
    const provider = await createDatabaseProvider(
      connection("opcua", { host: "opc.tcp://127.0.0.1:1", securityMode: "None" } as Partial<DatabaseConnection>),
    );
    expect(markersReachableFrom(provider, [path.join(first, "data", "opcua-pki")])).not.toEqual([]);
    expect(markersReachableFrom(provider, [later])).toEqual([]);
  });
});

describe("the first provider built takes the storage location, whatever its engine (FND-2 slice 3)", () => {
  afterAll(() => {
    process.chdir(first);
    forgetStorageLocation();
    storageLocation();
  });

  test.each([
    ["a postgres connection", { type: "postgres", host: "127.0.0.1", port: 1, database: "app" }],
    ["a SQLite :memory: connection", { type: "sqlite", database: ":memory:" }],
  ] as const)(
    "after %s is built first and the working directory changes, a connection to the storage database is still refused",
    async (_label, fields) => {
      process.chdir(first);
      forgetStorageLocation();
      await createDatabaseProvider(connection(fields.type, fields as Partial<DatabaseConnection>));
      process.chdir(later);
      const refused = await createDatabaseProvider(
        connection("sqlite", { database: path.join(first, "data", "libredb-storage.db") }),
      ).then(
        () => null,
        (error: unknown) => (error as Error).message,
      );
      expect(refused).toBe(RESERVED_STORAGE_PATH);
    },
  );
});
