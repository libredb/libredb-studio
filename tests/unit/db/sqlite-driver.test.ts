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
  readonly options: { readOnly?: boolean } | undefined;
  readonly calls: string[] = [];

  constructor(path: string, options?: { readOnly?: boolean }) {
    this.path = path;
    this.options = options;
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
    test("bridges exec/prepare/close", () => {
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

    // The read-only open flag is the SQLite half of the agent execution
    // profile's security boundary (#328). The two runtimes spell it
    // differently — bun `readonly`, node `readOnly` — so an adapter that
    // forwards nothing (or forwards the bun spelling verbatim) would hand the
    // agent a fully writable handle. These pin the mapping at the seam; the
    // node harness in tests/integration/db proves the real driver honors it.
    test("maps the read-only open flag onto node:sqlite's readOnly option", () => {
      const Driver = createNodeSQLiteDriver(StubDatabaseSync);
      new Driver("/tmp/agent.db", { readonly: true });

      expect(StubDatabaseSync.lastInstance!.options).toEqual({ readOnly: true });
    });

    test("opens read-write when no read-only flag is given (the shared editor path)", () => {
      const Driver = createNodeSQLiteDriver(StubDatabaseSync);
      new Driver("/tmp/editor.db", { create: true, readwrite: true });

      expect(StubDatabaseSync.lastInstance!.options).toEqual({ readOnly: false });
    });
  });

  test("loadNodeSQLiteDriver() builds the adapter from an injected module", async () => {
    const Driver = await loadNodeSQLiteDriver(async () => stubModule);
    const db = new Driver("/tmp/injected.db");

    expect(StubDatabaseSync.lastInstance!.path).toBe("/tmp/injected.db");
    db.close();
  });

  test("loadNodeSQLiteDriver() falls back to the real node:sqlite import", async () => {
    // Bun implements node:sqlite from 1.4.0 - the version this repo pins - so the default
    // importer resolves in-process instead of throwing, and this is the first time the
    // adapter can be driven against the REAL DatabaseSync rather than a stand-in. On Bun
    // 1.3.14 only the injected path above was reachable here.
    const Driver = await loadNodeSQLiteDriver();
    const db = new Driver(":memory:");

    db.exec("CREATE TABLE t (a INTEGER)");
    db.prepare("INSERT INTO t VALUES (?)").run(7);

    // The three bridges the adapter promises, against the real module: get() maps a miss
    // to null (node returns undefined), run() narrows bigint changes to number, and all()
    // hands back plain rows.
    expect(db.prepare("SELECT a FROM t").all()).toEqual([{ a: 7 }]);
    expect(db.prepare("SELECT a FROM t WHERE a = ?").get(999)).toBeNull();
    expect(db.prepare("DELETE FROM t").run()).toEqual({ changes: 1 });

    db.close();
  });

  describe("loadSQLiteDriver()", () => {
    test("returns the cached constructor on repeat loads", async () => {
      process.env.LIBREDB_SQLITE_DRIVER = "bun";
      const first = await loadSQLiteDriver();
      const second = await loadSQLiteDriver();
      expect(second).toBe(first);
    });

    // This asserted the failure path by relying on the runtime NOT implementing
    // node:sqlite, and skipped itself when the import resolved. Bun 1.4.0 implements it,
    // so on the pinned runtime the test passed while the whole catch below went
    // unexercised - a green test and an eight-line hole in a 100% gate. The loader is
    // injected instead, the way `loadNodeSQLiteDriver` already injects its importer, so
    // the arm is a property of this test rather than of whichever Bun is installed.
    test("wraps a driver that cannot load in DatabaseConfigError and caches the failure", async () => {
      process.env.LIBREDB_SQLITE_DRIVER = "node";

      const firstError = await loadSQLiteDriver(() => Promise.reject(new Error("node:sqlite is not available"))).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(firstError).toBeInstanceOf(DatabaseConfigError);
      expect((firstError as Error).message).toContain('SQLite driver "node" is not available');
      // The underlying reason is carried, not swallowed.
      expect((firstError as Error).message).toContain("node:sqlite is not available");

      // The cached failure is rethrown without consulting the loader a second time.
      let secondAttempts = 0;
      const secondError = await loadSQLiteDriver(() => {
        secondAttempts += 1;
        return Promise.reject(new Error("must not be reached"));
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(secondError).toBe(firstError);
      expect(secondAttempts).toBe(0);
    });
  });
});
