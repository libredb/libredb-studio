/**
 * The error record: what a failed call answers beside its words, as closed fields a reader can branch on.
 *
 * - `kind`: which class of failure it is, one per error class of `./errors`. A class declared elsewhere, such as a
 *   provider's own `QueryError` subclass, takes the kind of its nearest class here, so a kind decides exactly what
 *   `instanceof` decides. Any other thrown value is `internal`.
 * - `code`: the `ApiErrorCode` for every database kind, and `INTERNAL_ERROR` for `internal`; for the two execution
 *   profile kinds, the refusal's `ExecutionProfileDenyCode`, the closed code every reader of those errors branches on.
 * - `sqlState`: the five-character SQLSTATE the driver reported, when it reported one (`DatabaseError.sqlstate`).
 * - `engineCode`: an engine's own error code. Defined and read here; no error carries one yet.
 * - `outcome`: `not-sent` when the statement never reached the database, because Studio refused it before sending
 *   it or the provider's connect failed; `unknown` otherwise, since the statement may have run.
 * - `sessionState`: whether the session is in a transaction. Defined and read here; no error carries one yet.
 *
 * The record holds no text of the error: no message, detail, statement or identifier. The full record is built only
 * by `errorRecord` in src/lib/db/operations/provider-text.ts, which applies the core scrub first, so its string
 * fields are never a credential of the connection; a withheld error's record keeps its kind, code and outcome and
 * leaves out its SQLSTATE. `readErrorRecord` reads one from the wire and refuses anything
 * else by naming the field, never its value.
 *
 * The record's fields, their vocabularies and patterns are the provider contract's (`@libredb/provider-sdk/errors`,
 * docs/providers/CONTRACT.md, Errors); this module is core's reading of Studio's error classes into a record, with
 * Studio's own code vocabulary.
 *
 * Free of Node-only globals and of server-only imports, so every bundle that carries `./errors` can carry it.
 */
import {
  type ErrorRecord as ContractErrorRecord,
  ENGINE_CODE_PATTERN,
  ERROR_KINDS,
  type ErrorKind,
  EXECUTE_OUTCOMES,
  type ExecuteOutcome,
  SESSION_STATES,
  SQLSTATE_PATTERN,
} from "@libredb/provider-sdk/errors";
import { ApiErrorCode } from "@/lib/api/error-codes";
import {
  AuthenticationError,
  ByteBudgetRefusal,
  ConnectionError,
  CutValueRefusal,
  DatabaseConfigError,
  DatabaseError,
  type ExecutionProfileDenyCode,
  ExecutionProfileError,
  FacetNotOfferedError,
  OffsetUnsupportedError,
  PermissionDeniedError,
  PoolExhaustedError,
  ProviderTextWithheldError,
  QueryCancelledError,
  QueryError,
  ReadAllowanceExceededError,
  RefusedBeforeSendError,
  RowBudgetRefusal,
  SerialisedResultRefusal,
  StudioByteBudgetRefusal,
  StudioProfileRefusal,
  StudioRowBudgetRefusal,
  StudioTimeBudgetRefusal,
  StudioTimeoutRefusal,
  TimeBudgetRefusal,
  TimeoutError,
  TransactionLostError,
  UnknownProviderError,
} from "./errors";

/** The record's code: an API code, or a deny code for the two execution profile kinds. */
export type ErrorRecordCode = ApiErrorCode | ExecutionProfileDenyCode;

/** The contract's record with Studio's code vocabulary. */
export type ErrorRecord = ContractErrorRecord<ErrorRecordCode>;

/** Every deny code, held complete by its type: a code added to `ExecutionProfileDenyCode` fails typecheck here. */
const DENY_CODES: Readonly<Record<ExecutionProfileDenyCode, true>> = {
  UNSUPPORTED_PROFILE: true,
  PROFILE_UNSUPPORTED_BY_PROVIDER: true,
  PROFILE_ENGINE_NOT_REVIEWED: true,
  PROFILE_UNSUPPORTED_TARGET: true,
  PROFILE_PRIVILEGES_TOO_BROAD: true,
  PROFILE_PRIVILEGES_TOO_NARROW: true,
  PROFILE_SERVER_UNENFORCED: true,
  AGENT_CREDENTIAL_UNRESOLVABLE: true,
  AGENT_CREDENTIAL_WITH_CONNECTION_STRING: true,
  CONNECTION_SECRET_UNRESOLVABLE: true,
  AGENT_CREDENTIAL_REQUIRED: true,
  READ_ROOTS_REQUIRED: true,
};

export const EXECUTION_PROFILE_DENY_CODES = Object.keys(DENY_CODES) as readonly ExecutionProfileDenyCode[];

const API_CODES: ReadonlySet<string> = new Set(Object.values(ApiErrorCode));

/**
 * Each class's prototype and its kind. A kind is found by walking the thrown value's prototype chain to the first
 * prototype here, so the order of the entries does not matter, and no property of the error is read: a provider class
 * may have an own field of the same name and another meaning, as `TransportError`'s `kind` has.
 */
