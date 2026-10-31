/**
 * What an agent's RabbitMQ read answers: one row per delivered message, projected from the read's raw outcome to the
 * message's offset and body size alone, and the wording of a stop the editor would answer in part.
 *
 * The answer is built from the read loop's raw messages (`amqp/read-loop.ts`), never from a rendered row, so no body,
 * header, property, routing key or exchange is ever turned into text on this path, and no column's name comes from
 * the broker. A message carries no other metadata the agent may read: measured on 4.3.6 and 4.2.9
 * (tests/fixtures/rabbitmq/<version>/agent-boundary/), an AMQP 0-9-1 delivery from a stream holds no chunk time, only
 * the `x-stream-offset` header the read loop takes the offset from, and the `timestamp` property is the publisher's
 * own value. A cell that does not fit its column's kind refuses the whole answer, as a stored value smuggled into a
 * metadata field would look.
 *
 * Budgets refuse rather than cut: the row budget is checked against the request's own limit before anything is sent
 * (`index.ts`), the byte budget against the projected rows here, and every stop but the request's limit and the
 * stream's own end (no message within the idle window) refuses the answer instead of answering the messages read so
 * far, the 541 conversion close included.
 */
import { QueryError, TimeoutError } from "@/lib/db/errors";
import { byteBudgetSentence, measureResultBytes, TIME_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import {
  declareMetadataOnly,
  type MetadataOnlyDeclaration,
  type MetadataProjection,
  MetadataProjectionError,
  projectMetadata,
} from "@/lib/db/redaction/metadata-only";
import type { ColumnSchema, QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { RawMessage, StopReason } from "./amqp/read-loop";
import type { RabbitMQAgentOperation } from "./agent-statement";
import { IDLE_WARNING, NEXT_EMPTY_WARNING } from "./errors";
import { RABBITMQ_READ_WIRE_BYTES, RABBITMQ_RESULT_BUDGET_BYTES, RABBITMQ_TYPE } from "./limits";
import type { AgentReadOutcome } from "./read";
import type { ReadRequest } from "./request";

/** One delivered message: its offset in the stream and its declared body size, never the body or a property. */
const STREAM_MESSAGES: MetadataProjection<RawMessage> = [
  // An offset no number holds exactly is not a safe integer, so the count kind refuses the whole answer.
  { column: "offset", kind: "count", read: (message) => Number(message.offset) },
  { column: "body_bytes", kind: "count", read: (message) => message.bodySize },
];

const PROJECTIONS = Object.freeze({
  "stream messages": STREAM_MESSAGES,
} satisfies Record<RabbitMQAgentOperation, MetadataProjection<never>>);

/**
 * A stream's columns as an agent-mode handle describes them, so the grounding names the columns an agent read answers
 * and never the editor's message cells.
 */
export const RABBITMQ_AGENT_STREAM_COLUMNS: readonly ColumnSchema[] = Object.freeze(
  STREAM_MESSAGES.map(({ column }) =>
    Object.freeze({ name: column, type: "integer", nullable: false, isPrimary: false }),
  ),
);

/** What `ProviderCapabilities.metadataOnly` states for RabbitMQ: the one operation's columns and their kinds. */
export const RABBITMQ_METADATA_ONLY: MetadataOnlyDeclaration = declareMetadataOnly(PROJECTIONS);

const mebibytes = (bytes: number) => bytes / (1024 * 1024);

const REFUSED_NOT_CUT = "so the answer was refused rather than cut";

/** The sentences of an agent read the editor would have answered in part. No sentence names a broker value. */
export const RABBITMQ_AGENT_STOP_SENTENCES = {
  /** The read loop's deadline D stopped a read after the broker started it. */
  deadline: (ms: number): string =>
    `${TIME_BUDGET_PREFIX}: the read did not reach its limit within ${ms}ms, ${REFUSED_NOT_CUT}; ask for fewer messages or a later start.`,
  /** D ended the wait before the broker started the read. */
  timeout: (ms: number): string => `${TIME_BUDGET_PREFIX}: no answer within ${ms}ms`,
  budget: `The messages' bodies passed the ${mebibytes(RABBITMQ_RESULT_BUDGET_BYTES)} MiB Studio holds for one read before it reached its limit, ${REFUSED_NOT_CUT}; ask for fewer messages.`,
  wire: `The read passed the ${mebibytes(RABBITMQ_READ_WIRE_BYTES)} MiB one read may transfer before it reached its limit, ${REFUSED_NOT_CUT}; ask for fewer messages.`,
  cancel: `The read was stopped before it reached its limit, ${REFUSED_NOT_CUT}.`,
  ended: `The broker ended the read before it reached its limit (it cancelled the consumer or closed the connection), ${REFUSED_NOT_CUT}.`,
  conversion: (delivered: number): string =>
    `The broker closed the read with 541 INTERNAL_ERROR at a message it cannot convert to AMQP 0-9-1, after ${delivered} ${delivered === 1 ? "message" : "messages"}, ${REFUSED_NOT_CUT}; read a range that ends before that message, starting from an offset you have read.`,
} as const;

/** The refusal of a stop other than the request's limit and the stream's own end; undefined for those two. */
function stopRefusal(stop: StopReason, delivered: number, deadlineMs: number): string | undefined {
  switch (stop.kind) {
    case "limit":
    case "idle":
      return undefined;
    case "deadline":
      return RABBITMQ_AGENT_STOP_SENTENCES.deadline(deadlineMs);
    case "budget":
      return RABBITMQ_AGENT_STOP_SENTENCES.budget;
    case "wire":
    case "wire-oversize":
      return RABBITMQ_AGENT_STOP_SENTENCES.wire;
    case "cancel":
      return RABBITMQ_AGENT_STOP_SENTENCES.cancel;
    case "server-cancel":
    case "closed":
      return RABBITMQ_AGENT_STOP_SENTENCES.ended;
    case "conversion":
      return RABBITMQ_AGENT_STOP_SENTENCES.conversion(delivered);
  }
}

/**
 * The answer of one agent read: its projected rows, or a refusal. An idle stop is the stream's own end as far as the
 * read can tell, so it answers what it read with the one fixed warning that says so; a read from "next" that read
 * nothing says why.
 */
export function rabbitmqAgentResult(
  read: AgentReadOutcome,
  request: ReadRequest,
  budget: ReadOnlyStatementBudget,
  statement: string,
): QueryResult {
  const { messages, stop } = read.outcome;
  const refusal = stopRefusal(stop, messages.length, read.deadlineMs);
  if (refusal !== undefined) throw new QueryError(refusal, RABBITMQ_TYPE, statement);
  const projected = projectMetadata(STREAM_MESSAGES, messages);
  const bytes = measureResultBytes(projected.rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), RABBITMQ_TYPE, statement);
  }
  const fromNext = request.from.kind === "keyword" && request.from.value === "next";
  const idle =
    stop.kind === "idle" ? [{ message: fromNext && messages.length === 0 ? NEXT_EMPTY_WARNING : IDLE_WARNING }] : [];
  return {
    fields: projected.fields,
    rows: projected.rows,
    rowCount: projected.rows.length,
    executionTime: read.executionTime,
    ...(idle.length === 0 ? {} : { warnings: idle }),
  };
}

/**
 * The agent's wording of a failure, or undefined for one the provider passes on as it is. A read that D ended before
 * the broker started it is the time budget's refusal, and an answer that fits no column is the projection's own
 * sentence. Every other failure is already one of errors.ts's own sentences, picked by a reply code or a fixed
 * pattern and never quoting the broker, so it passes on unchanged.
 */
export function rabbitmqAgentFailure(error: unknown, deadlineMs: number, statement: string): QueryError | undefined {
  if (error instanceof MetadataProjectionError) return new QueryError(error.message, RABBITMQ_TYPE, statement);
  if (error instanceof TimeoutError) {
    return new QueryError(RABBITMQ_AGENT_STOP_SENTENCES.timeout(deadlineMs), RABBITMQ_TYPE, statement);
  }
  return undefined;
}
