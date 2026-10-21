import type { SSLMode } from "@/lib/types";

/**
 * One query parameter kept in the spelling it was pasted in. The lookup is
 * case-insensitive, but the banner quotes the parameter back at the user, so what it echoes
 * has to be their text and not a normalised form of it.
 */
export interface RawParam {
  readonly name: string;
  readonly value: string;
}

/**
 * What a TLS parameter resolved to: a mode the form can hold, or the parameter itself when
 * it has no representation. Never both, and never a fallback to "disable".
 */
export interface TLSIntent {
  sslMode?: SSLMode;
  unmappedTLSParam?: string;
}

/** A URL's query parameters, keyed by the lower-cased name, each kept in the spelling it was pasted in. */
export type QueryParams = ReadonlyMap<string, RawParam>;

/** One field a type's load check refuses, and the sentence it is refused with. */
export interface SeedFieldRefusal {
  readonly field: string;
  readonly sentence: string;
}

/** The fields a load check reads, as the file writes them: every one may be absent or a `${...}` reference. */
export type SeedCheckedFields = Readonly<
  Partial<Record<"host" | "user" | "authMethod" | "privateKey" | "password" | "role", string>>
>;

/** What one engine's connection string is: the scheme shown for it, the TLS its URL query carries, its seed checks. */
export interface ConnectionStringSpec {
  /**
   * The canonical URI scheme the engine is reachable by, for the engines that HAVE one, otherwise `null`.
   *
   * Deliberately partial, and the gaps are the point: SQLite is a file path, LibreDB is
   * embedded in the process, and Druid is reached over plain HTTP through the form. Inventing
   * `sqlite://` or `druid://` to make every row carry one would put a scheme on the login
   * page that `parseConnectionString` rejects - a claim the product does not honour,
   * which is the class of defect issue #425 exists to remove.
   *
   * Aliases the parser also accepts (`postgresql://`, `mongodb+srv://`, `rediss://`,
   * `sqlserver://`, `couchbases://`, and ClickHouse's `http(s)://`) are not listed: this field
   * answers "what is the one scheme to show a reader for this engine", not "what will parse".
   *
   * `tests/unit/lib/connection-string-parser.test.ts` pins the schemes against the parser
   * itself - every scheme must round-trip to its own `DatabaseType` - so they cannot
   * drift away from the parser's `startsWith` checks without failing CI.
   */
  readonly scheme: string | null;
  /** The TLS a URL carries in its QUERY STRING, for the engines that put it there, otherwise `null`. */
  readonly readTls: ((params: QueryParams) => TLSIntent) | null;
  /**
   * The checks the engine's provider makes before any socket, run at load on the fields the seed file writes (SF-038),
   * each skipped for a field `isReference` says holds a reference; `null` for an engine not checked at load.
   */
  readonly validateSeed:
    | ((conn: SeedCheckedFields, isReference: (value: string | undefined) => boolean) => readonly SeedFieldRefusal[])
    | null;
}
