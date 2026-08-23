/**
 * LibreDB Provider Integration Tests
 *
 * Uses the REAL @libredb/libredb package against a temp file — no mock.module(),
 * so this suite is exempt from the mock-isolation hazard in CLAUDE.md.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { LibreDBProvider } from "@/lib/db/providers/embedded/libredb";
import { ConnectionError, QueryError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";
import { open, kv, doc, table } from "@libredb/libredb";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Remove a database file AND its 0.2.x exclusive-lock sidecar (`<path>.lock`). */
function rmDbFile(file: string): void {
  for (const f of [file, `${file}.lock`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

let tmpFile: string;

function makeConn(database: string | undefined): DatabaseConnection {
  return { id: "libredb-test", name: "LibreDB Test", type: "libredb", database, createdAt: new Date() };
}

function seed(file: string): void {
  const db = open({ path: file });
  const store = kv(db);
  store.set("user:1", "Ada");
  store.set("user:2", JSON.stringify({ name: "Grace", age: 45 }));
  store.set("order:1", "42");
  store.set("config", "on");
  db.close();
}

/**
 * Seed that, in addition to raw kv keys, creates a catalog-backed relational
 * table ("employees") and a document collection ("articles"). This populates the
 * database's reserved catalog so the provider's catalog-aware schema view can be
 * exercised. The raw kv keys mirror the plain `seed()` so its assertions still
 * hold (user:*, order:*, config).
 */
function seedWithCatalog(file: string): void {
  const db = open({ path: file });

  // Raw kv keys (uncataloged namespaces).
  const store = kv(db);
  store.set("user:1", "Ada");
  store.set("user:2", JSON.stringify({ name: "Grace", age: 45 }));
  store.set("order:1", "42");
  store.set("config", "on");

  // A relational table — records a relational catalog entry with a schema.
  const employees = table(db, "employees", {
    primaryKey: "id",
    columns: { id: "string", name: "string", salary: "number", active: "boolean" },
  });
  employees.insert({ id: "1", name: "Ada", salary: 100, active: true });
  employees.insert({ id: "2", name: "Grace", salary: 120, active: false });

  // A document collection — records a document catalog entry on first put.
  const articles = doc(db, "articles");
  articles.put("a1", { title: "Hello", body: "world" });

  db.close();
}

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `libredb-test-${Math.random().toString(36).slice(2)}.libredb`);
  seed(tmpFile);
});

afterEach(() => {
  rmDbFile(tmpFile);
});

describe("LibreDBProvider — lifecycle & metadata", () => {
  test("validate() rejects a connection with no file path", () => {
    const provider = new LibreDBProvider(makeConn(undefined));
    expect(() => provider.validate()).toThrow(/path/i);
  });

  test("connect() with no file path throws (no silent in-memory open)", async () => {
    const provider = new LibreDBProvider(makeConn(undefined));
    await expect(provider.connect()).rejects.toThrow(/path/i);
    expect(provider.isConnected()).toBe(false);
  });

  test("connect() rejects a path containing a null byte (traversal guard)", async () => {
    const provider = new LibreDBProvider(makeConn("/tmp/bad" + String.fromCharCode(0) + ".libredb"));
    await expect(provider.connect()).rejects.toThrow(/traversal|invalid/i);
    expect(provider.isConnected()).toBe(false);
  });

  test("connect() then disconnect() against a real file", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
    await provider.disconnect(); // idempotent
  });

  test("getCapabilities() declares a non-SQL, read/write provider", () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    const caps = provider.getCapabilities();
    expect(caps.queryLanguage).toBe("json");
    expect(caps.queryDialect).toBe("libredb");
    expect(caps.supportsCreateTable).toBe(false);
    // The query language is a small JSON command grammar, not SQL, so the inline
    // row editor's `UPDATE ... SET` cannot be expressed here (#269).
    expect(caps.supportsInlineRowEdit).toBe(false);
    // The command grammar has no transaction verb at all (#U13).
    expect(caps.supportsTransactions).toBe(false);
    // The catalog declares namespaces and columns and nothing that references
    // another namespace, so there is no foreign key to read (#414).
    expect(caps.declaresForeignKeys).toBe(false);
    // The namespaces come from a bounded `kv.range` over the keyspace, grouped by
    // prefix, so they are this server's summary of what one scan reached rather than
    // objects the engine declares (#414).
    expect(caps.tablesAreDerivedGroupings).toBe(true);
    expect(caps.supportsExplain).toBe(false);
    expect(caps.explainFormat).toBeUndefined();
    expect(caps.supportsExplain).toBe(caps.explainFormat !== undefined);
    expect(caps.defaultPort).toBeNull();
  });

  test("getLabels() uses key-oriented labels", () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    expect(provider.getLabels().rowNamePlural).toBe("keys");
  });

  // The monitoring Queries panel is ALWAYS empty here - `getSlowQueries()` answers
  // `[]` unconditionally - and until #U12 it told the reader to enable a PostgreSQL
  // extension on the embedded engine.
  test("getLabels() says the embedded engine keeps no statement statistics", () => {
    const { slowQueriesEmptyState } = new LibreDBProvider(makeConn(tmpFile)).getLabels();

    expect(slowQueriesEmptyState).toContain("LibreDB keeps no statistics");
    expect(slowQueriesEmptyState).not.toContain("pg_stat_statements");
  });
});

