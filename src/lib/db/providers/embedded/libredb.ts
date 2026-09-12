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
  type Container,
  type ContainerLevelSpec,
  type DatabaseObject,
  type KindCount,
  type ObjectDetail,
  type ObjectDetailBatch,
  type ObjectKindSpec,
} from "../../types";
import { callerBoundTruncationReason, containerDepth, declaredKinds, findKind } from "../../object-kinds";
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
// Object model (issue #789)
// ============================================================================

/**
 * The three kinds this store holds, and the measurement that produced the list.
 *
 * Nothing external describes this engine's object surface, so the list below is a
 * MEASUREMENT of `@libredb/libredb` 0.2.2 rather than a reading of anyone's
 * documentation. Two things were enumerated: the package's entire export surface, and
 * a database opened cold after being written through every lens it publishes.
 *
 * The whole export surface is twelve names - `open`, `kv`, `doc`, `table`, `catalog`,
 * `isReservedKey`, `CATALOG_PREFIX`, `RESERVED_MARKER`, `nodeFileSystem`,
 * `readonlyFileSystem`, `version`, `LibreDbError` - and a `Database` handle publishes
 * exactly `close` and `transact`. There is no view, no routine, no procedure, no
 * trigger, no index, no sequence and no constraint anywhere in it, so none of those is
 * declared here: a kind an engine cannot have is a folder whose zero badge reads as a
 * measurement (standing ruling 4).
 *
 * What it DOES hold is a persisted catalog, and that is why the answer is not the single
 * kind Redis has. Read cold, the catalog is a registry of NAMED namespaces: a `table()`
 * records `{ kind: "relational", schema }` and a `doc()` records `{ kind: "document" }`
 * on its first write, both under the reserved key prefix, and both are addressed by the
 * name the person who created them chose. Those two are objects somebody named. The
 * third kind is not: `keyspace` is the prefix grouping this server derives by collapsing
 * a bounded scan of raw keys, which is what `tablesAreDerivedGroupings` says and what the
 * refusal below carries.
 *
 * `CatalogEntry.kind` publishes a THIRD arm, `"kv"`, which no write in the package ever
 * records (measured: raw `kv` writes leave the catalog untouched, and the two lens
 * constructors are the only writers). It is not given a kind of its own, and the mapping
 * in `objectKindFor` is TOTAL rather than a match over the two arms that exist: a catalog
 * entry this declaration does not model keeps its keys in the derived `keyspace`
 * grouping, where they are still counted and still listed, instead of falling out of both
 * the count and the listing (standing ruling 5a). Totality of the MAPPING is only half of
 * it: `scanGroups` injects every cataloged namespace the key scan never reached through
 * the same mapping, with no arm filtered out ahead of it, so an unmodelled entry holding
 * ZERO keys is counted and listed too rather than being the one shape that disappears.
 *
 * No kind declares `acceptsRowWrites`: the query grammar is `get` / `put` / `delete` /
 * `prefix` / `range` and has no INSERT, so Generate Test Data would have nothing to emit
 * and the folder's create item would open a modal this engine cannot serve
 * (`supportsCreateTable: false`). No kind declares `hasSource` either, for the reason the
 * export list gives: there is no routine here to have source.
 */
const LIBREDB_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
  { id: "collection", role: "relation", label: "Collection", labelPlural: "Collections" },
  { id: "keyspace", role: "relation", label: "Key Prefix", labelPlural: "Key Prefixes" },
] as const);

/**
 * Which declared kind a scanned namespace belongs to, from the CATALOG and nothing else.
 *
 * Total on purpose, and the default arm is load-bearing rather than defensive. The
 * package's `CatalogEntry.kind` is a union of three and only two of them are ever
 * written today, so a match over exactly those two would silently drop a namespace out
 * of the tree the day a third appears - the shape standing ruling 5a names as the worst
 * defect in this epic, because the count and the listing lose it together and every
 * conformance check still passes. Anything unmodelled lands on the derived grouping,
 * which is where its raw keys are visible anyway.
 *
 * Nothing here reads the NAME to decide what it is holding: a cataloged collection and a
 * bare key may legitimately be called the same thing, and the fixture holds exactly that
 * pair.
 */
