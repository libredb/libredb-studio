/**
 * Key, value and header decoding (spec 5.3).
 *
 * The decoders are a declared, ordered list tried in turn (spec 3.5, open/closed), ending
 * in base64, which claims anything. The order is the point: the Confluent framing is
 * checked before UTF-8, because a framed payload can itself be valid UTF-8.
 *
 * Only a bounded prefix of a value is ever turned into text (spec 5.4, K5). A value longer
 * than `PREFIX_FACTOR * cellLimit` bytes is judged on its first bytes: its encoding is
 * `text` or `base64`, and it is never parsed as JSON. A decompressed record can be far
 * larger than anything the broker bounded, and decoding it whole would hold a second copy.
 *
 * A JSON document is answered as its parse only when the parse shows every value sent (spec
 * 5.3): an integer JSON.parse would round is quoted before the parse, so it keeps its digits as
 * a string (docs/ADDING_A_PROVIDER.md), and a document that repeats a member name, or holds a
 * number no double shows as sent, is answered as its text.
 */
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";

export type KafkaEncoding = "null" | "confluent" | "json" | "text" | "base64";

export interface DecodedCell {
  readonly value: unknown;
  readonly encoding: KafkaEncoding;
  readonly truncated: boolean;
}

interface Decoder {
  /** The cell, or undefined when these bytes are not this decoder's. */
  readonly decode: (bytes: Uint8Array, cellLimit: number) => DecodedCell | undefined;
}

/**
 * Fatal: an invalid byte fails the decode instead of turning into U+FFFD, which would show data
 * that was never sent. `ignoreBOM` keeps a leading byte order mark in the text instead of
 * dropping it, so the text is the bytes as sent, and two header names that differ only by the
 * mark never collapse into one key.
 */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Magic byte 0 then a 4-byte big-endian schema id. */
const CONFLUENT_HEADER_BYTES = 5;

/**
 * UTF-8 spends at most 3 bytes per UTF-16 code unit, so this many bytes hold at least
 * `cellLimit` characters of valid text, with room for the cut to back off to a boundary.
 */
const PREFIX_FACTOR = 4;

const NULL_CELL: DecodedCell = { value: null, encoding: "null", truncated: false };

/**
 * The first `limit` UTF-16 code units, one fewer when the last one kept would be the first half
 * of a surrogate pair: a lone half renders as a replacement character, which was never sent.
 */