describe("LibreDBProvider — getSchema", () => {
  test("groups keys by colon-prefix into pseudo-tables", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const schema = await provider.getSchema();
    await provider.disconnect();

    const byName = Object.fromEntries(schema.map((t) => [t.name, t]));
    expect(byName["user:*"].rowCount).toBe(2);
    expect(byName["order:*"].rowCount).toBe(1);
    expect(byName["config"].rowCount).toBe(1); // no colon -> own group
    // columns are key (primary) + value
    expect(byName["user:*"].columns.map((c) => c.name)).toEqual(["key", "value"]);
    expect(byName["user:*"].columns[0].isPrimary).toBe(true);
    // sorted by rowCount desc -> user:* first
    expect(schema[0].name).toBe("user:*");
  });
});

describe("LibreDBProvider — catalog-aware schema", () => {
  let catalogFile: string;

  beforeEach(() => {
    catalogFile = path.join(os.tmpdir(), `libredb-cat-${Math.random().toString(36).slice(2)}.libredb`);
    seedWithCatalog(catalogFile);
  });

  afterEach(() => {
    rmDbFile(catalogFile);
  });

  test("a bare key is NOT catalog-upgraded even if its name matches a namespace", async () => {
    // A document collection "shadow" (keys shadow:*) AND a separate bare raw key
    // "shadow" (no colon). The bare key must stay raw key/value; only the
    // "shadow:*" prefix group may take the document view.
    const file = path.join(os.tmpdir(), `libredb-bare-${Math.random().toString(36).slice(2)}.libredb`);
    const db = open({ path: file });
    doc(db, "shadow").put("1", { theme: "dark" });
    kv(db).set("shadow", "on");
    db.close();

    try {
      const provider = new LibreDBProvider(makeConn(file));
      await provider.connect();
      const schema = await provider.getSchema();
      await provider.disconnect();

      const prefixGroup = schema.find((t) => t.name === "shadow:*");
      const bareGroup = schema.find((t) => t.name === "shadow");
      // The cataloged collection renders as a document view...
      expect(prefixGroup?.columns.map((c) => c.name)).toEqual(["id", "document"]);
      // ...but the bare key stays raw key/value, not upgraded.
      expect(bareGroup?.columns.map((c) => c.name)).toEqual(["key", "value"]);
    } finally {
      rmDbFile(file);
    }
  });

  test("getSchema never surfaces the reserved catalog prefix", async () => {
    const provider = new LibreDBProvider(makeConn(catalogFile));
    await provider.connect();
    const schema = await provider.getSchema();
    await provider.disconnect();

    for (const t of schema) {
      expect(t.name.startsWith("\x00")).toBe(false);
      expect(t.name).not.toContain("libredb:catalog:");
    }
    // No pseudo-table for the reserved namespace leaks in.
    expect(schema.some((t) => t.name.includes("catalog"))).toBe(false);
  });

  test("range/prefix queries never surface the reserved catalog keys", async () => {
    const provider = new LibreDBProvider(makeConn(catalogFile));
    await provider.connect();

    // Full-keyspace range — the reserved keys sort first (U+0000) but must be filtered.
    const rng = await provider.query("range \x00 \u{10FFFF}");
    expect(rng.rows.every((r) => !String(r.key).startsWith("\x00"))).toBe(true);
    expect(rng.rows.some((r) => String(r.key).includes("libredb:catalog:"))).toBe(false);

    // A prefix scan over the reserved marker returns nothing user-facing.
    const pre = await provider.query("prefix \x00");
    expect(pre.rowCount).toBe(0);

    await provider.disconnect();
  });

  test("hides the whole reserved namespace, not just the catalog prefix (isReservedKey widening)", async () => {
    // A raw kv key under the U+0000 marker but OUTSIDE the "catalog:" tail. The
    // previous hardcoded `\x00libredb:catalog:` filter would have leaked this;
    // isReservedKey is marker-based, so it hides the entire reserved namespace.
    const reservedKey = "\x00zzz-reserved-not-catalog";
    const writer = open({ path: catalogFile });
    kv(writer).set(reservedKey, "internal");
    writer.close();

    const provider = new LibreDBProvider(makeConn(catalogFile));
    await provider.connect();
    const schema = await provider.getSchema();
    const rng = await provider.query("range \x00 \u{10FFFF}");
    await provider.disconnect();

    expect(schema.some((t) => t.name.startsWith("\x00"))).toBe(false);
    expect(rng.rows.some((r) => String(r.key) === reservedKey)).toBe(false);

    // Sanity: the key really is in the file (so the provider hid it, not absence).
    const verify = open({ path: catalogFile });
    expect(kv(verify).get(reservedKey)).toBe("internal");
    verify.close();
  });

  test("a relational table shows its real columns and is labeled relational", async () => {
    const provider = new LibreDBProvider(makeConn(catalogFile));
    await provider.connect();
    const schema = await provider.getSchema();
    await provider.disconnect();

    const employees = schema.find((t) => t.name === "employees:*");
    expect(employees).toBeDefined();
    // Real declared columns from the catalog schema (not raw key/value).
    const cols = Object.fromEntries(employees!.columns.map((c) => [c.name, c]));
    expect(Object.keys(cols).sort()).toEqual(["active", "id", "name", "salary"]);
    expect(cols.id.isPrimary).toBe(true);
    expect(cols.name.isPrimary).toBe(false);
    expect(cols.salary.type).toBe("number");
    expect(cols.active.type).toBe("boolean");
    // Relational signal: columns are NOT the raw key/value pair.
    expect(employees!.columns.map((c) => c.name)).not.toEqual(["key", "value"]);
    expect(employees!.rowCount).toBe(2);
  });

  test("a document collection is labeled document (generic id + document columns)", async () => {
    const provider = new LibreDBProvider(makeConn(catalogFile));
    await provider.connect();
    const schema = await provider.getSchema();
    await provider.disconnect();

    const articles = schema.find((t) => t.name === "articles:*");
    expect(articles).toBeDefined();
    expect(articles!.columns.map((c) => c.name)).toEqual(["id", "document"]);
    expect(articles!.columns[0].isPrimary).toBe(true);
    expect(articles!.columns[1].type).toBe("object");
  });

  test("raw kv namespaces still group as key/value pseudo-tables", async () => {
    const provider = new LibreDBProvider(makeConn(catalogFile));
    await provider.connect();
    const schema = await provider.getSchema();
    await provider.disconnect();

    const byName = Object.fromEntries(schema.map((t) => [t.name, t]));
    expect(byName["user:*"].rowCount).toBe(2);
    expect(byName["user:*"].columns.map((c) => c.name)).toEqual(["key", "value"]);
    expect(byName["order:*"].rowCount).toBe(1);
    expect(byName["config"].columns.map((c) => c.name)).toEqual(["key", "value"]);
  });
});

