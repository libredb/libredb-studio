/**
 * libSQL object surface (issue #789)
 *
 * The same dialect as `providers/sql/sqlite.ts` over a network instead of a file handle,
 * and that one difference is what this file is for. `sqlite_schema` and `PRAGMA
 * table_list` answer here exactly as they do on a file, so the CATALOG decisions are
 * Task 12's and are not re-derived; the SHAPE of the reads is not, because every read is
 * an HTTP request rather than a call into a driver. A detail read that issued one request
 * per index the way the SQLite provider does would cost a round trip per index.
 *
 * Measured on 2026-09-11 against `ghcr.io/tursodatabase/libsql-server:v0.24.33`
 * (sqld 0.24.33 `40a151bd 2025-12-19`), the image `database-compose.yml` pins. That build
 * embeds SQLite 3.45.1, not the 3.47.0 the flat-surface notes record for `:latest`:
 *
 * - `PRAGMA table_list` ANSWERS, in both the pragma and the table-valued form. It arrived
 *   in SQLite 3.37, so 3.45.1 is above the floor, and the shadow-table separation Task 12
 *   depends on transfers unchanged.
 * - Bound parameters reach the `pragma_*` table-valued functions
 *   (`pragma_table_xinfo(?, ?)` answers). The flat surface in `introspect.ts` embeds
 *   object names as SQL literals instead; these statements bind.
 * - `VACUUM`, `ANALYZE`, `PRAGMA query_only`, `ATTACH DATABASE` and `CREATE TEMP TABLE`
 *   are all refused by the server's own statement allowlist, so no path here issues one.
 * - `CREATE VIEW temp.<name>` is NOT refused, and a view created that way is visible to
 *   `PRAGMA table_list`. So a `temp` object really can shadow a `main` one and the schema
 *   restriction below is load-bearing rather than defensive.
 * - `CREATE FUNCTION ... LANGUAGE wasm` is refused by sqld's parser ("syntax error around
 *   L1:16: `FUNCTION`"), `libsql_wasm_func_table` does not exist and the binary carries no
 *   wasm flag. So no routine kind is declared: see LIBSQL_OBJECT_KINDS.
 */
import type {
  ColumnSchema,
  Container,
  ContainerLevelSpec,
  DatabaseObject,
  ForeignKeySchema,
  IndexSchema,
  KindCount,
  ObjectDetail,
  ObjectKindSpec,
  ProviderCapabilities,
} from "@/lib/db/types";
import { QueryError } from "@/lib/db/errors";
import { containerDepth, declaredKinds, findKind } from "@/lib/db/object-kinds";
import { readNumber, readText } from "./introspect";
import type { LibSQLBatchOutcome, LibSQLRow, LibSQLStatement, LibSQLTransport } from "./transport";

// ============================================================================
// The one schema, and the statements that read it
// ============================================================================

/**
 * The one schema this object surface reads, and the reason it is a constant rather than a
 * path segment.
 *
 * libSQL declares ZERO container levels, so no container path carries a schema and nothing
 * here derives one. `main` is the database the connection opened. It is not cosmetic and
 * it is not a filter that could be dropped, and on this deployment that is measurable in a
 * way it is not on a file: sqld refuses `CREATE TEMP TABLE` and `ATTACH DATABASE` outright,
 * but ACCEPTS `CREATE VIEW temp.orders`, and `PRAGMA table_list` then publishes `orders`
 * under both `main` and `temp`. Without `t.schema = ?` the listing answers two objects with
 * ONE path, which is the uniqueness the tree addresses rows by.
 */
const MAIN_SCHEMA = "main";

