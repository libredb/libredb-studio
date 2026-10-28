import type { ObjectReadRange } from "@/lib/db/types";
import type { ColumnSchema } from "@/lib/types";

/**
 * What only the etcd arms of the two generators read (#1089, sections 3.3, 4.7 and 6.4), handed over by
 * `useTabManager` from the schema entry and the active connection. Every other arm ignores it, so no other
 * engine's text moves with it.
 */
export interface GeneratorScope {
  /** The pieces of a group's range this connection may read, `DatabaseObject.readRanges`, where they do not cover it. */
  readonly readRanges?: readonly ObjectReadRange[];
  /** The active connection's public `readOnly`: Generate Command then writes the read alone (#1089 E6). */
  readonly readOnly?: boolean;
  /** The object's kind, `DatabaseObject.kind`, handed to `rowAction`, whose statement depends on what the row is. */
  readonly kind?: string;
  /**
   * The path names one key the key browser listed, and never a prefix group. Read by the Redis arm alone: a key
   * may be named `cache:*`, which is how the tree spells the group of the same name, and only the caller knows
   * which of the two it activated.
   */
  readonly namesKey?: boolean;
}

/**
 * What one query dialect writes for a tree click (`table`, run on the user's behalf) and for "Generate Query"
 * (`select`, written into a tab and not run), each from the object's path, and, for a dialect whose provider
 * declares `ProviderCapabilities.rowActions`, what each declared row action runs (`rowAction`).
 */
export interface DialectGenerators {
  readonly table: (
    path: readonly string[],
    columns: readonly ColumnSchema[] | undefined,
    scope: GeneratorScope | undefined,
  ) => string;
  readonly select: (
    path: readonly string[],
    columns: readonly ColumnSchema[],
    scope: GeneratorScope | undefined,
  ) => string;
  /**
   * The statement one declared row action runs on one object, by the action's id, with the object's kind
   * on `scope.kind`. Absent on every dialect whose provider declares no row action.
   *
   * The statement reads and never writes, and honours `scope.readOnly`: it runs on click with no role
   * asked and no editing step. Every segment of `path` is an object name taken from a listing, which a
   * user of the database can choose, so it is quoted by the dialect's own quoting rule and never
   * concatenated.
   */
  readonly rowAction?: (path: readonly string[], actionId: string, scope: GeneratorScope) => string;
  /**
   * The statement Generate Count Query writes for one object, on a dialect whose `QUERY_DIALECTS` record offers it.
   * Absent on every dialect whose record does not; `generateCountQuery` refuses a record that offers a count and
   * writes none, rather than falling through to the JSON arm's MongoDB count document.
   */
  readonly count?: (path: readonly string[]) => string;
}

/**
 * What one query language an engine writes its own text in says, for a declaration with no dialect: the tree click
 * (`table`) and Generate Query (`select`) from the object's path, and, where the language spells names its own way,
 * how it quotes one name (`quote`) and a whole address (`quotePath`). Read after MongoDB's JSON arm and before any SQL
 * form.
 */
export interface LanguageGenerators {
  readonly table: (path: readonly string[], columns: readonly ColumnSchema[] | undefined) => string;
  readonly select: (path: readonly string[], columns: readonly ColumnSchema[]) => string;
  readonly quote?: (name: string) => string;
  readonly quotePath?: (path: readonly string[]) => string;
}

/** What an SQL row reads of the declaration it writes for. */
export interface SqlFormContext {
  /** The declaration's identifier quoting, `quoteIdentifier` with every rule ahead of the row's own. */
  readonly quote: (name: string) => string;
  /** The statement terminator: `;`, or nothing on a grammar with none. */
  readonly terminator: string;
}

/**
 * What one SQL engine writes apart from the shared SQL forms, selected by the default port its declaration names,
 * which is the signal the generators have always keyed these forms by. `quote` is the engine's identifier quoting,
 * read after a declared `identifierQuoting`; the forms are optional and each replaces the shared one at its place.
 */
export interface SqlPortGenerators {
  /** The default port that selects this row. */
  readonly port: number;
  /** A name quoted for the engine, left bare where it round-trips bare and `always` is false. */
  readonly quote: (name: string, always: boolean) => string;
  /** The tree click's statement on the quoted address, ahead of a declared projection or time window. */
  readonly table?: (table: string, context: SqlFormContext) => string;
  /** Generate Query's statement on the quoted address, ahead of a declared time window. */
  readonly select?: (table: string, columns: readonly ColumnSchema[], context: SqlFormContext) => string;
  /** Generate Query's statement on the quoted address and its projected column list, after a declared time window. */
  readonly selectList?: (table: string, columnList: string, context: SqlFormContext) => string;
  /** The count Generate Count Query writes, where the engine's is not `COUNT(*)`. */
  readonly countExpression?: string;
}