describe("LibreDBProvider — query commands", () => {
  test("get returns one row, JSON value pretty-printed", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const plain = await provider.query("get user:1");
    expect(plain.rows).toEqual([{ key: "user:1", value: "Ada" }]);

    const json = await provider.query("get user:2");
    expect(json.rows[0].value).toBe(JSON.stringify({ name: "Grace", age: 45 }, null, 2));
    await provider.disconnect();
  });

  test("get on a missing key returns zero rows", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const res = await provider.query("get nope");
    expect(res.rowCount).toBe(0);
    expect(res.rows).toEqual([]);
    await provider.disconnect();
  });

  test("prefix scans a group; range scans a half-open interval", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const pre = await provider.query("prefix user:");
    expect(pre.rows.map((r) => r.key)).toEqual(["user:1", "user:2"]);

    const rng = await provider.query("range user:1 user:2");
    expect(rng.rows.map((r) => r.key)).toEqual(["user:1"]); // end excluded
    await provider.disconnect();
  });

  test("put then delete round-trips durably", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();

    const put = await provider.query("put greeting hello");
    expect(put.rows).toEqual([{ changed: 1 }]);
    expect((await provider.query("get greeting")).rows[0].value).toBe("hello");

    const del = await provider.query("delete greeting");
    expect(del.rows).toEqual([{ changed: 1 }]);
    expect((await provider.query("get greeting")).rowCount).toBe(0);
    await provider.disconnect();
  });

  test("put preserves the rest of a multi-word value", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    await provider.query("put note hello world");
    expect((await provider.query("get note")).rows[0].value).toBe("hello world");
    await provider.disconnect();
  });

  test("an unknown command throws QueryError listing supported verbs", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    await expect(provider.query("select * from users")).rejects.toThrow(/get, put, delete, prefix, range/);
    await provider.disconnect();
  });

  test("an unterminated quote is rejected", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    await expect(provider.query('put key "unterminated')).rejects.toThrow(/quote/i);
    await provider.disconnect();
  });

  test("a leading # comment line is skipped; the command runs", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const res = await provider.query("# read Ada\nget user:1");
    expect(res.rows).toEqual([{ key: "user:1", value: "Ada" }]);
    await provider.disconnect();
  });

  test("blank lines are skipped", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const res = await provider.query("\n  \nget user:1");
    expect(res.rowCount).toBe(1);
    await provider.disconnect();
  });

  test("a multi-line cheatsheet runs its first real command (the prefix scan)", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const cheatsheet = [
      '# LibreDB commands for "user:*"',
      "",
      "# List every key under this prefix",
      "prefix user:",
      "",
      "# Read one entry",
      "get user:1",
    ].join("\n");
    const res = await provider.query(cheatsheet);
    expect(res.rows.map((r) => r.key)).toEqual(["user:1", "user:2"]); // prefix ran, not get
    await provider.disconnect();
  });

  test("input that is only comments/blank lines is rejected", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    await expect(provider.query("# just a note\n\n")).rejects.toThrow(/only comments|no command/i);
    await provider.disconnect();
  });
});

