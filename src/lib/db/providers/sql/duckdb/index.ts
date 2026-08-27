/**
 * DuckDB Database Provider (issue #424)
 *
 * An embedded analytical engine, opened in-process through `@duckdb/node-api` against
 * a local file or `:memory:`. There is no host, no port and no connection string: the
 * whole configuration is a path, which is why `defaultPort` is null and
 * `supportsConnectionString` is false.
 *
 * Four things make this provider different from `sqlite.ts`, and all four are measured
 * rather than assumed (DuckDB v1.5.5 / @duckdb/node-api 1.5.5-r.4, 2026-08-27; the
 * measurements are recorded in `.duckdb-measured.md` and published in
 * `docs/providers/duckdb.md`):
 *
 * - **One process per file.** DuckDB takes an operating-system lock at open and
 *   refuses a second process even in read-only mode, so `singleWriterFile` is declared
 *   and the three routes that would otherwise open a second handle borrow this one
 *   instead (`findOpenSingleWriterProvider`, BACKLOG D3). A second handle inside THIS
 *   process is allowed, which is what makes the agent's read-only handle possible at
 *   all.
 * - **`access_mode: 'READ_ONLY'` is not a filesystem sandbox.** It refuses every write
 *   to the attached database and it does NOT refuse `COPY ... TO '<path>'`,
 *   `EXPORT DATABASE`, `INSTALL`, `LOAD` or `read_text('/etc/hostname')` - all measured
 *   as succeeding on a genuinely read-only handle. Same class as the SQLite
 *   `VACUUM INTO` and PostgreSQL `COPY TO PROGRAM` escapes this repo has already paid
 *   for. What closes it is a SECOND engine option, `enable_external_access: 'false'`,
 *   passed beside `access_mode` when the read-only handle is opened (`client.ts`); the
 *   statement guard below is the layer above it, not the boundary.
 * - **No statement router.** `SQLBaseProvider.isReadOnlyQuery` types a statement by its
 *   leading keyword, and DuckDB has four row-producing forms that keyword set does not
 *   know (`FROM tbl`, `CALL`, `SUMMARIZE`, `PIVOT`). Rather than extend a router this
 *   provider does not need, every statement takes ONE code path and the answer's shape
 *   decides what it was - see `values.ts`.
 * - **Cancellation exists.** `DuckDBConnection.prototype.interrupt()` is on the 1.5.5-r.4
 *   prototype and was measured stopping a long scan ("INTERRUPT Error: Interrupted!")
 *   and leaving the connection usable, so `cancelQuery` is implemented.
 *
 * What DuckDB does NOT publish is stated as absence rather than filled in: there is no
 * `duckdb_queries()` and no `duckdb_connections()`, so the slow-query and session
 * panels are honest empties carrying a DuckDB-specific label.
 */

import { SQLBaseProvider } from "../sql-base";
import {
  type ActiveSessionDetails,
  type DatabaseConnection,
  type DatabaseOverview,
  type HealthInfo,
  type IndexStats,
  type MaintenanceResult,
  type MaintenanceType,
  type PerformanceMetrics,
  type ProviderCapabilities,
  type ProviderExecutionContext,
  type ProviderLabels,
  type ProviderOptions,
  type QueryResult,
  type ReadOnlyStatementBudget,
  type SlowQueryStats,
  type StorageStats,
  type TableSchema,
  type TableStats,
} from "../../../types";
import {
  DatabaseConfigError,
  DatabaseError,
  ExecutionProfileError,
  QueryCancelledError,
  QueryError,
  mapDatabaseError,
} from "../../../errors";
import { assertReadOnlyBudget, measureResultBytes } from "../read-only-budget";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readLeadingKeyword } from "@/lib/sql/leading-keyword";
import { findCodeWord } from "@/lib/sql/words";
import { hasUnterminatedSpan } from "@/lib/sql/spans";
import { type DuckDBClient, describeOpenFailure, openDuckDBClient } from "./client";
import {
  readActiveSessions,
  readHealth,
  readIndexStats,
  readOverview,
  readSchema,
  readSlowQueries,
  readStorageStats,
  readTableStats,
} from "./introspect";
import { toQueryResult } from "./values";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Constants
// ============================================================================

