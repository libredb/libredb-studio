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

/**
 * The tokens of text JSON.parse accepted: a string with its escapes, a number, or a structural
 * character. `true`, `false`, `null` and whitespace match nothing and are skipped.
 */
const JSON_TOKEN = /"(?:[^"\\]|\\["\\/bfnrtu])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],:]/g;

/** A decimal literal: a JSON number, or what String() writes for a finite double. */
const DECIMAL_LITERAL = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * One spelling per decimal value: the significant digits, then the power of ten that puts the
 * point before the first of them, so `1.10`, `1.1` and `0.11e1` all read `11e1`.
 */
function decimalValue(literal: string): string {
  // Only JSON number tokens and String() of a finite double reach here, and both always match.
  const [, sign, whole, fraction = "", exponent = "0"] = DECIMAL_LITERAL.exec(literal) as RegExpExecArray;
  const digits = whole + fraction;
  const first = digits.search(/[1-9]/);
  if (first < 0) return "0";
  return `${sign}${digits.slice(first).replace(/0+$/, "")}e${Number(exponent) + whole.length - first}`;
}

/**
 * True when a JSON number's double is the number sent, as JSON.stringify writes it back: finite
 * (not an overflow to Infinity), not negative zero (which it writes as 0), and of the same decimal
 * value, so no digit was lost to rounding or underflow. Another spelling of that value, such as
 * `1.10` or `1e2`, is the same number.
 */
function numberShowsItsValue(token: string): boolean {
  const value = Number(token);
  if (!Number.isFinite(value) || Object.is(value, -0)) return false;
  // Most tokens are spelled as String() writes them, which needs no comparison of values.
  const written = String(value);
  return written === token || decimalValue(written) === decimalValue(token);
}

/**
 * True when JSON.parse of `json`, text it accepted, shows every value sent: no object repeats a
 * member name, whose earlier values JSON.parse drops, and every number is one its double holds.
 */
function showsEveryValue(json: string): boolean {
  // One entry per open container: an object's member names so far, or undefined for an array.
  const names: Array<Set<string> | undefined> = [];
  let previous = "";
  for (const [token] of json.matchAll(JSON_TOKEN)) {
    const lead = token[0];
    if (lead === '"') {
      const members = names.at(-1);
      // Inside an object, a string right after `{` or `,` is a member name, decoded as JSON.parse
      // reads it; with no escape, its text between the quotes is its name.
      if (members !== undefined && (previous === "{" || previous === ",")) {
        const name: string = token.includes("\\") ? JSON.parse(token) : token.slice(1, -1);
        if (members.has(name)) return false;
        members.add(name);
      }
    } else if (lead === "{") names.push(new Set());
    else if (lead === "[") names.push(undefined);
    else if (lead === "}" || lead === "]") names.pop();
    else if (lead !== "," && lead !== ":" && !numberShowsItsValue(token)) return false;
    previous = lead;
  }
  return true;
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
    // Quoted only once JSON.parse accepted the text as sent: on other text the quotes can make
    // JSON of what is not, such as `{12345678901234567890:1}`.
    const exact = quoteUnsafeIntegers(text);
    // A parse that would not show every value sent leaves the value to the text rule.
    if (!showsEveryValue(exact)) return undefined;
    if (text.length <= cellLimit) {
      return { value: exact === text ? parsed : JSON.parse(exact), encoding: "json", truncated: false };
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