// ----------------------------------------------------------------------------
// `name NOT LIKE 'sqlite\_%' ESCAPE '\'`, in the six statements below
//
// Names SQLite reserves for itself, excluded from every count and every listing. This can
// never hide a user's object: the engine refuses the name outright, over Hrana as well,
// answering "object name reserved for internal use" to a table, an index, a view and a
// trigger alike. What it removes is real and arrives without being asked for -
// `sqlite_schema` is a row of `PRAGMA table_list` on every database, `sqlite_sequence`
// appears the moment a table declares AUTOINCREMENT, and `sqlite_autoindex_<table>_<n>`
// the moment a UNIQUE constraint needs an index.
//
// That last one is a row of `sqlite_schema` as well as of `pragma_index_list`, so it
// reaches the Indexes FOLDER and not only an object's detail. Measured on sqld 0.24.33:
// `code TEXT UNIQUE` on a ROWID table puts `sqlite_autoindex_badges_1` into
// `sqlite_schema` typed `index`. The one shape that does NOT is a WITHOUT ROWID table,
// whose autoindex `pragma_index_list` publishes and `sqlite_schema` omits - which is why
// a fixture holding only that shape makes this predicate look untestable when it is not.
//
// `ESCAPE` is load-bearing: `_` is LIKE's single-character wildcard, so the unescaped
// `'sqlite_%'` also matches `sqliteXledger`, a name a user CAN create. Measured on the
// fixture, the unescaped form answers nine tables where the engine holds ten.
//
// The same predicate is applied to every population, in the counts and in the listings, so
// the badge and its folder can never disagree about what an object is.
// ----------------------------------------------------------------------------

/**
 * How many objects of each kind the database holds, in ONE statement and one round trip.
 *
 * Two arms because two catalogs answer: `PRAGMA table_list` separates a real table from
 * the shadow tables an FTS5 or R-Tree module owns, and `sqlite_schema` is the only place
 * an index or a trigger appears at all. The `IN` list is the vocabulary, and it is
 * SQLite's documented four values (`table`, `view`, `shadow`, `virtual`) rather than a
 * `SELECT DISTINCT` over a fixture: the arm dropped is `shadow` and nothing else.
 */
const COUNTS_SQL = `
      SELECT kind, COUNT(*) AS n
        FROM (
               SELECT CASE t.type WHEN 'view' THEN 'view' ELSE 'table' END AS kind
                 FROM pragma_table_list AS t
                WHERE t.schema = ?
                  AND t.type IN ('table', 'view', 'virtual')
                  AND t.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
               UNION ALL
               SELECT s.type AS kind
                 FROM sqlite_schema AS s
                WHERE s.type IN ('index', 'trigger')
                  AND s.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             )
       GROUP BY kind
    `;

// `virtual` belongs with `table` and `shadow` does not, which is the whole reason
// `PRAGMA table_list` is read here instead of `sqlite_schema`. An FTS5 table is one
// `virtual` row plus five `shadow` rows, and `sqlite_schema` types every one of them
// `table`: measured on the fixture in `tests/integration/db/libsql-provider.test.ts`,
// which holds ten objects of the table kind, a naive scan answers 16. A user SELECTs from
// the `virtual` row and never from a `shadow` one.
const LIST_TABLES_SQL = `
      SELECT t.name AS name
        FROM pragma_table_list AS t
       WHERE t.schema = ?
         AND t.type IN ('table', 'virtual')
         AND t.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
    `;

const LIST_VIEWS_SQL = `
      SELECT t.name AS name
        FROM pragma_table_list AS t
       WHERE t.schema = ?
         AND t.type = 'view'
         AND t.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
    `;

// Indexes and triggers are not in `PRAGMA table_list` at all, so these two read
// `sqlite_schema`, which needs no schema bind: the unqualified name always resolves to
// `main.sqlite_schema`, and a temp object would live in the separate `sqlite_temp_schema`.
// So these two are already scoped to the one schema the two statements above bind.
const LIST_INDEXES_SQL = `
      SELECT s.name AS name
        FROM sqlite_schema AS s
       WHERE s.type = 'index'
         AND s.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
    `;

// `tbl_name` is the object the trigger fires on, which is the `attachedTo` nesting.
const LIST_TRIGGERS_SQL = `
      SELECT s.name AS name, s.tbl_name AS parent
        FROM sqlite_schema AS s
       WHERE s.type = 'trigger'
         AND s.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
    `;