function cutText(text: string, limit: number): string {
  const last = text.charCodeAt(limit - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

function cell(text: string, encoding: KafkaEncoding, cellLimit: number, cut = false): DecodedCell {
  if (!cut && text.length <= cellLimit) return { value: text, encoding, truncated: false };
  return { value: cutText(text, cellLimit), encoding, truncated: true };
}

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** The first `max` bytes, backed off so no UTF-8 sequence is split (a sequence has at most 3 continuation bytes). */
function utf8Prefix(bytes: Uint8Array, max: number): Uint8Array {
  let end = Math.min(max, bytes.length);
  for (let step = 0; step < 3 && end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80; step++) end--;
  return bytes.subarray(0, end);
}

/** The character codes the scan of JSON text below reads. */
const QUOTE = '"'.charCodeAt(0);
const BACKSLASH = "\\".charCodeAt(0);
const OPEN_OBJECT = "{".charCodeAt(0);
const CLOSE_OBJECT = "}".charCodeAt(0);
const OPEN_ARRAY = "[".charCodeAt(0);
const CLOSE_ARRAY = "]".charCodeAt(0);
const COMMA = ",".charCodeAt(0);
const COLON = ":".charCodeAt(0);
const MINUS = "-".charCodeAt(0);
const PLUS = "+".charCodeAt(0);
const POINT = ".".charCodeAt(0);
const LOWER_E = "e".charCodeAt(0);
const UPPER_E = "E".charCodeAt(0);
const DIGIT_ZERO = "0".charCodeAt(0);
const DIGIT_NINE = "9".charCodeAt(0);

function isDigit(code: number): boolean {
  return code >= DIGIT_ZERO && code <= DIGIT_NINE;
}

/** What the scan finds a JSON value to be. */
const NOT_SHOWN = 0;
const SHOWN = 1;
/** Shown once `quoteUnsafeIntegers` has quoted the integers JSON.parse would round. */
const SHOWN_ONCE_QUOTED = 2;
type Shown = typeof NOT_SHOWN | typeof SHOWN | typeof SHOWN_ONCE_QUOTED;

/**
 * The fewest digits an integer past `Number.MAX_SAFE_INTEGER` has. An integer of fewer digits is exact as
 * a double; one of this many or more is exact or lies past it, and then `quoteUnsafeIntegers` quotes it,
 * so either way its digits are shown.
 */
const SAFE_INTEGER_DIGITS = String(Number.MAX_SAFE_INTEGER).length;

/**
 * A decimal of at most `EXACT_DIGITS` significant digits inside the normal range is the value of the
 * double nearest it, so no double is made to check it: no two such decimals round to one double (DBL_DIG
 * of IEEE 754 binary64), and String() of that double, the shortest decimal that rounds to it, is the one
 * sent. A mantissa of at most `EXACT_MANTISSA_DIGITS` digits and an exponent of at most
 * `EXACT_EXPONENT_DIGITS` keep a nonzero decimal between 1e-119 and 1e119, well inside that range, which
 * runs from about 2.2e-308 to 1.8e308.
 */
const EXACT_DIGITS = 15;
const EXACT_MANTISSA_DIGITS = 20;
const EXACT_EXPONENT_DIGITS = 2;

/** A decimal literal: a JSON number, or what String() writes for a finite double. */
const DECIMAL_LITERAL = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * One spelling per nonzero decimal value: the significant digits, then the power of ten that puts the
 * point before the first of them, so `1.10`, `1.1` and `0.11e1` all read `11e1`.
 */
function decimalValue(literal: string): string {
  // Only nonzero JSON number tokens and String() of a finite nonzero double reach here, and both match.
  const [, sign, whole, fraction = "", exponent = "0"] = DECIMAL_LITERAL.exec(literal) as RegExpExecArray;
  const digits = whole + fraction;
  const first = digits.search(/[1-9]/);
  return `${sign}${digits.slice(first).replace(/0+$/, "")}e${Number(exponent) + whole.length - first}`;
}

/**
 * True when the double of `token`, a JSON number that is not zero, is the number sent, as
 * JSON.stringify writes it back: finite (not an overflow to Infinity), not zero (an underflow, which
 * it writes as 0) and of the same decimal value, so no digit was lost to rounding.
 */
function doubleShows(token: string): boolean {
  const value = Number(token);
  if (!Number.isFinite(value) || value === 0) return false;
  // Most tokens are spelled as String() writes them, which needs no comparison of values.
  const written = String(value);
  return written === token || decimalValue(written) === decimalValue(token);
}

/**
 * Whether the double of the JSON number `json[start, end)` is the number sent. Another spelling of that
 * value, such as `1.10` or `1e2`, is the same number, and every spelling of zero is zero, but `-0` is
 * not: JSON.stringify writes it as 0. An integer of `SAFE_INTEGER_DIGITS` digits or more is shown once
 * quoted, as its digits.
 */
function numberShown(json: string, start: number, end: number): Shown {
  const negative = json.charCodeAt(start) === MINUS;
  // The digits before the exponent, the point left out: how many, whether a point is among them, and
  // where the first and the last digit that is not 0 are.
  let digits = 0;
  let point = false;
  let first = -1;
  let last = -1;
  let index = negative ? start + 1 : start;
  for (; index < end; index++) {
    const code = json.charCodeAt(index);
    if (code === POINT) point = true;
    else if (!isDigit(code)) break;
    else {
      if (code !== DIGIT_ZERO) {
        if (first < 0) first = digits;
        last = digits;
      }
      digits++;
    }
  }
  if (first < 0) return negative ? NOT_SHOWN : SHOWN;
  // An integer, with no point and no exponent, of that many digits is exact or quoted.
  if (!point && index === end && digits >= SAFE_INTEGER_DIGITS) return SHOWN_ONCE_QUOTED;
  // The digits of the exponent, past its e or E and its sign, if any.
  let exponentDigits = 0;
  if (index < end) {
    const sign = json.charCodeAt(index + 1);
    exponentDigits = end - index - (sign === MINUS || sign === PLUS ? 2 : 1);
  }
  if (last - first < EXACT_DIGITS && digits <= EXACT_MANTISSA_DIGITS && exponentDigits <= EXACT_EXPONENT_DIGITS) {
    return SHOWN;
  }
  return doubleShows(json.slice(start, end)) ? SHOWN : NOT_SHOWN;
}

function isNumberCharacter(code: number): boolean {
  return isDigit(code) || code === POINT || code === LOWER_E || code === UPPER_E || code === PLUS || code === MINUS;
}

/** The index just past the JSON number that starts at `start`. */
function numberEnd(json: string, start: number): number {
  let index = start + 1;
  while (isNumberCharacter(json.charCodeAt(index))) index++;
  return index;
}

/** The index just past the JSON string that opens at `start`: an escape takes the character after it. */
function stringEnd(json: string, start: number): number {
  let index = start + 1;
  while (index < json.length) {
    const code = json.charCodeAt(index);
    if (code === QUOTE) break;
    index += code === BACKSLASH ? 2 : 1;
  }
  return index + 1;
}

/**
 * Whether JSON.parse of `json`, text it accepted, shows every value sent: no object repeats a member
 * name, whose earlier values JSON.parse drops, and every number is one its double holds, or holds once
 * the quoting has run. It walks the text once, by character code, since it runs over every value the
 * JSON rule judges, and gives a number a double only when its digits cannot settle it.
 */
function valuesShown(json: string): Shown {
  // One entry per open container: an object's member names so far, or undefined for an array.
  const names: Array<Set<string> | undefined> = [];
  // The last string, number or structural character read; whitespace and the letters of true, false
  // and null leave it as it is.
  let previous = 0;
  let shown: Shown = SHOWN;
  let index = 0;
  while (index < json.length) {
    const code = json.charCodeAt(index);
    if (code === QUOTE) {
      const end = stringEnd(json, index);
      const members = names.at(-1);
      // Inside an object, a string right after `{` or `,` is a member name, decoded as JSON.parse
      // reads it; with no escape, its text between the quotes is its name.
      if (members !== undefined && (previous === OPEN_OBJECT || previous === COMMA)) {
        const raw = json.slice(index + 1, end - 1);
        const name: string = raw.includes("\\") ? JSON.parse(json.slice(index, end)) : raw;
        if (members.has(name)) return NOT_SHOWN;
        members.add(name);
      }
      index = end;
    } else if (code === MINUS || isDigit(code)) {
      const end = numberEnd(json, index);
      const number = numberShown(json, index, end);
      if (number === NOT_SHOWN) return NOT_SHOWN;
      if (number === SHOWN_ONCE_QUOTED) shown = SHOWN_ONCE_QUOTED;
      index = end;
    } else {
      index++;
      if (code === OPEN_OBJECT) names.push(new Set());
      else if (code === OPEN_ARRAY) names.push(undefined);
      else if (code === CLOSE_OBJECT || code === CLOSE_ARRAY) names.pop();
      else if (code !== COMMA && code !== COLON) continue;
    }
    previous = code;
  }
  return shown;
}

const CONFLUENT: Decoder = {
  decode: (bytes, cellLimit) => {
    if (bytes.length < CONFLUENT_HEADER_BYTES || bytes[0] !== 0x00) return undefined;
    const schemaId = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0, false);
    return cell(`schema id ${schemaId}, not decoded`, "confluent", cellLimit);
  },
};

const JSON_DOCUMENT: Decoder = {
  decode: (bytes, cellLimit) => {
    // Past the prefix bound the value is judged on its first bytes, which cannot prove JSON.
    if (bytes.length > PREFIX_FACTOR * cellLimit) return undefined;
    const text = utf8(bytes);
    const first = text?.trimStart()[0];
    if (text === undefined || (first !== "{" && first !== "[")) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    // A parse that would not show every value sent leaves the value to the text rule.
    const shown = valuesShown(text);
    if (shown === NOT_SHOWN) return undefined;
    if (text.length <= cellLimit) {
      // Quoted only once JSON.parse accepted the text as sent: on other text the quotes can make
      // JSON of what is not, such as `{12345678901234567890:1}`.
      const value = shown === SHOWN ? parsed : JSON.parse(quoteUnsafeIntegers(text));
      return { value, encoding: "json", truncated: false };
    }
    // Past the cell limit the parsed value cannot be shown whole, so its cut text is, and says so.
    return { value: cutText(text, cellLimit), encoding: "json", truncated: true };
  },
};

const TEXT: Decoder = {
  decode: (bytes, cellLimit) => {
    const cut = bytes.length > PREFIX_FACTOR * cellLimit;
    const text = utf8(cut ? utf8Prefix(bytes, PREFIX_FACTOR * cellLimit) : bytes);
    return text === undefined ? undefined : cell(text, "text", cellLimit, cut);
  },
};

/** Spec 5.3, in order. A new decoder is one more entry here, before the base64 rule. */
const DECODERS: readonly Decoder[] = [CONFLUENT, JSON_DOCUMENT, TEXT];

/**
 * The last rule, which claims any bytes: the base64 of the value's first bytes, as many whole
 * 3-byte groups as fit in the cell beside the suffix, then the whole byte length. The suffix is
 * built first and never cut, because it is the one size fact a binary value has (spec 5.3).
 */
function base64Cell(bytes: Uint8Array, cellLimit: number): DecodedCell {
  const suffix = ` (${bytes.length} bytes)`;
  // Every 3 bytes encode to 4 characters, so a cut prefix ends on a whole group and carries no "=" padding.
  const room = Math.max(0, cellLimit - suffix.length);
  const shown = bytes.subarray(0, Math.min(bytes.length, Math.floor(room / 4) * 3));
  const base64 = Buffer.from(shown.buffer, shown.byteOffset, shown.byteLength).toString("base64");
  return { value: `${base64}${suffix}`, encoding: "base64", truncated: shown.length < bytes.length };
}

export function decodeBytes(bytes: Uint8Array | null, cellLimit: number): DecodedCell {
  if (bytes === null) return NULL_CELL;
  for (const decoder of DECODERS) {
    const decoded = decoder.decode(bytes, cellLimit);
    if (decoded !== undefined) return decoded;
  }
  return base64Cell(bytes, cellLimit);
}

/**
 * A header NAME: text, or base64 when it is not UTF-8. A name is never parsed as JSON and
 * never read as a Confluent frame, because it is a key, not a payload (spec 5.2).
 */
export function decodeHeaderName(bytes: Uint8Array | null, cellLimit: number): DecodedCell {
  if (bytes === null) return NULL_CELL;
  return TEXT.decode(bytes, cellLimit) ?? base64Cell(bytes, cellLimit);
}
