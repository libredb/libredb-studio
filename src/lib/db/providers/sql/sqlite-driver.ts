/**
 * SQLite driver adapter for the SQLite DB provider.
 *
 * Selects the embedded SQLite driver by runtime so sqlite connections work
 * both under Bun (standalone dev, Docker image) and under plain Node
 * (npx / brew / deb installs running `node server.js`):
 *
 * - Bun runtime  -> `bun:sqlite` (Bun built-in)
 * - Node runtime -> `node:sqlite` (Node built-in: unflagged from 22.13,
 *   stable on the recommended Node 24 LTS; `better-sqlite3` is not used here
 *   because Bun refuses to load it at all and its native binding must match
 *   the installing runtime's ABI, while `node:sqlite` needs no native
 *   dependency)
 *
 * Set LIBREDB_SQLITE_DRIVER=bun|node to force a driver (deterministic tests).
 * Both drivers load lazily via dynamic import, so neither is required unless
 * a sqlite connection is actually used. This module is internal to the SQLite
 * provider — other code must not depend on it.
 */

import { DatabaseConfigError } from "../../errors";

/**
 * One result column's name and the type it was DECLARED with — `undefined` where SQLite
 * declared none.
 *
 * A PAIR rather than a map, because that is exactly what `declaredColumnTypes()` in
 * `column-types.ts` already consumes from the four other drivers that answer this
 * question, duplicate column names and all: `SELECT 1 AS c, name AS c` really does
 * declare two columns called `c`, the row object keeps the last one, and the shared
 * helper is where last-wins is decided.
 */
export type SQLiteDeclaredColumn = readonly [name: string, declaredType: string | undefined];

// The exact driver surface the SQLite provider uses (bun:sqlite-shaped).
export type SQLiteStatement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number };
  /**
   * What the schema DECLARED each result column to be (`sqlite3_column_decltype`), in
   * column order. Both drivers publish it and spell it differently — bun:sqlite
   * `columnNames` beside `declaredTypes`, node:sqlite one `columns()` answering both — so
   * the two are bridged here, exactly as `inTransaction` and the big-integer flag are.
   *
   * CALL IT AFTER THE ROWS. Measured 2026-09-18 on bun:sqlite (Bun 1.4.0) and node:sqlite
   * (Node 24.14.0): bun THROWS "Statement must be executed before accessing declaredTypes"
   * until the statement has run, while node answers either way — so after the rows is the
   * one order both drivers accept. A statement that matched NO rows still answers
   * (`SELECT id, r FROM t WHERE id = -1` → `INTEGER`, `REAL`), so an empty result is
   * described rather than guessed at, and a write answers an EMPTY list on both.
   *
   * `undefined` is an ordinary answer and not a failure: an expression, a literal, an
   * aggregate, a function call, every PRAGMA column and a column declared with no type at
   * all have no declaration for SQLite to report, and both drivers say so with `null`.
   *
   * NOT bun:sqlite's `columnTypes`, which is a different question wearing a similar name.
   * Measured the same day: it reports the RUNTIME storage class of the row just read — a
   * `REAL` column answers `FLOAT`, an undeclared column answers whatever that row happens
   * to hold — and it throws outright on anything that is not a read-only statement,
   * `PRAGMA journal_mode` included. Reading it here would have typed every float column
   * wrong and broken every PRAGMA the provider runs.
   */
  declaredColumns(): readonly SQLiteDeclaredColumn[];
};

export type SQLiteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  /**
   * Close the handle. `throwOnError: true` means "release the file NOW", and the
   * provider always asks for it.
   *
   * Measured 2026-09-15 on bun:sqlite (Bun 1.4.2), through /proc/self/fd: bare
   * `close()` is `sqlite3_close_v2`, so a connection with any statement still
   * unfinalized becomes a zombie and the database, its `-wal` and its `-shm` stay
   * OPEN until the last statement is finalized or garbage collected. The provider
   * prepares a statement per query and drops the reference, so that is whenever the
   * collector gets to it. `close(true)` finalizes them and closes for real, and
   * raises if SQLite cannot.
   *
   * POSIX hides the difference, because it unlinks a file that is still open;
   * Windows does not, and a deferred close is a database the user cannot delete or
   * move (and, on windows-latest, a test temp directory whose teardown fails with
   * EBUSY). node:sqlite needs no flag - measured on Node 24.14.0, its `close()`
   * finalizes the statements it tracks and releases every descriptor - so the node
   * adapter below declares no parameter at all.
   */
  close(throwOnError?: boolean): void;
  /**
   * Whether this handle currently has a transaction open, as SQLite itself reports it
   * (`sqlite3_get_autocommit`), in the bun:sqlite spelling. Both drivers publish it and
   * spell it differently — bun:sqlite `inTransaction`, node:sqlite `isTransaction` — so
   * the node adapter below translates, exactly as it does for the read-only flag.
   *
   * Measured 2026-09-13 on bun:sqlite (Bun 1.4.2) and node:sqlite (Node 24.14.0): false
   * on a fresh handle, true after `BEGIN`, false again after `ROLLBACK`.
   */
  readonly inTransaction: boolean;
};

