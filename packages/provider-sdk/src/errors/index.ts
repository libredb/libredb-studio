/**
 * The error record's contract (docs/providers/CONTRACT.md, Errors): the closed fields a failed call answers beside its
 * words, the vocabulary and pattern of each, the kinds a provider may raise, and the driver error row contract.
 *
 * Studio's core reads its error classes into a record (src/lib/db/error-record.ts); this module states only what a
 * record may hold, so a provider, a host and a reader of an answer share one vocabulary.
 */
export type {
  AccessRefusal,
  DriverErrorClassifier,
  DriverErrorFields,
  LateDriverClassification,
} from "./driver-rows";

/**
 * Every kind, in the order of Studio's error classes (src/lib/db/errors.ts), and `internal` for any other thrown
 * value.
 */
export const ERROR_KINDS = [
  "database",
  "config",
  "unknown-provider",
  "provider-unavailable",
  "package-engine-unsupported",
  "not-offered",
  "connection",
  "transaction-lost",
  "authentication",
  "permission",
  "pool-exhausted",
  "query",
  "offset-unsupported",
  "studio-offset-refusal",
  "studio-object-model-refusal",
  "refused-before-send",
  "read-allowance-exceeded",
  "row-budget-refusal",
  "byte-budget-refusal",
  "time-budget-refusal",
  "cut-value-refusal",
  "serialised-result-refusal",
  "studio-row-budget-refusal",
  "studio-byte-budget-refusal",
  "studio-time-budget-refusal",
  "timeout",
  "studio-timeout-refusal",
  "cancelled",
  "execution-profile",
  "studio-profile-refusal",
  "provider-text-withheld",
  "internal",
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

/**
 * The kinds a provider raises, in `ERROR_KINDS` order: each is the kind of an error class provider code constructs.
 * A provider's own class takes the kind of its nearest contract class.
 */
export const PROVIDER_ERROR_KINDS = [
  "database",
  "config",
  "connection",
  "transaction-lost",
  "authentication",
  "permission",
  "pool-exhausted",
  "query",
  "offset-unsupported",
  "refused-before-send",
  "row-budget-refusal",
  "byte-budget-refusal",
  "time-budget-refusal",
  "cut-value-refusal",
  "serialised-result-refusal",
  "timeout",
  "cancelled",
  "execution-profile",
] as const satisfies readonly ErrorKind[];

export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/** The kinds only Studio's core raises, in `ERROR_KINDS` order, each with the reason no provider raises it. */
export const CORE_ERROR_KINDS = [
  /** Raised from a connection's type before any provider is built, so no provider exists to raise it. */
  "unknown-provider",
  /** Raised from a connection's type whose provider package was refused at boot, so no provider exists to raise it. */
  "provider-unavailable",
  /**
   * Raised from a connection's type an admitted provider package serves, on a request the host does not serve for such
   * an engine yet, before the package's provider is called.
   */
  "package-engine-unsupported",
  /**
   * Core refuses a facet member from the engine's declaration before build and from the provider's declared
   * capabilities after connect: a provider declares what it offers, and never discovers a feature by being called.
   */
  "not-offered",
  /**
   * Studio's refusal, raised by the legacy bridge before the provider's read path is called, of an offset the
   * provider's prepare did not apply; a provider raises `offset-unsupported`.
   */
  "studio-offset-refusal",
  /**
   * Studio's refusal, before any call, of a tree request naming a level or a kind the session's object model does not
   * state; a provider is never sent such a request.
   */
  "studio-object-model-refusal",
  /**
   * The read allowance is core's budget across an agent run, and core's allowance object raises this refusal: a
   * provider charges the allowance it is handed and lets the refusal pass unchanged, but never constructs one.
   */
  "read-allowance-exceeded",
  /** Core's refusal of a provider's answer, in Studio's voice; a provider raises `row-budget-refusal`. */
  "studio-row-budget-refusal",
  /** Core's refusal of a provider's answer, in Studio's voice; a provider raises `byte-budget-refusal`. */
  "studio-byte-budget-refusal",
  /** Core's refusal of a provider's answer, in Studio's voice; a provider raises `time-budget-refusal`. */
  "studio-time-budget-refusal",
  /** A time limit Studio's own read set; a provider raises `timeout`. */
  "studio-timeout-refusal",
  /** An execution profile refusal Studio's own code wrote; a provider raises `execution-profile`. */
  "studio-profile-refusal",
  /** Core's replacement for an error whose text held a credential of the connection, built only by core's scrub. */
  "provider-text-withheld",
  /** No class: core's reading of a thrown value that is no contract error, so a provider never raises it on purpose. */
  "internal",
] as const satisfies readonly ErrorKind[];

export type CoreErrorKind = (typeof CORE_ERROR_KINDS)[number];

/** Whether the statement may have reached the database: `not-sent` when it cannot have, `unknown` otherwise. */
export const EXECUTE_OUTCOMES = ["not-sent", "unknown"] as const;

export type ExecuteOutcome = (typeof EXECUTE_OUTCOMES)[number];

/** Whether the session is in a transaction, an aborted one included, not in one, or unknown. */
export const SESSION_STATES = ["in-transaction", "not-in-transaction", "unknown"] as const;

export type SessionState = (typeof SESSION_STATES)[number];

/**
 * The record: `kind` and `code` always, and the optional `sqlState`, `engineCode`, `outcome` and `sessionState`, each
 * in its vocabulary or pattern. It holds no text of the error. `Code` is the host's code vocabulary.
 */
export interface ErrorRecord<Code extends string = string> {
  readonly kind: ErrorKind;
  readonly code: Code;
  readonly sqlState?: string;
  readonly engineCode?: string;
  readonly outcome?: ExecuteOutcome;
  readonly sessionState?: SessionState;
}

/** A SQLSTATE: five digits or upper-case letters, with a digit, so a system code such as `EPIPE` is not read as one. */
export const SQLSTATE_PATTERN = /^(?=[A-Z]*\d)[0-9A-Z]{5}$/;

/**
 * An engine's own code: MySQL `1146`, Oracle `ORA-00942`, Db2 `-204`, SQLite `SQLITE_ERROR`, MongoDB
 * `NamespaceNotFound`.
 */
export const ENGINE_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
