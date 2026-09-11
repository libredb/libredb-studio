/**
 * LibreDB Provider Integration Tests
 *
 * Uses the REAL @libredb/libredb package against a temp file — no mock.module(),
 * so this suite is exempt from the mock-isolation hazard in CLAUDE.md.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  LIBREDB_ACTIVE_SESSIONS_REFUSAL,
  LIBREDB_INDEX_STATS_REFUSAL,
  LIBREDB_MAX_KEY_SCAN,
  LIBREDB_TABLE_STATS_TRUNCATED,
  LibreDBProvider,
} from "@/lib/db/providers/embedded/libredb";
import { ConnectionError, QueryError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";
import { open, kv, doc, table, CATALOG_PREFIX } from "@libredb/libredb";
import { buildObjectFixture } from "../../../docker/libredb-init/01-object-fixture";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import { containerDepth } from "@/lib/db/object-kinds";
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
    // The command grammar has no transaction verb at all (#464).
    expect(caps.supportsTransactions).toBe(false);
    // The catalog declares namespaces and columns and nothing that references
    // another namespace, so there is no foreign key to read (#414).
    expect(caps.declaresForeignKeys).toBe(false);
    // The namespaces come from a bounded `kv.range` over the keyspace, grouped by
    // prefix, so they are this server's summary of what one scan reached rather than
    // objects the engine declares (#414).
    expect(caps.tablesAreDerivedGroupings).toBe(true);
    // `lib.open({ path })` takes an exclusive `<path>.lock`, so this engine admits ONE
    // handle per file - the fact the connection test and the agent's grounding read
    // both borrow the open one instead of opening a second (D3, B49).
    expect(caps.singleWriterFile).toBe(true);
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

  // `statementLanguage` is the sentence the agent's plan contract states verbatim
  // (`ProviderLabels.statementLanguage`), and this engine needs one for the reason
  // Redis did: a plan run on 2026-08-22, asked to list every entry under the `users`
  // prefix, drafted `GET users:*`. `dispatchCommand` gives `get` exactly one meaning
  // - `kv.get(parts[1])`, an exact-key lookup with no glob - so that command answers
  // zero rows and no error, which on a key-value store reads as "nothing stored
  // there" (#518). So the sentence names all five verbs AND says a key is exact,
  // because the inventory's rows are named `users:*` and that reads as a wildcard
  // the grammar does not have.
  test("getLabels() declares the five verbs as the statement language and that a key is exact", () => {
    const { statementLanguage } = new LibreDBProvider(makeConn(tmpFile)).getLabels();

    expect(statementLanguage).toBeString();
    // Every verb `dispatchCommand` matches; a verb left out is one a model must guess.
    for (const verb of ["get", "put", "delete", "prefix", "range"]) {
      expect(statementLanguage).toContain(verb);
    }
    // The two words that stop `users:*` being read as a pattern, and the runnable
    // form for that objective - the one `generateTableQuery` already emits.
    expect(statementLanguage).toContain("exact");
    expect(statementLanguage).toContain("no wildcard");
    expect(statementLanguage).toContain("prefix users:");
    // Neither SQL nor a shell: the grammar is line-oriented and one command per line.
    expect(statementLanguage).toContain("SQL");
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

  test("getSlowQueries stays empty - the label, not an error, carries LibreDB's sentence", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    // The one panel that is legitimately empty: `QueriesTab` renders
    // `ProviderLabels.slowQueriesEmptyState` in place of an empty list, and this provider
    // declares one, so LibreDB's own sentence already reaches the user here.
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(provider.getLabels().slowQueriesEmptyState).toMatch(/keeps no statistics/i);
    await provider.disconnect();
  });

  test("getActiveSessions is refused with its reason, not answered as an empty session list", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    await expect(provider.getActiveSessions()).rejects.toThrow(LIBREDB_ACTIVE_SESSIONS_REFUSAL);
    // Health must keep answering: /api/db/test-connection calls it and the connection
    // dialog's save is gated on that request (#455).
    expect((await provider.getHealth()).activeSessions).toEqual([]);
    await provider.disconnect();
  });

  test("getIndexStats is refused: this engine has no index object to count", async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    await expect(provider.getIndexStats()).rejects.toThrow(LIBREDB_INDEX_STATS_REFUSAL);
    await provider.disconnect();
  });

  test("getTableStats counts every namespace's keys and names the lens it belongs to", async () => {
    rmDbFile(tmpFile);
    seedWithCatalog(tmpFile);
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();

    const stats = await provider.getTableStats();
    const byName = new Map(stats.map((s) => [s.tableName, s]));
    // The same groups the schema tree shows, with the same counts - both read one scan.
    expect(byName.get("employees:*")?.rowCount).toBe(2);
    expect(byName.get("articles:*")?.rowCount).toBe(1);
    expect(byName.get("user:*")?.rowCount).toBe(2);
    expect(byName.get("order:*")?.rowCount).toBe(1);
    expect(byName.get("config")?.rowCount).toBe(1);
    // LibreDB has no schema namespace, so the column carries the namespace's lens - the
    // one thing the catalog does declare about it.
    expect(byName.get("employees:*")?.schemaName).toBe("relational");
    expect(byName.get("articles:*")?.schemaName).toBe("document");
    expect(byName.get("config")?.schemaName).toBe("kv");

    // No per-namespace bytes exist in the file format, so the byte fields stay ABSENT
    // rather than carrying a zero the Storage tab would sum as a measurement.
    for (const row of stats) {
      expect(row.tableSizeBytes).toBeUndefined();
      expect(row.indexSizeBytes).toBeUndefined();
      expect(row.totalSize).toBe("N/A");
    }
    await provider.disconnect();
  });

  test("getTableStats reports an empty cataloged namespace as a real zero", async () => {
    rmDbFile(tmpFile);
    const db = open({ path: tmpFile });
    table(db, "empty_table", { primaryKey: "id", columns: { id: "string" } });
    db.close();

    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const stats = await provider.getTableStats();
    // The catalog declares the table and the scan found none of its keys: zero rows is
    // the measurement here, which is exactly what an empty answered panel may mean.
    expect(stats).toEqual([
      {
        schemaName: "relational",
        tableName: "empty_table:*",
        rowCount: 0,
        totalSize: "N/A",
        totalSizeBytes: 0,
      },
    ]);
    await provider.disconnect();
  });

  test("getTableStats refuses rather than under-count when the key scan hits its cap", async () => {
    rmDbFile(tmpFile);
    // One kernel transaction, so seeding past the cap costs ~30ms instead of ~12s: the
    // kv lens fsyncs per set(), the kernel's own transact() commits the batch once.
    const db = open({ path: tmpFile });
    const encoder = new TextEncoder();
    db.transact((tx) => {
      for (let i = 0; i < LIBREDB_MAX_KEY_SCAN + 500; i++) {
        tx.set(encoder.encode(`bulk:${i}`), encoder.encode("x"));
      }
    });
    db.close();

    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    // Assert the exported sentence itself: a regex over a fragment would keep passing if
    // the user-facing wording drifted, and `knip` fails on an export nothing consumes.
    await expect(provider.getTableStats()).rejects.toThrow(LIBREDB_TABLE_STATS_TRUNCATED);
    expect(LIBREDB_TABLE_STATS_TRUNCATED).toContain("10,000 keys");
    // The schema tree still renders - it is a list of namespaces, not a count.
    expect((await provider.getSchema()).map((s) => s.name)).toEqual(["bulk:*"]);
    await provider.disconnect();
  });

  test("getMonitoringData leaves the two refused panels absent with their sentences", async () => {
    rmDbFile(tmpFile);
    seedWithCatalog(tmpFile);
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();

    const data = await provider.getMonitoringData();
    expect(data.activeSessions).toBeUndefined();
    expect(data.indexes).toBeUndefined();
    expect(data.errors?.activeSessions).toBe(LIBREDB_ACTIVE_SESSIONS_REFUSAL);
    expect(data.errors?.indexes).toBe(LIBREDB_INDEX_STATS_REFUSAL);
    // The panel that fabricated zero tables on a database with tables now answers.
    expect(data.tables?.length).toBe(5);
    expect(data.errors?.tables).toBeUndefined();
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

// ============================================================================
// Object surface (#789)
//
// Built by `docker/libredb-init/01-object-fixture.ts`, imported rather than retyped:
// standing ruling 5i makes the fixture part of the deliverable, and this engine is
// embedded, so the fixture is a module a person can also run to get a durable file
// instead of a compose mount.
// ============================================================================

describe("LibreDBProvider object surface (#789)", () => {
  let fixtureDir: string;
  let fixtureFile: string;
  let provider: LibreDBProvider;

  beforeEach(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "libredb-objects-"));
    fixtureFile = path.join(fixtureDir, "object-fixture.libredb");
    buildObjectFixture(fixtureFile);
    provider = new LibreDBProvider(makeConn(fixtureFile));
    await provider.connect();
  });

  afterEach(async () => {
    await provider.disconnect();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("declares the three kinds the store holds and no container level", () => {
    const capabilities = provider.getCapabilities();
    expect(containerDepth(capabilities)).toBe(0);
    expect(capabilities.objectKinds?.map((kind) => [kind.id, kind.role])).toEqual([
      ["table", "relation"],
      ["collection", "relation"],
      ["keyspace", "relation"],
    ]);
    // No kind accepts row writes: the grammar has get/put/delete/prefix/range and no
    // INSERT, so Generate Test Data and the create-object item have nothing to emit.
    expect(capabilities.objectKinds?.some((kind) => kind.acceptsRowWrites === true)).toBe(false);
    // Nothing here has readable source: the package publishes no routine of any kind.
    expect(capabilities.objectKinds?.some((kind) => kind.hasSource === true)).toBe(false);
  });

  test("object surface conformance against the fixture", async () => {
    await assertObjectSurface(provider, {
      containers: [],
      kinds: { table: 3, collection: 2, keyspace: 3 },
      sampleObject: { path: ["employees"], kind: "table" },
    });
  });

  /**
   * The fourth `KindCount` state, and this engine is the proof that it is PER KIND: one
   * record answers two populations and one floor. `table` and `collection` come from
   * `catalog(db)`, which is read whole however far the key walk got, so they stay exact
   * while the derived `keyspace` count becomes a floor once the walk stops short (#789).
   */
  test("a key scan stopped at its cap makes the derived count a FLOOR while the cataloged counts stay exact", async () => {
    await provider.disconnect();
    // One kernel transaction, so seeding past the cap costs ~30ms instead of ~12s.
    const writer = open({ path: fixtureFile });
    const encoder = new TextEncoder();
    writer.transact((tx) => {
      for (let i = 0; i < LIBREDB_MAX_KEY_SCAN + 500; i++) {
        tx.set(encoder.encode(`bulk:${i}`), encoder.encode("x"));
      }
    });
    writer.close();
    await provider.connect();

    const counts = await provider.countObjects([]);
    // ONE, on a file whose derived groupings are four: the walk spent its whole budget
    // inside `bulk:` and never reached `cache:*`, `notes` or `standalone`, which sort after
    // it. A bare `1` on this file is not an imprecise number, it is a wrong fact, and that
    // is the whole reason the state exists.
    expect(counts.keyspace).toEqual({
      count: 1,
      sampledFrom: "the first 10,000 keys of a bounded key scan",
    });
    // The two cataloged kinds are NOT marked, in the same answer, from the same pass.
    expect(counts.table).toEqual({ count: 3 });
    expect(counts.collection).toEqual({ count: 2 });
  });

  test("a key scan that reached the end of the file leaves every count exact", async () => {
    // The control for the test above: without it, marking the derived count a floor
    // unconditionally passes that assertion and is wrong on every ordinary file, where the
    // walk reached every key there is and `3` is a measurement rather than a lower bound.
    const counts = await provider.countObjects([]);
    expect(counts.keyspace).toEqual({ count: 3 });
    expect("sampledFrom" in counts.keyspace).toBe(false);
  });

  test("listContainers answers no container, because the engine has none", async () => {
    expect(await provider.listContainers()).toEqual([]);
  });

  test("the catalog names the tables and collections; the scan derives the rest", async () => {
    expect(await provider.countObjects([])).toEqual({
      table: { count: 3 },
      collection: { count: 2 },
      keyspace: { count: 3 },
    });

    // Addressed by the CATALOG name, labelled with the key pattern `getSchema()` uses.
    // SORTED, and `applicants` is the row that proves it: the enumerator reaches it after
    // `employees`, because `scanGroups` appends a cataloged namespace the scan never saw.
    expect(await provider.listObjects([], "table")).toEqual([
      { path: ["applicants"], name: "applicants:*", kind: "table", rowCount: 0 },
      { path: ["employees"], name: "employees:*", kind: "table", rowCount: 2 },
      // Cataloged and empty: the scan reached none of its keys because it has none, and
      // the catalog still names it. A count of 0 rows here is the engine answering none.
      { path: ["vacancies"], name: "vacancies:*", kind: "table", rowCount: 0 },
    ]);
    expect(await provider.listObjects([], "collection")).toEqual([
      { path: ["articles"], name: "articles:*", kind: "collection", rowCount: 2 },
      { path: ["notes"], name: "notes:*", kind: "collection", rowCount: 1 },
    ]);
    // The derived groupings, and NOT the four cataloged namespaces whose keys they would
    // otherwise double-count.
    expect(await provider.listObjects([], "keyspace")).toEqual([
      { path: ["cache:*"], name: "cache:*", kind: "keyspace", rowCount: 2 },
      { path: ["notes"], name: "notes", kind: "keyspace", rowCount: 1 },
      { path: ["standalone"], name: "standalone", kind: "keyspace", rowCount: 1 },
    ]);
  });

  test("one name, two kinds: the collision the catalog allows is described by KIND", async () => {
    // Measured on @libredb/libredb 0.2.2: a cataloged collection `notes` and a bare key
    // `notes` coexist, so the same path answers under two kinds. The tree identifies a row
    // by path PLUS kind, which is why this is legal rather than a provider defect.
    const collection = await provider.describeObject(["notes"], "collection");
    const key = await provider.describeObject(["notes"], "keyspace");
    expect(collection.columns.map((column) => column.name)).toEqual(["id", "document"]);
    expect(key.columns.map((column) => column.name)).toEqual(["key", "value"]);
    expect(collection.path).toEqual(["notes"]);
    expect(key.path).toEqual(["notes"]);
  });

  test("describeObject answers a cataloged table's real columns, and no index or foreign key", async () => {
    const detail = await provider.describeObject(["employees"], "table");
    expect(detail.columns).toEqual([
      { name: "id", type: "string", nullable: false, isPrimary: true },
      { name: "name", type: "string", nullable: false, isPrimary: false },
      { name: "salary", type: "number", nullable: false, isPrimary: false },
      { name: "active", type: "boolean", nullable: false, isPrimary: false },
    ]);
    // Facts about the engine: the kernel has no secondary index and the catalog records
    // nothing that references another namespace.
    expect(detail.indexes).toEqual([]);
    expect(detail.foreignKeys).toEqual([]);
  });

  test("an object the current read does not hold raises rather than answering an empty shape", async () => {
    await expect(provider.describeObject(["no_such_table"], "table")).rejects.toThrow(
      /holds no "table" named "no_such_table"/,
    );
    // A cataloged name under the WRONG kind is the same refusal: the kind decides.
    await expect(provider.describeObject(["employees"], "collection")).rejects.toThrow(
      /holds no "collection" named "employees"/,
    );
  });

  test("an undeclared kind is refused by the DECLARATION, on both methods", async () => {
    await expect(provider.listObjects([], "view")).rejects.toThrow(/declares no object kind "view"/);
    await expect(provider.describeObject(["x"], "view")).rejects.toThrow(/declares no object kind "view"/);
  });

  test("a container path of another engine's shape is refused, from the declaration", async () => {
    await expect(provider.countObjects(["main"])).rejects.toThrow(/container path is empty, received \["main"\]/);
    await expect(provider.listObjects(["main"], "table")).rejects.toThrow(/container path is empty/);
    await expect(provider.describeObject(["main", "employees"], "table")).rejects.toThrow(
      /path is \[name\], received \["main","employees"\]/,
    );
  });

  /**
   * Standing ruling 5g, the one test every provider owes whatever its engine's depth.
   *
   * LibreDB declares ZERO container levels, so all three forbidden spellings - a hardcoded
   * length comparison, a positional bind for the object name, and `path[0]` for a
   * container segment - are behaviour-identical here and none of them can be mutated by a
   * fixture this engine can produce. So the DECLARATION is varied instead: a two-level
   * one is spied in, and the call is driven all the way to a BOUND VALUE rather than to a
   * refusal, which is the part ruling 5g says keeps being skipped.
   *
   * Against the derivations: `assertContainerPath` written as `container.length !== 0`
   * would refuse `["cat", "sch"]`, `enumerate` written with a literal root would answer
   * one-segment paths, `describeObject`'s depth check written as `path.length !== 1` would
   * refuse the three-segment path, and its name read as `path[0]` would look up "cat" and
   * raise instead of describing `employees`.
   */
  test("a two-level declaration is followed to a bound value, not to a refusal", async () => {
    const real = provider.getCapabilities();
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
      ],
    });

    const container = ["cat", "sch"];
    expect(await provider.countObjects(container)).toEqual({
      table: { count: 3 },
      collection: { count: 2 },
      keyspace: { count: 3 },
    });
    expect((await provider.listObjects(container, "table")).map((object) => object.path)).toEqual([
      ["cat", "sch", "applicants"],
      ["cat", "sch", "employees"],
      ["cat", "sch", "vacancies"],
    ]);

    const detail = await provider.describeObject(["cat", "sch", "employees"], "table");
    expect(detail.path).toEqual(["cat", "sch", "employees"]);
    expect(detail.columns.map((column) => column.name)).toEqual(["id", "name", "salary", "active"]);

    // The shape the two-level declaration now refuses is the one it accepted above.
    await expect(provider.countObjects([])).rejects.toThrow(/container path is \[catalog, schema\], received \[\]/);
  });

  /**
   * Standing ruling 5a, enumerate the ENGINE and not the fixture.
   *
   * `CatalogEntry.kind` is a union of three and only `relational` and `document` are ever
   * written by @libredb/libredb 0.2.2 (measured: a raw kv write leaves the catalog
   * untouched, and the two lens constructors are its only writers). The third arm, `kv`,
   * and any arm a later release adds, must still reach the tree rather than falling out of
   * both the count and the listing, so the mapping is total and lands on the derived
   * grouping where the namespace's keys are visible anyway.
   *
   * No fixture this package can build produces such an entry, so the catalog key is
   * written through the RAW kv lens, which is the layer the package documents as having
   * full keyspace access. That is the only way to hand the provider the arm the engine's
   * own type publishes and its writers do not yet emit.
   */
  test("a catalog entry this declaration does not model keeps its keys in the derived grouping", async () => {
    await provider.disconnect();
    const writer = open({ path: fixtureFile });
    kv(writer).set(`${CATALOG_PREFIX}legacy`, JSON.stringify({ kind: "kv" }));
    kv(writer).set("legacy:1", "a namespace cataloged under an arm this provider does not model");
    writer.close();
    await provider.connect();

    const counts = await provider.countObjects([]);
    expect(counts).toEqual({ table: { count: 3 }, collection: { count: 2 }, keyspace: { count: 4 } });
    const keyspaces = await provider.listObjects([], "keyspace");
    expect(keyspaces.map((object) => object.path)).toEqual([["cache:*"], ["legacy:*"], ["notes"], ["standalone"]]);
    // And it describes, so the row is not a dead entry in a listing.
    const detail = await provider.describeObject(["legacy:*"], "keyspace");
    expect(detail.columns.map((column) => column.name)).toEqual(["key", "value"]);
  });

  /**
   * The same ruling, on the case the test above cannot see: the unmodelled entry holds NO
   * keys.
   *
   * The test above writes the catalog entry AND a key under it, so the bounded scan
   * produces the group and the mapping is asked about it. A cataloged entry with zero keys
   * is never produced by the scan, and the injection that exists for exactly that case -
   * the one that makes the empty table `vacancies` a listable object - used to skip the
   * `kv` arm before `objectKindFor` was ever asked. An empty table and an empty collection
   * were injected and listed while an empty unmodelled namespace fell out of BOTH the count
   * and the listing, which is ruling 5a's shape with the badge and the folder agreeing on
   * an object nobody can see. The injection is now total too: it asks the same mapping every
   * other group is put through.
   */
  test("a cataloged entry of an unmodelled arm holding ZERO keys is still counted and listed", async () => {
    await provider.disconnect();
    const writer = open({ path: fixtureFile });
    // The entry and nothing under it: the key scan can never reach this namespace, so only
    // the injection can put it in front of the mapping.
    kv(writer).set(`${CATALOG_PREFIX}orphan`, JSON.stringify({ kind: "kv" }));
    writer.close();
    await provider.connect();

    expect(await provider.countObjects([])).toEqual({
      table: { count: 3 },
      collection: { count: 2 },
      keyspace: { count: 4 },
    });
    const keyspaces = await provider.listObjects([], "keyspace");
    expect(keyspaces.map((object) => object.path)).toEqual([["cache:*"], ["notes"], ["orphan:*"], ["standalone"]]);
    expect(keyspaces.find((object) => object.path[0] === "orphan:*")?.rowCount).toBe(0);
    // And it describes, so the row is not a dead entry in a listing.
    const detail = await provider.describeObject(["orphan:*"], "keyspace");
    expect(detail.columns.map((column) => column.name)).toEqual(["key", "value"]);
  });

  /**
   * Standing ruling 4: `tablesAreDerivedGroupings` is a REFUSAL and it had not reached the
   * object model. Task 20 carried it for Redis and this is the other engine that sets it.
   *
   * It STAYS true here, and it is asserted in the same test as the declaration so the
   * refusal cannot quietly disappear the day somebody edits `objectKinds`. The split is
   * the one `row-actions.ts` documents: no kind declares `acceptsRowWrites`, so Generate
   * Test Data and the create item are withheld by the kinds; the single maintenance
   * operation is `perEntity: false`, so `maintenanceControl` withholds the per-row links;
   * and Profile reads this engine-wide flag, which is the gate that has no kind-level
   * declaration behind it.
   *
   * The flag costs the two CATALOGED kinds their Profile item as well, and measured, that
   * costs nothing: `POST /api/db/profile` has no arm for this engine. It branches on
   * `queryLanguage === "sql"`, and this provider declares `json`, so a profile of a
   * LibreDB table is sent as a MongoDB aggregate pipeline, which the grammar rejects with
   * the message this test pins.
   */
  test("the derived-grouping refusal survives the declaration, and Profile could not work anyway", async () => {
    expect(provider.getCapabilities().tablesAreDerivedGroupings).toBe(true);
    expect(provider.getCapabilities().supportsMaintenance).toBe(false);
    await expect(
      provider.query(JSON.stringify({ collection: "employees", operation: "aggregate", pipeline: [] })),
    ).rejects.toThrow(/Unknown command .* Supported: get, put, delete, prefix, range/);
  });

  test("the object surface never opens a second handle on the single-writer file", async () => {
    // `singleWriterFile`: `open({ path })` takes an exclusive `<path>.lock` sidecar, so a
    // second open throws LOCKED. If any object method opened its own handle it would fail
    // here, where the provider already holds the file.
    expect(provider.getCapabilities().singleWriterFile).toBe(true);
    expect(() => open({ path: fixtureFile })).toThrow();
    await provider.countObjects([]);
    await provider.listObjects([], "table");
    await provider.describeObject(["employees"], "table");
    // Still usable afterwards: nothing above took or dropped the lock.
    expect((await provider.getSchema()).length).toBeGreaterThan(0);
  });
});
