/**
 * The editor text is one JSON read request (spec 5.1). The schema is strict: a key
 * this parser does not know is a mistake the caller should hear about, because
 * ignoring it would run a different read from the one they wrote. Empty text is the
 * provider's refusal, a QueryError (spec 5.1), and never reaches this parser.
 *
 * A value is refused here, before any request, when the wire cannot carry it as
 * written: a partition past Kafka's INT32, an offset past its INT64 (the client's
 * writer would throw a bare RangeError), a calendar day the month does not have
 * (Date.parse rolls it into the next month under Bun and Node alike), and an instant
 * before 1970, whose negative milliseconds ListOffsets reads as its sentinels (-1 is
 * latest, -2 earliest).
 */
import { KafkaError } from "./client";

export type ReadStart =
  | { readonly kind: "earliest" }
  | { readonly kind: "latest" }
  | { readonly kind: "offset"; readonly offset: bigint }
  | { readonly kind: "timestamp"; readonly timestampMs: bigint; readonly iso: string };

export interface ReadRequest {
  readonly topic: string;
  readonly partition?: number;
  readonly from: ReadStart;
  readonly limit: number;
}

const KAFKA_DEFAULT_READ_LIMIT = 50;

/** Kafka's own legal topic name. */
const KAFKA_TOPIC_NAME = /^[a-zA-Z0-9._-]{1,249}$/;

/** A partition id is an INT32 on the wire. */
const KAFKA_MAX_PARTITION = 2147483647;
/** An offset is an INT64 on the wire; the string form, because the number would round. */
const KAFKA_MAX_OFFSET_TEXT = "9223372036854775807";
const KAFKA_MAX_OFFSET = BigInt(KAFKA_MAX_OFFSET_TEXT);

const KEYS = new Set(["topic", "partition", "from", "limit"]);
const DIGITS = /^\d+$/;
/** An ISO-8601 instant with an explicit zone: a bare local time means different instants in the server's and the browser's zones. */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

// A function declaration, not an arrow const: TypeScript treats a call to a `never`
// function as ending control flow only when the function's type is explicit.
function refuse(message: string): never {
  throw new KafkaError("invalid-request", message);
}

export function parseReadRequest(text: string, maxLimit: number): ReadRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's own message is not repeated: under Node it quotes the start of the text.
    refuse("The read request is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    refuse('A Kafka read request is one JSON object, such as {"topic": "orders", "from": "latest"}');
  }
  const request = parsed as Record<string, unknown>;
  for (const key of Object.keys(request)) {
    if (!KEYS.has(key))
      refuse(`Unknown key ${JSON.stringify(key)} in the read request; the keys are topic, partition, from and limit`);
  }

  const topic = request.topic;
  if (typeof topic !== "string" || !KAFKA_TOPIC_NAME.test(topic)) {
    refuse(
      '"topic" is required and must be a Kafka topic name: 1 to 249 of the characters a-z, A-Z, 0-9, ".", "_" and "-"',
    );
  }

  const partition = request.partition;
  if (
    partition !== undefined &&
    !(Number.isInteger(partition) && (partition as number) >= 0 && (partition as number) <= KAFKA_MAX_PARTITION)
  ) {
    refuse(`"partition" must be a whole number from 0 to ${KAFKA_MAX_PARTITION}`);
  }

  const from = parseStart(request.from, partition !== undefined);

  // `=== undefined`, not `??`: a `"limit": null` is a wrong type to refuse, not a default to supply.
  const limit = request.limit === undefined ? KAFKA_DEFAULT_READ_LIMIT : request.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > maxLimit) {
    refuse(`"limit" must be a whole number from 1 to ${maxLimit}`);
  }

  return {
    topic: topic as string,
    ...(partition === undefined ? {} : { partition: partition as number }),
    from,
    limit: limit as number,
  };
}

function parseStart(value: unknown, hasPartition: boolean): ReadStart {
  if (value === undefined || value === "latest") return { kind: "latest" };
  if (value === "earliest") return { kind: "earliest" };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "offset") {
      if (!hasPartition) refuse('Reading from an offset needs a "partition": offsets are per partition');
      return { kind: "offset", offset: parseOffset((value as { offset: unknown }).offset) };
    }
    if (keys.length === 1 && keys[0] === "timestamp")
      return parseTimestamp((value as { timestamp: unknown }).timestamp);
  }
  return refuse('"from" is "earliest", "latest", {"offset": n} or {"timestamp": "<ISO-8601 with a zone>"}');
}

function parseOffset(value: unknown): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      refuse(
        "The offset must be a non-negative whole number; above 9007199254740991 write it as a digit string, because JSON numbers lose precision there",
      );
    }
    return BigInt(value);
  }
  if (typeof value === "string" && DIGITS.test(value)) {
    const offset = BigInt(value);
    if (offset > KAFKA_MAX_OFFSET)
      refuse(`The offset must be at most ${KAFKA_MAX_OFFSET_TEXT}, Kafka's largest offset`);
    return offset;
  }
  return refuse("The offset must be a non-negative whole number or a digit string");
}

const TIMESTAMP_FORM =
  'The timestamp must be ISO-8601 with a zone, such as "2026-09-23T00:00:00Z" or "2026-09-23T03:00:00+03:00"';

function parseTimestamp(value: unknown): ReadStart {
  const match = typeof value === "string" ? ISO_INSTANT.exec(value) : null;
  if (match === null) refuse(TIMESTAMP_FORM);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month >= 1 && month <= 12 && (day < 1 || day > daysInMonth(year, month))) {
    refuse(`The timestamp names day ${match[3]} of a month that does not have it`);
  }
  const ms = Date.parse(value as string);
  if (Number.isNaN(ms)) refuse(TIMESTAMP_FORM);
  if (ms < 0)
    refuse("The timestamp must be at or after 1970-01-01T00:00:00Z: Kafka reads an earlier instant as a sentinel");
  return { kind: "timestamp", timestampMs: BigInt(ms), iso: new Date(ms).toISOString() };
}

/** The Gregorian month length, February by the leap-year rule. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