/** DuckDB's in-memory target. Accepted wherever a path is, and never touched on disk. */
const MEMORY_TARGET = ":memory:";

/** DuckDB's default schema; a maintenance target with no schema is resolved into it. */
const DEFAULT_SCHEMA = "main";

// ============================================================================
// Error mapping
// ============================================================================

/**
 * DuckDB prefixes every error with the class that raised it, so the classification is
 * read off that prefix rather than guessed from the sentence.
 *
 * The shared `mapDatabaseError` cannot be used first here, and the reason is concrete:
 * it classifies on substrings, and `Binder Error: Referenced column "password" not
 * found in FROM clause!` contains "password", so a mistyped column name in a users
 * table would be reported to the operator as an AUTHENTICATION failure. Reading the
 * prefix first ends that whole class of misreading; anything without a recognised
 * prefix still falls through to the shared mapper.
 */
const QUERY_ERROR_PREFIXES = [
  "Parser Error",
  "Binder Error",
  "Catalog Error",
  "Conversion Error",
  "Invalid Input Error",
  "Constraint Error",
  "Out of Range Error",
  "Not implemented Error",
  "Permission Error",
  "Serialization Error",
  "TransactionContext Error",
];

/** DuckDB's own word for a statement `interrupt()` stopped. */
const INTERRUPT_PREFIX = "INTERRUPT Error";

/** The lock message; shared with `client.ts`'s open-time diagnosis. */
const LOCK_CONFLICT_MARKER = "conflicting lock is held";

export function mapDuckDBError(error: unknown, sql?: string): Error {
  if (error instanceof DatabaseError || error instanceof ExecutionProfileError) return error;

  const message = error instanceof Error ? error.message : String(error);

  if (message.startsWith(INTERRUPT_PREFIX)) {
    return new QueryCancelledError("Query was cancelled", "duckdb", sql);
  }

  // A lock conflict can arrive mid-session as well as at open - a `CHECKPOINT` or an
  // `ATTACH` re-takes the lock - so the same actionable sentence is produced here.
  if (message.toLowerCase().includes(LOCK_CONFLICT_MARKER)) {
    return describeOpenFailure(error, "the database file", false);
  }

  if (QUERY_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))) {
    return new QueryError(message, "duckdb", sql);
  }

  return mapDatabaseError(error, "duckdb", sql);
}

// ============================================================================
// Agent read-only statement guard (#328)
// ============================================================================