// `table_xinfo` and not `table_info`, which is the same read minus the hidden column.
// Measured here as on a file: `table_info` DROPS a generated column, so a table declaring
// one reports a column list the engine does not have. `hidden = 1` is the other direction,
// a virtual table module's own interface columns - on the FTS5 table `notes` its own name
// and `rank` - which the table does not declare. `readSchema()` in `introspect.ts` still
// reads `table_info` and still loses generated columns; that is the flat surface.
const OBJECT_COLUMNS_SQL = `
      SELECT name, type, "notnull", dflt_value, pk
        FROM pragma_table_xinfo(?, ?)
       WHERE hidden <> 1
       ORDER BY cid
    `;

const OBJECT_INDEXES_SQL = `
      SELECT name, "unique"
        FROM pragma_index_list(?, ?)
       WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
    `;

const OBJECT_INDEX_COLUMNS_SQL = `
      SELECT name
        FROM pragma_index_info(?, ?)
       ORDER BY seqno
    `;

const OBJECT_FOREIGN_KEYS_SQL = `
      SELECT id, seq, "table", "from", "to"
        FROM pragma_foreign_key_list(?, ?)
       ORDER BY id, seq
    `;

// The parent's PRIMARY KEY, in declaration order, for a foreign key that names no column.
// Measured: `REFERENCES customers` with no column list answers `to = NULL`, which means
// the parent's primary key, and `ForeignKeySchema.referencedColumn` is a string - so the
// alternative to resolving it is putting a null in a typed string field.
const PARENT_KEY_COLUMNS_SQL = `
      SELECT name
        FROM pragma_table_info(?, ?)
       WHERE pk > 0
       ORDER BY pk
    `;

// ============================================================================
// The declaration
// ============================================================================

/**
 * Every object kind libSQL has, and nothing else.
 *
 * The same four as SQLite, because it IS SQLite: `sqlite_schema.type` carries exactly
 * `table`, `index`, `view` and `trigger`, and that is the whole inventory.
 *
 * **No `function` kind**, and that is a measurement rather than an omission. libSQL once
 * advertised WASM user-defined functions (`CREATE FUNCTION ... LANGUAGE wasm`), which
 * would be a stored routine this file could list. On the build this repo runs the server's
 * own parser refuses the statement ("syntax error around L1:16: `FUNCTION`"), the
 * `libsql_wasm_func_table` catalog does not exist, and the binary publishes no flag that
 * would enable either. A declared kind draws a folder, and a folder for something the
 * engine cannot hold is a lie the zero badge makes look like a fact, so the kind is absent.
 *
 * `index` IS declared, unlike on postgres, mysql, mssql and oracle. The test is whether
 * the engine's own catalog models an index as a first-class named object at container
 * level, and this one does: an index is a row in `sqlite_schema` beside the tables,
 * addressed by a bare name in one namespace with tables and views.
 *
 * Module scope rather than a literal inside `getCapabilities()`, so the array is one object
 * rather than a fresh one per call: `getCapabilities()` is called several times per request
 * by the object routes and the tree.
 */
export const LIBSQL_OBJECT_KINDS: readonly ObjectKindSpec[] = [
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
  // No `acceptsRowWrites`. A write to a view is refused outright unless an INSTEAD OF
  // trigger carries it, which is a per-OBJECT fact a per-kind declaration cannot state.
  { id: "view", role: "relation", label: "View", labelPlural: "Views" },
  { id: "index", role: "config", label: "Index", labelPlural: "Indexes" },
  { id: "trigger", role: "attached", label: "Trigger", labelPlural: "Triggers", attachedTo: "table" },
];

// ============================================================================
// Pure derivations
// ============================================================================

