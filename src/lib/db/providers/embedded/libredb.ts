/**
 * LibreDB Embedded Provider
 *
 * Opens a local `.libredb` file in-process via the embedded `@libredb/libredb`
 * package (the SQLite embedded pattern). LibreDB has no server or wire protocol;
 * the file path travels in `config.database`, like SQLite. The on-disk format is
 * raw ordered key-value bytes, so this provider presents keys grouped by their
 * `:`-prefix as pseudo-"tables" (the Redis pattern) and exposes a small
 * get/put/delete/prefix/range command grammar over the kv lens.
 *
 * Since `@libredb/libredb` 0.0.2 the file also carries a persisted CATALOG: the
 * lenses record, under a reserved key prefix, which lens (`document` /
 * `relational`) each namespace belongs to and — for a relational table — its
 * column schema. `getSchema()` reads `catalog(db)` to present faithful per-kind
 * views (real columns for relational tables, a document view for collections)
 * while uncataloged namespaces fall back to the raw key-prefix grouping. The
 * reserved catalog keys are themselves internal metadata and are excluded from
 * every user-facing view.
 *
 * The package API is synchronous; calls are wrapped to satisfy the async
 * provider contract. The import is lazy and dynamic so the package never enters
 * a client bundle and `build:lib` (tsup) can externalize it.
 */
import { BaseDatabaseProvider } from "../../base-provider";
import {
  type DatabaseConnection,
  type TableSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type ProviderCapabilities,
  type ProviderLabels,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
} from "../../types";
import { DatabaseConfigError, ConnectionError, QueryError } from "../../errors";
import { formatBytes } from "../../utils/pool-manager";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Lazy package loader (mirrors sqlite.ts loading bun:sqlite)
// ============================================================================

type LibreDBModule = typeof import("@libredb/libredb");
type LibreDatabase = import("@libredb/libredb").Database;
type LibreKv = import("@libredb/libredb").Kv;
type LibreCatalogEntry = import("@libredb/libredb").CatalogEntry;
type LibreCatalogRegistry = import("@libredb/libredb").CatalogRegistry;

let libredbModule: LibreDBModule | null = null;
let libredbLoadError: Error | null = null;

async function loadLibreDB(): Promise<LibreDBModule> {
  if (libredbModule) return libredbModule;
  if (libredbLoadError) throw libredbLoadError;
  try {
    libredbModule = await import("@libredb/libredb");
    return libredbModule;
  } catch {
    libredbLoadError = new DatabaseConfigError(
      "LibreDB package (@libredb/libredb) is not available in this environment. Install it with: bun add @libredb/libredb",
      "libredb",
    );
    throw libredbLoadError;
  }
}

// ============================================================================
// The two panels this engine cannot answer, and the one cap that can stop a third
// ============================================================================

/**
 * The ceiling on the one keyspace scan every namespace figure is derived from.
 *
 * The kernel keeps no per-namespace counter, so "how many rows" here means "how many
 * keys a scan reached", and the scan is bounded so a large file cannot hang a schema
 * refresh. Exported because it is also the number `LIBREDB_TABLE_STATS_TRUNCATED`
 * names to the user.
 */
export const LIBREDB_MAX_KEY_SCAN = 10000;

/**
 * Sessions: refused on every database, because the concept has no source here.
 *
 * `@libredb/libredb` 0.2.2 publishes no session, connection or client call at all (grepped
 * over its shipped `.d.ts`), and the file is opened in this server's own process. The
 * `<path>.lock` it holds is not a session registry either: measured, it contains
 * `libredb-lock\n<pid>\n<hostname>\n<nonce>` - the pid is THIS server's, and there is no
 * user, statement or start time in it to build a session row from. `[]` said the store was
 * asked who was connected and answered nobody, which is the opposite of the truth: nobody
 * can be asked.
 */
