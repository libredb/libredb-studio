/**
 * Records to a QueryResult (spec 5.2). Pure.
 */
import { QueryError } from "@/lib/db/errors";
import type { QueryResult, QueryWarning } from "@/lib/types";
import type { KafkaRecord } from "./client";
import { decodeBytes, decodeHeaderName } from "./decode";

/** The fixed columns of a read (spec 4.2), in order. */
export const KAFKA_RESULT_FIELDS: readonly string[] = Object.freeze([
  "partition",
  "offset",
  "timestamp",
  "key",
  "key_encoding",
  "value",
  "value_encoding",
  "headers",
]);

/** The protocol's "no timestamp" value (RecordBatch.NO_TIMESTAMP), which is an absence, not an instant. */
const NO_TIMESTAMP = BigInt(-1);

/** The widest instant a JavaScript Date holds, in milliseconds either side of the epoch (ECMA-262, "Time Values and Time Range"). */
const DATE_RANGE_MS = BigInt("8640000000000000");

export interface ShapeLimits {
  readonly cellLimit: number;
}

/** The three fields rows are ordered by, which a shaped row keeps after its record is dropped. */
export type RecordOrder = Pick<KafkaRecord, "partition" | "offset" | "timestamp">;

/**
 * Timestamp, then partition, then offset (spec 5.2). Within one partition that is log order
 * only while the timestamps rise with the offsets, as under LogAppendTime or one producer's
 * clock: a producer's CreateTime can go back along the log, and the rows then follow the
 * timestamps, not the offsets.
 */
export function compareRecords(a: RecordOrder, b: RecordOrder): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  if (a.partition !== b.partition) return a.partition - b.partition;
  if (a.offset !== b.offset) return a.offset < b.offset ? -1 : 1;
  return 0;
}

/**
 * A timestamp no Date can hold is refused in words naming the record (plan D-T8-3): the protocol
 * allows any 64-bit CreateTime, and toISOString would otherwise throw a bare RangeError.
 */
function toIsoTimestamp(record: KafkaRecord): string | null {
  if (record.timestamp === NO_TIMESTAMP) return null;
  if (record.timestamp > DATE_RANGE_MS || record.timestamp < -DATE_RANGE_MS) {
    throw new QueryError(
      `The record at partition ${record.partition}, offset ${record.offset} has timestamp ${record.timestamp}, which is outside the range a date can show (${-DATE_RANGE_MS} to ${DATE_RANGE_MS} ms); read from a later offset to skip it.`,
      "kafka",
    );
  }
  return new Date(Number(record.timestamp)).toISOString();
}

/** `{}`, the text of a headers cell that holds no header. */
const EMPTY_HEADERS_LENGTH = 2;

/**
 * The headers cell, one cell like the key and the value (spec 5.4): the headers in arrival order,
 * while the text the grid renders for the cell, its JSON, stays within the cell limit. The first
 * header that would pass the limit ends the cell, so no header after it is decoded, and the cell
 * is cut. A header whose name or value was itself cut at the limit can never fit, so it ends the
 * cell too.
 */
function headersCell(
  headers: KafkaRecord["headers"],
  cellLimit: number,
): { value: Record<string, unknown>; truncated: boolean } {
  // Grouped in a Map and emitted with Object.fromEntries, which defines every name as an
  // own property: a name such as "__proto__" or "toString" is a header like any other, and
  // a plain object's `in` or assignment would lose it or merge it with Object.prototype.
  const grouped = new Map<string, unknown[]>();
  let length = EMPTY_HEADERS_LENGTH;
  let truncated = false;
  for (const [rawName, rawValue] of headers) {
    // The protocol forbids a null header name, so "null" here documents a broker that sent one.
    const name = String(decodeHeaderName(rawName, cellLimit).value);
    const value = decodeBytes(rawValue, cellLimit).value;
    const values = grouped.get(name);
    const added =
      JSON.stringify(value).length +
      (values === undefined
        ? // `,"name":` before a new name's value, with no comma before the first name.
          Number(grouped.size > 0) + JSON.stringify(name).length + 1
        : // `,` before another value of a name already held, and the array's brackets at its second.
          1 + (values.length === 1 ? 2 : 0));
    if (length + added > cellLimit) {
      truncated = true;
      break;
    }
    length += added;
    if (values === undefined) grouped.set(name, [value]);
    else values.push(value);
  }
  return {
    // A name repeated in one record becomes an array in arrival order, so no header the cell holds is lost.
    value: Object.fromEntries([...grouped].map(([name, values]) => [name, values.length === 1 ? values[0] : values])),
    truncated,
  };
}

export function shapeRecord(
  record: KafkaRecord,
  limits: ShapeLimits,
): { row: Record<string, unknown>; truncatedCells: number } {
  const key = decodeBytes(record.key, limits.cellLimit);
  const value = decodeBytes(record.value, limits.cellLimit);
  const headers = headersCell(record.headers, limits.cellLimit);
  return {
    row: {
      partition: record.partition,
      offset: record.offset.toString(),
      timestamp: toIsoTimestamp(record),
      key: key.value,
      key_encoding: key.encoding,
      value: value.value,
      value_encoding: value.encoding,
      headers: headers.value,
    },
    truncatedCells: Number(key.truncated) + Number(value.truncated) + Number(headers.truncated),
  };
}

/**
 * `hasMore` is always false: a bound the provider applied to its own result is `wasLimited`,
 * never `hasMore`, which the query route derives from its own limiter, and no offset can page
 * a Kafka read (spec 5.4, plan D0-23).
 */
export function toQueryResult(
  rows: Record<string, unknown>[],
  executionTime: number,
  limit: number,
  warnings: QueryWarning[],
  wasLimited: boolean,
): QueryResult {
  return {
    rows,
    fields: [...KAFKA_RESULT_FIELDS],
    rowCount: rows.length,
    executionTime,
    pagination: { limit, offset: 0, hasMore: false, totalReturned: rows.length, wasLimited },
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}
