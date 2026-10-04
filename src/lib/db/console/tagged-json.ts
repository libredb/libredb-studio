/**
 * The JSON values a console body is read into (vector-family spec 3.4).
 *
 * A number keeps the text it was typed as, so no integer ever passes through a JavaScript number on its way to
 * the wire: an integer literal, one with no fraction and no exponent whatever its size, is a `TaggedInt` holding
 * its digits, and any other number literal is a `TaggedFloat` holding its text. The two node classes are private
 * to this file and their instances are frozen; `taggedNumber` builds them from a number literal and nothing else
 * does, and the parser builds every object on `Object.create(null)`, so no JSON text can produce a tag:
 * `{"kind": "int", "digits": "42"}` is an object wherever it appears.
 */

class TaggedIntNode {
  declare private readonly brand: "int";
  readonly digits: string;

  constructor(digits: string) {
    this.digits = digits;
    Object.freeze(this);
  }
}

class TaggedFloatNode {
  declare private readonly brand: "float";
  readonly text: string;

  constructor(text: string) {
    this.text = text;
    Object.freeze(this);
  }
}

/** An integer literal, `-`? and digits, exactly as typed. */
export type TaggedInt = InstanceType<typeof TaggedIntNode>;
/** A number literal with a fraction or an exponent, its text kept. */
export type TaggedFloat = InstanceType<typeof TaggedFloatNode>;
export type TaggedJson =
  | string
  | number
  | boolean
  | null
  | TaggedInt
  | TaggedFloat
  | readonly TaggedJson[]
  | TaggedObject;
/** A JSON object, always built on `Object.create(null)`. */
export interface TaggedObject {
  readonly [key: string]: TaggedJson;
}
/** The integer ranges a request field takes. */
export type IntRange = "int64" | "uint64" | "uint32" | "safe";

const NUMBER_LITERAL = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

/** The tagged value of one JSON number literal; anything else is a programming error and throws. */
export function taggedNumber(literal: string): TaggedInt | TaggedFloat {
  const match = NUMBER_LITERAL.exec(literal);
  if (match === null) throw new Error(`Not a JSON number literal: ${literal}`);
  return match[1] === undefined && match[2] === undefined ? new TaggedIntNode(literal) : new TaggedFloatNode(literal);
}

export function isTaggedInt(value: TaggedJson): value is TaggedInt {
  return value instanceof TaggedIntNode;
}

export function isTaggedFloat(value: TaggedJson): value is TaggedFloat {
  return value instanceof TaggedFloatNode;
}

const RANGES: Readonly<Record<IntRange, { readonly min: string; readonly max: string }>> = {
  int64: { min: "-9223372036854775808", max: "9223372036854775807" },
  uint64: { min: "0", max: "18446744073709551615" },
  uint32: { min: "0", max: "4294967295" },
  safe: { min: "-9007199254740991", max: "9007199254740991" },
};

/** Whether the integer lies in the range, compared as BigInt so no digit is lost. */
export function checkIntRange(value: TaggedInt, range: IntRange): boolean {
  const integer = BigInt(value.digits);
  const bounds = RANGES[range];
  return integer >= BigInt(bounds.min) && integer <= BigInt(bounds.max);
}

/** A number Studio produced, never a user's literal: its shortest decimal, with `.0` when it is integral. */
function producedNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`A non-finite number cannot be written as JSON: ${value}`);
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

/**
 * The JSON text of a value: a `TaggedInt` as its digits, for a caller that has checked its range; a `TaggedFloat`
 * as its typed text; a number Studio produced as its shortest decimal, `.0` added when integral; and a
 * non-finite number throws, because only a programming error produces one.
 */
export function toJsonText(value: TaggedJson): string {
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return producedNumber(value);
  if (isTaggedInt(value)) return value.digits;
  if (isTaggedFloat(value)) return value.text;
  if (Array.isArray(value)) return `[${value.map(toJsonText).join(",")}]`;
  const object = value as TaggedObject;
  return `{${Object.keys(object)
    .map((key) => `${JSON.stringify(key)}:${toJsonText(object[key])}`)
    .join(",")}}`;
}