export const LIBREDB_ACTIVE_SESSIONS_REFUSAL =
  "LibreDB is embedded: the file is opened inside this server's own process, and its API has no session, connection or client call to ask (@libredb/libredb 0.2.2). The exclusive lock it takes admits one process and names only that holder's pid and host - this server's own - with no user, statement or start time to build a session row from, so there is nothing to list here rather than a list that came back empty.";

/**
 * Indexes: refused on every database, because there is no index object to count.
 *
 * The kernel is one ordered key-value keyspace and the catalog records a namespace's
 * lens plus, for a relational table, its columns and primary key - nothing else. An
 * empty Indexes panel reads as "this database has no indexes yet", which invites the
 * user to create one; this engine can never have one to show.
 */
export const LIBREDB_INDEX_STATS_REFUSAL =
  "LibreDB has no secondary indexes: the kernel is a single ordered key-value keyspace, where a key's own byte order is the only index there is, and the catalog declares a namespace's lens and a relational table's columns and nothing that indexes them (@libredb/libredb 0.2.2). This panel has no object to list, rather than a database that has none yet.";

/**
 * Tables: refused only when the scan was cut off, never otherwise.
 *
 * Below the cap the key count IS the row count and the panel answers it. Above the cap
 * every namespace's figure is short by an unknown amount, and a silently low row count
 * is the same class of fabrication as the empty panel this work removed.
 */
export const LIBREDB_TABLE_STATS_TRUNCATED = `LibreDB keeps no row counter, so this panel counts each namespace's keys - and that scan stops at ${LIBREDB_MAX_KEY_SCAN.toLocaleString("en-US")} keys, which this database exceeds. Every count would be short by an unknown amount, so none is reported. The namespaces themselves are in the schema tree.`;

// ============================================================================
// LibreDB Provider
// ============================================================================