/**
 * Open options in the bun:sqlite spelling (this surface is bun-shaped; the
 * node adapter below translates). `readonly` opens the database under SQLite's
 * own read-only enforcement — writes are refused by the engine and a missing
 * file is NOT created — which is the SQLite half of the agent execution
 * profile (#328).
 */
export type SQLiteOpenOptions = { create?: boolean; readwrite?: boolean; readonly?: boolean };

export type SQLiteConstructor = new (path: string, options?: SQLiteOpenOptions) => SQLiteDatabase;

export type SQLiteDriverName = "bun" | "node";

// ============================================================================
// Big integers at the provider boundary (#39)
// ============================================================================

/**
 * SQLite stores INTEGER as a signed 64-bit value, so an id past 2^53 does not
 * survive a JavaScript `number`. Measured 2026-09-18, reading 9007199254740993
 * back through this provider with each driver's defaults:
 *
 * - bun:sqlite (what the Docker image runs) silently answers 9007199254740992 -
 *   the row NEXT to the one that was asked for. The inline editor then builds its
 *   UPDATE ... WHERE id = <that key> and edits the neighbouring row.
 * - node:sqlite (npx / brew / deb installs) throws ERR_OUT_OF_RANGE instead:
 *   loud, and no wrong write.
 *
 * Both drivers can hand back every integer as a BigInt instead, and each spells
 * the flag its own way - bun `safeIntegers`, node `readBigInts`. The flag alone is
 * not a fix, because it is all-or-nothing: `1`, `COUNT(*)` and every PRAGMA
 * column become BigInt too, rows are serialized to the browser with
 * JSON.stringify, and JSON.stringify refuses BigInt outright ("cannot serialize
 * BigInt") - measured, that alone turns 180 passing SQLite tests into 149 passing
 * and 31 failing, 16 of them connections that will not even open.
 *
 * So the flag is turned on for BOTH drivers and the BigInt is converted back
 * HERE, at the one seam every row crosses:
 *
 * - a value that fits a JavaScript number exactly comes back AS a number, so `1`
 *   stays `1`, COUNT(*) stays a number and PRAGMA columns are unchanged;
 * - a value that does not fit comes back as its decimal STRING, every digit kept.
 *
 * That is exactly what `supportBigNumbers` already does on the MySQL side, so the
 * two providers now answer the same shape. Nothing outside this module ever sees
 * a BigInt.
 */
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/** One 64-bit integer, as a number when that is lossless and as digits when it is not. */
export function normalizeSQLiteBigInt(value: bigint): number | string {
  return value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT ? Number(value) : value.toString();
}