describe("LibreDBProvider — 0.2.x error mapping & locking", () => {
  test("a second open of a live-locked file is a clear ConnectionError (LOCKED)", async () => {
    const writer = open({ path: tmpFile }); // holds the exclusive <path>.lock
    try {
      const provider = new LibreDBProvider(makeConn(tmpFile));
      const error = await provider.connect().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConnectionError);
      expect((error as Error).message).toMatch(/already open by another process/i);
      expect(provider.isConnected()).toBe(false);
    } finally {
      writer.close();
    }
  });

  test("connect() takes the exclusive lock; disconnect() releases it (.lock removed)", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    expect(fs.existsSync(`${tmpFile}.lock`)).toBe(true);
    await provider.disconnect();
    expect(fs.existsSync(`${tmpFile}.lock`)).toBe(false);
  });

  test("a non-LibreDB file is refused (NOT_A_DATABASE) and left byte-for-byte untouched", async () => {
    // mkdtempSync atomically creates a unique 0700 dir — the secure-temp pattern
    // (avoids the predictable-name race CodeQL flags for os.tmpdir + Math.random).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libredb-foreign-"));
    const foreign = path.join(dir, "foreign.libredb");
    const bytes = Buffer.from("definitely not a libredb database; long enough to pass the header probe\n");
    fs.writeFileSync(foreign, bytes);
    try {
      const provider = new LibreDBProvider(makeConn(foreign));
      const error = await provider.connect().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConnectionError);
      expect((error as Error).message).toMatch(/not a LibreDB database/i);
      // The refusal must not mutate the file (0.1.x used to truncate it to zero).
      expect(fs.readFileSync(foreign).equals(bytes)).toBe(true);
      // A refused open must not keep holding the exclusive lock.
      expect(fs.existsSync(`${foreign}.lock`)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file written by a newer format version is refused (UNSUPPORTED_VERSION)", async () => {
    // Secure-temp pattern (mkdtempSync), same as the foreign-file test above.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libredb-future-"));
    const future = path.join(dir, "future.libredb");
    // "LRDB" magic + big-endian format version 99 — a valid header from the future.
    fs.writeFileSync(future, Buffer.from([0x4c, 0x52, 0x44, 0x42, 0x00, 0x63, 0x00, 0x00]));
    try {
      const provider = new LibreDBProvider(makeConn(future));
      const error = await provider.connect().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConnectionError);
      expect((error as Error).message).toMatch(/newer version of LibreDB/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed UTF-16 put value (lone surrogate) is a QueryError, and the connection survives", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const error = await provider.query("put broken \uD800").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toMatch(/utf-16|surrogate/i);
    // The invalid write must not poison the open handle.
    expect((await provider.query("get user:1")).rowCount).toBe(1);
    await provider.disconnect();
  });
});

