import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AGENT_EXECUTION_ENGINES, namedList } from "@/lib/agent/engine-support";
import { getDBConfig } from "@/lib/db-ui-config";
import { ExecutionProfileError } from "@/lib/db/errors";
import type { PreparedQuery } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import type { ManagedConnection } from "@/lib/seed";
import type { QueryResult } from "@/lib/types";
import {
  newMcpCorrelationId,
  recordMcpDecision,
  recordMcpOutcome,
  type McpCallRecord,
  type McpToolAuditReason,
} from "../audit";
import {
  MCP_CONNECTIONS_UNREADABLE,
  MCP_CONNECTIONS_UNREADABLE_TEXT,
  type McpConnectionContext,
  type McpToolCall,
} from "../context";
import { checkReadOnlyStatement } from "../guards/execution-fence";
import {
  engineError,
  MCP_CANCELLED_TEXT,
  MCP_ENGINE_ERROR_PREFIX,
  MCP_NOT_VISIBLE_TEXT,
  MCP_PROVIDER_BYTE_CAP,
  MCP_PROVIDER_ROW_CAP,
  MCP_READ_ONLY_ANNOTATIONS,
  MCP_RESULT_CAP_BYTES,
  MCP_UNTRUSTED_NOTICE,
  ownWordsError,
  recordOrRefuse,
  untrustedResult,
  withByteSize,
  type ToolResult,
} from "../output";
import { redactError, safeSerialize } from "../serializer";
import {
  classifyReadQueryFailure,
  fenceRefusalText,
  MORE_ROWS_THAN_PAGEABLE_HINT,
  nextPageHint,
  offsetRefusalText,
  profileRefusalText,
  raceDeadline,
  ROW_OVER_CAP_TEXT,
  timeoutText,
} from "./read-query-limits";

/**
 * run_read_query (#246): one read-only statement, on an engine that can bound it itself.
 *
 * The boundary is the agent-read-only acquisition and the provider's queryReadOnly, which the
 * factory refuses to hand out for an engine without one; this module never calls query(), and that
 * is what makes its readOnlyHint true. The execution fence runs first as defence in depth. One
 * deadline, the call's start plus timeout_ms, covers acquisition and execution; neither a cancel
 * nor the deadline stops a statement already running (docs/BACKLOG.md D122), they end the wait.
 *
 * Rows are fetched one past the page, so the extra row proves more exist, cut to max_rows, then
 * cut to the result cap by binary search. offset on a query the provider did not rewrite is
 * refused before anything runs, because the provider would answer the first page labelled with
 * the requested offset.
 */

export const RunReadQueryInputSchema = z.object({
  connection_id: z.string().min(1, "connection_id is required"),
  sql: z.string().min(1, "SQL cannot be empty"),
  max_rows: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
  timeout_ms: z.number().int().min(500).max(30000).default(10000),
});

const RunReadQueryOutputSchema = z.object({
  connection_id: z.string(),
  columns: z.array(z.object({ name: z.string(), type: z.string().optional() })),
  rows: z.array(z.record(z.string(), z.unknown())),
  row_count: z.number().int(),
  truncated: z.boolean(),
  truncated_by: z.enum(["max_rows", "result_bytes"]).nullable(),
  pagination: z.object({
    offset: z.number().int(),
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextOffset: z.number().int().nullable(),
    wasLimited: z.boolean(),
  }),
  hint: z.string().nullable(),
  byte_size: z.number().int(),
  execution_time_ms: z.number(),
});

export type RunReadQueryInput = z.infer<typeof RunReadQueryInputSchema>;

const RUN_READ_QUERY_TITLE = "Run a read-only query";
/** Derived from the one engine list, as src/lib/agent/posture.ts derives its own sentence. */
export const RUN_READ_QUERY_ENGINES = namedList(AGENT_EXECUTION_ENGINES.map((type) => getDBConfig(type).label));
export const RUN_READ_QUERY_DESCRIPTION = `Run one read-only SQL statement on a connection: a SELECT (a WITH is fine), VALUES, TABLE, or EXPLAIN without ANALYZE. Runs on ${RUN_READ_QUERY_ENGINES}; other engines refuse it, so use inspect_schema there. Returns at most max_rows rows (default 100, at most 500) and at most 32 KiB; truncated and pagination.hasMore say when rows were cut, and pagination.nextOffset is the offset of the next page when the query can be paged. ${MCP_UNTRUSTED_NOTICE}`;