export class LibreDBProvider extends BaseDatabaseProvider {
  protected db: LibreDatabase | null = null;
  protected kv: LibreKv | null = null;
  protected dbVersion = "unknown";
  /** The resolved, validated absolute file path, set on connect(). */
  protected dbPath: string | null = null;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
  }

  // --------------------------------------------------------------------------
  // Metadata
  // --------------------------------------------------------------------------

  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "json",
      queryDialect: "libredb",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      // The query language is a small JSON command grammar
      // (get/put/delete/prefix/range), so there is no `UPDATE ... SET` for the
      // inline row editor to emit (issue #269).
      supportsInlineRowEdit: false,
      // The command grammar has no transaction verb.
      supportsTransactions: false,
      // The embedded engine's catalog declares namespaces and columns, and nothing
      // that references another namespace. There is no foreign key to read (#414).
      declaresForeignKeys: false,
      // The catalog namespaces are read from a bounded `kv.range` over 10000 keys and
      // grouped by their prefix, so the rows are this server's summary of the keys that
      // scan reached rather than objects the engine declares (#414).
      tablesAreDerivedGroupings: true,
      // `lib.open({ path })` takes an exclusive `<path>.lock` sidecar, so a second
      // open of a file this process already holds throws `LOCKED` rather than
      // returning a second handle. The two callers that used to open one - the
      // connection test and the agent's execution-profile acquisition - reuse the open
      // handle instead (`findOpenSingleWriterProvider`, D3 and B49).
      singleWriterFile: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: null,
      schemaRefreshPattern: "\\b(put|delete)\\b",
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      entityName: "Key Prefix",
      entityNamePlural: "Key Prefixes",
      rowName: "key",
      rowNamePlural: "keys",
      selectAction: "Scan Keys",
      generateAction: "Generate Command",
      analyzeAction: "Key Info",
      vacuumAction: "Compact",
      searchPlaceholder: "Search keys...",
      analyzeGlobalLabel: "Info",
      analyzeGlobalTitle: "Database Info",
      analyzeGlobalDesc: "Show LibreDB file information and key statistics.",
      vacuumGlobalLabel: "Compact",
      vacuumGlobalTitle: "Compact",
      vacuumGlobalDesc: "Not supported for LibreDB in this version.",
      // `getSlowQueries()` answers `[]` unconditionally, so the monitoring Queries
      // panel is ALWAYS empty here - and it used to name a PostgreSQL extension (#U12).
      slowQueriesEmptyState: "LibreDB keeps no statistics about finished statements in this version.",
    };
  }

  // --------------------------------------------------------------------------
  // Validation & lifecycle
  // --------------------------------------------------------------------------

  public override validate(): void {
    super.validate();
    if (!this.config.database) {
      throw new DatabaseConfigError(
        'LibreDB requires a file path (use the "database" field, e.g. /data/app.libredb)',
        "libredb",
      );
    }
  }

  /**
   * Validate and resolve the configured file path, mirroring the SQLite provider
   * (sql/sqlite.ts): resolve to an absolute, normalized path and reject
   * traversal / null-byte inputs. Centralizing this guards every filesystem use
   * (open, statSync) behind one barrier, so an untrusted connection config
   * cannot open unexpected locations.
   */
  private resolveDatabasePath(): string {
    const configured = this.config.database;
    if (!configured) {
      throw new DatabaseConfigError(
        'LibreDB requires a file path (use the "database" field, e.g. /data/app.libredb)',
        "libredb",
      );
    }
    const resolved = path.resolve(configured);
    if (resolved !== path.normalize(resolved) || configured.includes("\0")) {
      throw new DatabaseConfigError("Invalid database path: path traversal is not allowed", "libredb");
    }
    return resolved;
  }

  public async connect(): Promise<void> {
    this.validate(); // throws DatabaseConfigError if database path is missing
    const dbPath = this.resolveDatabasePath(); // resolves + rejects traversal/null-byte
    const lib = await loadLibreDB(); // DatabaseConfigError propagates if unavailable
    try {
      this.db = lib.open({ path: dbPath });
      this.kv = lib.kv(this.db);
      this.dbVersion = lib.version;
      this.dbPath = dbPath;
      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(this.describeOpenError(lib, error), "libredb");
    }
  }

  /**
   * Map a 0.2.x kernel open() failure to a user-actionable message. The kernel's
   * `LibreDbError.code` is its stable contract (messages may be reworded between
   * releases), so branch on the code, never on message text. Codes that cannot
   * occur at open time (CLOSED, NESTED_TRANSACTION, ...) fall through to the
   * generic wrapper together with non-kernel errors.
   */
  private describeOpenError(lib: LibreDBModule, error: unknown): string {
    if (error instanceof lib.LibreDbError) {
      switch (error.code) {
        case "LOCKED":
          return "LibreDB file is already open by another process (exclusive lock). Close the other writer, or wait for its lock to be released.";
        case "NOT_A_DATABASE":
          return "The file is not a LibreDB database. It was left untouched — check the path.";
        case "UNSUPPORTED_VERSION":
          return "The file was written by a newer version of LibreDB than this Studio supports. Upgrade the @libredb/libredb package.";
        case "CORRUPT_WAL":
          return `The LibreDB write-ahead log is corrupt mid-file; refusing to open so no data is destroyed. (${error.message})`;
        // no default: open-time codes only; anything else keeps the kernel message below
      }
    }
    return `Failed to open LibreDB file: ${error instanceof Error ? error.message : String(error)}`;
  }

  public async disconnect(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* the null-guard above runs close() at most once; ignore any error */
      }
      this.db = null;
      this.kv = null;
      this.dbPath = null;
    }
    this.setConnected(false);
  }

  // --------------------------------------------------------------------------
  // Schema & query (filled in Tasks 3-4)
  // --------------------------------------------------------------------------

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();
    const lib = await loadLibreDB();
    // The catalog (since 0.0.2) tells us which namespaces are real document
    // collections / relational tables and, for tables, their column schema. Raw
    // kv keys are not cataloged, so anything outside the catalog falls back to
    // key-prefix grouping below.
    const registry: LibreCatalogRegistry = lib.catalog(this.db!);
    const { groups } = this.scanGroups(registry);

    return groups
      .map(({ name, rowCount, entry }) => this.schemaForGroup(name, rowCount, entry))
      .sort((a, b) => (b.rowCount ?? 0) - (a.rowCount ?? 0));
  }

  /**
   * The one keyspace scan behind BOTH the schema tree and the Tables panel.
   *
   * Sharing it is what keeps the two views consistent: the row count a namespace shows
   * in the tree and the row count the monitoring panel reports are the same number from
   * the same pass, so neither can quietly disagree with the other. `truncated` says the
   * scan hit `LIBREDB_MAX_KEY_SCAN` and stopped - the tree still lists the namespaces it
   * reached, while the Tables panel refuses (see `getTableStats`).
   */
  private scanGroups(registry: LibreCatalogRegistry): {
    groups: { name: string; rowCount: number; entry: LibreCatalogEntry | undefined }[];
    truncated: boolean;
  } {
    // Count keys per scanned group, excluding the reserved catalog namespace.
    const groupCounts = new Map<string, number>();
    let scanned = 0;
    let truncated = false;
    // Empty-string start encodes to the lowest bytes; '\u{10FFFF}' encodes above
    // any UTF-8 text key the lenses produce, so [start, end) covers the keyspace.
    // (kv.prefix cannot be used here — it rejects an empty prefix.)
    for (const { key } of this.kv!.range("", "\u{10FFFF}")) {
      // Skip the database's reserved internal namespace — it is not user data.
      if (this.isReserved(key)) continue;
      if (scanned >= LIBREDB_MAX_KEY_SCAN) {
        truncated = true;
        break;
      }
      scanned++;
      const name = this.groupName(key);
      groupCounts.set(name, (groupCounts.get(name) ?? 0) + 1);
    }

    // A cataloged namespace owns keys "<name>:..." (its rows live under that
    // colon-prefix), so it is the scanned group "<name>:*". Reconcile the two so
    // a cataloged table/collection always appears even if its group name differs
    // and is rendered with the richer catalog-aware columns.
    const groups = [...groupCounts].map(([name, rowCount]) => ({
      name,
      rowCount,
      entry: this.catalogEntryFor(name, registry),
    }));
    // Surface cataloged namespaces that exist but have no scanned rows yet (an
    // empty table/collection), so the catalog view is complete.
    for (const [catalogName, entry] of registry) {
      if (entry.kind === "kv") continue; // kv is the raw layer, never cataloged as a table
      const groupName = `${catalogName}:*`;
      if (groupCounts.has(groupName)) continue;
      groups.push({ name: groupName, rowCount: 0, entry });
    }

    return { groups, truncated };
  }

  /** Group key "user:1" under "user:*"; a key with no ":" is its own group. */
  private groupName(key: string): string {
    const colon = key.indexOf(":");
    return colon > 0 ? `${key.slice(0, colon)}:*` : key;
  }

  /**
   * True if `key` is in the database's reserved internal namespace (catalog
   * metadata and any future reserved sub-namespace). Uses the package's pinned
   * `isReservedKey` predicate — which tests the U+0000 marker, not a specific
   * prefix — instead of a hardcoded string, so the database can evolve its
   * internal key layout without Studio silently leaking it. Safe to hide: the
   * database forbids user namespace names from starting with the marker
   * (assertUserName), so the predicate can never hide user data. The package
   * module is loaded by connect() before any scan, so the cache is populated.
   */
  private isReserved(key: string): boolean {
    return libredbModule!.isReservedKey(key);
  }

  /** The catalog entry that owns a scanned group, if any. A catalog entry named
   * "users" owns the keys "users:..." which group as "users:*", so strip the
   * trailing ":*" to recover the namespace name and look it up. */
  private catalogEntryFor(groupName: string, registry: LibreCatalogRegistry): LibreCatalogEntry | undefined {
    // Only prefix groups ("<ns>:*") own a cataloged namespace. A bare single-key
    // group (no colon) is raw kv and must never be "upgraded" to relational /
    // document columns, even if its name happens to match a catalog namespace.
    if (!groupName.endsWith(":*")) return undefined;
    return registry.get(groupName.slice(0, -2));
  }

  /**
   * Build the TableSchema for a group, made catalog-aware:
   * - relational: the table's real columns + types (primary key marked), so the
   *   view reflects the declared schema rather than raw key/value.
   * - document: a generic id + document column pair (documents are schemaless).
   * - uncataloged (raw kv): the historical key (primary) + value columns.
   *
   * Studio's TableSchema has no dedicated "kind" field, so the kind is signalled
   * by the columns themselves (real columns => relational; id/document =>
   * document; key/value => raw kv).
   */
  private schemaForGroup(name: string, rowCount: number, entry: LibreCatalogEntry | undefined): TableSchema {
    if (entry?.kind === "relational" && entry.schema) {
      const { primaryKey, columns } = entry.schema;
      const cols = Object.entries(columns).map(([colName, colType]) => ({
        name: colName,
        type: colType, // string | number | boolean | object (database ColumnType)
        nullable: false, // v1 relational columns are all required
        isPrimary: colName === primaryKey,
      }));
      return { name, columns: cols, indexes: [], rowCount };
    }
    if (entry?.kind === "document") {
      return {
        name,
        columns: [
          { name: "id", type: "string", nullable: false, isPrimary: true },
          { name: "document", type: "object", nullable: true, isPrimary: false },
        ],
        indexes: [],
        rowCount,
      };
    }
    // Uncataloged raw kv namespace — keep the historical key/value view.
    return {
      name,
      columns: [
        { name: "key", type: "string", nullable: false, isPrimary: true },
        { name: "value", type: "string", nullable: true, isPrimary: false },
      ],
      indexes: [],
      rowCount,
    };
  }

  public async query(input: string): Promise<QueryResult> {
    this.ensureConnected();
    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => this.runCommand(input));
      return { ...result, executionTime };
    });
  }

  private runCommand(input: string): Omit<QueryResult, "executionTime"> {
    const line = this.firstCommandLine(input);
    if (line === "") {
      throw new QueryError("No command to run (only comments or blank lines)", "libredb");
    }
    const parts = this.tokenize(line);
    if (parts.length === 0) throw new QueryError("Empty command", "libredb");
    const verb = parts[0].toLowerCase();
    try {
      return this.dispatchCommand(verb, parts);
    } catch (error) {
      // A kernel INVALID_ARGUMENT is bad user input (e.g. a lone-surrogate key or
      // value the lenses reject), so present it as a QueryError. Every other
      // kernel code (CLOSED, FAILED, ...) is a storage/durability condition and
      // is rethrown untouched so its meaning survives to the caller.
      if (error instanceof libredbModule!.LibreDbError && error.code === "INVALID_ARGUMENT") {
        throw new QueryError(error.message, "libredb", line);
      }
      throw error;
    }
  }

  private dispatchCommand(verb: string, parts: string[]): Omit<QueryResult, "executionTime"> {
    const kv = this.kv!;

    switch (verb) {
      case "get": {
        if (parts.length < 2) throw new QueryError("Usage: get <key>", "libredb");
        const value = kv.get(parts[1]);
        if (value === undefined) return { rows: [], fields: ["key", "value"], rowCount: 0 };
        return { rows: [{ key: parts[1], value: this.renderValue(value) }], fields: ["key", "value"], rowCount: 1 };
      }
      case "put": {
        if (parts.length < 3) throw new QueryError("Usage: put <key> <value>", "libredb");
        const { changed } = kv.set(parts[1], parts.slice(2).join(" "));
        return { rows: [{ changed }], fields: ["changed"], rowCount: changed };
      }
      case "delete": {
        if (parts.length < 2) throw new QueryError("Usage: delete <key>", "libredb");
        const { changed } = kv.delete(parts[1]);
        return { rows: [{ changed }], fields: ["changed"], rowCount: changed };
      }
      case "prefix": {
        if (parts.length < 2) throw new QueryError("Usage: prefix <p>", "libredb");
        return this.toRows(kv.prefix(parts[1]));
      }
      case "range": {
        if (parts.length < 3) throw new QueryError("Usage: range <start> <end>", "libredb");
        return this.toRows(kv.range(parts[1], parts[2]));
      }
    }
    // Reached only for verbs no case matched; a bare `default:` label is not
    // attributable in bun lcov, so the dispatcher rejects unknown verbs here.
    throw new QueryError(`Unknown command "${verb}". Supported: get, put, delete, prefix, range`, "libredb");
  }

  /**
   * Pick the first runnable command, skipping blank lines and `#` comment lines.
   * This lets the schema-explorer "Generate Command" cheatsheet — a commented,
   * multi-line template — run directly: a selected command line runs as-is, and
   * running the whole buffer runs its first real command. A line is a comment
   * only when it *starts* with `#` (after trimming), so `#` inside a key or value
   * is never mistaken for one. Returns `''` when nothing runnable remains.
   */
  private firstCommandLine(input: string): string {
    for (const raw of input.split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      return line;
    }
    return "";
  }

  /**
   * Split on whitespace, honoring single/double quotes (Redis-style).
   *
   * Note: consecutive whitespace outside quotes is collapsed to a single
   * token boundary (unquoted `put key hello  world` stores `"hello world"`).
   * To preserve exact spacing, wrap the value in quotes: `put key "hello  world"`.
   */
  private tokenize(input: string): string[] {
    const parts: string[] = [];
    let current = "";
    let inQuote = false;
    let quoteChar = "";
    let sawToken = false;
    for (const ch of input) {
      if (!inQuote && (ch === '"' || ch === "'")) {
        inQuote = true;
        quoteChar = ch;
        sawToken = true;
      } else if (inQuote && ch === quoteChar) {
        inQuote = false;
      } else if (!inQuote && /\s/.test(ch)) {
        if (sawToken) {
          parts.push(current);
          current = "";
          sawToken = false;
        }
      } else {
        current += ch;
        sawToken = true;
      }
    }
    if (sawToken) parts.push(current);
    if (inQuote) {
      throw new QueryError("Unmatched quote in command", "libredb");
    }
    return parts;
  }

  /** Pretty-print a JSON value; leave non-JSON strings as-is. */
  private renderValue(value: string): string {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }

  private toRows(scan: Iterable<{ key: string; value: string }>): Omit<QueryResult, "executionTime"> {
    const rows: Record<string, unknown>[] = [];
    for (const { key, value } of scan) {
      // Never surface the database's reserved internal namespace in query results.
      if (this.isReserved(key)) continue;
      rows.push({ key, value: this.renderValue(value) });
    }
    return { rows, fields: ["key", "value"], rowCount: rows.length };
  }

  // --------------------------------------------------------------------------
  // Monitoring
  //
  // Each panel answers a real measurement or is ABSENT with this engine's own sentence
  // (D24 / #477). Nothing here reports a figure the file does not hold.
  // --------------------------------------------------------------------------

  /**
   * Health keeps ANSWERING where the monitoring panels refuse.
   *
   * `POST /api/db/test-connection` calls this and the connection dialog's save is gated
   * on that request, so a health check that threw what `getActiveSessions()` throws
   * would lock the embedded engine out of the product (#455). The two fields it fills
   * with `[]` are a liveness summary, not the panels: the Sessions and Queries panels
   * are the surfaces obliged to say what could not be read.
   */
  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();
    return {
      activeConnections: 1,
      databaseSize: this.fileSizeHuman(),
      cacheHitRatio: CACHE_HIT_RATIO_UNAVAILABLE,
      slowQueries: [],
      activeSessions: [],
    };
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();
    return {
      version: this.dbVersion,
      uptime: "-",
      activeConnections: 1,
      maxConnections: 1,
      databaseSize: this.fileSizeHuman(),
      databaseSizeBytes: this.fileSizeBytes(),
      tableCount: (await this.getSchema()).length,
      // Not a placeholder: there is no index object in this engine to count, which is
      // the same fact `getIndexStats()` refuses the Indexes panel with. Zero is the
      // measurement here, so the Overview card states it.
      indexCount: 0,
    };
  }

  /**
   * Nothing, and permanently so.
   *
   * The embedded kernel keeps no cache counters to read: its whole public surface
   * is `open` / `kv` / `doc` / `table` / `catalog` (`@libredb/libredb` 0.2.2), with
   * no statistics call of any kind, and the store it reads from is the process's own
   * memory rather than a buffer pool with hits and misses. A cache hit ratio here
   * would be a number this provider made up - it used to say 100% - so the panel is
   * told there is none and renders "Not measured".
   */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    return {};
  }

  /**
   * Empty, and it reads nothing: there is no log of finished statements to read.
   *
   * The one always-empty panel that stays empty. `QueriesTab` renders
   * `ProviderLabels.slowQueriesEmptyState` in place of an empty list and this provider
   * declares one (`getLabels()` above), so LibreDB's own sentence already reaches the
   * user here - which is the thing an absent panel exists to deliver.
   */
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    return [];
  }

  /** ABSENT with its reason rather than an empty list: see `LIBREDB_ACTIVE_SESSIONS_REFUSAL`. */
  public getActiveSessions(): Promise<ActiveSessionDetails[]> {
    return Promise.reject(new QueryError(LIBREDB_ACTIVE_SESSIONS_REFUSAL, "libredb"));
  }

  /**
   * A real measurement: one key-count per namespace, from the schema tree's own scan.
   *
   * This panel used to answer `[]` on a database with tables - the embedded engine is
   * the zero-config first run, so that empty table was the first monitoring dashboard
   * many users ever saw. The count is honest because a namespace's rows ARE its keys
   * (`employees:1`, `articles:a1`), which is the same thing `getSchema()` reports; the
   * bytes are not, so `tableSize*`/`indexSize*` stay absent and `totalSize` carries the
   * "N/A" placeholder the Storage tab already gates on (`tableSizeKnown`, #469).
   */
  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();
    const lib = await loadLibreDB();
    const { groups, truncated } = this.scanGroups(lib.catalog(this.db!));
    // A count cut off by the cap is short by an unknown amount, so refuse instead.
    if (truncated) throw new QueryError(LIBREDB_TABLE_STATS_TRUNCATED, "libredb");

    return groups
      .map(({ name, rowCount, entry }) => ({
        // LibreDB has no schema namespace. The column carries the namespace's LENS -
        // relational / document / kv - which is the one thing the catalog declares
        // about it, so the panel says something true instead of a filler "main".
        schemaName: entry?.kind ?? "kv",
        tableName: name,
        rowCount,
        totalSize: "N/A",
        totalSizeBytes: 0,
      }))
      .sort((a, b) => b.rowCount - a.rowCount);
  }

  /** ABSENT with its reason rather than an empty list: see `LIBREDB_INDEX_STATS_REFUSAL`. */
  public getIndexStats(): Promise<IndexStats[]> {
    return Promise.reject(new QueryError(LIBREDB_INDEX_STATS_REFUSAL, "libredb"));
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();
    return [
      {
        name: "File",
        location: this.dbPath ?? this.config.database ?? "",
        size: this.fileSizeHuman(),
        sizeBytes: this.fileSizeBytes(),
      },
    ];
  }

  public async runMaintenance(type: MaintenanceType): Promise<MaintenanceResult> {
    throw new QueryError(`Maintenance operation "${type}" is not supported for LibreDB`, "libredb");
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private fileSizeBytes(): number {
    try {
      return this.dbPath ? fs.statSync(this.dbPath).size : 0;
    } catch {
      return 0;
    }
  }

  private fileSizeHuman(): string {
    return formatBytes(this.fileSizeBytes());
  }
}
