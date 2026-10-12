/**
 * The fixed shape of a stream read: nine columns, in order, one row per delivered message.
 *
 * `describeObject` and `describeObjects` answer a stream's columns from this table with no broker read, so MCP
 * `inspect_schema` and plan mode see the same shape a read returns.
 */
import type { ColumnSchema } from "@/lib/types";

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