/**
 * The container levels this provider declares, sliced to the depth `containerDepth()`
 * reports.
 *
 * One reader for the whole file, so the depth and the level list can never be taken by two
 * different rules. `containerDepth()` is what decides, never `containerLevels.length`:
 * absent and empty are the same fact, and two callers reading the field by different rules
 * is how the tree and the API route came to disagree about one engine.
 *
 * On libSQL this answers the empty array, which is the engine and not a degenerate case.
 */
function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * Refuses a container path that is not the shape the DECLARATION describes.
 *
 * On libSQL the only valid container path is the empty one, and `container.length !== 0` is
 * NOT how that is written. The depth comes from `containerDepth()` and the segment names
 * from the declared level labels, so the check and its message are the same array: a
 * provider copying this file onto a one- or two-level engine inherits a derivation rather
 * than a literal that would refuse every valid path there.
 *
 * This raises rather than answering an empty folder, because a path of another shape is a
 * caller that built it from another engine's model, and an empty folder that looks exactly
 * like a database holding nothing is the worst way to report that.
 */
function assertContainerPath(capabilities: ProviderCapabilities, container: readonly string[]): void {
  const levels = declaredLevels(capabilities);
  if (container.length === levels.length) return;
  const shape = levels.length === 0 ? "empty" : `[${levels.map((level) => level.label.toLowerCase()).join(", ")}]`;
  throw new QueryError(`A libSQL container path is ${shape}, received ${JSON.stringify(container)}`, "libsql");
}

/**
 * Every declared kind seeded at zero, before any row is read.
 *
 * Seeding is what makes "libSQL has this kind and this database holds none" render as a 0
 * badge. Building the record from the GROUP BY rows alone would leave the kind out
 * entirely, and an absent kind already means something else and stronger: the engine has no
 * such concept, so the tree draws no folder at all.
 */
function seedZeroCounts(kinds: readonly ObjectKindSpec[]): Record<string, KindCount> {
  return Object.fromEntries(kinds.map((kind) => [kind.id, { count: 0 } as KindCount]));
}

/**
 * Overwrites the seeded zeros with what the GROUP BY actually answered.
 *
 * A kind that was never seeded is SKIPPED, so the DECLARATION decides which folders exist
 * and a catalog row cannot add one.
 *
 * `Object.hasOwn` and not `in`, which is what makes that absolute rather than nearly so:
 * `in` walks the prototype chain, so a row whose kind read `toString` or `constructor`
 * would pass the test and write a folder the provider never declared.
 */
function applyKindCounts(counts: Record<string, KindCount>, rows: readonly LibSQLRow[]): void {
  for (const row of rows) {
    const kind = readText(row.kind);
    if (kind !== undefined && Object.hasOwn(counts, kind)) counts[kind] = { count: readNumber(row.n) ?? 0 };
  }
}

/**
 * The server's own sentence, verbatim, against every kind the failed read covered.
 *
 * Deliberately NOT through the provider's error mapping: that gives a thrown error a type
 * and this product's wording, and nothing here throws. The sentence is rendered to a person
 * as the reason a folder has no number, so prefixing it would put our words in front of the
 * server's. A refused read is never 0 - on a deployment that refused the statement the
 * sentence is "SQLite error: no such table: pragma_table_list", which is a different fact
 * from "this database holds no tables", and `KindCount` is the type that keeps them apart.
 */
function unavailableCounts(ids: readonly string[], error: unknown): Record<string, KindCount> {
  const reason = error instanceof Error ? error.message : String(error);
  return Object.fromEntries(ids.map((id) => [id, { unavailable: reason } as KindCount]));
}

/** Which statement lists one kind, and what it binds. */
const OBJECT_LISTINGS: Readonly<Record<string, { readonly sql: string; readonly params: readonly unknown[] }>> = {
  table: { sql: LIST_TABLES_SQL, params: [MAIN_SCHEMA] },
  view: { sql: LIST_VIEWS_SQL, params: [MAIN_SCHEMA] },
  index: { sql: LIST_INDEXES_SQL, params: [] },
  trigger: { sql: LIST_TRIGGERS_SQL, params: [] },
};