/** A result, and the reason its outcome event records when it is a failure. */
type Answer = readonly [ToolResult, McpToolAuditReason?];

/**
 * The answer to a step that failed. A failure answered as the timeout can be a real engine or
 * connection error that settled after the deadline, so the provider's own message, redacted, goes
 * to the server log with the call's correlation id, and never to the client.
 */
function failureAnswer(
  error: unknown,
  settledAt: number,
  deadline: number,
  timeoutMs: number,
  record: McpCallRecord,
): Answer {
  const failure = classifyReadQueryFailure(error, settledAt, deadline);
  if (failure.kind === "timeout") {
    logger.warn("MCP run_read_query answered a provider failure as the timeout", {
      route: "/api/mcp",
      error: redactError(error).message,
      connection: record.connectionName,
      correlationId: record.correlationId,
    });
    return [ownWordsError(timeoutText(timeoutMs)), "mcp_timeout"];
  }
  if (failure.kind === "too-large") return [ownWordsError(failure.text), "mcp_result_too_large"];
  return [engineError(MCP_ENGINE_ERROR_PREFIX, failure.error), "mcp_execution_failed"];
}

function resultOf(args: RunReadQueryInput, prepared: PreparedQuery, raw: QueryResult): Answer {
  const all = safeSerialize(raw.rows);
  const page = all.slice(0, args.max_rows);
  const columns = raw.fields.map((name) => {
    const type = raw.columnTypes?.[name];
    return type === undefined ? { name } : { name, type };
  });
  const build = (count: number) => {
    const truncatedBy = count < page.length ? "result_bytes" : all.length > args.max_rows ? "max_rows" : null;
    const hasMore = all.length > count;
    const nextOffset = hasMore && prepared.wasLimited ? args.offset + count : null;
    return withByteSize(
      {
        connection_id: args.connection_id,
        columns,
        rows: page.slice(0, count),
        row_count: count,
        truncated: truncatedBy !== null,
        truncated_by: truncatedBy,
        pagination: { offset: args.offset, limit: args.max_rows, hasMore, nextOffset, wasLimited: prepared.wasLimited },
        hint: nextOffset !== null ? nextPageHint(nextOffset) : hasMore ? MORE_ROWS_THAN_PAGEABLE_HINT : null,
        byte_size: 0,
        execution_time_ms: raw.executionTime,
      },
      untrustedResult,
    );
  };
  const whole = build(page.length);
  if (whole.bytes <= MCP_RESULT_CAP_BYTES) return [whole.result];
  let fits = 0;
  let fails = page.length;
  while (fails - fits > 1) {
    const middle = Math.floor((fits + fails) / 2);
    if (build(middle).bytes <= MCP_RESULT_CAP_BYTES) fits = middle;
    else fails = middle;
  }
  return fits === 0 ? [ownWordsError(ROW_OVER_CAP_TEXT), "mcp_result_too_large"] : [build(fits).result];
}