/**
 * Sending one back (#42)
 * ----------------------
 * The conversion above is lossy in ONE direction that matters: `9007199254740993`
 * the integer and `'9007199254740993'` the text both leave this provider as the same
 * JavaScript string, so a value coming back in a bind carries no clue which it was.
 * SQLite settles it by the COLUMN's affinity, and only for a column that HAS one:
 * measured 2026-09-18 on bun:sqlite (Bun 1.4.0) and node:sqlite (Node 24), against a
 * row whose key is 9007199254740993 -
 *
 *   column declared   | bound as text | bound as a 64-bit integer
 *   INTEGER / NUMERIC |       matches |                   matches
 *   TEXT              |       matches |                   matches
 *   BLOB / undeclared |   NO MATCH    |                   matches
 *
 * INTEGER and NUMERIC affinity convert the text to a number before comparing, and
 * TEXT affinity converts the integer to text, so those three columns answer the same
 * either way. A column declared BLOB or declared NOTHING has NO affinity: SQLite
 * compares the operands as they stand, a text is never equal to an integer, and the
 * row the grid just read cannot be found again - `UPDATE ... WHERE id = ?` reports 0
 * rows changed and the editor tells the user nothing happened.
 *
 * The affinity is not knowable here - a bind is a value, with no column attached, and
 * neither driver exposes which column an operand belongs to - so the seam answers the
 * question it CAN answer exactly: it accepts back precisely what it handed out.
 * `normalizeSQLiteBigInt` emits these digits for one input only, a 64-bit integer
 * outside the safe range, so reading them back as that integer is its exact inverse
 * and every other string is left alone:
 *
 * - inside the safe range (`'1'`, `'9007199254740991'`) the read hands out a NUMBER,
 *   never digits, so such a string is the caller's own text;
 * - `'007'`, `'+7'`, `''`, `' 7'`, `'7.0'` are not shapes it can emit at all;
 * - wider than 64 bits (`'99999999999999999999'`) is not a value SQLite's INTEGER can
 *   hold, so no row could match it as a number either.
 *
 * What that costs, measured and accepted: in a column with NO affinity that genuinely
 * stores this shape as TEXT, the bind now misses where it used to match. That is the
 * same ambiguity read from the other end, it cannot be resolved without the affinity,
 * and the integer reading is the one these digits exist for. A TEXT-declared column is
 * NOT affected - TEXT affinity converts the bind back to text - so an ordinary textual
 * key still matches as text. Every string function agrees on both forms as well
 * (measured: `length`, `substr`, `||`, `LIKE`, `lower`, `printf`, `CAST(? AS TEXT)`);
 * `typeof(?)` and `quote(?)` are the ones that can tell, and they are asking which
 * storage class it is, which is the question this conversion answers.
 */

/** SQLite's own INTEGER: signed 64-bit, and nothing wider can be stored in a row. */
const MAX_INT64_BIGINT = BigInt("9223372036854775807");
const MIN_INT64_BIGINT = BigInt("-9223372036854775808");

/**
 * The exact shape `normalizeSQLiteBigInt` prints: an optional minus, a non-zero first
 * digit, at most 19 digits in all (INT64's own width). Leading zeros, a leading `+`,
 * surrounding space, a decimal point and the empty string all fall outside it.
 */
const SQLITE_INT64_DIGITS = /^-?[1-9][0-9]{0,18}$/;

/** One bound parameter, with the digits of a 64-bit integer read back as that integer. */
export function toSQLiteBindValue(param: unknown): unknown {
  if (typeof param !== "string" || !SQLITE_INT64_DIGITS.test(param)) {
    return param;
  }
  const parsed = BigInt(param);
  if (parsed >= MIN_SAFE_BIGINT && parsed <= MAX_SAFE_BIGINT) {
    return param;
  }
  if (parsed < MIN_INT64_BIGINT || parsed > MAX_INT64_BIGINT) {
    return param;
  }
  return parsed;
}

/**
 * Every parameter of one call. Positional only, which is the one shape this provider
 * binds (`query(sql, params: unknown[])`); a named-parameter OBJECT passes through
 * untouched rather than being walked, so it keeps the behaviour it has today.
 */
function toSQLiteBindValues(params: unknown[]): unknown[] {
  return params.map(toSQLiteBindValue);
}

/**
 * Convert the BigInt cells of one returned record, in place.
 *
 * In place on purpose: node:sqlite returns null-prototype row objects and
 * bun:sqlite returns its own row objects, and rebuilding them would change what
 * every existing caller receives. Only the BigInt cells change. A BLOB column is
 * a typed array, never a row, and is left alone rather than walked byte by byte.
 */
function normalizeRecordInPlace(record: unknown): unknown {
  if (record === null || record === undefined) {
    return record;
  }
  if (typeof record === "bigint") {
    return normalizeSQLiteBigInt(record);
  }
  if (typeof record !== "object" || ArrayBuffer.isView(record)) {
    return record;
  }
  const row = record as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (typeof value === "bigint") {
      row[key] = normalizeSQLiteBigInt(value);
    }
  }
  return record;
}

/**
 * A driver's OWN statement: the three row methods, before the bridge below adds the
 * declarations. Neither driver publishes `declaredColumns` — it is this module's name for
 * a question each of them answers its own way.
 */
type RawSQLiteStatement = Omit<SQLiteStatement, "declaredColumns">;