describe("LibreDBProvider — monitoring", () => {
  test("getHealth reports a single embedded connection and the file size", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const health = await provider.getHealth();
    expect(health.activeConnections).toBe(1);
    expect(health.databaseSize).toMatch(/\d/); // human-formatted, e.g. "12.0 KB"
    // The kernel publishes no cache statistics, so there is no ratio to report.
    expect(health.cacheHitRatio).toBe("N/A");
    expect(health.slowQueries).toEqual([]);
    expect(health.activeSessions).toEqual([]);
    await provider.disconnect();
  });

  test("getPerformanceMetrics measures nothing, so it reports nothing", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    // The embedded kernel's whole public surface is open/kv/doc/table/catalog: there
    // is no counter of cache hits or misses anywhere in it, so the panel must show
    // "Not measured" rather than the 100% this used to assert.
    expect(await provider.getPerformanceMetrics()).toEqual({});
    await provider.disconnect();
  });

  test("slow-query/session/table/index stats are honest empty defaults", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getTableStats()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    await provider.disconnect();
  });

  test("getOverview reports file size and group count", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const overview = await provider.getOverview();
    expect(overview.databaseSizeBytes).toBeGreaterThan(0);
    expect(overview.tableCount).toBe(3); // user:*, order:*, config
    await provider.disconnect();
  });

  test("getStorageStats lists the file path", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const storage = await provider.getStorageStats();
    expect(storage).toHaveLength(1);
    expect(storage[0].location).toBe(tmpFile);
    expect(storage[0].sizeBytes).toBeGreaterThan(0);
    await provider.disconnect();
  });

  test("runMaintenance is unsupported", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    await expect(provider.runMaintenance("vacuum")).rejects.toThrow(/not supported/i);
    await provider.disconnect();
  });
});
