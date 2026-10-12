/**
 * One delivered message to one row of the nine columns (R-S7: a payload is data).
 *
 * Headers are rendered by their wire tag, never guessed from their text; names become own properties, so a name such
 * as `__proto__` is a header like any other; bytes that are not UTF-8 are shown in the base64 form
 * `"<base64> (<n> bytes)"`. The payload decoder chain is: the AMQP 1.0 rule (the `type` property alone never decides
 * it), then JSON, then text, then base64. A JSON body nested deeper than RABBITMQ_PAYLOAD_JSON_DEPTH is shown as
 * base64, never as text, because the results grid reads a text cell that looks like JSON back as JSON and renders it
 * with no depth bound. A cut body (longer than RABBITMQ_BODY_PREFIX_BYTES) is judged on its kept prefix only, so it is
 * text or base64, never json.
 *
 * Pure: the tally counts what the result's warnings report, and no sentence is built here.
 */
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";
import type { FieldEntry, FieldValue } from "./amqp/field-table";
import type { RawMessage } from "./amqp/read-loop";
import {
  RABBITMQ_AMQP1_DESCRIPTOR_DEPTH,
  RABBITMQ_BODY_PREFIX_BYTES,
  RABBITMQ_CELL_CHARS,
  RABBITMQ_HEADER_DEPTH,
  RABBITMQ_PAYLOAD_JSON_DEPTH,
} from "./limits";
import type { RabbitMQRow } from "./results";

/** What one read's rows needed, for the warnings results.ts adds once per read. */
export interface RenderTally {
  timestampsOutOfRange: number;
  cellsCut: number;
  amqp10Bodies: number;
  deepPayloads: number;
  cutBodies: number;
}

export function emptyTally(): RenderTally {
  return { timestampsOutOfRange: 0, cellsCut: 0, amqp10Bodies: 0, deepPayloads: 0, cutBodies: 0 };
}

/**
 * Fatal, so an invalid byte fails the decode instead of becoming U+FFFD, which was never sent; `ignoreBOM` keeps a
 * leading byte order mark as sent.
 */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The header the broker adds to every stream delivery; the offset column shows it, so the headers cell does not. */
const STREAM_OFFSET_HEADER = "x-stream-offset";

/** The `type` property RabbitMQ sets on a message it converted from AMQP 1.0. */
const AMQP_1_0_TYPE = "amqp-1.0";

/** The widest instant a JavaScript Date holds, in milliseconds either side of the epoch (ECMA-262 time range). */
const DATE_RANGE_MS = BigInt("8640000000000000");

/** `{}`, the compact JSON of a headers cell with no entry. */
const EMPTY_OBJECT_LENGTH = 2;

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** `"<base64> (<n> bytes)"`, where n is the size the bytes stand for, which a cut body declares larger than its prefix. */
function base64Form(bytes: Uint8Array, declaredBytes: number): string {
  return `${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")} (${declaredBytes} bytes)`;
}

/** A name or short string: its text when it is UTF-8, else the base64 form. */
function textOrBase64(bytes: Uint8Array): string {
  return utf8(bytes) ?? base64Form(bytes, bytes.length);
}

/** AMQP timestamp seconds to ISO 8601 UTC, or the decimal seconds when no Date can hold the instant. */
function timestampText(seconds: bigint, tally: RenderTally): string {
  const ms = seconds * BigInt(1000);
  if (ms > DATE_RANGE_MS || ms < -DATE_RANGE_MS) {
    tally.timestampsOutOfRange += 1;
    return seconds.toString();
  }
  return new Date(Number(ms)).toISOString();
}

/** A float as JSON can hold it: NaN and the infinities as their names, which JSON numbers cannot spell. */
function floatValue(value: number): number | string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  return value;
}

