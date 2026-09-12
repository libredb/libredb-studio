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

describe("LibreDBProvider — catalog-aware schema", () => {
  let catalogFile: string;

  beforeEach(() => {
    catalogFile = path.join(os.tmpdir(), `libredb-cat-${Math.random().toString(36).slice(2)}.libredb`);
    seedWithCatalog(catalogFile);
  });

  afterEach(() => {
    rmDbFile(catalogFile);
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
      sampleObject: { path: ["employees:*"], kind: "table" },
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

    // Addressed by the GROUP, which is the only identifier unique within the parent here,
    // and labelled with the same pattern `getSchema()` answers. SORTED, and `applicants` is
    // the row that proves it: the enumerator reaches it after `employees`, because
    // `scanGroups` appends a cataloged namespace the scan never saw.
    expect(await provider.listObjects([], "table")).toEqual([
      { path: ["applicants:*"], name: "applicants:*", kind: "table", rowCount: 0 },
      { path: ["employees:*"], name: "employees:*", kind: "table", rowCount: 2 },
      // Cataloged and empty: the scan reached none of its keys because it has none, and
      // the catalog still names it. A count of 0 rows here is the engine answering none.
      { path: ["vacancies:*"], name: "vacancies:*", kind: "table", rowCount: 0 },
    ]);
    expect(await provider.listObjects([], "collection")).toEqual([
      { path: ["articles:*"], name: "articles:*", kind: "collection", rowCount: 2 },
      { path: ["notes:*"], name: "notes:*", kind: "collection", rowCount: 1 },
    ]);
    // The derived groupings, and NOT the four cataloged namespaces whose keys they would
    // otherwise double-count.
    expect(await provider.listObjects([], "keyspace")).toEqual([
      { path: ["cache:*"], name: "cache:*", kind: "keyspace", rowCount: 2 },
      { path: ["notes"], name: "notes", kind: "keyspace", rowCount: 1 },
      { path: ["standalone"], name: "standalone", kind: "keyspace", rowCount: 1 },
    ]);
  });

  /**
   * ONE ADDRESS, ONE OBJECT, across every kind this engine declares (#789).
   *
   * Standing ruling 3 stops uniqueness at the kind boundary because a tree row is path
   * PLUS kind, and that is right for MySQL, where a table and a procedure share a name and
   * the two kinds have different ROLES. It does not cover this engine: all three kinds here
   * are `role: "relation"`, so nothing downstream that filters by role can tell two
   * same-addressed objects apart, and the flat reading, which spells one string per object,
   * then addresses both and resolves to neither.
   *
   * Measured on @libredb/libredb 0.2.2 rather than argued: with a bare key `notes` written
   * beside a document collection `notes`, `doc(db, "notes").all()` yields `n1` and not the
   * bare key, and `kv.get("notes")` answers the bare value with the collection intact. Two
   * objects, not one listed twice. So they must not share an address.
   */
  test("no two objects share an address, whatever the catalog and the key scan both hold", async () => {
    const kinds = provider.getCapabilities().objectKinds ?? [];
    const listed = (await Promise.all(kinds.map((kind) => provider.listObjects([], kind.id)))).flat();
    const addresses = listed.map((object) => object.path.join("\u0000"));

    expect(listed.length).toBeGreaterThan(1);
    expect([...new Set(addresses)].sort()).toEqual([...addresses].sort());
  });

  test("one NAME, two objects, two addresses: the collision the catalog allows is separated by the group", async () => {
    // Measured on @libredb/libredb 0.2.2: a cataloged collection `notes` and a bare key
    // `notes` coexist in one file, and they are two objects rather than one listed twice -
    // `doc(db, "notes").all()` yields the collection's documents and not the bare key,
    // and `kv.get("notes")` answers the bare value with the collection intact.
    //
    // They used to be published at ONE address, `["notes"]`, under two kinds that are both
    // `role: "relation"`. Ruling 3 permits path reuse across kinds, and it is right for
    // MySQL's table beside a procedure; it is not enough here, because the two kinds share
    // a role, so the flat reading, which spells one string per object, addressed both and
    // resolved to neither. The group separates them, and the engine's own grammar is what
    // it separates them by: `prefix notes:` reaches the collection and `get notes` the key.
    const collection = await provider.describeObject(["notes:*"], "collection");
    const key = await provider.describeObject(["notes"], "keyspace");
    expect(collection.columns.map((column) => column.name)).toEqual(["id", "document"]);
    expect(key.columns.map((column) => column.name)).toEqual(["key", "value"]);
    expect(collection.path).toEqual(["notes:*"]);
    expect(key.path).toEqual(["notes"]);
    // The LABEL is unchanged and is still the key pattern, which is what a generated
    // command needs: `get notes` reads a key nobody stored (#518).
    const listed = await provider.listObjects([], "collection");
    expect(listed.find((object) => object.path[0] === "notes:*")?.name).toBe("notes:*");
  });

  test("describeObject answers a cataloged table's real columns, and no index or foreign key", async () => {
    const detail = await provider.describeObject(["employees:*"], "table");
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
      ["cat", "sch", "applicants:*"],
      ["cat", "sch", "employees:*"],
      ["cat", "sch", "vacancies:*"],
    ]);

    const detail = await provider.describeObject(["cat", "sch", "employees:*"], "table");
    expect(detail.path).toEqual(["cat", "sch", "employees:*"]);
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

  // ==========================================================================
  // The bulk column read (#789)
  // ==========================================================================

  /**
   * ONE enumeration for the whole folder, and the count of passes is what is asserted.
   *
   * `enumerate()` is the single reader of the catalog and the keyspace on this engine, so
   * the thing that would re-introduce the N+1 here is not a second statement but a second
   * PASS: a body looping `describeObject` would scan the file once per object. `scanGroups`
   * is spied to count the passes rather than the time, because an embedded engine is fast
   * enough that a timing comparison would pass either way.
   */
  test("describeObjects reads the file ONCE for a whole folder, not once per object", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scan = spyOn(provider as any, "scanGroups");
    const batch = await provider.describeObjects!([], "table");
    expect(scan).toHaveBeenCalledTimes(1);
    expect(batch.details.map((detail) => detail.path)).toEqual([["applicants:*"], ["employees:*"], ["vacancies:*"]]);
    expect(batch.truncated).toBeUndefined();
  });

  test("every kind on this engine has columns, and the bulk read spells them as the single read does", async () => {
    for (const kind of ["table", "collection", "keyspace"] as const) {
      const batch = await provider.describeObjects!([], kind);
      const listed = await provider.listObjects([], kind);
      // Every detail path was NAMED by the listing, and nothing the listing named is missing.
      expect(batch.details.map((detail) => detail.path)).toEqual(listed.map((object) => object.path));
      for (const detail of batch.details) {
        // Byte-identical to the single read of the same object, which is what one shared
        // mapper buys: two copies would be two chances to spell a column differently.
        expect(detail).toEqual(await provider.describeObject(detail.path, kind));
      }
    }
  });

  test("the three lenses come through the bulk read intact", async () => {
    const tables = await provider.describeObjects!([], "table");
    expect(tables.details.find((detail) => detail.path[0] === "employees:*")!.columns).toEqual([
      { name: "id", type: "string", nullable: false, isPrimary: true },
      { name: "name", type: "string", nullable: false, isPrimary: false },
      { name: "salary", type: "number", nullable: false, isPrimary: false },
      { name: "active", type: "boolean", nullable: false, isPrimary: false },
    ]);
    const collections = await provider.describeObjects!([], "collection");
    expect(collections.details.find((detail) => detail.path[0] === "notes:*")!.columns).toEqual([
      { name: "id", type: "string", nullable: false, isPrimary: true },
      { name: "document", type: "object", nullable: true, isPrimary: false },
    ]);
    const keyspaces = await provider.describeObjects!([], "keyspace");
    // The RAW half of the `notes` collision, described as key/value while the cataloged
    // half above is described as a document collection. Two objects, two shapes, one name.
    expect(keyspaces.details.find((detail) => detail.path[0] === "notes")!.columns).toEqual([
      { name: "key", type: "string", nullable: false, isPrimary: true },
      { name: "value", type: "string", nullable: true, isPrimary: false },
    ]);
    // Facts about the engine, on every kind: one ordered keyspace has no secondary index
    // and the catalog records nothing that references another namespace.
    for (const batch of [tables, collections, keyspaces]) {
      for (const detail of batch.details) {
        expect(detail.indexes).toEqual([]);
        expect(detail.foreignKeys).toEqual([]);
      }
    }
  });

  test("the caller's bound cuts the SORTED enumeration and reports the caller's own limit", async () => {
    const batch = await provider.describeObjects!([], "table", 2);
    // `applicants:*` and `employees:*`, in the order `comparePaths` puts them, and NOT the
    // order the enumerator reached them in - `applicants:*` is injected after `employees:*`
    // because the key scan never saw it. The cut is applied after the sort, so a bounded
    // read's membership on this engine is OURS rather than the engine's.
    expect(batch.details.map((detail) => detail.path)).toEqual([["applicants:*"], ["employees:*"]]);
    expect(batch.truncated).toEqual({
      limit: 2,
      reason: "the bulk column read was bounded at 2 objects by its caller",
    });
  });

  test("a bound the folder fits inside reports nothing", async () => {
    const batch = await provider.describeObjects!([], "collection", 2);
    expect(batch.details.length).toBe(2);
    expect(batch.truncated).toBeUndefined();
  });

  test("a bound of exactly the folder size reports nothing, which is the off-by-one", async () => {
    expect((await provider.describeObjects!([], "table", 3)).truncated).toBeUndefined();
    expect((await provider.describeObjects!([], "table", 4)).truncated).toBeUndefined();
  });

  /**
   * The bound this provider did NOT choose, reported rather than hidden.
   *
   * The key walk stops at `LIBREDB_MAX_KEY_SCAN`, which is a cap nobody asked for on this
   * call, and on a file larger than it the derived groupings are the groupings of a SAMPLE.
   * `countObjects` already says so through the fourth `KindCount` state; this is the same
   * fact on the same pass, in the field `ObjectDetailBatch` has for it. The two CATALOGED
   * kinds are not marked in the same answer, because `catalog()` is read whole.
   */
  test("a key scan stopped at its cap is reported as truncation on the derived kind alone", async () => {
    await provider.disconnect();
    const writer = open({ path: fixtureFile });
    const encoder = new TextEncoder();
    writer.transact((tx) => {
      for (let i = 0; i < LIBREDB_MAX_KEY_SCAN + 500; i++) {
        tx.set(encoder.encode(`bulk:${i}`), encoder.encode("x"));
      }
    });
    writer.close();
    await provider.connect();

    const keyspaces = await provider.describeObjects!([], "keyspace");
    expect(keyspaces.details.map((detail) => detail.path)).toEqual([["bulk:*"]]);
    expect(keyspaces.truncated).toEqual({
      limit: 1,
      reason: "the key walk stopped at the first 10,000 keys of a bounded key scan",
    });
    // The same answer, unmarked, for the two kinds the CATALOG enumerates.
    expect((await provider.describeObjects!([], "table")).truncated).toBeUndefined();
    expect((await provider.describeObjects!([], "collection")).truncated).toBeUndefined();
  });

  test("both bounds at once name both, and the limit reported is the caller's", async () => {
    await provider.disconnect();
    const writer = open({ path: fixtureFile });
    const encoder = new TextEncoder();
    writer.transact((tx) => {
      for (let i = 0; i < LIBREDB_MAX_KEY_SCAN + 500; i++) {
        tx.set(encoder.encode(`b${i % 3}:${i}`), encoder.encode("x"));
      }
    });
    writer.close();
    await provider.connect();

    const batch = await provider.describeObjects!([], "keyspace", 1);
    expect(batch.details.map((detail) => detail.path)).toEqual([["b0:*"]]);
    expect(batch.truncated).toEqual({
      limit: 1,
      reason:
        "the bulk column read was bounded at 1 object by its caller, and the key walk " +
        "stopped at the first 10,000 keys of a bounded key scan",
    });
  });

  test("an undeclared kind is refused by the DECLARATION, naming the engine and the kind", async () => {
    await expect(provider.describeObjects!([], "view")).rejects.toThrow(/LibreDB declares no object kind "view"/);
  });

  test("a container path of another engine's shape is refused before anything is read", async () => {
    await expect(provider.describeObjects!(["main"], "table")).rejects.toThrow(
      /container path is empty, received \["main"\]/,
    );
  });

  test("a limit that is not a positive whole number is refused, never clamped", async () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(provider.describeObjects!([], "table", limit)).rejects.toThrow(
        /bulk column read limit must be a positive whole number/,
      );
    }
    // The guard runs AFTER the declaration check and AFTER the container check, which is
    // the order the reference sets: a caller gets the strongest true statement first.
    await expect(provider.describeObjects!([], "view", 0)).rejects.toThrow(/declares no object kind "view"/);
    await expect(provider.describeObjects!(["main"], "table", 0)).rejects.toThrow(/container path is empty/);
  });

  /**
   * The sort is OURS and the walk is the ENGINE's, and on these two names they disagree.
   *
   * Task 26a-2 measured that on sqlite, libsql, duckdb, clickhouse and trino the server's
   * own order is the UTF-8 BYTE order while `comparePaths` compares UTF-16 code units, and
   * that the two answer the reverse for `U+E000` against `U+1F600`. The same holds here and
   * it is worth pinning, because on this engine the CUT is applied to the sorted list: the
   * kernel walks `U+E000` first (bytes `ee 80 80` below `f0 9f 98 80`) and `comparePaths`
   * puts `U+1F600` first (the high surrogate `D83D` below `E000`), so a bounded read keeps
   * the emoji and not the private-use character.
   */
  test("the bounded read cuts in comparePaths order, which is the reverse of the kernel's byte order", async () => {
    await provider.disconnect();
    const writer = open({ path: fixtureFile });
    kv(writer).set("\u{E000}", "private use");
    kv(writer).set("\u{1F600}", "emoji");
    writer.close();
    await provider.connect();

    const all = await provider.describeObjects!([], "keyspace");
    const exotic = all.details
      .map((detail) => detail.path[0])
      .filter((name) => name === "\u{E000}" || name === "\u{1F600}");
    expect(exotic).toEqual(["\u{1F600}", "\u{E000}"]);
    // The control, and it is what makes the assertion above non-vacuous: the kernel's own
    // walk answers the two the other way round. The `range` covers exactly this pair,
    // because every other key in the fixture is ASCII and sorts below both on either order.
    const walked = (await provider.query("range \u{E000} \u{10FFFF}")).rows.map((row) => String(row.key));
    expect(walked).toEqual(["\u{E000}", "\u{1F600}"]);
  });

  /**
   * Standing ruling 5g on the fifth method: the two-level declaration is driven to a BOUND
   * VALUE and not to a refusal, so a hardcoded depth and a positional read both die.
   */
  test("the bulk read follows a two-level declaration to a bound value", async () => {
    const real = provider.getCapabilities();
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
      ],
    });

    const batch = await provider.describeObjects!(["cat", "sch"], "table");
    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["cat", "sch", "applicants:*"],
      ["cat", "sch", "employees:*"],
      ["cat", "sch", "vacancies:*"],
    ]);
    expect(batch.details[1].columns.map((column) => column.name)).toEqual(["id", "name", "salary", "active"]);
    // The shape it accepted before the declaration changed is now the one it refuses.
    await expect(provider.describeObjects!([], "table")).rejects.toThrow(
      /container path is \[catalog, schema\], received \[\]/,
    );
  });
});