/**
 * Wrap one prepared statement so every row it returns, and every parameter it is given,
 * crosses the conversions above.
 *
 * Both driver adapters below route `prepare()` through this, which is what makes the
 * coverage argument checkable: the provider reaches the database ONLY through
 * `SQLiteDatabase`, whose sole row-returning entry point is `prepare()` (`exec()`
 * returns nothing). The wrapper republishes exactly the three methods of
 * `SQLiteStatement` and hands back none of the raw driver statement, so a plain
 * query, a prepared statement, a statement inside a transaction and every schema /
 * PRAGMA read go through it alike, and a future row-returning driver method cannot
 * quietly bypass it. The parameters travel the same three methods, so the two
 * directions are inverses at ONE seam rather than at two that can drift apart.
 *
 * `declaredColumns` is handed in rather than read off `stmt`, because it is the one part
 * of the surface the two drivers do not already spell the same way; each adapter below
 * passes its own spelling and both come out of here as one method on one object. Keeping
 * it on the SAME object as the rows is what makes "after the rows" checkable: a caller
 * holds the statement that produced them and asks it, rather than holding a second handle
 * whose order nothing constrains.
 */
function withoutBigInts(
  stmt: RawSQLiteStatement,
  declaredColumns: SQLiteStatement["declaredColumns"],
): SQLiteStatement {
  return {
    declaredColumns,
    all: (...params: unknown[]): unknown[] => {
      const rows = stmt.all(...toSQLiteBindValues(params));
      for (const row of rows) {
        normalizeRecordInPlace(row);
      }
      return rows;
    },
    get: (...params: unknown[]): unknown => normalizeRecordInPlace(stmt.get(...toSQLiteBindValues(params))),
    run: (...params: unknown[]): { changes: number } => {
      // `changes` is a row count and always fits; `lastInsertRowid` (bun publishes it)
      // is a rowid and does not have to, so the whole result goes through the same
      // conversion before anything reads it.
      const info = normalizeRecordInPlace(stmt.run(...toSQLiteBindValues(params))) as Record<string, unknown> & {
        changes: number | bigint;
      };
      return { ...info, changes: Number(info.changes) };
    },
  };
}

/**
 * bun:sqlite's own open options: the flags the provider passes, plus `safeIntegers`
 * - bun's spelling of "read 64-bit integers without rounding them". node:sqlite
 * spells the same request `readBigInts`; the two are bridged here and in
 * `createNodeSQLiteDriver` below, so the provider keeps passing one set of flags
 * and no new option reaches any shared surface.
 */
export type BunSQLiteOpenOptions = SQLiteOpenOptions & { safeIntegers?: boolean };

/**
 * Minimal structural view of bun:sqlite's own Statement and Database, kept local for the
 * reason `NodeDatabaseSyncLike` below is: the adapter then says exactly which of the
 * driver's members it uses, and a stand-in can satisfy that and nothing more.
 *
 * `columnNames` and `declaredTypes` are bun's two halves of the answer node:sqlite gives
 * in one `columns()` call, and the only reason this type exists at all - the rest of the
 * surface was already bun-shaped.
 */
type BunStatementLike = RawSQLiteStatement & {
  readonly columnNames: string[];
  readonly declaredTypes: (string | null)[];
};
export type BunDatabaseLike = Omit<SQLiteDatabase, "prepare"> & { prepare(sql: string): BunStatementLike };
export type BunSQLiteConstructor = new (path: string, options?: BunSQLiteOpenOptions) => BunDatabaseLike;

/**
 * Adapt bun:sqlite's Database: open it with `safeIntegers`, and convert what the
 * flag produces back at `prepare()`. Exported with an injectable constructor for
 * the same reason `createNodeSQLiteDriver` is - the semantics are then unit-testable
 * against a stand-in on any runtime.
 */
export function createBunSQLiteDriver(DatabaseCtor: BunSQLiteConstructor): SQLiteConstructor {
  class BunSQLiteDatabase implements SQLiteDatabase {
    private readonly db: BunDatabaseLike;

    constructor(dbPath: string, options?: SQLiteOpenOptions) {
      this.db = new DatabaseCtor(dbPath, { ...options, safeIntegers: true });
    }

    exec(sql: string): void {
      this.db.exec(sql);
    }

    prepare(sql: string): SQLiteStatement {
      const stmt = this.db.prepare(sql);
      // Read lazily, never here: bun refuses `declaredTypes` until the statement has run
      // (measured - see `SQLiteStatement.declaredColumns`), so reading it at `prepare()`
      // would throw on every query the provider makes.
      return withoutBigInts(stmt, () =>
        stmt.columnNames.map((name, index) => [name, stmt.declaredTypes[index] ?? undefined] as const),
      );
    }

    close(throwOnError?: boolean): void {
      this.db.close(throwOnError);
    }

    get inTransaction(): boolean {
      return this.db.inTransaction;
    }
  }

  return BunSQLiteDatabase;
}