/** The exact decimal of an AMQP `D` value: the signed integer with `scale` digits after the point. */
function decimalText(scale: number, value: number): string {
  const negative = value < 0;
  const digits = Math.abs(value)
    .toString()
    .padStart(scale + 1, "0");
  const point = digits.length - scale;
  const text = scale === 0 ? digits : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${text}` : text;
}

/** One header value by its wire tag. Tables nest at most RABBITMQ_HEADER_DEPTH deep, so this recursion is bounded. */
function fieldValue(value: FieldValue, tally: RenderTally): unknown {
  switch (value.tag) {
    case "S":
      return textOrBase64(value.bytes);
    case "x":
      return base64Form(value.bytes, value.bytes.length);
    case "t":
    case "b":
    case "B":
    case "s":
    case "u":
    case "I":
    case "i":
      return value.value;
    case "f":
    case "d":
      return floatValue(value.value);
    case "l":
    case "L":
      return value.value.toString();
    case "T":
      return timestampText(value.value, tally);
    case "D":
      return decimalText(value.scale, value.value);
    case "V":
      return null;
    case "F":
      return tableValue(value.entries, tally);
    case "A":
      return value.items.map((item) => fieldValue(item, tally));
    case "omitted":
      return `[value omitted: ${value.bytes} bytes]`;
    case "too-deep":
      return `[nested deeper than ${RABBITMQ_HEADER_DEPTH}: ${value.bytes} bytes]`;
  }
}

/**
 * Entries grouped by name in arrival order, a repeated name becoming an array, and emitted with Object.fromEntries,
 * which defines each name as an own property: `__proto__`, `constructor` and the empty name are kept as delivered.
 */
function groupEntries(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  const grouped = new Map<string, unknown[]>();
  for (const [name, value] of entries) {
    const values = grouped.get(name);
    if (values === undefined) grouped.set(name, [value]);
    else values.push(value);
  }
  return Object.fromEntries([...grouped].map(([name, values]) => [name, values.length === 1 ? values[0] : values]));
}

function tableValue(entries: readonly FieldEntry[], tally: RenderTally): Record<string, unknown> {
  return groupEntries(entries.map((entry) => [textOrBase64(entry.name), fieldValue(entry.value, tally)] as const));
}

function isStreamOffset(entry: FieldEntry): boolean {
  return entry.value.tag === "l" && utf8(entry.name) === STREAM_OFFSET_HEADER;
}

/**
 * The headers cell: entries in arrival order while the cell's compact JSON stays within RABBITMQ_CELL_CHARS; the first
 * entry that would pass it ends the cell, which is counted as cut. The broker's `x-stream-offset` is left out. Each
 * value is rendered against a tally of its own, added to the read's only when the entry is kept, so a timestamp the
 * cut dropped is not counted in the warning about timestamps shown as seconds.
 */
function headersCell(entries: readonly FieldEntry[], tally: RenderTally): Record<string, unknown> {
  const kept: (readonly [string, unknown])[] = [];
  const seen = new Map<string, number>();
  let length = EMPTY_OBJECT_LENGTH;
  for (const entry of entries) {
    if (isStreamOffset(entry)) continue;
    const name = textOrBase64(entry.name);
    const counted = emptyTally();
    const value = fieldValue(entry.value, counted);
    const count = seen.get(name) ?? 0;
    const added =
      JSON.stringify(value).length +
      (count === 0
        ? // `,"name":` before a new name's value, with no comma before the first name.
          Number(seen.size > 0) + JSON.stringify(name).length + 1
        : // `,` before another value of a name already held, and the array's brackets at its second.
          1 + (count === 1 ? 2 : 0));
    if (length + added > RABBITMQ_CELL_CHARS) {
      tally.cellsCut += 1;
      break;
    }
    // A field value counts only timestamps out of Date's range; nothing else in it is tallied.
    tally.timestampsOutOfRange += counted.timestampsOutOfRange;
    length += added;
    seen.set(name, count + 1);
    kept.push([name, value]);
  }
  return groupEntries(kept);
}

/** The basic properties other than `headers` and `timestamp`, which have columns of their own, in snake_case. */
function propertiesCell(message: RawMessage): Record<string, unknown> {
  const p = message.properties;
  const shown: Record<string, unknown> = {};
  const text = (name: string, bytes: Uint8Array | undefined) => {
    if (bytes !== undefined) shown[name] = textOrBase64(bytes);
  };
  text("content_type", p.contentType);
  text("content_encoding", p.contentEncoding);
  if (p.deliveryMode !== undefined) shown.delivery_mode = p.deliveryMode;
  if (p.priority !== undefined) shown.priority = p.priority;
  text("correlation_id", p.correlationId);
  text("reply_to", p.replyTo);
  text("expiration", p.expiration);
  text("message_id", p.messageId);
  text("type", p.type);
  text("user_id", p.userId);
  text("app_id", p.appId);
  text("cluster_id", p.clusterId);
  return shown;
}

/**
 * The first `limit` UTF-16 code units, one fewer when the last one kept would be the first half of a surrogate pair, so
 * the cut falls on a code point boundary.
 */
function cutText(text: string, limit: number): string {
  const last = text.charCodeAt(limit - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

/**
 * The kept prefix of a cut body without a UTF-8 sequence the cut split: the last sequence is dropped only when it has
 * fewer bytes than its lead byte announces.
 */
function utf8Prefix(bytes: Uint8Array): Uint8Array {
  let lead = bytes.length - 1;
  while (lead >= 0 && (bytes[lead] & 0xc0) === 0x80 && bytes.length - lead <= 3) lead--;
  const first = bytes[lead];
  const length = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
  return bytes.length - lead < length ? bytes.subarray(0, lead) : bytes;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;

/**
 * Whether the text nests deeper than RABBITMQ_PAYLOAD_JSON_DEPTH, found before any parse by a lexer that skips every
 * string up to its closing unescaped quote, so a bracket inside a string is never counted. Iterative, so no depth of
 * input reaches the stack.
 */
export function nestsTooDeep(text: string): boolean {
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === QUOTE) {
      index += 1;
      while (index < text.length && text.charCodeAt(index) !== QUOTE) {
        index += text.charCodeAt(index) === BACKSLASH ? 2 : 1;
      }
    } else if (code === OPEN_OBJECT || code === OPEN_ARRAY) {
      depth += 1;
      if (depth > RABBITMQ_PAYLOAD_JSON_DEPTH) return true;
    } else if (code === CLOSE_OBJECT || code === CLOSE_ARRAY) {
      depth -= 1;
    }
    index += 1;
  }
  return false;
}

/** The AMQP 1.0 section codes RabbitMQ leaves in a converted body, in the order they may appear. */
const SECTION_AMQP_SEQUENCE = 0x76;
const SECTION_AMQP_VALUE = 0x77;
const SECTION_FOOTER = 0x78;
const DESCRIBED = 0x00;
const SMALL_ULONG = 0x53;
const ULONG = 0x80;
/** The bytes of a full ulong: RabbitMQ 4.2 and 4.3 write a section descriptor this way, the code in the last byte. */
const ULONG_WIDTH = 8;

/**
 * The section code of the descriptor at `index` and the index just past it, or undefined when the bytes there are not
 * a section descriptor: `00 53 <code>` (smallulong) or `00 80` and eight bytes whose first seven are zero (ulong).
 */
function sectionDescriptor(bytes: Uint8Array, index: number): { code: number; next: number } | undefined {
  if (bytes[index] !== DESCRIBED) return undefined;
  if (bytes[index + 1] === SMALL_ULONG) {
    return index + 3 <= bytes.length ? { code: bytes[index + 2], next: index + 3 } : undefined;
  }
  if (bytes[index + 1] !== ULONG) return undefined;
  const last = index + 1 + ULONG_WIDTH;
  if (last >= bytes.length) return undefined;
  for (let high = index + 2; high < last; high += 1) if (bytes[high] !== 0) return undefined;
  return { code: bytes[last], next: last + 1 };
}

/** The bytes after a fixed-width constructor, by its subcategory nibble; the codes each nibble defines. */
const FIXED_WIDTHS: ReadonlyMap<number, number> = new Map([
  ...[0x40, 0x41, 0x42, 0x43, 0x44, 0x45].map((code) => [code, 0] as const),
  ...[0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56].map((code) => [code, 1] as const),
  ...[0x60, 0x61].map((code) => [code, 2] as const),
  ...[0x70, 0x71, 0x72, 0x73, 0x74].map((code) => [code, 4] as const),
  ...[0x80, 0x81, 0x82, 0x83, 0x84].map((code) => [code, 8] as const),
  ...[0x94, 0x98].map((code) => [code, 16] as const),
]);
/** Variable, compound and array constructors: the width of the size field that follows them. */
const SIZED: ReadonlyMap<number, number> = new Map([
  ...[0xa0, 0xa1, 0xa3, 0xc0, 0xc1, 0xe0].map((code) => [code, 1] as const),
  ...[0xb0, 0xb1, 0xb3, 0xd0, 0xd1, 0xf0].map((code) => [code, 4] as const),
]);

/**
 * The index just past one encoded AMQP 1.0 value at `start`, or -1 when the bytes are not one. It reads constructors
 * and size fields only and never decodes a value; every size is checked against the bytes left; a descriptor chain
 * longer than RABBITMQ_AMQP1_DESCRIPTOR_DEPTH fails.
 */
function skipValue(bytes: Uint8Array, start: number): number {
  let index = start;
  let descriptors = 0;
  while (index < bytes.length && bytes[index] === DESCRIBED) {
    descriptors += 1;
    if (descriptors > RABBITMQ_AMQP1_DESCRIPTOR_DEPTH) return -1;
    // A descriptor is itself one plain value: a symbol or a ulong.
    index = skipPlain(bytes, index + 1);
    if (index < 0) return -1;
  }
  return skipPlain(bytes, index);
}

function skipPlain(bytes: Uint8Array, start: number): number {
  if (start >= bytes.length || bytes[start] === DESCRIBED) return -1;
  const code = bytes[start];
  const fixed = FIXED_WIDTHS.get(code);
  if (fixed !== undefined) return start + 1 + fixed <= bytes.length ? start + 1 + fixed : -1;
  const sizeWidth = SIZED.get(code);
  if (sizeWidth === undefined || start + 1 + sizeWidth > bytes.length) return -1;
  const view = new DataView(bytes.buffer, bytes.byteOffset + start + 1, sizeWidth);
  const size = sizeWidth === 1 ? view.getUint8(0) : view.getUint32(0, false);
  const end = start + 1 + sizeWidth + size;
  return end <= bytes.length ? end : -1;
}

/**
 * Whether the whole body is AMQP 1.0 body sections: one amqp-value, or one or more amqp-sequence sections, then at
 * most one footer, and nothing after them. Any other order or any byte left over means it is not.
 */
export function isAmqp10Body(bytes: Uint8Array): boolean {
  let index = 0;
  let sections = 0;
  let previous = -1;
  while (index < bytes.length) {
    const descriptor = sectionDescriptor(bytes, index);
    if (descriptor === undefined) return false;
    const section = descriptor.code;
    const allowed =
      sections === 0
        ? section === SECTION_AMQP_VALUE || section === SECTION_AMQP_SEQUENCE
        : previous !== SECTION_FOOTER &&
          (section === SECTION_FOOTER || (section === SECTION_AMQP_SEQUENCE && previous === SECTION_AMQP_SEQUENCE));
    if (!allowed) return false;
    index = skipValue(bytes, descriptor.next);
    if (index < 0) return false;
    previous = section;
    sections += 1;
  }
  return sections > 0;
}

interface Payload {
  readonly payload: unknown;
  readonly encoding: RabbitMQRow["payload_encoding"];
}

function base64Payload(message: RawMessage, tally: RenderTally): string {
  const suffix = ` (${message.bodySize} bytes)`;
  // Every 3 bytes encode to 4 characters, so a cut ends on a whole group and carries no "=" padding.
  const room = Math.floor((RABBITMQ_CELL_CHARS - suffix.length) / 4) * 3;
  if (message.body.length <= room) return base64Form(message.body, message.bodySize);
  tally.cellsCut += 1;
  return base64Form(message.body.subarray(0, room), message.bodySize);
}

function textPayload(text: string, tally: RenderTally): string {
  if (text.length <= RABBITMQ_CELL_CHARS) return text;
  tally.cellsCut += 1;
  return cutText(text, RABBITMQ_CELL_CHARS);
}

function payloadCell(message: RawMessage, tally: RenderTally): Payload {
  if (message.bodySize === 0) return { payload: "", encoding: "text" };
  const cut = message.bodySize > RABBITMQ_BODY_PREFIX_BYTES;
  if (cut) {
    tally.cutBodies += 1;
    const text = utf8(utf8Prefix(message.body));
    if (text === undefined || tooDeep(text, tally))
      return { payload: base64Payload(message, tally), encoding: "base64" };
    return { payload: textPayload(text, tally), encoding: "text" };
  }
  const type = message.properties.type;
  if (type !== undefined && utf8(type) === AMQP_1_0_TYPE && isAmqp10Body(message.body)) {
    tally.amqp10Bodies += 1;
    return { payload: base64Payload(message, tally), encoding: "amqp-1.0" };
  }
  const text = utf8(message.body);
  if (text === undefined || tooDeep(text, tally)) return { payload: base64Payload(message, tally), encoding: "base64" };
  if (looksLikeJson(text)) {
    const parsed = parseJson(text);
    if (parsed !== undefined) return { payload: parsed, encoding: "json" };
  }
  return { payload: textPayload(text, tally), encoding: "text" };
}

/** Whether the text starts, after leading whitespace, as a JSON object or array does. */
function looksLikeJson(text: string): boolean {
  const first = text.trimStart().charCodeAt(0);
  return first === OPEN_OBJECT || first === OPEN_ARRAY;
}

/**
 * Whether a text that looks like JSON nests deeper than RABBITMQ_PAYLOAD_JSON_DEPTH, counted when it does. A cut body's
 * kept prefix is judged too: the results grid would read a balanced deep prefix back as JSON just the same.
 */
function tooDeep(text: string, tally: RenderTally): boolean {
  if (!looksLikeJson(text) || !nestsTooDeep(text)) return false;
  tally.deepPayloads += 1;
  return true;
}

/** The parse with every integer past 2^53 quoted, so its digits survive; undefined when the text is not JSON. */
function parseJson(text: string): unknown {
  try {
    JSON.parse(text);
  } catch {
    return undefined;
  }
  // Quoted only once JSON.parse accepted the text as sent: on other text the quotes can make JSON of what is not.
  return JSON.parse(quoteUnsafeIntegers(text));
}

export function renderMessage(message: RawMessage, stream: string, tally: RenderTally): RabbitMQRow {
  const timestamp = message.properties.timestamp;
  const { payload, encoding } = payloadCell(message, tally);
  return {
    offset: message.offset.toString(),
    timestamp: timestamp === undefined ? null : timestampText(timestamp, tally),
    exchange: textOrBase64(message.exchange),
    // A message stored without a routing key, as an AMQP 1.0 publish to the queue address is, shows the stream name.
    routing_key: message.routingKey.length === 0 ? stream : textOrBase64(message.routingKey),
    headers: headersCell(message.properties.headers ?? [], tally),
    properties: propertiesCell(message),
    payload,
    payload_encoding: encoding,
    payload_bytes: message.bodySize,
  };
}