function objectKindFor(entry: LibreCatalogEntry | undefined): string {
  if (entry?.kind === "relational") return "table";
  if (entry?.kind === "document") return "collection";
  return "keyspace";
}

/**
 * The one kind whose members are DERIVED from the bounded key walk rather than named by the
 * catalog, taken from the function above rather than written out again, so the two cannot
 * come apart if the derived arm ever changes.
 *
 * This engine holds BOTH shapes at once, which is why the fourth `KindCount` state is per
 * KIND and not a per-provider flag: `table` and `collection` are enumerated from
 * `catalog(db)`, read whole as an eager snapshot, so those counts are populations however
 * far the key scan got; this one is a count of what the scan SAW (#789).
 */
const SCAN_DERIVED_KIND_ID = objectKindFor(undefined);

/**
 * What a `keyspace` count was counted FROM once the walk has stopped on its key budget,
 * phrased to follow "counted from", which is how `flatten.ts` builds the badge's title.
 *
 * Only then: below the cap the walk reached every key in the file, so the grouping count is
 * a population and marking it a floor would teach a reader to discount an exact number. That
 * is the same line `getTableStats` draws with `LIBREDB_TABLE_STATS_TRUNCATED`, and both read
 * the same `truncated` from the same pass.
 */
const KEY_SCAN_SAMPLE_SENTENCE = `the first ${LIBREDB_MAX_KEY_SCAN.toLocaleString("en-US")} keys of a bounded key scan`;

/**
 * The SECOND of the two sentences `describeObjects` reports a bound with, and they are two
 * DIFFERENT bounds rather than two phrasings of one (#789).
 *
 * The first is the CALLER's and is `callerBoundTruncationReason()` in `object-kinds.ts`,
 * shared by every provider so that one event reads one way whichever engine is open. This
 * one is a bound the caller never asked for and this provider did not choose per call: the
 * key walk stops at `LIBREDB_MAX_KEY_SCAN`, so on a larger file the derived groupings are
 * the groupings of a SAMPLE. A cap nobody can see is exactly what
 * `ObjectDetailBatch.truncated` exists to prevent, so this one is reported on an UNBOUNDED
 * call too, and both are named when both bite.
 *
 * It reuses `KEY_SCAN_SAMPLE_SENTENCE`, the same words `countObjects` puts on the badge
 * through `KindCount.sampledFrom`, so a person meeting the fact twice meets it in one
 * wording.
 */
const SCAN_BOUND_SENTENCE = `the key walk stopped at ${KEY_SCAN_SAMPLE_SENTENCE}`;

/**
 * The container levels this provider declares, sliced to the depth `containerDepth()`
 * reports.
 *
 * One reader for the whole file, so the depth and the level list can never be taken by
 * two different rules: `containerDepth()` decides, never `containerLevels.length`, and
 * absent and empty are the same fact. On LibreDB this answers the empty array, and that
 * is the engine rather than a degenerate case - a database is ONE FILE with one flat
 * namespace, with no catalog and no schema above it, so every object is addressed at the
 * root container.
 */
function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * Refuses a container path that is not the shape the DECLARATION describes.
 *
 * On LibreDB the only valid container path is the empty one, and `container.length !== 0`
 * is NOT how that is written: the depth comes from `containerDepth()` through
 * `declaredLevels` and the segment names from the declared labels, so the check and its
 * message are the same array. A provider copying this onto a one- or two-level engine
 * inherits a derivation rather than a literal that would refuse every valid path there
 * (standing ruling 5g).
 *
 * It raises rather than answering an empty folder, because a path of another shape came
 * from a caller holding another engine's model, and an empty folder looks exactly like a
 * database holding nothing.
 */
function assertContainerPath(capabilities: ProviderCapabilities, container: readonly string[]): void {
  const levels = declaredLevels(capabilities);
  if (container.length === levels.length) return;
  const shape = levels.length === 0 ? "empty" : `[${levels.map((level) => level.label.toLowerCase()).join(", ")}]`;
  throw new QueryError(`A LibreDB container path is ${shape}, received ${JSON.stringify(container)}`, "libredb");
}

