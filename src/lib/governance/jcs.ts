/**
 * RFC 8785 canonical JSON (JCS) for what an `lsb1` envelope binds (spec 8.2).
 *
 * A control plane and Studio each hash the canonical form of a connection definition into the additional
 * authenticated data of every envelope, so both must turn the same value into the same bytes whatever order its keys
 * arrive in. JCS gives that: no whitespace, object keys sorted by their UTF-16 code units, and strings and numbers
 * written exactly as ECMAScript's `JSON.stringify` writes them, with non-finite numbers refused.
 *
 * A definition is narrower still: strings, booleans, null, integers whose magnitude is below 2^53, and objects and
 * arrays of these, so no fraction or rounding can ever make two implementations disagree. A refusal names the JSON
 * path of the value, never the value.
 */

/** Why a value has no canonical form, or is not one a definition may hold. */
export class CanonicalJsonError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`${reason} (at ${path})`);
    this.name = "CanonicalJsonError";
  }
}

/** A JSON object as `JSON.parse` builds it: its prototype is `Object.prototype`, or null. */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Orders strings by their UTF-16 code units, as RFC 8785 section 3.2.3 sorts object keys; not by locale. */
function byCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function serialize(value: unknown, path: string): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalJsonError(path, "A number that is not finite has no JSON form");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    // Array.from visits a hole as undefined, which is refused, where JSON.stringify would write null for it.
    return `[${Array.from(value, (item, index) => serialize(item, `${path}[${index}]`)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const members = Object.keys(value)
      .sort(byCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${serialize(value[key], `${path}.${key}`)}`);
    return `{${members.join(",")}}`;
  }
  throw new CanonicalJsonError(path, "Only null, booleans, strings, finite numbers, arrays and plain objects are JSON");
}

/** The RFC 8785 canonical JSON text of `value`, which must be made of JSON values only. */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$");
}

function checkDefinitionValue(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalJsonError(path, "A definition number must be an integer whose magnitude is below 2^53");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) checkDefinitionValue(value[index], `${path}[${index}]`);
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) checkDefinitionValue(value[key], `${path}.${key}`);
    return;
  }
  throw new CanonicalJsonError(path, "A definition value must be a string, boolean, null, integer, array or object");
}

/**
 * Refuses a definition outside the values spec 8.2 admits: it must be a JSON object whose values are strings,
 * booleans, null, integers whose magnitude is below 2^53 (`Number.isSafeInteger`), and objects and arrays of these.
 */
export function assertDefinitionValues(definition: unknown): void {
  if (!isPlainObject(definition)) throw new CanonicalJsonError("$", "A definition must be a JSON object");
  checkDefinitionValue(definition, "$");
}