/**
 * Statement forms whose reach the read-only profile does not want, named so they can be
 * refused with a sentence a human can act on.
 *
 * **This list is DEFENCE IN DEPTH, not the boundary.** The boundary is
 * `enable_external_access: 'false'`, fixed at open in `client.ts`, which refuses every
 * one of these engine-side with `Permission Error: Cannot access file "..." - file
 * system operations are disabled by configuration`. This layer exists because a
 * refusal that names the construct and says why is worth more to the reader than the
 * engine's sentence, because it costs nothing to run before the engine, and because a
 * future option change here would otherwise be a silent single point of failure.
 *
 * Every entry was measured succeeding against an instance opened with
 * `access_mode: 'READ_ONLY'` ALONE - whose `INSERT` was refused in the same session -
 * so the list is a record of real holes rather than a precaution:
 *
 * | statement | outcome on a read-only-only handle |
 * | --- | --- |
 * | `COPY (SELECT 1) TO '<path>' (FORMAT CSV)` | file written |
 * | `EXPORT DATABASE '<path>'` | directory written |
 * | `INSTALL httpfs` / `LOAD json` | extension installed / loaded |
 * | `SELECT * FROM read_text('/etc/hostname')` | file contents returned |
 * | `SELECT * FROM glob('/etc/*')` | directory listing returned |
 *
 * The words are matched as CODE words through `findCodeWord`, not by regex over the
 * text: a keyword inside a comment, a string or a quoted identifier is not the
 * statement doing it, and this repo has fixed that same defect four times over (#275,
 * #280, #287, #294). `COPY` is refused in both directions rather than only in its
 * `TO` form - `COPY ... FROM` is a write the engine refuses anyway, so refusing the
 * keyword outright costs nothing and leaves no `TO`-detection to get wrong.
 *
 * **What this matcher CANNOT see, and therefore what this list does not cover.** Do not
 * read it as exhaustive; all three of these were measured executing when the denylist
 * was the only control, and all three are refused by the engine option today:
 *
 * - **A quoted function name.** `findCodeWord` skips `quoted-identifier` spans by
 *   design - right for a keyword, wrong for a function name, because DuckDB resolves
 *   `"read_text"(...)` and `main."read_text"(...)` exactly like `read_text(...)`.
 * - **A bare path in `FROM`.** DuckDB's replacement scan turns `FROM '/tmp/x.csv'` into
 *   a `read_csv_auto`, and there is no forbidden word anywhere in the statement to find.
 * - **A statement inside a string literal.** `json_execute_serialized_sql` (denied
 *   below by NAME) carries a whole second statement in a literal the scanner correctly
 *   refuses to read as code; so does `query('...')`, which is deliberately NOT denied -
 *   a bare `query` is a plausible column name, and with external access off it can
 *   reach nothing this profile does not already allow.
 *
 * `duckdb-provider.test.ts` derives the file-reaching table functions from the live
 * `duckdb_functions()` catalog and fails when one of them is missing here, so a DuckDB
 * version that ships a new reader breaks the build rather than widening the list.
 */
const READ_ONLY_FORBIDDEN_WORDS: ReadonlyArray<{ word: string; reason: string }> = [
  { word: "COPY", reason: "COPY writes to a path of its own choosing, which a read-only handle does not refuse" },
  { word: "EXPORT", reason: "EXPORT DATABASE writes the whole database to a directory" },
  { word: "IMPORT", reason: "IMPORT DATABASE replays arbitrary SQL from a directory" },
  { word: "INSTALL", reason: "INSTALL fetches and installs an extension" },
  { word: "LOAD", reason: "LOAD activates an extension whose functions are outside this boundary" },
  { word: "ATTACH", reason: "ATTACH opens a second database outside the one this profile was granted" },
  { word: "DETACH", reason: "DETACH removes the database this profile was granted" },
  { word: "READ_CSV", reason: "read_csv reads an arbitrary local file" },
  { word: "READ_CSV_AUTO", reason: "read_csv_auto reads an arbitrary local file" },
  { word: "SNIFF_CSV", reason: "sniff_csv reads an arbitrary local file" },
  { word: "READ_PARQUET", reason: "read_parquet reads an arbitrary local file" },
  { word: "PARQUET_SCAN", reason: "parquet_scan reads an arbitrary local file" },
  { word: "READ_JSON", reason: "read_json reads an arbitrary local file" },
  { word: "READ_JSON_AUTO", reason: "read_json_auto reads an arbitrary local file" },
  { word: "READ_JSON_OBJECTS", reason: "read_json_objects reads an arbitrary local file" },
  { word: "READ_JSON_OBJECTS_AUTO", reason: "read_json_objects_auto reads an arbitrary local file" },
  { word: "READ_NDJSON", reason: "read_ndjson reads an arbitrary local file" },
  { word: "READ_NDJSON_AUTO", reason: "read_ndjson_auto reads an arbitrary local file" },
  { word: "READ_NDJSON_OBJECTS", reason: "read_ndjson_objects reads an arbitrary local file" },
  {
    word: "READ_DUCKDB",
    reason: "read_duckdb reads a whole other DuckDB database file, which is the ATTACH refusal by another name",
  },
  { word: "PARQUET_METADATA", reason: "parquet_metadata reads an arbitrary local file" },
  { word: "PARQUET_FILE_METADATA", reason: "parquet_file_metadata reads an arbitrary local file" },
  { word: "PARQUET_KV_METADATA", reason: "parquet_kv_metadata reads an arbitrary local file" },
  { word: "PARQUET_FULL_METADATA", reason: "parquet_full_metadata reads an arbitrary local file" },
  { word: "PARQUET_SCHEMA", reason: "parquet_schema reads an arbitrary local file" },
  { word: "PARQUET_BLOOM_PROBE", reason: "parquet_bloom_probe reads an arbitrary local file" },
  {
    word: "JSON_EXECUTE_SERIALIZED_SQL",
    reason:
      "json_execute_serialized_sql runs a whole statement carried in a string literal, which no reader of the surrounding text can inspect",
  },
  { word: "READ_TEXT", reason: "read_text returns the contents of an arbitrary local file" },
  { word: "READ_BLOB", reason: "read_blob returns the contents of an arbitrary local file" },
  { word: "READ_XLSX", reason: "read_xlsx reads an arbitrary local file" },
  { word: "GLOB", reason: "glob lists an arbitrary local directory" },
  { word: "DELTA_SCAN", reason: "delta_scan reads a table outside this database" },
  { word: "ICEBERG_SCAN", reason: "iceberg_scan reads a table outside this database" },
];

