/**
 * The nine columns of a stream read, and one read's outcome to a QueryResult.
 *
 * Rows are in offset order, one per delivered message, never re-sorted. The row limit is `wasLimited` and no warning;
 * every other stop is one warning, listed first, then the timestamp-start note, then the rendering counts. `hasMore`
 * is always false: no offset can page a stream read, and the next read is the one a warning names.
 *
 * `describeObject` and `describeObjects` answer a stream's columns from this table with no broker read, so MCP
 * `inspect_schema` and plan mode see the same shape a read returns.
 *
 * Pure: the sentences come from errors.ts.
 */
import type { ColumnSchema, QueryResult, QueryWarning } from "@/lib/types";
import type { RawMessage, StopReason, StreamReadOutcome } from "./amqp/read-loop";
import {
  amqp10Bodies,
  budgetWarning,
  cancelWarning,
  cellsCut,
  closedWarning,
  conversionAfter,
  conversionNoRowKeyword,
  conversionNoRowNumeric,
  cutBodies,
  deadlineWarning,
  deepPayloads,
  IDLE_WARNING,
  lastIdleWarning,
  NEXT_EMPTY_WARNING,
  queryError,
  serverCancelWarning,
  TIMESTAMP_START_WARNING,
  timestampsOutOfRange,
  wireOversizeAtOffset,
  wireOversizeUnknown,
  wireWarning,
} from "./errors";
import { emptyTally, renderMessage, type RenderTally } from "./render";
import type { ReadRequest } from "./request";

/** One row of a read, as `render.ts` builds it. */
export type RabbitMQRow = {
  offset: string;
  timestamp: string | null;
  exchange: string;
  routing_key: string;
  headers: Record<string, unknown>;
  properties: Record<string, unknown>;
  payload: unknown;
  payload_encoding: "json" | "text" | "base64" | "amqp-1.0";
  payload_bytes: number;
};

const column = (name: keyof RabbitMQRow, type: string, nullable: boolean): ColumnSchema =>
  Object.freeze({ name, type, nullable, isPrimary: false });

/**
 * The nine columns. `offset` is the stream offset as a decimal string, because an int64 does not fit a JSON number;
 * `timestamp` is null when the publisher set none; `payload_bytes` is the declared body size, also for a body whose
 * first bytes only are shown.
 */
export const RABBITMQ_STREAM_COLUMNS: readonly ColumnSchema[] = Object.freeze([
  column("offset", "string", false),
  column("timestamp", "timestamp", true),
  column("exchange", "string", false),
  column("routing_key", "string", false),
  column("headers", "json", false),
  column("properties", "json", false),
  column("payload", "json", false),
  column("payload_encoding", "string", false),
  column("payload_bytes", "integer", false),
]);

/** The nine column names in order: a read result's `fields`. */
export const RABBITMQ_RESULT_FIELDS: readonly string[] = Object.freeze(RABBITMQ_STREAM_COLUMNS.map((c) => c.name));

function warning(message: string): QueryWarning {
  return { message };
}

/** The offset after the last row, which a byte stop names as the next read's start; such a stop always kept one. */
function offsetAfter(messages: readonly RawMessage[]): bigint {
  const last = messages.at(-1);
  if (last === undefined) throw new Error("a byte limit was reached with no message kept");
  return last.offset + BigInt(1);
}

function lastOffset(messages: readonly RawMessage[]): bigint | null {
  return messages.at(-1)?.offset ?? null;
}

/** The one warning a stop other than the row limit adds, or the 541 error when no row was read. */
function stopWarning(
  stop: StopReason,
  outcome: StreamReadOutcome,
  request: ReadRequest,
  deadlineSeconds: number,
): QueryWarning | undefined {
  const { messages } = outcome;
  switch (stop.kind) {
    case "limit":
      return undefined;
    case "idle":
      if (messages.length > 0 && request.from.kind === "keyword" && request.from.value === "last") {
        return warning(lastIdleWarning(request.vhost, request.stream, messages.length, messages[0].offset));
      }
      if (messages.length === 0 && request.from.kind === "keyword" && request.from.value === "next") {
        return warning(NEXT_EMPTY_WARNING);
      }
      return warning(IDLE_WARNING);
    case "budget":
      return warning(budgetWarning(offsetAfter(messages)));
    case "wire":
      return warning(wireWarning(offsetAfter(messages)));
    case "wire-oversize":
      return warning(
        stop.offset === null ? wireOversizeUnknown(lastOffset(messages)) : wireOversizeAtOffset(stop.offset),
      );
    case "deadline":
      return warning(deadlineWarning(deadlineSeconds, lastOffset(messages)));
    case "cancel":
      return warning(cancelWarning(lastOffset(messages)));
    case "server-cancel":
      return warning(serverCancelWarning(lastOffset(messages)));
    case "closed":
      return warning(closedWarning(lastOffset(messages)));
    case "conversion":
      return conversionWarning(outcome, request);
  }
}

/**
 * A 541 after consume-ok: with rows, a warning on a partial result naming the offset after which it stopped; with no
 * row, an error carrying the same guidance, so no empty result is ever presented as complete.
 */
function conversionWarning(outcome: StreamReadOutcome, request: ReadRequest): QueryWarning {
  const { messages, prefetch } = outcome;
  const last = lastOffset(messages);
  if (last !== null) return warning(conversionAfter(last, prefetch, request.vhost, request.stream));
  const { from } = request;
  if (from.kind === "offset") {
    throw queryError(conversionNoRowNumeric(from.value, prefetch, request.vhost, request.stream));
  }
  const isLast = from.kind === "keyword" && from.value === "last";
  throw queryError(conversionNoRowKeyword(request.startText, isLast, request.vhost, request.stream));
}

function tallyWarnings(tally: RenderTally): QueryWarning[] {
  const counted: [number, (count: number) => string][] = [
    [tally.timestampsOutOfRange, timestampsOutOfRange],
    [tally.cellsCut, cellsCut],
    [tally.amqp10Bodies, amqp10Bodies],
    [tally.deepPayloads, deepPayloads],
    [tally.cutBodies, cutBodies],
  ];
  return counted.filter(([count]) => count > 0).map(([count, sentence]) => warning(sentence(count)));
}

/**
 * Rows in offset order and the warnings, the stop's first; a 541 after consume-ok with no row throws its QueryError
 * instead of answering an empty result. `deadlineSeconds` is the read's deadline D, for the deadline sentence.
 */
export function buildReadResult(
  outcome: StreamReadOutcome,
  request: ReadRequest,
  executionTime: number,
  deadlineSeconds: number,
): QueryResult {
  const stop = stopWarning(outcome.stop, outcome, request, deadlineSeconds);
  const tally = emptyTally();
  const rows = outcome.messages.map((message) => renderMessage(message, request.stream, tally));
  const startsByTime = request.from.kind === "timestamp" || request.from.kind === "age";
  const warnings = [
    ...(stop === undefined ? [] : [stop]),
    ...(startsByTime ? [warning(TIMESTAMP_START_WARNING)] : []),
    ...tallyWarnings(tally),
  ];
  return {
    rows,
    fields: [...RABBITMQ_RESULT_FIELDS],
    rowCount: rows.length,
    executionTime,
    pagination: {
      limit: request.limit,
      offset: 0,
      hasMore: false,
      totalReturned: rows.length,
      wasLimited: outcome.stop.kind === "limit",
    },
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}
