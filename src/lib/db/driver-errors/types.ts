/**
 * The driver error contract: what one database driver states about the errors it raises, for `mapDatabaseError` in
 * `src/lib/db/map-database-error.ts` to classify them.
 *
 * A row is keyed by the driver's own error fields and words, never by a type id: several providers share a driver,
 * and the classification reads the fields whichever provider handed the error over. Each row is declared beside the
 * provider that owns the driver and imports nothing that raises an error class, so the shared module builds the
 * classes from what a row answers. Every member is optional: a driver with nothing to say for one step leaves it out.
 */

/**
 * What a server's refusal of the caller is: `privilege`, a privilege the credential lacks, answered 403, or
 * `credential`, the credential itself refused, answered 401.
 */
export type AccessRefusal = "privilege" | "credential";

/** The code fields the installed drivers put on their errors, each unknown until a row reads it. */
export type DriverErrorFields = Error & {
  readonly code?: unknown;
  readonly codeName?: unknown;
  readonly sqlState?: unknown;
  readonly sqlstate?: unknown;
  readonly errno?: unknown;
  readonly number?: unknown;
  readonly errorNum?: unknown;
  readonly sqlcode?: unknown;
  readonly errcode?: unknown;
};

/** What a row decides of an error late in the mapping, after the generic timeout words. */
export type LateDriverClassification =
  | { readonly kind: "connection"; readonly message: string }
  | { readonly kind: "query"; readonly message: string; readonly keepsPosition: boolean };

/** One driver's row. `message` is always the error's message lower-cased, read once by the shared mapping. */
export interface DriverErrorClassifier {
  /** The driver's package name, which identifies the row and nothing else. */
  readonly driver: string;
  /** A refusal of the driver's own configuration, as the whole message a configuration error carries, or null. */
  readonly configRefusal?: (message: string, error: Error) => string | null;
  /** Whether the message says the login cannot open the database it names. */
  readonly missingDatabase?: (message: string) => boolean;
  /** Words of a refused credential, read only in an error that carries no code, beside the generic ones. */
  readonly credentialWords?: readonly string[];
  /** The access refusal the driver's code fields name, or undefined when they name none. */
  readonly accessRefusal?: (fields: DriverErrorFields) => AccessRefusal | undefined;
  /** Whether the error carries a code field of this driver at all, so its words are not read. */
  readonly carriesCode?: (fields: DriverErrorFields) => boolean;
  /** Whether the code fields say the statement is NOT at fault, decided before any SQLSTATE is read. */
  readonly notStatementFault?: (fields: DriverErrorFields) => boolean;
  /** Whether the code fields say the statement is at fault, or undefined when they say nothing of it. */
  readonly statementFault?: (fields: DriverErrorFields) => boolean | undefined;
  /** Whether the message is the engine's own report of a time budget that elapsed, kept as the engine wrote it. */
  readonly timeout?: (message: string) => boolean;
  /** Whether the error is the driver's report of a cancelled statement. */
  readonly cancelled?: (message: string, fields: DriverErrorFields) => boolean;
  /** A classification read from the message after the generic timeout words, or undefined for none. */
  readonly late?: (message: string, error: Error) => LateDriverClassification | undefined;
}