/**
 * Refuse a named form before the engine is asked - the belt, not the boundary.
 *
 * The engine owns both halves of the boundary and neither is delegated here:
 * `access_mode: 'READ_ONLY'` owns "no write reaches this database" and
 * `enable_external_access: 'false'` owns "no statement reaches the filesystem around
 * it", both fixed at open and neither reachable from a statement. What this function
 * adds is a refusal that NAMES the construct and says why, in front of an engine
 * sentence that says only that the file system is disabled by configuration.
 *
 * It is a name denylist, so it is not exhaustive and cannot be made so - see the list
 * above for the three forms its matcher cannot see. Do not let anything come to depend
 * on it as the only control.
 *
 * Fails closed on text it cannot read. An unterminated literal or comment means the
 * scanner has no reliable view of what follows it (`spans.ts` reports the run as
 * reaching the end of the input), and a guard that guesses there is a guard that can
 * be walked past.
 */
export function assertReadOnlyStatementIsBounded(sql: string): void {
  const grammar = resolveSqlGrammar("duckdb");

  if (hasUnterminatedSpan(sql, grammar)) {
    throw new QueryError(
      "Read-only execution refused a statement with an unterminated string or comment: it cannot be read reliably, and this boundary does not guess",
      "duckdb",
      sql,
    );
  }

  for (const { word, reason } of READ_ONLY_FORBIDDEN_WORDS) {
    if (findCodeWord(sql, word, 0, grammar) !== null) {
      throw new QueryError(
        `Read-only execution refused ${word}: ${reason}. DuckDB's read-only access mode governs this database only, not the filesystem around it, which is why this profile also opens the handle with external access disabled.`,
        "duckdb",
        sql,
      );
    }
  }
}

// ============================================================================
// DuckDB Provider
// ============================================================================

export class DuckDBProvider extends SQLBaseProvider {
  private client: DuckDBClient | null = null;

  /** True when this instance was opened under the agent read-only profile. */
  private readonly readOnlyProfile: boolean;

  /**
   * Client-supplied query tokens currently in flight, so `cancelQuery` can tell "I
   * never started that" from "I interrupted it". DuckDB holds one connection, so the
   * set is at most one deep in practice; it is a set rather than a field so a
   * cancellation for a token that already finished answers false instead of
   * interrupting whatever started next.
   */
  private readonly runningQueryIds = new Set<string>();