/**
 * Order two paths segment by segment.
 *
 * Never `JSON.stringify(path)`: at mixed depth the deeper path sorts first, because `,`
 * is below `]`, and JSON escaping reorders exotic names. This is the fourth-plus copy in
 * the repo and Task 28's sweep hoists them all into `object-kinds.ts`; it is written the
 * settled way here so that sweep is a deletion (standing ruling 5h).
 */
function comparePaths(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

/** One enumerated object, with the two things `describeObject` needs to describe it. */
interface LibreDBEnumeratedObject {
  readonly object: DatabaseObject;
  /** The catalog entry that named it. Absent for a derived grouping. */
  readonly entry: LibreCatalogEntry | undefined;
  /** The scanned key-prefix group it owns: `employees:*` for the table `employees`. */
  readonly groupName: string;
  /** The keys the bounded walk saw under it. Carried so `describeObject` can rebuild the
   * SAME `TableSchema` the flat model builds, rather than a second shape with a 0 in it. */
  readonly rowCount: number;
}

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
      //
      // It stays true with the object model, and it is now a HALF-truth this engine
      // carries knowingly: of the three declared kinds only `keyspace` is derived, while
      // `table` and `collection` are entries the persisted catalog names. The flag is
      // engine-wide and its only remaining reader, the Profile item in
      // `src/components/object-tree/row-actions.ts`, therefore withholds Profile from
      // those two named kinds as well. Measured, that costs nothing: `/api/db/profile`
      // branches on `queryLanguage === "sql"` and this provider declares `json`, so
      // Profile could not work on any kind here. Backlog X13 carries the per-kind half
      // and the condition that would make the gap bite (#789).
      tablesAreDerivedGroupings: true,
      // No container level, and that is the engine rather than an omission: a LibreDB
      // database is ONE FILE holding one flat namespace, with nothing above it to list.
      // `containerLevels` is therefore absent, which `containerDepth()` reads as 0 -
      // absent and `[]` are the same fact and only that helper is allowed to decide it.
      objectKinds: LIBREDB_OBJECT_KINDS,
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
      // Stated verbatim in the agent's plan contract, and needed for the reason Redis
      // needed one: a plan run on 2026-08-22, asked to list every entry under the
      // `users` prefix, drafted `GET users:*`. `dispatchCommand` gives `get` exactly
      // one meaning - `kv.get(parts[1])`, an exact-key lookup with no glob of any kind
      // - so that command answers zero rows and NO error, which on a key-value store
      // reads as "nothing stored there" rather than as a mistake (#518). The cause is
      // the one Redis has: the inventory's rows are named `users:*`, which reads as a
      // wildcard this grammar does not have, so the sentence names all five verbs and
      // says in words what `tablesAreDerivedGroupings` says in a flag.
      statementLanguage:
        "LibreDB's own command grammar - exactly one command on one line, in one of the five forms `get <key>`, `put <key> <value>`, `delete <key>`, `prefix <p>` or `range <start> <end>` - and NOT SQL and not a shell: every key is matched EXACTLY, with no glob and no wildcard, so `get users:*` looks up a key literally named `users:*` and answers nothing; the inventory's `prefix:*` rows are groupings this engine summarised, not keys, so reach every entry under one with `prefix users:` and a single entry by its real name",
      // `getSlowQueries()` answers `[]` unconditionally, so the monitoring Queries
      // panel is ALWAYS empty here - and it used to name a PostgreSQL extension (#463).
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
    // Surface cataloged namespaces that exist but have no scanned rows yet (an empty
    // table/collection), so the catalog view is complete.
    //
    // EVERY catalog entry, with no arm skipped, and that is standing ruling 5a rather than
    // tidiness. This loop used to skip `entry.kind === "kv"`, on the reasoning that the raw
    // layer is never cataloged as a table - which is true of what the package WRITES, and
    // says nothing about what it can hold. The effect was that an entry of an arm this
    // provider does not model fell out of both the count and the listing whenever it held
    // no keys, while an empty table or collection was injected and listed: invisible in the
    // tree with the badge agreeing with the folder, which is the worst shape this epic has.
    // `objectKindFor` is total, but a total mapping is worth nothing behind a filter that
    // decides which entries reach it, so the filter is gone and the mapping decides. An
    // unmodelled entry lands on the derived `keyspace` grouping and `schemaForGroup` gives
    // it the raw key/value columns, so nothing is "upgraded" to relational or document
    // columns it does not have (#789).
    for (const [catalogName, entry] of registry) {
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
    return registry.get(LibreDBProvider.namespaceOfGroup(groupName));
  }

  /**
   * The catalog namespace a scanned prefix group belongs to: `employees:*` -> `employees`.
   *
   * One spelling for the whole file, so the group-to-namespace mapping cannot be written
   * one way where an entry is LOOKED UP and another way where an object is ADDRESSED.
   * Only ever called on a group name `catalogEntryFor` has already accepted, which is why
   * it can strip the two trailing characters unconditionally.
   */
  private static namespaceOfGroup(groupName: string): string {
    return groupName.slice(0, -2);
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
  // Object model (#789)
  //
  // Every read below goes through `this.db` / `this.kv`, the handle `connect()` already
  // holds, and nothing here calls `lib.open` a second time. That is not style: this is
  // the one engine that declares `singleWriterFile`, because `open({ path })` takes an
  // exclusive `<path>.lock` sidecar and a second open of the same file throws `LOCKED`.
  // A second handle opened for an object read would lock the session out of its own
  // database (`findOpenSingleWriterProvider`, D3 and B49).
  // --------------------------------------------------------------------------

  /**
   * No containers, because the engine has none.
   *
   * A LibreDB database is one file holding one flat namespace: there is no catalog, no
   * schema, no keyspace and no numbered database to select, so every object is addressed
   * at the root container and this answers the empty array. `getCapabilities()` declares
   * no `containerLevels` to match, and the two are read through `containerDepth()` so
   * they cannot disagree.
   */
  public async listContainers(): Promise<Container[]> {
    this.ensureConnected();
    return [];
  }

  /**
   * THE single enumerator behind all three object methods, and the seam standing ruling
   * 5f is held on.
   *
   * The rule is that the listing must contain exactly what the count counted. On a SQL
   * engine that is a warning about two `WHERE` clauses drifting apart; here there is no
   * statement layer at all, so the seam is a METHOD: this one reads the catalog and walks
   * the keyspace, and `countObjects`, `listObjects` and `describeObject` all read what it
   * returns and nothing else. A count is the LENGTH of the array its own kind was given,
   * so there is no second scan with a different bound for the badge and the folder to
   * disagree in.
   *
   * It reads through `scanGroups`, which is the same pass `getSchema()` and
   * `getTableStats()` make, so the flat model and the object model cannot report a
   * different inventory of the same file while both surfaces are live.
   *
   * TWO COUNTS OF DIFFERENT KINDS COME OUT OF THIS, and the difference is written down
   * rather than smoothed over. `table` and `collection` are enumerated from the CATALOG,
   * which `catalog()` reads whole as an eager snapshot, so those two counts are
   * populations: `scanGroups` injects a cataloged namespace the scan never reached, which
   * is how the empty table `vacancies` is counted and listed at all. `keyspace` is
   * enumerated from a scan bounded at `LIBREDB_MAX_KEY_SCAN` keys, so on a file larger
   * than that bound its count is a SAMPLE SIZE and not a population. `KindCount` now has a
   * state that says so, and `countObjects` puts it on that kind alone once `truncated` is
   * set: this provider answers a floor and two populations in one record.
   *
   * Every declared kind is seeded with an empty array BEFORE any group is placed, so a
   * kind holding nothing lands as an empty listing and a `{ count: 0 }` badge rather than
   * disappearing from the record.
   */
  private enumerate(container: readonly string[]): {
    byKind: Record<string, LibreDBEnumeratedObject[]>;
    truncated: boolean;
  } {
    const registry: LibreCatalogRegistry = libredbModule!.catalog(this.db!);
    const { groups, truncated } = this.scanGroups(registry);

    const byKind: Record<string, LibreDBEnumeratedObject[]> = {};
    for (const kind of declaredKinds(this.getCapabilities())) byKind[kind.id] = [];

    for (const { name: groupName, rowCount, entry } of groups) {
      const kind = objectKindFor(entry);
      // EVERY object is ADDRESSED BY ITS GROUP, cataloged or derived, and the catalog name
      // addresses nothing (#789).
      //
      // It was the catalog name until this round, on the reasoning that `employees` is the
      // string the catalog keys the table under and the one `table()` and `doc()` take.
      // That is true about the ENGINE'S API and false about this address: standing ruling 2
      // says the last path segment is the identifier that is UNIQUE WITHIN ITS PARENT, and
      // a catalog name cannot be, because the catalog and the raw keyspace are one
      // namespace. Measured on @libredb/libredb 0.2.2: a bare key `notes` and a document
      // collection `notes` coexist in one file - `assertUserName` forbids `:` in a
      // namespace name and nothing forbids a raw key equal to one - and they are two
      // objects rather than one listed twice, because `doc(db, "notes").all()` yields the
      // collection's documents and not the bare key, while `kv.get("notes")` answers the
      // bare value with the collection intact. Two objects published at `["notes"]`, both
      // `role: "relation"`, so neither the kind filter nor a container could separate them
      // and the flat reading resolved to neither.
      //
      // The GROUP name is unique within the parent by construction rather than by luck:
      // every group comes from one grouping pass over one keyspace, and the injected
      // `<name>:*` for a cataloged namespace the scan never reached is only pushed when
      // that group is absent. It is also the spelling `getSchema()` answers, so the two
      // readings now agree on every object rather than on the derived ones alone.
      //
      // This is ruling 2's routine precedent rather than an exception to it: where an
      // engine's bare name is not unique within its parent, the path carries the
      // disambiguated form the engine itself tells them apart by, and the LABEL keeps the
      // bare one. Here the engine tells them apart by the key pattern.
      const segment = groupName;
      byKind[kind].push({
        object: {
          path: [...container, segment],
          // The LABEL is the group, deliberately, and it is allowed to differ from the
          // last path segment (standing ruling 2). Everything the row menu still reaches
          // through `flatTargetName` looks an object up in `getSchema()`'s list BY NAME,
          // and that list spells a cataloged namespace `employees:*`; naming the object
          // `employees` here would miss that lookup, and the generated command would then
          // be `get employees`, an exact-key read of a key nobody stored, which answers
          // zero rows and no error (#518). The path already carries the real identity, so
          // when the flat narrowing goes the label can follow with no identity change.
          name: groupName,
          kind,
          // The keys this bounded walk SAW under the namespace, which is a sample rather
          // than a total on a file larger than `LIBREDB_MAX_KEY_SCAN`. It is the same
          // number `getSchema()` reports for the same namespace, from the same pass.
          rowCount,
        },
        entry,
        groupName,
        rowCount,
      });
    }

    for (const objects of Object.values(byKind)) {
      objects.sort((left, right) => comparePaths(left.object.path, right.object.path));
    }
    // `truncated` travels out with the objects rather than being re-derived by a caller: the
    // count, the rows and the claim about how complete they are then all come from one pass.
    return { byKind, truncated };
  }

  /**
   * How many objects of each declared kind the file holds.
   *
   * There is no `{ unavailable }` state on this engine, and that is a measurement rather
   * than an omission. Every kind is counted from ONE read, `catalog()` plus the keyspace
   * walk, made on a handle this process already holds - there is no per-kind command that
   * a deployment might not have, the way `FUNCTION LIST` is missing on three Redis-wire
   * relatives. A failure of that read is a kernel storage condition, and this provider's
   * settled answer to one is to let it propagate with the kernel's own code intact
   * (`runCommand`), not to report every folder as unavailable.
   */
  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    assertContainerPath(capabilities, container);
    const { byKind, truncated } = this.enumerate(container);
    const counts: Record<string, KindCount> = {};
    // Over the DECLARATION, so every declared kind gets an entry whatever the file holds
    // and no group can add a folder the provider never declared.
    for (const kind of declaredKinds(capabilities)) {
      const count = byKind[kind.id].length;
      // TWO SHAPES IN ONE RECORD, which is the whole reason the fourth state is per kind: the
      // two cataloged kinds stay exact numbers in the same answer where the derived one
      // becomes a floor, and only once the walk actually stopped short.
      counts[kind.id] =
        truncated && kind.id === SCAN_DERIVED_KIND_ID ? { count, sampledFrom: KEY_SCAN_SAMPLE_SENTENCE } : { count };
    }
    return counts;
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    // The DECLARATION answers "is this a kind of mine", never the presence of a reader
    // below: deciding it from the reader would report "declares no object kind" about a
    // kind `objectKinds` does declare.
    this.assertDeclaredKind(capabilities, kind);
    assertContainerPath(capabilities, container);
    return this.enumerate(container).byKind[kind].map((enumerated) => enumerated.object);
  }

  /**
   * What one object of one KIND is made of.
   *
   * The KIND decides, and nothing here reads the name to work out what it is holding.
   * That matters on this engine rather than being a principle recited: a cataloged
   * document collection and a bare raw key may carry the SAME string, measured, and the
   * fixture holds that pair - `notes` is a collection of one document and also a key with
   * a value. Asking the catalog what `notes` is would describe one of them twice.
   *
   * The columns come from `schemaForGroup`, which is what `getSchema()` builds its rows
   * from, so the flat model and the object model cannot describe the same object
   * differently while both surfaces are live. `indexes` and `foreignKeys` are empty for
   * every kind, and both are facts about the engine rather than unfinished reads: the
   * kernel is one ordered keyspace where a key's own byte order is the only index there
   * is (`LIBREDB_INDEX_STATS_REFUSAL`), and the catalog records a namespace's lens and a
   * table's columns and nothing that references another namespace
   * (`declaresForeignKeys: false`).
   *
   * An object the current read no longer holds RAISES rather than answering an empty
   * shape. All three kinds are alike in this, unlike Redis where one kind can be
   * described without asking: every kind here is enumerated from the same read, so
   * checking costs nothing, and an empty shape would claim a table that was never
   * cataloged or a grouping whose last key is gone.
   */
  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    this.assertDeclaredKind(capabilities, kind);

    // Derived, not counted: the depth comes from `containerDepth()` through
    // `declaredLevels`, and the names in the message are the declared labels, so the
    // check and its message cannot disagree. No kind declares `attachedTo`, so there is
    // one shape rather than two.
    const levels = declaredLevels(capabilities);
    if (path.length !== levels.length + 1) {
      throw new QueryError(
        `A LibreDB "${kind}" path is [${[...levels.map((level) => level.label.toLowerCase()), "name"].join(", ")}], ` +
          `received ${JSON.stringify(path)}`,
        "libredb",
      );
    }

    // The LAST segment and never `path[0]`: at depth 2 the first segment is a container.
    const name = path[path.length - 1];
    const found = this.enumerate(path.slice(0, levels.length)).byKind[kind].find(
      (enumerated) => enumerated.object.path[enumerated.object.path.length - 1] === name,
    );
    if (found === undefined) {
      throw new QueryError(
        `LibreDB holds no "${kind}" named ${JSON.stringify(name)} (the catalog and a ` +
          `${LIBREDB_MAX_KEY_SCAN.toLocaleString("en-US")}-key scan were read)`,
        "libredb",
      );
    }
    return this.objectDetailOf(path, found);
  }

  /**
   * One enumerated object turned into one `ObjectDetail`, shared by the single and the
   * bulk read.
   *
   * One function because a caller joins the two answers together: two copies of this
   * mapping would be two chances for the bulk read to spell a cataloged table's columns
   * differently from the single read of the same table. It goes through `schemaForGroup`,
   * which is also what `getSchema()` builds its rows from, so all three surfaces describe
   * one group one way while the flat one is still live.
   *
   * `indexes` and `foreignKeys` are empty for every kind, and both are facts about the
   * engine rather than unread fields: the kernel is one ordered keyspace where a key's own
   * byte order is the only index there is, and the catalog records a namespace's lens and
   * a table's columns and nothing that references another namespace.
   */
  private objectDetailOf(path: readonly string[], enumerated: LibreDBEnumeratedObject): ObjectDetail {
    return {
      path: [...path],
      columns: this.schemaForGroup(enumerated.groupName, enumerated.rowCount, enumerated.entry).columns,
      indexes: [],
      foreignKeys: [],
    };
  }

  /**
   * Columns for EVERY object of one kind in the file, from ONE enumeration (#789).
   *
   * ONE PASS for the whole folder, which is the entire reason this method exists. There is
   * no statement layer on this engine, so the N+1 the inventory route removed would not
   * come back here as 5000 round trips but as 5000 KEY WALKS: `describeObject` calls
   * `enumerate()`, and a body that looped it would scan the file once per object. The
   * suite counts the passes rather than the time, because an embedded engine is fast
   * enough that a timing comparison would pass either way.
   *
   * NO KIND ON THIS ENGINE ANSWERS AN EMPTY BATCH FOR WANT OF COLUMNS, and that is a
   * measurement rather than an omission. The reference's fourth guard covers a routine, a
   * trigger or a sequence, and this store has none: all three declared kinds are
   * `role: "relation"` and `schemaForGroup` answers real columns for each of them - a
   * cataloged table's declared schema, a collection's id/document pair, and a raw
   * grouping's key/value pair. So there is no early return to write, and writing one would
   * be a branch nothing can reach.
   *
   * TWO BOUNDS, AND THE ANSWER NAMES WHICHEVER BIT. The caller's `limit` is applied to the
   * SORTED enumeration and reports the caller's own number. The key walk's own cap is a
   * bound this provider did not choose on this call, and it is reported too, on an
   * unbounded read as readily as on a bounded one, because a cap nobody can see is the
   * defect `truncated` exists to prevent. It is reported on the DERIVED kind alone, which
   * is the same rule `countObjects` applies to `KindCount.sampledFrom` and for the same
   * measured reason: `catalog()` is read whole as an eager snapshot, so `table` and
   * `collection` are populations however far the key walk got.
   *
   * THE CUT IS OURS AND THE WALK IS THE ENGINE'S, which is the reverse of every SQL engine
   * in #789, where a `LIMIT` cuts under the server's collation and the sort is ours. There
   * is no `LIMIT` to push down here - `scanGroups` has to reach the end of the keyspace
   * before it knows which GROUPS exist at all, and it appends a cataloged namespace the
   * walk never saw after that - so the enumeration is sorted with `comparePaths` and cut
   * afterwards. On the two names Task 26a-2 measured across five engines, `U+E000` and
   * `U+1F600`, that is observable: the kernel walks them in UTF-8 byte order and
   * `comparePaths` compares UTF-16 code units, so a bounded read here keeps the emoji
   * where a server-side cut would have kept the private-use character.
   */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    // The four guards, in the reference's order: the DECLARATION first, because an
    // undeclared kind is a fact about the engine and an empty answer is a claim about the
    // data; then the container, through the same reader `listObjects` uses.
    this.assertDeclaredKind(capabilities, kind);
    assertContainerPath(capabilities, container);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      // Not clamped and not ignored. A 0 would answer nothing while reporting a truncation
      // the caller never asked for, and a fraction cannot cut a list; both are caller
      // mistakes and neither has a right answer to guess at.
      throw new QueryError(
        `A LibreDB bulk column read limit must be a positive whole number, received ${limit}`,
        "libredb",
      );
    }

    const { byKind, truncated: scanTruncated } = this.enumerate(container);
    const enumerated = byKind[kind];
    const bounded = limit !== undefined && enumerated.length > limit;
    const details = (bounded ? enumerated.slice(0, limit) : enumerated).map((object) =>
      this.objectDetailOf(object.object.path, object),
    );

    // Only the DERIVED kind can be short because of the walk. The two cataloged kinds come
    // from the whole catalog, so marking them would teach a reader to discount a number
    // that is exact.
    const scanBound = scanTruncated && kind === SCAN_DERIVED_KIND_ID;
    if (!bounded && !scanBound) return { details };
    const reasons = [
      ...(bounded ? [callerBoundTruncationReason(limit!)] : []),
      ...(scanBound ? [SCAN_BOUND_SENTENCE] : []),
    ];
    // The CALLER's limit whenever the caller set one that bit; otherwise the number this
    // read actually produced, which is the only bound in existence on that arm and keeps
    // `details.length <= truncated.limit` true either way.
    return { details, truncated: { limit: bounded ? limit! : details.length, reason: reasons.join(", and ") } };
  }

  /** One spelling of the declaration check, so two methods cannot refuse by two rules. */
  private assertDeclaredKind(capabilities: ProviderCapabilities, kind: string): void {
    if (findKind(capabilities, kind) === undefined) {
      throw new QueryError(`LibreDB declares no object kind "${kind}"`, "libredb");
    }
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