/**
 * Where one listed object is addressed.
 *
 * Built from the CONTAINER and the ROW rather than from the kind id, so the four listing
 * statements share one rule: a `parent` column adds a nesting segment and nothing else
 * does, which is what the `attachedTo: "table"` declaration states. The container path is
 * prefixed rather than assumed empty, so every path starts with its container even though
 * this engine's container path is always `[]` - writing `[name]` here would be a second
 * place that knows this engine's depth.
 *
 * A trigger's parent is `sqlite_schema.tbl_name`, which is never null for a trigger. It is
 * not always a TABLE: an INSTEAD OF trigger on a VIEW is legal and `tbl_name` then names
 * the view. `attachedTo` names the kind a trigger usually hangs off, and the count and the
 * listing both carry the view case rather than one of them dropping it.
 */
function objectPath(container: readonly string[], name: string, parent: string | undefined): string[] {
  return parent === undefined ? [...container, name] : [...container, parent, name];
}

/**
 * Two paths compared SEGMENT BY SEGMENT, so a sort is over the address and never over one
 * joined string.
 *
 * Exported because the two cases that separate this from `JSON.stringify` cannot arise
 * inside ONE kind on this engine, where every path of a kind is the same length, so a test
 * driven through `listObjects` could not tell the two spellings apart.
 *
 * `JSON.stringify(path)` is the obvious spelling and it is wrong twice. At MIXED DEPTH the
 * deeper path sorts first, because the separator `,` (0x2C) is below the terminator `]`
 * (0x5D), which would put a trigger above the object it hangs off. And JSON ESCAPES, so a
 * name holding a quote, a backslash or a control character sorts by its escape sequence
 * rather than by its own code points.
 *
 * This is the fifth copy in the repo (#789 hoists them all in one sweep at the end rather
 * than each task hoisting it into a shared module and colliding with the others).
 */
