/**
 * The SQLite child-process worker, exercised for real (#1623).
 *
 * Every on-disk SQLite connection runs its statements in a `node` child process (the
 * worker). These tests drive that child directly and through `SQLiteProvider`, so the
 * worker's kill, restart, queue, timeout and large-result paths are all covered rather
 * than excluded from coverage. They run under `bun test`, but the child is `node` with
 * `node:sqlite`; Bun's own `bun:sqlite` would hang a child a `bun test` run spawned
 * (Bun 1.4.x), which is exactly why the worker does not run under Bun.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET as apiHealth } from "@/app/api/health/route";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";
import { SQLiteWorkerClient } from "@/lib/db/providers/sql/sqlite-worker";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/** A statement that cannot finish before it is killed: one billion recursive steps. */
const SLOW =
  "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 1000000000) SELECT count(*) AS n FROM r";

const BUDGET: ReadOnlyStatementBudget = {
  statementTimeoutMs: 5_000,
  maxResultRows: 100,
  maxResultBytes: 64 * 1024,
};

function makeConfig(dbPath: string): DatabaseConnection {
  return { id: "worker-test", name: "Worker", type: "sqlite", database: dbPath, createdAt: new Date() };
}

/** Create an on-disk database with one table, then close the writer. */
async function seedFile(dir: string, name: string): Promise<string> {
  const dbPath = join(dir, name);
  const seed = new SQLiteProvider(makeConfig(dbPath));
  await seed.connect();
  await seed.query("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  await seed.query("INSERT INTO t (id, v) VALUES (1, 'seeded')");
  await seed.disconnect();
  return dbPath;
}

describe("SQLite child-process worker (#1623)", () => {
  const dir = mkdtempSync(join(tmpdir(), "libredb-sqlite-worker-"));

  afterAll(async () => {
    // Windows keeps a WAL -shm memory mapping for a beat after SIGKILL ends its
    // child, so the removal retries with a real delay instead of racing that
    // release (EBUSY).
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        await Bun.sleep(200);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("cancelling a running statement rejects the statement queued behind it", async () => {
    const dbPath = join(dir, "queue.db");
    const client = await SQLiteWorkerClient.start({ dbPath, readonly: false, queryOnly: false });
    try {
      const slow = client.queryRows(SLOW, []);
      // Sent while the first statement is still in flight, so it waits in the queue.
      const queued = client.queryRows("SELECT 1 AS one", []);
      // Attach a handler BEFORE the kill, so a synchronous rejection is observed
      // rather than reported as an unhandled rejection.
      const slowOutcome = slow.then(
        () => "resolved",
        (error: unknown) => error,
      );
      const queuedOutcome = queued.then(
        () => "resolved",
        (error: unknown) => error,
      );
      await Bun.sleep(20);
      client.terminate();

      expect(await slowOutcome).toBeInstanceOf(Error);
      expect(await queuedOutcome).toBeInstanceOf(Error);
    } finally {
      client.terminate();
    }
  });

  test("get, inTransaction and a graceful close round-trip through the worker", async () => {
    const dbPath = join(dir, "surface.db");
    const client = await SQLiteWorkerClient.start({ dbPath, readonly: false, queryOnly: false });
    try {
      await client.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      await client.exec("INSERT INTO t VALUES (1, 'one')");
      expect(await client.get("SELECT v FROM t WHERE id = 1")).toEqual({ v: "one" });
      expect(await client.inTransaction()).toBe(false);
      await client.exec("BEGIN");
      expect(await client.inTransaction()).toBe(true);
      await client.exec("ROLLBACK");
      expect(await client.inTransaction()).toBe(false);
    } finally {
      await client.close();
    }
  });

  test("the read-only path serves two statements after a deadline kills the worker", async () => {
    const dbPath = await seedFile(dir, "readonly.db");
    const profile = new SQLiteProvider(makeConfig(dbPath), {}, { readOnly: true });
    await profile.connect();
    try {
      const killed = await profile
        .queryReadOnly(SLOW, { statementTimeoutMs: 50, maxResultRows: 10, maxResultBytes: 1024 })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(killed).toBeInstanceOf(Error);

      // The kill left the worker dead; these two restarts and both succeed.
      expect((await profile.queryReadOnly("SELECT 1 AS one", BUDGET)).rows).toEqual([{ one: 1 }]);
      expect((await profile.queryReadOnly("SELECT 2 AS two", BUDGET)).rows).toEqual([{ two: 2 }]);
    } finally {
      await profile.disconnect();
    }
  });

  test("parallel restarts after a cancel share one child", async () => {
    const dbPath = await seedFile(dir, "restart.db");
    const provider = new SQLiteProvider(makeConfig(dbPath));
    await provider.connect();

    const originalStart = SQLiteWorkerClient.start;
    let restarts = 0;
    SQLiteWorkerClient.start = (open) => {
      restarts += 1;
      return originalStart(open);
    };
    try {
      const slow = provider.query(SLOW, undefined, "restart-q");
      await Bun.sleep(20);
      expect(await provider.cancelQuery("restart-q")).toBe(true);
      await expect(slow).rejects.toThrow();

      // Two statements racing to restart must share the one pending start.
      const [a, b] = await Promise.all([provider.query("SELECT 1 AS one"), provider.query("SELECT 2 AS two")]);
      expect(a.rows).toEqual([{ one: 1 }]);
      expect(b.rows).toEqual([{ two: 2 }]);
      expect(restarts).toBe(1);
    } finally {
      SQLiteWorkerClient.start = originalStart;
      await provider.disconnect();
    }
  });

  test("100,000 rows and a BLOB come back whole through the worker", async () => {
    const dbPath = join(dir, "big.db");
    const provider = new SQLiteProvider(makeConfig(dbPath));
    await provider.connect();
    try {
      await provider.query("CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT)");
      await provider.query(
        "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 100000) " +
          "INSERT INTO big (id, v) SELECT i, 'row-' || i FROM r",
      );

      const started = Date.now();
      const result = await provider.query("SELECT id, v FROM big ORDER BY id");
      const elapsed = Date.now() - started;

      expect(result.rows.length).toBe(100_000);
      expect(result.rows[0]).toEqual({ id: 1, v: "row-1" });
      expect(result.rows[99_999]).toEqual({ id: 100_000, v: "row-100000" });
      // The parent scans only each new chunk, so a 100k-row answer arrives in
      // near in-process time; a quadratic whole-buffer rescan would blow this.
      expect(elapsed).toBeLessThan(30_000);

      await provider.query("CREATE TABLE blobs (id INTEGER PRIMARY KEY, b BLOB)");
      await provider.query("INSERT INTO blobs (id, b) VALUES (1, X'DEADBEEF00FF')");
      const blobRow = (await provider.query("SELECT b FROM blobs WHERE id = 1")).rows[0] as { b: Buffer };
      expect(Buffer.isBuffer(blobRow.b)).toBe(true);
      expect([...blobRow.b]).toEqual([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    } finally {
      await provider.disconnect();
    }
  });

  test("the editor's query timeout kills an overrunning statement", async () => {
    const dbPath = await seedFile(dir, "timeout.db");
    const provider = new SQLiteProvider(makeConfig(dbPath), { queryTimeout: 100 });
    await provider.connect();
    try {
      await expect(provider.query(SLOW)).rejects.toThrow();
      // The worker was killed by the timeout; a later statement restarts it.
      expect((await provider.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
    } finally {
      await provider.disconnect();
    }
  });

  test("liveness answers while a long SQLite statement runs in its child", async () => {
    const dbPath = await seedFile(dir, "health.db");
    const provider = new SQLiteProvider(makeConfig(dbPath));
    await provider.connect();
    const slow = provider.query(SLOW, undefined, "health-q");
    try {
      await Bun.sleep(50);
      expect(apiHealth().status).toBe(200);
      // The statement must still be in flight: had it run on the server thread, the
      // liveness handler above could not have been reached until it finished.
      const stillRunning = await Promise.race([
        slow.then(
          () => false,
          () => false,
        ),
        Bun.sleep(150).then(() => true),
      ]);
      expect(stillRunning).toBe(true);
    } finally {
      await provider.cancelQuery("health-q").catch(() => {});
      await provider.disconnect();
    }
    await expect(slow).rejects.toThrow();
  });

  test("more than 64 KB of multibyte text round-trips through the worker unchanged", async () => {
    const dbPath = join(dir, "utf8.db");
    const provider = new SQLiteProvider(makeConfig(dbPath));
    await provider.connect();
    try {
      await provider.query("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      // Turkish and CJK text long enough that a character very likely straddles a 64 KB
      // pipe chunk; the pipe would corrupt such a character into U+FFFD before the
      // setEncoding fix. No single quote, so the literal below needs no escaping.
      const text = "İstanbul ğüşiöç ÜĞİŞÇÖ 東京日本語 한국어 😀".repeat(1_800);
      expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(64 * 1024);

      await provider.query("INSERT INTO t (id, v) VALUES (1, ?)", [text]);
      await provider.query(`INSERT INTO t (id, v) VALUES (2, '${text}')`);

      const rows = (await provider.query("SELECT v FROM t ORDER BY id")).rows;
      expect(rows[0]).toEqual({ v: text });
      expect(rows[1]).toEqual({ v: text });
    } finally {
      await provider.disconnect();
    }
  });

  test("cancelling a queued statement leaves the running statement alone", async () => {
    const dbPath = await seedFile(dir, "cancel-queued.db");
    const provider = new SQLiteProvider(makeConfig(dbPath));
    await provider.connect();
    try {
      const running = provider.query(SLOW, undefined, "running-q");
      // Let the running statement reach the child before the second one is queued.
      await Bun.sleep(20);
      const queued = provider.query("SELECT 1 AS one", undefined, "queued-q");
      const runningOutcome = running.then(
        () => "resolved",
        (error: unknown) => error,
      );
      const queuedOutcome = queued.then(
        () => "resolved",
        (error: unknown) => error,
      );
      await Bun.sleep(20);

      // Dropping the queued id must reject only that statement, not the running one.
      expect(await provider.cancelQuery("queued-q")).toBe(true);
      expect(await queuedOutcome).toBeInstanceOf(Error);
      expect(await provider.cancelQuery("running-q")).toBe(true);
      expect(await runningOutcome).toBeInstanceOf(Error);
    } finally {
      await provider.disconnect();
    }
  });

  test("LIBREDB_SQLITE_WORKER_TIMEOUT_MS bounds every request; a value that is not a positive number sets none", async () => {
    const dbPath = join(dir, "env-timeout.db");
    const saved = process.env.LIBREDB_SQLITE_WORKER_TIMEOUT_MS;
    const client = await SQLiteWorkerClient.start({ dbPath, readonly: false, queryOnly: false });
    try {
      process.env.LIBREDB_SQLITE_WORKER_TIMEOUT_MS = "not-a-number";
      expect(await client.all("SELECT 1 AS one")).toEqual([{ one: 1 }]);

      process.env.LIBREDB_SQLITE_WORKER_TIMEOUT_MS = "50";
      const killed = await client.all(SLOW).then(
        () => null,
        (error: unknown) => error,
      );
      expect((killed as Error).message).toBe("SQLite worker timed out after 50ms (all)");
      expect(client.isAlive()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.LIBREDB_SQLITE_WORKER_TIMEOUT_MS;
      else process.env.LIBREDB_SQLITE_WORKER_TIMEOUT_MS = saved;
      client.terminate();
    }
  });

  test("a request after the child was terminated is refused at once rather than written to a dead pipe", async () => {
    const dbPath = join(dir, "dead.db");
    const client = await SQLiteWorkerClient.start({ dbPath, readonly: false, queryOnly: false });
    client.terminate();

    const refused = await client.all("SELECT 1 AS one").then(
      () => null,
      (error: unknown) => error,
    );

    expect((refused as Error).message).toBe("SQLite worker is not running");
  });

  test("a stdout line that is not a response is skipped, and the next answer still arrives", async () => {
    // The child writes only JSON lines, so this is the parent's guard against anything else
    // that reaches the pipe; it is fed here straight into the child's stdout stream.
    const dbPath = join(dir, "noise.db");
    const client = await SQLiteWorkerClient.start({ dbPath, readonly: false, queryOnly: false });
    try {
      const stdout = (client as unknown as { child: { stdout: { emit(event: string, chunk: string): void } } }).child
        .stdout;
      stdout.emit("data", "not a response line\n");

      expect(await client.all("SELECT 1 AS one")).toEqual([{ one: 1 }]);
    } finally {
      await client.close();
    }
  });

  test("disconnect returns at once while a long statement runs", async () => {
    const dbPath = await seedFile(dir, "disconnect.db");
    const provider = new SQLiteProvider(makeConfig(dbPath));
    await provider.connect();
    const slow = provider.query(SLOW, undefined, "disconnect-q");
    const slowOutcome = slow.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await Bun.sleep(20);

    const started = Date.now();
    await provider.disconnect();
    expect(Date.now() - started).toBeLessThan(2_000);
    // The kill rejects the statement that was running, rather than leaving it dangling.
    expect(await slowOutcome).toBeInstanceOf(Error);
  });
});
