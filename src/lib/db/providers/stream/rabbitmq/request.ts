/**
 * The editor text is one JSON read request: `{"vhost", "stream", "from", "limit"}`, nothing else.
 *
 * Every value is checked here, before any request or socket, so a read that cannot be carried on the wire as written
 * is refused in words and never sent: a name the management API or a short string cannot address, an offset past the
 * signed 64-bit range `x-stream-offset` carries, a calendar day the month does not have, and an instant before 1970.
 * A key this parser does not know is refused by name, because ignoring it would run another read than the one written,
 * and so is a key written twice in one object, which JSON.parse would otherwise settle by keeping the last.
 *
 * Pure: no I/O, and the sentences come from errors.ts.
 */
import type { StreamOffset } from "./amqp/codec";
import {
  FROM_FORMS,
  LIMIT_RANGE,
  NAMES_REQUIRED,
  OFFSET_NOT_WHOLE,
  OFFSET_TOO_LARGE,
  queryError,
  REQUEST_NOT_OBJECT,
  repeatedRequestKey,
  TIMESTAMP_BEFORE_EPOCH,
  TIMESTAMP_DAY,
  TIMESTAMP_FORM,
  unknownRequestKey,
} from "./errors";
import { RABBITMQ_NAME_MAX_BYTES, RABBITMQ_READ_DEFAULT_ROWS, RABBITMQ_READ_MAX_ROWS } from "./limits";

export interface ReadRequest {
  readonly vhost: string;
  readonly stream: string;
  readonly from: StreamOffset;
  /** The start as Studio re-serialises it for a sentence: `"last"`, `{"offset": "120"}`, `{"age": "5m"}`. */
  readonly startText: string;
  readonly limit: number;
}

const KEYS: ReadonlySet<string> = new Set(["vhost", "stream", "from", "limit"]);
const KEYWORDS: ReadonlySet<string> = new Set(["first", "last", "next"]);
const DIGITS = /^\d+$/;
/** RabbitMQ's interval form: a positive count and one unit, Y, M (months), D, h, m (minutes) or s. */
const AGE = /^[1-9][0-9]*[YMDhms]$/;
/** An ISO-8601 instant with an explicit zone: a bare local time means another instant in another server zone. */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
/** The largest `x-stream-offset`, a signed 64-bit integer, derived rather than spelled. */
const MAX_OFFSET = (BigInt(1) << BigInt(63)) - BigInt(1);
const UTF8 = new TextEncoder();

// A function declaration, not an arrow const: TypeScript ends control flow at a call only when the type is explicit.
function refuse(sentence: string): never {
  throw queryError(sentence);
}

export function parseReadRequest(text: string): ReadRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's own message is not repeated: under Node it quotes the start of the text.
    refuse(REQUEST_NOT_OBJECT);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) refuse(REQUEST_NOT_OBJECT);
  const repeated = repeatedKey(text);
  if (repeated !== undefined) refuse(repeatedRequestKey(repeated));
  const request = parsed as Record<string, unknown>;
  for (const key of Object.keys(request)) {
    if (!KEYS.has(key)) refuse(unknownRequestKey(key));
  }
  const vhost = readName(request.vhost);
  const stream = readName(request.stream);
  const { from, startText } = readStart(request.from);
  // `=== undefined`, not `??`: a `"limit": null` is a wrong type to refuse, not a default to supply.
  const limit = request.limit === undefined ? RABBITMQ_READ_DEFAULT_ROWS : request.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > RABBITMQ_READ_MAX_ROWS) {
    refuse(LIMIT_RANGE);
  }
  return { vhost, stream, from, startText, limit: limit as number };
}

/**
 * The first key written twice in one object of `text`, which JSON.parse has already accepted, so the scan only tells
 * keys from values: a string is a key when its object expects one, and its spelling is decoded as JSON decodes it.
 */