// Minimal structural view of node:sqlite (kept local so the adapter and its
// tests never need the real module, which Bun does not implement).
type NodeStatementLike = {
  all(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
  /**
   * node:sqlite's spelling of bun:sqlite's `columnNames` + `declaredTypes`: one call
   * answering both, with `type` null where the column was declared with none. It carries
   * `column`, `database` and `table` as well; the bridge reads neither, because the name
   * the ROW object uses is `name` (the alias, where there is one).
   */
  columns(): { name: string; type: string | null }[];
};
export type NodeDatabaseSyncLike = {
  exec(sql: string): void;
  prepare(sql: string): NodeStatementLike;
  close(): void;
  /** node:sqlite's spelling of bun:sqlite's `inTransaction`. */
  readonly isTransaction: boolean;
};
/** node:sqlite's own open options — only the ones this adapter maps. */
export type NodeSQLiteOpenOptions = { readOnly?: boolean; readBigInts?: boolean };
export type NodeSQLiteModule = {
  DatabaseSync: new (path: string, options?: NodeSQLiteOpenOptions) => NodeDatabaseSyncLike;
};

const loadedDrivers = new Map<SQLiteDriverName, SQLiteConstructor>();
const driverLoadErrors = new Map<SQLiteDriverName, Error>();

/**
 * Resolve which driver to use: the LIBREDB_SQLITE_DRIVER override wins,
 * otherwise pick by the current runtime.
 */
export function resolveSQLiteDriverName(): SQLiteDriverName {
  const override = process.env.LIBREDB_SQLITE_DRIVER;
  if (override === "bun" || override === "node") {
    return override;
  }
  return typeof Bun === "undefined" ? "node" : "bun";
}

async function loadBunDriver(): Promise<SQLiteConstructor> {
  // The ignore comments keep the bundler's hands off this import: Turbopack
  // would otherwise emit an externals chunk FILE named after the specifier
  // ("[externals]_bun:sqlite_<hash>._.js"), and the colon makes that name
  // unwritable on NTFS - the win32 standalone build fails (issue #114).
  // At runtime nothing changes: Bun resolves its builtin natively, and this
  // branch is only ever taken under the Bun runtime.
  const sqlite = await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "bun:sqlite");
  return createBunSQLiteDriver(sqlite.Database as unknown as BunSQLiteConstructor);
}

/**
 * Adapts node:sqlite's DatabaseSync to the bun:sqlite-shaped surface above.
 * The two APIs are nearly identical (synchronous exec/prepare/all/get/run);
 * the bridges below keep behaviour byte-compatible with bun:sqlite:
 * - node:sqlite opens read-write and creates missing files by default,
 *   matching the `{ create: true, readwrite: true }` options the provider
 *   passes to bun:sqlite, so those two flags need no translation. The
 *   read-only flag DOES: node spells it `readOnly`, bun spells it `readonly`,
 *   and an adapter that dropped it would silently hand an agent execution
 *   profile a fully writable database handle (#328).
 * - `inTransaction` is node:sqlite's `isTransaction` under bun:sqlite's name. The
 *   provider reads it to tell whether a statement left a transaction open on the handle
 *   (D71), and a handle whose answer never changed would report every script as clean.
 * - `close(throwOnError)` is bun's spelling of "release the file now". node:sqlite has
 *   no such flag and needs none, so this is the one delta with nothing to bridge; see
 *   the measurement on `SQLiteDatabase.close` above.
 * - the big-integer flag is `readBigInts` here and `safeIntegers` on bun:sqlite; both
 *   adapters set their own spelling and both send `prepare()` through the same
 *   conversion, so the two drivers answer a 64-bit id identically (#39).
 * - the DECLARED column types are `columns()[].name`/`.type` here and `columnNames` +
 *   `declaredTypes` on bun:sqlite; both adapters hand their own spelling to
 *   `withoutBigInts`, which republishes one `declaredColumns()` (#273). A handle that
 *   dropped it would leave the result carrying no types at all, which is the state this
 *   provider was in: the SQL export then names a column by the JavaScript type of its
 *   value, and the inline editor has nothing to read a key's width from.
 * - `get()` returns `undefined` on a miss where bun:sqlite returns `null`.
 * - `run()` reports `changes` as `number | bigint`; normalize to `number`.
 *
 * Exported (with the injectable ctor) so the adapter semantics are unit-testable
 * in-process against a stand-in, on any runtime, rather than only where node:sqlite
 * happens to resolve - Bun could not import it before 1.4.0.
 */