export function comparePaths(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

// ============================================================================
// Reading
// ============================================================================

/**
 * What one object-surface read needs: somewhere to send a statement, the declaration to
 * derive shapes from, and the provider's own error mapping.
 *
 * The mapping is passed in rather than rebuilt here because the STATUS carries the
 * distinction and the wording does not: a statement the engine rejected arrives as an HTTP
 * 200 and a credential that expired mid-session arrives as a 4xx, and only the provider
 * knows the host and port a connection failure has to name.
 */
export interface LibSQLObjectReader {
  readonly transport: LibSQLTransport;
  readonly capabilities: ProviderCapabilities;
  readonly mapError: (error: unknown, sql?: string) => Error;
}

/**
 * A catalog value that IDENTIFIES something, or a refusal.
 *
 * `readText(...) ?? ""` is the obvious spelling and it masks: an object row with no name
 * would become an addressable object whose last path segment is the empty string, and a
 * column with no name would key the results grid on nothing. Neither is reachable on this
 * engine, because every one of these columns is `NOT NULL` in the catalog it comes from -
 * which is exactly why a silent default here would never be noticed if it ever were.
 *
 * The house rule is to raise rather than recover, and a refusal naming the statement is
 * what tells whoever reads it which read produced the row.
 */
function requiredName(value: unknown, what: string, sql: string): string {
  const name = readText(value);
  if (name === undefined) throw new QueryError(`libSQL answered a ${what} with no name`, "libsql", sql);
  return name;
}

/** The rows one statement of a batch answered, or that statement's own failure, raised. */
function rowsOrThrow(reader: LibSQLObjectReader, outcome: LibSQLBatchOutcome, sql: string): LibSQLRow[] {
  if (!outcome.ok) throw reader.mapError(outcome.error, sql);
  return outcome.result.rows;
}

/**
 * No containers, because libSQL has no container level.
 *
 * `[]` is the ENGINE answering, not a refusal and not a gap: a connection addresses one
 * database and every object in it is addressed by a bare name. The tree reads
 * `containerDepth()` off the same declaration, sees 0 and draws the kind folders at the
 * root under the empty container path. Inventing a synthetic `main` container to make the
 * shape match the other sixteen engines would put a row in the tree that names nothing a
 * user can act on.
 */
export function listObjectContainers(): Container[] {
  return [];
}

/**
 * How many objects of each declared kind the database holds, in one statement.
 *
 * Three outcomes, and the type keeps all three apart. A kind the GROUP BY answered for
 * carries its count. A kind it did not carries `{ count: 0 }`, because it was seeded before
 * the read. A kind whose read was refused carries the server's own sentence, so the object
 * browser can say why a folder has no number instead of showing a zero nobody measured.
 *
 * The container path is checked BEFORE the read and raises, because a path of the wrong
 * shape is a caller mistake and not something the engine refused.
 */
export async function countLibSQLObjects(
  reader: LibSQLObjectReader,
  container: readonly string[],
): Promise<Record<string, KindCount>> {
  assertContainerPath(reader.capabilities, container);
  const declared = declaredKinds(reader.capabilities);
  const counts = seedZeroCounts(declared);

  try {
    const result = await reader.transport.execute(COUNTS_SQL, { params: [MAIN_SCHEMA] });
    applyKindCounts(counts, result.rows);
    return counts;
  } catch (error) {
    return unavailableCounts(
      declared.map((kind) => kind.id),
      error,
    );
  }
}

/**
 * The objects of one kind, names only, in one statement.
 *
 * Ordering is done here rather than with an `ORDER BY`, and that is deliberate. Four
 * statements answer these listings, so four `ORDER BY` clauses would be four chances to
 * disagree; and a SQL sort runs under the column's own collation. A code-point sort here is
 * one rule and the same rule everywhere. It is not cosmetic either: measured, `PRAGMA
 * table_list` answers in page order, `legacy_ref` before `legacy` before `orders`.
 *
 * By PATH and not by name, because it is the address that has to be stable: sorting by the
 * address groups an object's triggers under it.
 *
 * No `rowCount` and no `sizeBytes`, and both absences are facts about the engine rather
 * than unfinished work. There is no catalog row estimate: `sqlite_stat1` exists only after
 * ANALYZE, which this server refuses outright, so a `COUNT(*)` per object would be a full
 * scan per row of this listing and a round trip per row on top. `dbstat` does answer here,
 * but it scans the whole database to do it. A fabricated 0 in either field would read as an
 * empty object.
 */
export async function listLibSQLObjects(
  reader: LibSQLObjectReader,
  container: readonly string[],
  kind: string,
): Promise<DatabaseObject[]> {
  assertContainerPath(reader.capabilities, container);
  // Two questions, asked in order, and only the DECLARATION answers the first. Deciding
  // "is this kind declared" from whether a listing statement exists would make the two
  // methods disagree, and would report "declares no object kind" about a kind
  // `objectKinds` does declare but nothing here can list.
  if (findKind(reader.capabilities, kind) === undefined) {
    throw new QueryError(`libSQL declares no object kind "${kind}"`, "libsql");
  }
  const statement = OBJECT_LISTINGS[kind];
  if (statement === undefined) {
    throw new QueryError(`libSQL declares the kind "${kind}" but has no statement that lists it`, "libsql");
  }

  let rows: LibSQLRow[];
  try {
    rows = (await reader.transport.execute(statement.sql, { params: [...statement.params] })).rows;
  } catch (error) {
    throw reader.mapError(error, statement.sql);
  }

  return rows
    .map((row) => {
      const name = requiredName(row.name, `${kind} row`, statement.sql);
      // `parent` is selected by the trigger listing alone, so ABSENT is the normal answer
      // for the other three and is what `objectPath` reads as "this kind does not nest".
      return { path: objectPath(container, name, readText(row.parent)), name, kind };
    })
    .sort((left, right) => comparePaths(left.path, right.path));
}

/** One column of an object, as `pragma_table_xinfo` publishes it. */
function toColumn(row: LibSQLRow, sql: string): ColumnSchema {
  const defaultValue = row.dflt_value;

  return {
    name: requiredName(row.name, "column", sql),
    // The empty string on a virtual table's columns and on a column declared with no type
    // at all, which SQLite allows. `readSchema()` spells that absence "TEXT", which is a
    // guess about affinity; the empty string is what the engine said.
    type: readText(row.type) ?? "",
    nullable: readNumber(row.notnull) !== 1,
    // `pk` is a 1-BASED RANK and not a flag: a composite primary key answers 1 and 2, so
    // `=== 1` reports the second key column as ordinary. Measured on
    // `PRIMARY KEY (region, year)`.
    isPrimary: (readNumber(row.pk) ?? 0) > 0,
    ...(defaultValue === null || defaultValue === undefined ? {} : { defaultValue: String(defaultValue) }),
  };
}

/**
 * Columns, indexes and foreign keys for one object of one KIND, in at most two round trips.
 *
 * The kind decides everything and nothing here reads the name to work out what it is
 * holding. Only the two `relation` kinds have any of the three: an index and a trigger
 * answer three empty arrays WITHOUT touching the network, which is a true fact about those
 * kinds rather than a failed read. An index's own key list is NOT published here and that
 * is deliberate: `IndexSchema.columns` is a list of column names and an index on an
 * expression has none, measured as `index_info.name = NULL, cid = -2`. A trigger's body is
 * source text, which is Phase 2's Source tab.
 *
 * Keying on `role === "relation"` is safe HERE and is not the general rule: MySQL keys the
 * same decision on the catalog, because a MariaDB sequence is declared `config` and still
 * has real columns. On libSQL the two coincide exactly.
 *
 * Path depth is derived from the declaration: one segment per declared container level,
 * plus the attached parent where the kind declares one, plus the name.
 *
 * **Two round trips, not one per index.** This is where the file stops being the SQLite
 * provider: there each read is a call into a file handle and costs nothing to repeat, and
 * here each one is an HTTP request. The first batch asks for the columns, the index list
 * and the foreign keys; the second asks every index for its columns and every unresolved
 * foreign key parent for its primary key, all at once. A table with four indexes costs two
 * requests rather than seven.
 *
 * Zero columns IS a failed read and raises: SQLite refuses `CREATE TABLE t()`, so every
 * table and every view has at least one column, and an empty answer means the object is not
 * there under that name in `main`.
 */
export async function describeLibSQLObject(
  reader: LibSQLObjectReader,
  path: readonly string[],
  kind: string,
): Promise<ObjectDetail> {
  const spec = findKind(reader.capabilities, kind);
  if (spec === undefined) {
    throw new QueryError(`libSQL declares no object kind "${kind}"`, "libsql");
  }

  const levels = declaredLevels(reader.capabilities).map((level) => level.label.toLowerCase());
  const shape = spec.attachedTo === undefined ? [...levels, "name"] : [...levels, spec.attachedTo, "name"];
  if (path.length !== shape.length) {
    throw new QueryError(
      `A libSQL "${kind}" path is [${shape.join(", ")}], received ${JSON.stringify(path)}`,
      "libsql",
    );
  }

  if (spec.role !== "relation") {
    return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
  }

  // Neither bind is positional. The object's own name is the LAST segment, which is right
  // at every depth, where `path[0]` is right only at depth 1 and would name a container
  // segment on the five two-level engines that copy this shape. The schema is the constant
  // `main` rather than a segment, because this engine declares no container level to take
  // one from - see MAIN_SCHEMA for what leaving it out actually does.
  const binds = [path[path.length - 1], MAIN_SCHEMA];

  const first = await reader.transport.executeBatch([
    { sql: OBJECT_COLUMNS_SQL, params: binds },
    { sql: OBJECT_INDEXES_SQL, params: binds },
    { sql: OBJECT_FOREIGN_KEYS_SQL, params: binds },
  ]);

  const columnRows = rowsOrThrow(reader, first[0], OBJECT_COLUMNS_SQL);
  if (columnRows.length === 0) {
    throw new QueryError(`No libSQL ${kind} named ${binds[0]} in ${MAIN_SCHEMA}`, "libsql", OBJECT_COLUMNS_SQL);
  }
  const indexRows = rowsOrThrow(reader, first[1], OBJECT_INDEXES_SQL);
  const foreignKeyRows = rowsOrThrow(reader, first[2], OBJECT_FOREIGN_KEYS_SQL);

  return {
    path: [...path],
    columns: columnRows.map((row) => toColumn(row, OBJECT_COLUMNS_SQL)),
    ...(await readIndexesAndKeys(reader, binds, indexRows, foreignKeyRows)),
  };
}

/**
 * The second round trip: every index's columns and every unresolved parent's key, together.
 *
 * One batch carries both questions because they are independent of each other and both
 * depend only on the first batch. Splitting them would cost a third request for no answer
 * the caller could not already have.
 */
async function readIndexesAndKeys(
  reader: LibSQLObjectReader,
  binds: readonly unknown[],
  indexRows: readonly LibSQLRow[],
  foreignKeyRows: readonly LibSQLRow[],
): Promise<{ indexes: IndexSchema[]; foreignKeys: ForeignKeySchema[] }> {
  const [, schema] = binds;
  const indexNames = indexRows.map((row) => requiredName(row.name, "index", OBJECT_INDEXES_SQL));
  // Only a constraint that named no column needs its parent's key, and a parent is asked
  // once however many of its columns are referenced.
  const parents = [
    ...new Set(
      foreignKeyRows
        .filter((row) => readText(row.to) === undefined)
        .map((row) => requiredName(row.table, "foreign key parent", OBJECT_FOREIGN_KEYS_SQL)),
    ),
  ];

  const statements: LibSQLStatement[] = [
    ...indexNames.map((name) => ({ sql: OBJECT_INDEX_COLUMNS_SQL, params: [name, schema] })),
    ...parents.map((parent) => ({ sql: PARENT_KEY_COLUMNS_SQL, params: [parent, schema] })),
  ];
  const outcomes = await reader.transport.executeBatch(statements);

  const indexes = indexRows.map((row, position) => ({
    name: indexNames[position],
    columns: rowsOrThrow(reader, outcomes[position], OBJECT_INDEX_COLUMNS_SQL)
      // An index on an EXPRESSION publishes a null column name (`cid = -2`), and so does
      // one that keys the rowid. Those are not columns of this object, so they are left out
      // rather than rendered as a fabricated label.
      .map((column) => readText(column.name))
      .filter((column): column is string => column !== undefined),
    unique: readNumber(row.unique) === 1,
  }));

  const parentKeys = new Map<string, readonly string[]>();
  for (const [position, parent] of parents.entries()) {
    parentKeys.set(
      parent,
      rowsOrThrow(reader, outcomes[indexNames.length + position], PARENT_KEY_COLUMNS_SQL).map((row) =>
        requiredName(row.name, "primary key column", PARENT_KEY_COLUMNS_SQL),
      ),
    );
  }

  const foreignKeys = foreignKeyRows.map((row) => {
    const parent = requiredName(row.table, "foreign key parent", OBJECT_FOREIGN_KEYS_SQL);
    return {
      columnName: requiredName(row.from, "foreign key column", OBJECT_FOREIGN_KEYS_SQL),
      // A bare name, never qualified: a foreign key's parent is resolved inside the same
      // database, so there is no cross-schema case to spell.
      referencedTable: parent,
      // `to` is NULL when the reference names no column - `REFERENCES customers` rather
      // than `REFERENCES customers(id)` - and SQLite reads that as the parent's PRIMARY
      // KEY, position by position. A parent with no primary key at all is a schema the
      // engine accepts and rejects only on INSERT, so there is nothing to name and the
      // field is empty rather than invented.
      referencedColumn: readText(row.to) ?? (parentKeys.get(parent) ?? [])[readNumber(row.seq) ?? 0] ?? "",
    };
  });

  return { indexes, foreignKeys };
}
