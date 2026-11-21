/**
 * The one check of a connection's `type` against the `DatabaseType` union (FND-1).
 *
 * A record read from storage or from a request may carry any value in `type`: a connection saved by a newer Studio that
 * shares the same server storage, a hand-edited record, one with no type at all, or one whose type is not text. A value
 * that is not exactly a type id is refused by name, never normalised (no trimming, no lowercasing).
 *
 * The provider factory, `resolveConnection`, the `db-ui-config` lookups, the Studio connection lists, the connection
 * hook, the embedded workspace's connection adapter and the connection form hook ask this module first; so do the five
 * contract registry lookups (through `typeIdRow`) and the migration's dialect header, and the published
 * `QuerySafetyDialog`, `TestDataGenerator`, `QueryEditor` and `ResultsGrid`, the components that read a per-engine fact
 * with a type a host hands them. Not every per-engine read does yet: the capability tables (`WRITE_REACH`,
 * the `CONNECTION_FORM` helpers such as `offersSslPanel`, the destructive vocabulary and their neighbours) are still
 * read by bare index, so a new per-engine lookup is not covered by this module unless it calls it.
 *
 * The set is `SHIPPED_DATABASE_TYPES`, which the compiler holds to the union through an exhaustive Record, so this
 * module has no list of its own. Membership is a `Set` lookup, so a prototype key such as `"constructor"` is unknown
 * rather than answered by `Object.prototype`.
 */
import type { DatabaseType } from "@/lib/types";
import { SHIPPED_DATABASE_TYPES } from "./compatibility";
import { type TypeIdRefusal, UnknownProviderError } from "./errors";

export type { TypeIdRefusal } from "./errors";

const TYPE_IDS: ReadonlySet<string> = new Set(SHIPPED_DATABASE_TYPES);

/** The refusal of a connection whose `type` is missing, `null` or empty. */
export const ABSENT_TYPE_SENTENCE = "This connection names no type, so no provider in this LibreDB Studio can open it.";

/**
 * The refusal of a connection whose `type` is present and not a string: a number, a boolean, an array or an object.
 * It quotes nothing, so a value that is not text is never repeated in a sentence or a log line.
 */
export const MALFORMED_TYPE_SENTENCE =
  "This connection's type is not text, so it is not a type id, and no provider in this LibreDB Studio can open it.";

/**
 * The code points `JSON.stringify` leaves raw that could still break or reorder a line: the C1 controls (U+0080 to
 * U+009F), the line and paragraph separators (U+2028, U+2029) and the twelve bidirectional controls of Unicode's
 * Bidi_Control property (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069).
 */
const UNESCAPED_LINE_HAZARDS = /[\u0080-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * A type value quoted for a sentence or a log line. `JSON.stringify` escapes a C0 control character, the quote and the
 * backslash; the code points of `UNESCAPED_LINE_HAZARDS` are escaped as `\uXXXX` too, so the quoted value stays on one
 * line and reads in order. The value is not truncated.
 */
export function quoteTypeId(typeId: string): string {
  return JSON.stringify(typeId).replace(
    UNESCAPED_LINE_HAZARDS,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * The refusal of a connection whose `type` names no provider, with the value quoted by `quoteTypeId`. The error that
 * carries it keeps the value as given in `typeId`.
 */
export function unknownTypeSentence(typeId: string): string {
  return `No provider for the connection type ${quoteTypeId(typeId)} is installed in this LibreDB Studio.`;
}

/** Whether `value` is exactly one of the type ids this Studio has a provider for. */
export function isDatabaseType(value: unknown): value is DatabaseType {
  return typeof value === "string" && TYPE_IDS.has(value);
}

/** `null` for a type id, otherwise why the value is refused and the sentence that says so. */
export function typeIdRefusal(value: unknown): TypeIdRefusal | null {
  if (isDatabaseType(value)) return null;
  if (value === undefined || value === null || value === "")
    return { reason: "absent", sentence: ABSENT_TYPE_SENTENCE };
  if (typeof value !== "string") return { reason: "malformed", sentence: MALFORMED_TYPE_SENTENCE };
  return { reason: "unknown", typeId: value, sentence: unknownTypeSentence(value) };
}

/**
 * Refuses a value that is not a type id with `UnknownProviderError`.
 *
 * @throws {UnknownProviderError} When `value` is absent, not text, or names no provider.
 */
export function assertDatabaseType(value: unknown): asserts value is DatabaseType {
  const refusal = typeIdRefusal(value);
  if (refusal !== null) throw new UnknownProviderError(refusal);
}

/**
 * Reads `table`'s row for `value` after `assertDatabaseType`, so a value that is not a type id is refused by name
 * before the table is read, and a prototype key such as `"constructor"` never reaches an `Object.prototype` member. A
 * total table answers its row; a partial table answers `undefined` for a type id it has no row for. The table is an
 * argument, so any module holding a per-engine table reads it through this one function.
 *
 * @throws {UnknownProviderError} When `value` is absent, not text, or names no provider.
 */
export function typeIdRow<T extends Readonly<Partial<Record<DatabaseType, unknown>>>>(
  table: T,
  value: unknown,
): T[DatabaseType] {
  assertDatabaseType(value);
  return table[value];
}