  constructor(config: DatabaseConnection, options: ProviderOptions = {}, execution: ProviderExecutionContext = {}) {
    super(config, options);
    // Server-injected only (see ProviderExecutionContext): the shared editor path
    // builds providers from caller-supplied ProviderOptions, which has no route to
    // this flag in either direction.
    this.readOnlyProfile = execution.readOnly === true;
    this.validate();
  }

  // ==========================================================================
  // Provider metadata
  // ==========================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      // Embedded: there is nothing to connect to over a network.
      defaultPort: null,
      supportsConnectionString: false,
      supportsExplain: true,
      explainFormat: "duckdb-json",
      supportsInlineRowEdit: true,
      // DuckDB HAS transactions - `BEGIN`/`COMMIT` are accepted - but this provider
      // holds no session for one, so POST /api/db/transaction refuses the call and the
      // controls stay hidden. Same position as sqlite.ts.
      supportsTransactions: false,
      // The file admits ONE operating-system process, measured in read-only mode too,
      // so a second Studio handle on it is not a lesser handle - it is no handle at
      // all. See `findOpenSingleWriterProvider` (BACKLOG D3, B49).
      singleWriterFile: true,
      // Declared explicitly rather than left to `query-generators.ts`'s port
      // heuristics: `defaultPort: null` is shared with sqlite, and two engines behind
      // one null port is the collision that forced this field for the search engines.
      identifierQuoting: "double",
      // Only what a live probe accepted. `REINDEX` is a parser error on this engine,
      // and `PRAGMA integrity_check` and `PRAGMA optimize` are both "Pragma Function
      // with name ... does not exist!", so `reindex`, `check` and `kill` are not
      // offered at all rather than offered and failed.
      maintenanceOperations: ["vacuum", "analyze", "optimize"],
      // Every declared operation gets a spec, and each placement comes from the probe
      // rather than from the operation's name (#U9): `VACUUM` and `ANALYZE` accept a
      // bare table AND run over everything without one, while `CHECKPOINT` takes no
      // object at all - a per-table control for it would name a table and act on the
      // database.
      maintenanceOperationSpecs: {
        vacuum: { label: "Vacuum Table", perEntity: true, global: true },
        analyze: { label: "Analyze Table", perEntity: true, global: true },
        optimize: { label: "Checkpoint Database", perEntity: false, global: true },
      },
    };
  }

  /**
   * The two empty states and the wording for `optimize`, which on this engine is
   * a checkpoint rather than anything an operator would call optimization.
   *
   * `getSlowQueries()` answers `[]` unconditionally, so the monitoring Queries panel is
   * ALWAYS empty here - and the default sentence tells the reader to install a
   * PostgreSQL extension (#U12). `getActiveSessions()` is the same shape for the same
   * reason: measured on DuckDB v1.5.5, `duckdb_connections()` answers
   * `Catalog Error: Table Function with name duckdb_connections does not exist!`, so the
   * default "No active sessions found." would read as "nothing is running right now" on a
   * panel that can never show a row (#D48).
   */
  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      slowQueriesEmptyState:
        "DuckDB keeps no store of finished statements - it publishes no duckdb_queries() table function - so there is nothing to enable.",
      sessionsEmptyState:
        "DuckDB publishes no session list - there is no duckdb_connections() table function - so this panel can never show a row.",
      vacuumGlobalDesc:
        "Runs bare VACUUM over the whole database. DuckDB reclaims space at checkpoint time, so this is a no-op on a database that has just been checkpointed.",
    };
  }

  // ==========================================================================
  // Validation
  // ==========================================================================

  public validate(): void {
    super.validate();

    if (!this.config.database) {
      throw new DatabaseConfigError(
        'Database file path is required for DuckDB (use the "database" field, or ":memory:" for an in-memory database)',
        "duckdb",
      );
    }
  }

  // ==========================================================================
  // Connection management
  // ==========================================================================

  /**
   * The resolved target: `:memory:` verbatim, or an absolute filesystem path.
   *
   * Deliberately reads `config.database` and NOTHING else. `factory.ts`'s
   * `fileIdentity` - which is what matches this connection against an already-open
   * single-writer handle - computes `path.resolve(connection.database)` from the
   * connection record, so any second source here (a `connectionString`, an
   * environment default) would resolve to a path the factory never looks at and the
   * borrow would silently stop matching. DuckDB declares
   * `supportsConnectionString: false`, so there is no second source to reconcile.
   *
   * `..` segments are accepted by design: these are trusted server-side paths, the
   * same position `docs/providers/sqlite.md` records. A NUL byte is not a path at all
   * and is refused. DuckDB's own extra spellings - `md:` for MotherDuck, `s3://`,
   * `:memory:named` - are NOT handled: this provider is local files only, and each of
   * those would resolve here into a relative filesystem path, which is a worse answer
   * than none.
   */
  private getDatabasePath(): string {
    const configured = this.config.database ?? MEMORY_TARGET;

    if (configured === MEMORY_TARGET) return MEMORY_TARGET;

    if (configured.includes("\0")) {
      throw new DatabaseConfigError("Invalid database path: NUL bytes are not allowed", "duckdb");
    }

    return path.resolve(configured);
  }

  public async connect(): Promise<void> {
    if (this.client) return;

    try {
      const dbPath = this.getDatabasePath();

      if (this.readOnlyProfile) {
        this.client = await this.connectReadOnly(dbPath);
        this.setConnected(true);
        return;
      }

      if (dbPath !== MEMORY_TARGET) {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      }

      this.client = await openDuckDBClient(dbPath, { readOnly: false });
      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      // Typed refusals keep their own identity: wrapping them would strip the config
      // diagnosis, the profile's deny reason code, or the lock holder's PID.
      throw mapDuckDBError(error);
    }
  }

  /**
   * Open the agent read-only handle.
   *
   * No directory is created and no file is: a read-only open of a missing database is
   * refused by the engine itself ("Cannot open database ... in read-only mode: database
   * does not exist"), which is precisely the property that makes this handle safe, and
   * `client.ts` turns that sentence into an actionable one.
   *
   * An in-memory target is refused outright. A read-only open of `:memory:` yields a
   * fresh, empty, anonymous database - there is nothing in it to read - so vending it
   * would hand the agent a silently useless target rather than an error.
   */
  private async connectReadOnly(dbPath: string): Promise<DuckDBClient> {
    if (dbPath === MEMORY_TARGET) {
      throw new ExecutionProfileError(
        "The agent read-only execution profile cannot target an in-memory DuckDB database: a read-only handle on :memory: opens an empty database with nothing to read",
        "PROFILE_UNSUPPORTED_TARGET",
      );
    }

    return openDuckDBClient(dbPath, { readOnly: true });
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      this.client.close();
      this.client = null;
      this.runningQueryIds.clear();
      this.setConnected(false);
    }
  }

  // ==========================================================================
  // Query execution
  // ==========================================================================

  /**
   * The statement's leading keyword as DuckDB reads it, or `undefined` when the text
   * opens with something that is not one. Only used to tell a write acknowledgement
   * from a projection - see `values.ts`.
   */
  private leadingKeyword(sql: string): string | undefined {
    return readLeadingKeyword(sql, resolveSqlGrammar("duckdb"))?.keyword;
  }

  public async query(sql: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      if (queryId) this.runningQueryIds.add(queryId);
      try {
        const { result, executionTime } = await this.measureExecution(async () => {
          try {
            return await this.client!.run(sql, params);
          } catch (error) {
            throw mapDuckDBError(error, sql);
          }
        });

        return toQueryResult(result, executionTime, this.leadingKeyword(sql));
      } finally {
        if (queryId) this.runningQueryIds.delete(queryId);
      }
    });
  }

  /**
   * Stop the statement this connection is running, named by the CLIENT's token.
   *
   * `false` means nothing was recorded under this token, so there is nothing here to
   * cancel. `true` means the interrupt was delivered - measured, it stops a running
   * scan with "INTERRUPT Error: Interrupted!" and leaves the connection usable for the
   * next statement.
   *
   * A failure is swallowed to `false` rather than thrown, matching `postgres.ts` and
   * `trino/index.ts`: this is called from a UI affordance whose whole purpose is to
   * stop something, and an error dialog on top of a query that is still running helps
   * nobody.
   */
  public async cancelQuery(queryId: string): Promise<boolean> {
    if (!this.runningQueryIds.has(queryId) || this.client === null) return false;

    try {
      this.client.interrupt();
      return true;
    } catch (error) {
      this.logError("cancelQuery", error);
      return false;
    }
  }

  /**
   * Execute exactly one statement under BOTH read-only controls (#328).
   *
   * The order is fixed and each step is load-bearing:
   *
   * 1. `assertReadOnlyBudget` - the shared fail-closed budget check, identical on every
   *    provider that implements this method.
   * 2. The profile check - a writable handle has no boundary to enforce, so running the
   *    statement there would be exactly the fail-open this layer exists to prevent.
   * 3. `assertReadOnlyStatementIsBounded` - the statement guard, BEFORE the engine, for
   *    the forms `access_mode` does not refuse. This is the one step with no equivalent
   *    in `sqlite.ts`, where `PRAGMA query_only` covers the same ground engine-side;
   *    DuckDB has no such pragma, so the boundary has to be drawn here.
   * 4. The engine, which owns "no writes to this database" and is re-asserted by
   *    construction rather than per statement: `access_mode` is fixed at OPEN and no
   *    statement can change it (unlike `PRAGMA query_only`, which is why sqlite
   *    re-asserts).
   * 5. The result budgets - rows, then bytes, then time.
   *
   * `client.run()` issues ONE `runAndReadAll`, which executes only the FIRST statement
   * of a multi-statement string (measured: `"SELECT 1 AS a; SELECT 2 AS b"` answers
   * `[{"a":1}]`). Rejecting multi-statement input is the policy pipeline's job; this
   * method guarantees the tail is never executed - and the guard above reads the whole
   * string anyway, so a forbidden form hiding in that tail is still refused.
   */
  public async queryReadOnly(sql: string, budget: ReadOnlyStatementBudget): Promise<QueryResult> {
    this.ensureConnected();
    assertReadOnlyBudget(budget, "duckdb");
    if (!this.readOnlyProfile) {
      throw new QueryError(
        "Read-only execution requires a provider opened under the agent read-only profile",
        "duckdb",
        sql,
      );
    }
    assertReadOnlyStatementIsBounded(sql);

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          return await this.client!.run(sql);
        } catch (error) {
          throw mapDuckDBError(error, sql);
        }
      });

      if (result.rows.length > budget.maxResultRows) {
        throw new QueryError(
          `Read-only execution exceeded the row budget: ${result.rows.length} rows > ${budget.maxResultRows} allowed`,
          "duckdb",
          sql,
        );
      }
      const resultBytes = measureResultBytes(result.rows);
      if (resultBytes > budget.maxResultBytes) {
        throw new QueryError(
          `Read-only execution exceeded the byte budget: ${resultBytes} bytes > ${budget.maxResultBytes} allowed`,
          "duckdb",
          sql,
        );
      }
      // DuckDB has no statement-level timeout setting, so the budget's timeout is a
      // post-execution deadline here: an overrunning statement is not preempted, but its
      // result is refused rather than returned as if it had been within budget. The
      // engine CAN be interrupted (`cancelQuery`), and wiring the deadline to that is
      // recorded as follow-up work in `docs/providers/duckdb.md` rather than claimed.
      if (executionTime > budget.statementTimeoutMs) {
        throw new QueryError(
          `Read-only execution exceeded the time budget: ${executionTime}ms > ${budget.statementTimeoutMs}ms allowed`,
          "duckdb",
          sql,
        );
      }

      return toQueryResult(result, executionTime, this.leadingKeyword(sql));
    });
  }

  // ==========================================================================
  // Schema
  // ==========================================================================

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();
    return readSchema(this.client!);
  }

  // ==========================================================================
  // Health & monitoring
  // ==========================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();
    return readHealth(this.client!);
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();
    return readOverview(this.client!);
  }

  /**
   * Only what DuckDB can actually be asked, which is nothing.
   *
   * There is no cache hit ratio (`duckdb_memory()` reports bytes held per subsystem and
   * no hit or miss counter), no statement counter and no server-side buffer pool whose
   * usage could be read, so every field is omitted and the monitoring tabs show "Not
   * measured" for each. A fabricated `0` cacheHitRatio renders as a red critical fault
   * on a perfectly healthy database.
   *
   * `deadlocks` is omitted too, and that is the one worth stating. On SQLite it is a
   * true `0` - the engine serializes writers and has no lock-wait graph. DuckDB DOES
   * have transactions with optimistic concurrency, and it reports the conflict as a
   * TransactionContext error rather than counting it anywhere, so a `0` here would be a
   * reading nobody took rather than a fact about the engine.
   */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    return {};
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    return readSlowQueries();
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    return readActiveSessions();
  }

  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();
    return readTableStats(this.client!);
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();
    return readIndexStats(this.client!);
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();
    return readStorageStats(this.client!);
  }

  // ==========================================================================
  // Maintenance
  // ==========================================================================

  /**
   * A maintenance target as a schema-qualified, quoted identifier. A bare name is
   * resolved into `main`, DuckDB's default schema; `schema.table` is quoted part by
   * part. Mirrors `postgres.ts`'s `qualifyMaintenanceTarget`.
   */
  private qualifyMaintenanceTarget(target: string): string {
    if (target.includes(".")) {
      return target
        .split(".")
        .map((part) => this.escapeIdentifier(part))
        .join(".");
    }
    return `${this.escapeIdentifier(DEFAULT_SCHEMA)}.${this.escapeIdentifier(target)}`;
  }

  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      const qualified = target ? this.qualifyMaintenanceTarget(target) : "";
      let sql = "";

      switch (type) {
        case "vacuum":
          sql = target ? `VACUUM ${qualified}` : "VACUUM";
          break;
        case "analyze":
          sql = target ? `ANALYZE ${qualified}` : "ANALYZE";
          break;
        case "optimize":
          // DuckDB's `optimize` is CHECKPOINT: it flushes the write-ahead log into the
          // database file and is the operation that actually reclaims space here. It
          // takes no object, which is why its spec declares `perEntity: false` - a
          // target reaching this branch would be silently ignored, so it is refused
          // instead.
          if (target) {
            throw new QueryError(
              `DuckDB's ${type} operation is CHECKPOINT, which runs over the whole database and takes no target`,
              "duckdb",
            );
          }
          sql = "CHECKPOINT";
          break;
      }

      // Unsupported types fall through the switch with sql left empty. A `default:`
      // label is deliberately avoided here: bun's coverage emits a 0-hit line record
      // for `default:` that no runtime execution ever credits, which permanently
      // poisons the merged lcov report.
      if (!sql) {
        throw new QueryError(
          `DuckDB does not support the ${type} maintenance operation: REINDEX is a parser error on this engine, and PRAGMA integrity_check and PRAGMA optimize do not exist`,
          "duckdb",
        );
      }

      try {
        await this.client!.run(sql);
      } catch (error) {
        throw mapDuckDBError(error, sql);
      }
      return { success: true, message: `${type.toUpperCase()} completed successfully` };
    });

    return { success: result.success, executionTime, message: result.message };
  }
}