export function createNodeSQLiteDriver(DatabaseSyncCtor: NodeSQLiteModule["DatabaseSync"]): SQLiteConstructor {
  class NodeSQLiteDatabase implements SQLiteDatabase {
    private readonly db: NodeDatabaseSyncLike;

    constructor(dbPath: string, options?: SQLiteOpenOptions) {
      this.db = new DatabaseSyncCtor(dbPath, { readOnly: options?.readonly === true, readBigInts: true });
    }

    exec(sql: string): void {
      this.db.exec(sql);
    }

    prepare(sql: string): SQLiteStatement {
      const stmt = this.db.prepare(sql);
      return withoutBigInts(
        {
          all: (...params: unknown[]): unknown[] => stmt.all(...params) as unknown[],
          get: (...params: unknown[]): unknown => stmt.get(...params) ?? null,
          run: (...params: unknown[]): { changes: number } => {
            const info = stmt.run(...params);
            return { changes: Number(info.changes) };
          },
        },
        // node answers this before the statement has run as readily as after it, so the
        // "after the rows" rule the bun half needs costs this half nothing.
        () => stmt.columns().map((column) => [column.name, column.type ?? undefined] as const),
      );
    }

    // Takes no `throwOnError`, and needs none: node:sqlite's own close already finalizes
    // the statements it tracks and releases every descriptor (measured on Node 24.14.0),
    // which is exactly what the flag asks bun:sqlite for. A method that declares fewer
    // parameters still satisfies the surface, so `close(true)` reaches here unchanged.
    close(): void {
      this.db.close();
    }

    get inTransaction(): boolean {
      return this.db.isTransaction;
    }
  }

  return NodeSQLiteDatabase;
}

async function importNodeSQLite(): Promise<NodeSQLiteModule> {
  return (await import("node:sqlite")) as unknown as NodeSQLiteModule;
}

/**
 * Load the node:sqlite-backed driver. The module import is injectable for deterministic
 * test isolation: the success path is then driven the same way on every runtime instead
 * of only where node:sqlite resolves. Bun gained it in 1.4.0, so the real module is
 * exercised too - both arms are asserted rather than whichever one the toolchain allows.
 * Callers outside tests use the default importer.
 */
export async function loadNodeSQLiteDriver(
  importModule: () => Promise<NodeSQLiteModule> = importNodeSQLite,
): Promise<SQLiteConstructor> {
  const sqlite = await importModule();
  return createNodeSQLiteDriver(sqlite.DatabaseSync);
}

/** The real loader for a driver name — the default behind the seam below. */
async function importDriverForName(name: SQLiteDriverName): Promise<SQLiteConstructor> {
  return name === "bun" ? loadBunDriver() : loadNodeSQLiteDriver();
}

/**
 * Load the runtime-appropriate SQLite driver (lazily, cached per driver).
 *
 * The loader is injectable for the same reason `loadNodeSQLiteDriver`'s importer is:
 * the failure arm is otherwise reachable only on a runtime that lacks the module, so a
 * test asserting it is really asserting a property of the installed Bun. It was written
 * that way once and went quietly unexercised the day Bun 1.4.0 shipped `node:sqlite`.
 * Callers outside tests pass nothing.
 */
export async function loadSQLiteDriver(
  loadDriver: (name: SQLiteDriverName) => Promise<SQLiteConstructor> = importDriverForName,
): Promise<SQLiteConstructor> {
  const name = resolveSQLiteDriverName();

  const cached = loadedDrivers.get(name);
  if (cached) {
    return cached;
  }
  const cachedError = driverLoadErrors.get(name);
  if (cachedError) {
    throw cachedError;
  }

  try {
    const driver = await loadDriver(name);
    loadedDrivers.set(name, driver);
    return driver;
  } catch (error) {
    const loadError = new DatabaseConfigError(
      `SQLite driver "${name}" is not available in this environment: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'The "bun" driver requires the Bun runtime (bun:sqlite); ' +
        'the "node" driver requires Node.js with the built-in node:sqlite module (present from Node 22.13; the supported floor is Node 24 LTS).',
      "sqlite",
    );
    driverLoadErrors.set(name, loadError);
    throw loadError;
  }
}
