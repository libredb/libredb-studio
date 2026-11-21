import { UnknownProviderError } from "@/lib/db/errors";
import { typeIdRefusal } from "@/lib/db/type-id";

/**
 * The values outside the `DatabaseType` union that every FND-1 boundary refuses by name, as `[label, value]` rows for
 * `test.each`, so each table that pins a refusal reads the same definition of "a value outside the union".
 *
 * - Unknown: a string that is not exactly a type id, a differently cased one, and the `Object.prototype` keys a bare
 *   index would answer with a prototype member.
 * - Absent: the empty string and `null`. `undefined` is not here: wherever a lookup takes one, it means no connection.
 * - Malformed: a value that is not a primitive string, including a `String` object and an object whose `toString`
 *   spells a type id, which a coercing read would take for that type.
 */
const UNKNOWN_TYPE_VALUES: readonly (readonly [string, string])[] = [
  ["acmefoo", "acmefoo"],
  ["Postgres", "Postgres"],
  ["constructor", "constructor"],
  ["__proto__", "__proto__"],
  ["toString", "toString"],
  ["hasOwnProperty", "hasOwnProperty"],
];

/** The absent values of `OUTSIDE_THE_UNION`: neither is no connection. */
const ABSENT_TYPE_VALUES: readonly (readonly [string, unknown])[] = [
  ["the empty string", ""],
  ["null", null],
];

/** The malformed values of `OUTSIDE_THE_UNION`. */
const MALFORMED_TYPE_VALUES: readonly (readonly [string, unknown])[] = [
  ["the number 5", 5],
  ['a String object of "mysql"', new String("mysql")],
  ['the array ["mongodb"]', ["mongodb"]],
  ['an object whose toString answers "redis"', { toString: () => "redis" }],
];

/** The three sets, unknown first. */
export const OUTSIDE_THE_UNION: readonly (readonly [string, unknown])[] = [
  ...UNKNOWN_TYPE_VALUES,
  ...ABSENT_TYPE_VALUES,
  ...MALFORMED_TYPE_VALUES,
];

/** What a refusal by name carries: the reason, the refused string for an unknown type, and the sentence. */
interface RefusalShape {
  readonly reason: string;
  readonly typeId: string | undefined;
  readonly message: string;
}

/** The shape a refusal of `value` carries, read from `typeIdRefusal`; it throws when `value` is a type id. */
export function refusalOf(value: unknown): RefusalShape {
  const refusal = typeIdRefusal(value);
  if (refusal === null) throw new Error("refusalOf was handed a type id, which no boundary refuses");
  return {
    reason: refusal.reason,
    typeId: refusal.reason === "unknown" ? refusal.typeId : undefined,
    message: refusal.sentence,
  };
}

/** The shape of an `UnknownProviderError`, as `refusalOf` gives it. */
export function shapeOfRefusal(error: UnknownProviderError): RefusalShape {
  return { reason: error.reason, typeId: error.typeId, message: error.message };
}

/**
 * Runs `call` and answers the shape of the `UnknownProviderError` it threw, or `"returned"` when it threw nothing, so a
 * table can compare it with `refusalOf(value)` and a lookup that answers a row reads as "returned". Any other error is
 * thrown again.
 */
export function refusalThrownBy(call: () => unknown): RefusalShape | "returned" {
  try {
    call();
  } catch (error) {
    if (error instanceof UnknownProviderError) return shapeOfRefusal(error);
    throw error;
  }
  return "returned";
}