const KIND_OF_PROTOTYPE: ReadonlyMap<object, ErrorKind> = new Map<object, ErrorKind>([
  [DatabaseError.prototype, "database"],
  [DatabaseConfigError.prototype, "config"],
  [UnknownProviderError.prototype, "unknown-provider"],
  [FacetNotOfferedError.prototype, "not-offered"],
  [ConnectionError.prototype, "connection"],
  [TransactionLostError.prototype, "transaction-lost"],
  [AuthenticationError.prototype, "authentication"],
  [PermissionDeniedError.prototype, "permission"],
  [PoolExhaustedError.prototype, "pool-exhausted"],
  [QueryError.prototype, "query"],
  [OffsetUnsupportedError.prototype, "offset-unsupported"],
  [RefusedBeforeSendError.prototype, "refused-before-send"],
  [ReadAllowanceExceededError.prototype, "read-allowance-exceeded"],
  [RowBudgetRefusal.prototype, "row-budget-refusal"],
  [ByteBudgetRefusal.prototype, "byte-budget-refusal"],
  [TimeBudgetRefusal.prototype, "time-budget-refusal"],
  [CutValueRefusal.prototype, "cut-value-refusal"],
  [SerialisedResultRefusal.prototype, "serialised-result-refusal"],
  [StudioRowBudgetRefusal.prototype, "studio-row-budget-refusal"],
  [StudioByteBudgetRefusal.prototype, "studio-byte-budget-refusal"],
  [StudioTimeBudgetRefusal.prototype, "studio-time-budget-refusal"],
  [TimeoutError.prototype, "timeout"],
  [StudioTimeoutRefusal.prototype, "studio-timeout-refusal"],
  [QueryCancelledError.prototype, "cancelled"],
  [ExecutionProfileError.prototype, "execution-profile"],
  [StudioProfileRefusal.prototype, "studio-profile-refusal"],
  [ProviderTextWithheldError.prototype, "provider-text-withheld"],
]);

const PROFILE_KINDS: ReadonlySet<ErrorKind> = new Set(["execution-profile", "studio-profile-refusal"]);

/** The kind of a thrown value: its nearest class's, or `internal` when it is no error class of `./errors`. */
export function errorKind(error: unknown): ErrorKind {
  if (typeof error !== "object" || error === null) return "internal";
  for (let prototype = Object.getPrototypeOf(error); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
    const kind = KIND_OF_PROTOTYPE.get(prototype);
    if (kind !== undefined) return kind;
  }
  return "internal";
}

/** The record's code for a thrown value: its deny code, its API code or `DATABASE_ERROR`, or `INTERNAL_ERROR`. */
export function errorCode(error: unknown): ErrorRecordCode {
  const kind = errorKind(error);
  if (kind === "internal") return ApiErrorCode.INTERNAL_ERROR;
  if (PROFILE_KINDS.has(kind)) return (error as ExecutionProfileError).reasonCode;
  return (error as DatabaseError).code ?? ApiErrorCode.DATABASE_ERROR;
}

/** `not-sent` when the error says the statement never reached the database, `unknown` otherwise. */
export function errorOutcome(error: unknown): ExecuteOutcome {
  if (error instanceof DatabaseError || error instanceof ExecutionProfileError) return error.outcome ?? "unknown";
  return "unknown";
}

/** A value `readErrorRecord` refused. `field` names the field at fault; neither it nor the message holds its value. */
export class ErrorRecordError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ErrorRecordError";
    Object.setPrototypeOf(this, ErrorRecordError.prototype);
  }
}

const RECORD_KEYS: ReadonlySet<string> = new Set(["kind", "code", "sqlState", "engineCode", "outcome", "sessionState"]);

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** The optional string field `key` of `value`, refused when it is present and does not hold. */
function optional<T extends string>(
  value: Record<string, unknown>,
  key: string,
  holds: (field: unknown) => field is T,
  what: string,
): T | undefined {
  if (!(key in value)) return undefined;
  if (!holds(value[key])) throw new ErrorRecordError(key, `The error record's ${key} is not ${what}.`);
  return value[key];
}

/**
 * The record a JSON value holds, read strictly: a value that is not an object, a missing `kind` or `code`, a field
 * outside its vocabulary or pattern, a code of the wrong family for its kind, or a key the record does not define is
 * refused with an `ErrorRecordError` naming the field.
 */
export function readErrorRecord(value: unknown): ErrorRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ErrorRecordError("record", "An error record is a JSON object.");
  }
  const fields = value as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!RECORD_KEYS.has(key)) throw new ErrorRecordError(key, "The error record has a field it does not define.");
  }
  const kind = fields.kind;
  if (!isOneOf(ERROR_KINDS, kind)) throw new ErrorRecordError("kind", "The error record's kind is not an error kind.");
  const code = fields.code;
  const profile = PROFILE_KINDS.has(kind);
  if (profile ? !isOneOf(EXECUTION_PROFILE_DENY_CODES, code) : !(typeof code === "string" && API_CODES.has(code))) {
    throw new ErrorRecordError(
      "code",
      profile
        ? "The error record's code is not an execution profile deny code, which its kind takes."
        : "The error record's code is not an API error code, which its kind takes.",
    );
  }
  const sqlState = optional(
    fields,
    "sqlState",
    (field): field is string => typeof field === "string" && SQLSTATE_PATTERN.test(field),
    "a SQLSTATE",
  );
  const engineCode = optional(
    fields,
    "engineCode",
    (field): field is string => typeof field === "string" && ENGINE_CODE_PATTERN.test(field),
    "an engine code",
  );
  const outcome = optional(fields, "outcome", (field) => isOneOf(EXECUTE_OUTCOMES, field), "an execute outcome");
  const sessionState = optional(fields, "sessionState", (field) => isOneOf(SESSION_STATES, field), "a session state");
  return {
    kind,
    code: code as ErrorRecordCode,
    ...(sqlState === undefined ? {} : { sqlState }),
    ...(engineCode === undefined ? {} : { engineCode }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(sessionState === undefined ? {} : { sessionState }),
  };
}