async function execute(
  args: RunReadQueryInput,
  call: McpToolCall,
  connection: ManagedConnection,
  record: McpCallRecord,
  deadline: number,
): Promise<Answer> {
  const acquired = await raceDeadline(() => call.context.acquire(connection, "agent-read-only"), call.signal, deadline);
  if (acquired.kind === "cancelled") return [ownWordsError(MCP_CANCELLED_TEXT), "mcp_cancelled"];
  if (acquired.kind === "timeout") return [ownWordsError(timeoutText(args.timeout_ms)), "mcp_timeout"];
  if (acquired.kind === "failed") {
    return acquired.error instanceof ExecutionProfileError
      ? [ownWordsError(profileRefusalText(acquired.error.message, RUN_READ_QUERY_ENGINES)), "mcp_execution_failed"]
      : failureAnswer(acquired.error, acquired.settledAt, deadline, args.timeout_ms, record);
  }
  const provider = acquired.value;
  const queryReadOnly = provider.queryReadOnly?.bind(provider);
  if (queryReadOnly === undefined) {
    // The profile seam refuses such a provider, so this is a server fault; query() is never the fallback.
    const refusal = profileRefusalText(
      "the acquired provider exposes no read-only execution path",
      RUN_READ_QUERY_ENGINES,
    );
    return [ownWordsError(refusal), "mcp_execution_failed"];
  }
  const prepared = provider.prepareQuery(args.sql, { limit: args.max_rows + 1, offset: args.offset });
  if (!prepared.wasLimited && args.offset > 0) {
    return [ownWordsError(offsetRefusalText(args.sql, connection.type)), "mcp_offset_unsupported"];
  }
  const executed = await raceDeadline(
    () =>
      queryReadOnly(prepared.query, {
        maxResultRows: MCP_PROVIDER_ROW_CAP,
        maxResultBytes: MCP_PROVIDER_BYTE_CAP,
        statementTimeoutMs: Math.max(1, Math.floor(deadline - Date.now())),
      }),
    call.signal,
    deadline,
  );
  if (executed.kind === "cancelled") return [ownWordsError(MCP_CANCELLED_TEXT), "mcp_cancelled"];
  if (executed.kind === "timeout") return [ownWordsError(timeoutText(args.timeout_ms)), "mcp_timeout"];
  if (executed.kind === "failed") {
    return failureAnswer(executed.error, executed.settledAt, deadline, args.timeout_ms, record);
  }
  return resultOf(args, prepared, executed.value);
}

export async function runReadQuery(args: RunReadQueryInput, call: McpToolCall): Promise<ToolResult> {
  const startedAt = Date.now();
  const deadline = startedAt + args.timeout_ms;
  const record: McpCallRecord = {
    action: "run_read_query",
    user: call.context.caller.username,
    correlationId: newMcpCorrelationId(),
  };
  const refuse = (target: McpCallRecord, reason: McpToolAuditReason, text: string) =>
    recordOrRefuse(() => recordMcpDecision(target, reason)) ?? ownWordsError(text);

  if (call.signal.aborted) return refuse(record, "mcp_cancelled", MCP_CANCELLED_TEXT);
  const connection = await call.context.resolve(args.connection_id);
  if (connection === MCP_CONNECTIONS_UNREADABLE)
    return refuse(record, "mcp_connections_unreadable", MCP_CONNECTIONS_UNREADABLE_TEXT);
  if (connection === null) return refuse(record, "mcp_connection_not_visible", MCP_NOT_VISIBLE_TEXT);
  const resolved: McpCallRecord = { ...record, connectionName: connection.seedId };
  const violation = checkReadOnlyStatement(args.sql);
  if (violation !== null) return refuse(resolved, "mcp_statement_refused", fenceRefusalText(violation));
  const unrecorded = recordOrRefuse(() => recordMcpDecision(resolved));
  if (unrecorded !== null) return unrecorded;

  const finish = ([result, failure]: Answer): ToolResult =>
    recordOrRefuse(() => recordMcpOutcome(resolved, Date.now() - startedAt, failure)) ?? result;
  try {
    return finish(await execute(args, call, connection, resolved, deadline));
  } catch (error) {
    return finish([engineError(MCP_ENGINE_ERROR_PREFIX, error), "mcp_execution_failed"]);
  }
}

export function registerRunReadQuery(server: McpServer, context: McpConnectionContext): void {
  server.registerTool(
    "run_read_query",
    {
      title: RUN_READ_QUERY_TITLE,
      description: RUN_READ_QUERY_DESCRIPTION,
      inputSchema: RunReadQueryInputSchema,
      outputSchema: RunReadQueryOutputSchema,
      annotations: MCP_READ_ONLY_ANNOTATIONS,
    },
    (args, ctx) => runReadQuery(args, { context, signal: ctx.mcpReq.signal }),
  );
}
