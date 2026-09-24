/**
 * Records to a QueryResult (spec 5.2). Pure.
 */
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

export interface ShapeLimits {
  readonly cellLimit: number;
}

/** The three fields rows are ordered by, which a shaped row keeps after its record is dropped. */
export type RecordOrder = Pick<KafkaRecord, "partition" | "offset" | "timestamp">;

/** Timestamp, then partition, then offset: within one partition that is log order (spec 5.2). */
export function compareRecords(a: RecordOrder, b: RecordOrder): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  if (a.partition !== b.partition) return a.partition - b.partition;
  if (a.offset !== b.offset) return a.offset < b.offset ? -1 : 1;
  return 0;
}

export function shapeRecord(
  record: KafkaRecord,
  limits: ShapeLimits,
): { row: Record<string, unknown>; truncatedCells: number } {
  const key = decodeBytes(record.key, limits.cellLimit);
  const value = decodeBytes(record.value, limits.cellLimit);
  let truncatedCells = Number(key.truncated) + Number(value.truncated);
  // Grouped in a Map and emitted with Object.fromEntries, which defines every name as an
  // own property: a name such as "__proto__" or "toString" is a header like any other, and
  // a plain object's `in` or assignment would lose it or merge it with Object.prototype.
  const grouped = new Map<string, unknown[]>();
  for (const [rawName, rawValue] of record.headers) {
    const name = decodeHeaderName(rawName, limits.cellLimit);
    const decoded = decodeBytes(rawValue, limits.cellLimit);
    truncatedCells += Number(name.truncated) + Number(decoded.truncated);
    // The protocol forbids a null header name, so "null" here documents a broker that sent one.
    const headerName = String(name.value);
    const values = grouped.get(headerName);
    if (values === undefined) grouped.set(headerName, [decoded.value]);
    else values.push(decoded.value);
  }
  return {
    row: {
      partition: record.partition,
      offset: record.offset.toString(),
      timestamp: record.timestamp === NO_TIMESTAMP ? null : new Date(Number(record.timestamp)).toISOString(),
      key: key.value,
      key_encoding: key.encoding,
      value: value.value,
      value_encoding: value.encoding,
      // A name repeated in one record becomes an array in arrival order, so no header is lost.
      headers: Object.fromEntries(
        [...grouped].map(([name, values]) => [name, values.length === 1 ? values[0] : values]),
      ),
    },
    truncatedCells,
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
