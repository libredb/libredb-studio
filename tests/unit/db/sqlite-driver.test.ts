import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  createNodeSQLiteDriver,
  loadNodeSQLiteDriver,
  loadSQLiteDriver,
  resolveSQLiteDriverName,
  type NodeDatabaseSyncLike,
  type NodeSQLiteModule,
} from "@/lib/db/providers/sql/sqlite-driver";

/** In-memory stand-in for node:sqlite's DatabaseSync (Bun cannot import the real one). */
class StubDatabaseSync implements NodeDatabaseSyncLike {
  static lastInstance: StubDatabaseSync | undefined;
  readonly path: string;
  readonly calls: string[] = [];

  constructor(path: string) {
    this.path = path;
    StubDatabaseSync.lastInstance = this;
  }

  exec(sql: string): void {
    this.calls.push(`exec:${sql}`);
  }

  prepare(sql: string) {
    this.calls.push(`prepare:${sql}`);
    return {
      all: (...params: unknown[]) => [{ sql, params }],
      get: (...params: unknown[]) => (params[0] === "miss" ? undefined : { sql, first: params[0] }),
      run: (...params: unknown[]) => ({ changes: params[0] === "bigint" ? BigInt(3) : 1 }),
    };
  }

  close(): void {
    this.calls.push("close");
  }
}

const stubModule: NodeSQLiteModule = { DatabaseSync: StubDatabaseSync };

describe("sqlite-driver", () => {
  let origDriver: string | undefined;

  beforeEach(() => {
    origDriver = process.env.LIBREDB_SQLITE_DRIVER;
  });

  afterEach(() => {
    if (origDriver === undefined) delete process.env.LIBREDB_SQLITE_DRIVER;
    else process.env.LIBREDB_SQLITE_DRIVER = origDriver;
  });

  describe("resolveSQLiteDriverName()", () => {
    test.each(["bun", "node"] as const)("honors the %s override", (name) => {
      process.env.LIBREDB_SQLITE_DRIVER = name;
      expect(resolveSQLiteDriverName()).toBe(name);
    });

    test.each([undefined, "sqlite3", ""])("falls back to the runtime for %j", (value) => {
      if (value === undefined) delete process.env.LIBREDB_SQLITE_DRIVER;
      else process.env.LIBREDB_SQLITE_DRIVER = value;
      // Tests run under Bun, so the runtime pick is always "bun" here.
      expect(resolveSQLiteDriverName()).toBe("bun");
    });
  });

  describe("createNodeSQLiteDriver() adapter semantics", () => {
    test("bridges exec/prepare/close and ignores bun-style open options", () => {
      const Driver = createNodeSQLiteDriver(StubDatabaseSync);
      const db = new Driver("/tmp/adapter.db", { create: true, readwrite: true });
      const stub = StubDatabaseSync.lastInstance!;

      expect(stub.path).toBe("/tmp/adapter.db");

      db.exec("CREATE TABLE t (id)");
      expect(stub.calls).toContain("exec:CREATE TABLE t (id)");

      const stmt = db.prepare("SELECT * FROM t WHERE id = ?");
      expect(stmt.all(7)).toEqual([{ sql: "SELECT * FROM t WHERE id = ?", params: [7] }]);

      db.close();
      expect(stub.calls).toContain("close");
    });

    test("get() maps node:sqlite's undefined miss to bun:sqlite's null", () => {
      const Driver = createNodeSQLiteDriver(StubDatabaseSync);
      const stmt = new Driver("/tmp/adapter.db").prepare("SELECT 1");

      expect(stmt.get("hit")).toEqual({ sql: "SELECT 1", first: "hit" });
      expect(stmt.get("miss")).toBeNull();
    });

    test("run() normalizes bigint change counts to number", () => {
      const Driver = createNodeSQLiteDriver(StubDatabaseSync);
      const stmt = new Driver("/tmp/adapter.db").prepare("DELETE FROM t");

      expect(stmt.run("bigint")).toEqual({ changes: 3 });
      expect(stmt.run("number")).toEqual({ changes: 1 });
    });
  });

  test("loadNodeSQLiteDriver() builds the adapter from an injected module", async () => {
    const Driver = await loadNodeSQLiteDriver(async () => stubModule);
    const db = new Driver("/tmp/injected.db");

    expect(StubDatabaseSync.lastInstance!.path).toBe("/tmp/injected.db");
    db.close();
  });

  describe("loadSQLiteDriver()", () => {
    test("returns the cached constructor on repeat loads", async () => {
      process.env.LIBREDB_SQLITE_DRIVER = "bun";
      const first = await loadSQLiteDriver();
      const second = await loadSQLiteDriver();
      expect(second).toBe(first);
    });

    test("wraps an unavailable driver in DatabaseConfigError and caches the failure", async () => {
      process.env.LIBREDB_SQLITE_DRIVER = "node";
      let firstError: unknown;
      try {
        // Bun does not implement node:sqlite, so the real import path fails here.
        // (If a future Bun adds node:sqlite this resolves instead - then the
        // error-path assertions below are simply skipped.)
        await loadSQLiteDriver();
      } catch (error) {
        firstError = error;
      }
      if (firstError === undefined) return;

      expect(firstError).toBeInstanceOf(DatabaseConfigError);
      expect((firstError as Error).message).toContain('SQLite driver "node" is not available');

      let secondError: unknown;
      try {
        await loadSQLiteDriver();
      } catch (error) {
        secondError = error;
      }
      expect(secondError).toBe(firstError);
    });
  });
});