function repeatedKey(text: string): string | undefined {
  const open: { readonly keys: Set<string> | null; expectsKey: boolean }[] = [];
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === "{" || char === "[") open.push({ keys: char === "{" ? new Set() : null, expectsKey: char === "{" });
    else if (char === "}" || char === "]") open.pop();
    else if (char === ",") {
      const top = open.at(-1) as { readonly keys: Set<string> | null; expectsKey: boolean };
      top.expectsKey = top.keys !== null;
    } else if (char === '"') {
      let end = at + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const top = open.at(-1);
      if (top?.keys && top.expectsKey) {
        const key = JSON.parse(text.slice(at, end + 1)) as string;
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        top.expectsKey = false;
      }
      at = end;
    }
  }
  return undefined;
}

/**
 * 1 to 255 UTF-8 bytes, no NUL, and not `.` or `..`, which a URL path removes as dot segments. A lone surrogate has no
 * UTF-8 form: encoding it would name another stream, so it is refused here, before any I/O.
 */
function readName(value: unknown): string {
  if (typeof value !== "string" || value === "." || value === ".." || value.includes("\u0000")) refuse(NAMES_REQUIRED);
  if (!value.isWellFormed()) refuse(NAMES_REQUIRED);
  const bytes = UTF8.encode(value).length;
  if (bytes < 1 || bytes > RABBITMQ_NAME_MAX_BYTES) refuse(NAMES_REQUIRED);
  return value;
}

function readStart(value: unknown): { from: StreamOffset; startText: string } {
  if (value === undefined) return keyword("last");
  if (typeof value === "string" && KEYWORDS.has(value)) return keyword(value as "first" | "last" | "next");
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const field = (value as Record<string, unknown>)[keys[0]];
    if (keys.length === 1 && keys[0] === "offset") {
      const offset = readOffset(field);
      return { from: { kind: "offset", value: offset }, startText: `{"offset": "${offset}"}` };
    }
    if (keys.length === 1 && keys[0] === "timestamp") return readTimestamp(field);
    if (keys.length === 1 && keys[0] === "age" && typeof field === "string" && AGE.test(field)) {
      return { from: { kind: "age", value: field }, startText: `{"age": "${field}"}` };
    }
  }
  return refuse(FROM_FORMS);
}

function keyword(value: "first" | "last" | "next"): { from: StreamOffset; startText: string } {
  return { from: { kind: "keyword", value }, startText: `"${value}"` };
}

/** A JSON number up to 2^53 - 1, or a digit string up to 2^63 - 1, which a JSON number cannot carry exactly. */
function readOffset(value: unknown): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) refuse(OFFSET_NOT_WHOLE);
    return BigInt(value);
  }
  if (typeof value === "string" && DIGITS.test(value)) {
    const offset = BigInt(value);
    if (offset > MAX_OFFSET) refuse(OFFSET_TOO_LARGE);
    return offset;
  }
  return refuse(OFFSET_NOT_WHOLE);
}

/**
 * Whole seconds, rounded down, so the second the request names is never skipped: the broker reads an AMQP timestamp,
 * which has no fraction.
 */
function readTimestamp(value: unknown): { from: StreamOffset; startText: string } {
  const match = typeof value === "string" ? ISO_INSTANT.exec(value) : null;
  if (match === null) refuse(TIMESTAMP_FORM);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Date.parse rolls a day the month does not have into the next month under Bun and Node alike.
  if (month >= 1 && month <= 12 && (day < 1 || day > daysInMonth(year, month))) refuse(TIMESTAMP_DAY);
  const ms = Date.parse(value as string);
  if (Number.isNaN(ms)) refuse(TIMESTAMP_FORM);
  if (ms < 0) refuse(TIMESTAMP_BEFORE_EPOCH);
  const seconds = BigInt(Math.floor(ms / 1000));
  const iso = new Date(Number(seconds) * 1000).toISOString();
  return { from: { kind: "timestamp", seconds }, startText: `{"timestamp": "${iso}"}` };
}

/** The Gregorian month length, February by the leap-year rule. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
