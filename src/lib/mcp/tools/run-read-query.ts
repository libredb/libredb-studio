import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { namedList } from "@/lib/agent/engine-support";
import { getDBConfig } from "@/lib/db-ui-config";
import { ExecutionProfileError, OffsetUnsupportedError } from "@/lib/db/errors";
import type { DatabaseProvider, PreparedQuery } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseType, QueryResult } from "@/lib/types";
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
import { DATABASE_ARGUMENT_DESCRIPTION, McpDatabaseChoiceError, providerInDatabase } from "./database-choice";
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
  moreRowsThanPageableHint,
  nextPageHint,
  offsetRefusalText,
  profileRefusalText,
  raceDeadline,
  ROW_OVER_CAP_TEXT,
  timeoutText,
} from "./read-query-limits";
import { mcpStatementEngines } from "./served-engines";

/**
 * run_read_query (#246): one read-only statement, on an engine that can bound it itself.
 *
 * The boundary is the agent-read-only acquisition and the provider's queryReadOnly, which the
 * factory refuses to hand out for an engine without one; this module never calls query(), and that
 * is what makes its readOnlyHint true. An engine this tool does not serve (RUN_READ_QUERY_TYPES) is
 * refused before anything is acquired, and the execution fence then runs as defence in depth. One
 * deadline, the call's start plus timeout_ms, covers acquisition and execution; neither a cancel
 * nor the deadline stops a statement already running (docs/BACKLOG.md D128), they end the wait.
 *
 * Rows are fetched one past the page, so the extra row proves more exist, cut to max_rows, then
 * cut to the result cap by binary search. offset on a query the provider did not rewrite is
 * refused before anything runs, because the provider would answer the first page labelled with
 * the requested offset; so is an offset the provider's prepareQuery refuses by throwing
 * OffsetUnsupportedError, as the Elasticsearch and Cassandra overrides do, answered in their own words.
 */

export const RunReadQueryInputSchema = z.object({
  connection_id: z.string().min(1, "connection_id is required"),
  database: z.string().min(1).optional().describe(DATABASE_ARGUMENT_DESCRIPTION),
  sql: z.string().min(1, "SQL cannot be empty"),
  max_rows: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
  timeout_ms: z.number().int().min(500).max(30000).default(10000),
});

const RunReadQueryOutputSchema = z.object({
  connection_id: z.string(),
  database: z.string().optional(),
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
/**
 * The engines this tool serves, from the one served-engine resolver: those agent mode executes
 * statements on, offered to MCP by MCP_EXPOSABLE, opened to MCP statement reads by
 * MCP_STATEMENT_READ, whose statement is SQL. The description names them and runReadQuery refuses
 * every other engine before anything is acquired, both from this one list, so the tool cannot
 * advertise an engine it refuses or run on one it does not name.
 *
 * The factory's profile does not draw this line: it refuses a provider with no read-only path at
 * all. Kubernetes is executed by the agent and closed to MCP. MongoDB is offered to MCP for
 * inspect_schema, and agent mode executes its JSON command, so its provider has a read-only path,
 * but this tool's input is a SQL statement: issue #1614 (decision 2) keeps it out of this tool, and
 * docs/BACKLOG.md records the MCP tool it lacks as "MongoDB has no MCP run_read_query arm".
 */
export const RUN_READ_QUERY_TYPES: readonly DatabaseType[] = mcpStatementEngines("sql");
/** Derived from the list, as src/lib/agent/posture.ts derives its own sentence. */
export const RUN_READ_QUERY_ENGINES = namedList(RUN_READ_QUERY_TYPES.map((type) => getDBConfig(type).label));
/** Names no statement form beyond SELECT, because the others differ by engine; the refusal names the engine's own. */
export const RUN_READ_QUERY_DESCRIPTION = `Run one read-only SQL statement on a connection. A SELECT (a WITH is fine) runs on every engine it serves; a refused statement's answer names what else that engine takes. Runs on ${RUN_READ_QUERY_ENGINES}; other engines refuse it, so use inspect_schema there. Returns at most max_rows rows (default 100, at most 500) and at most 32 KiB; truncated and pagination.hasMore say when rows were cut, and pagination.nextOffset is the offset of the next page when the query can be paged. ${MCP_UNTRUSTED_NOTICE}`;

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

function resultOf(args: RunReadQueryInput, type: DatabaseType, prepared: PreparedQuery, raw: QueryResult): Answer {
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
        ...(args.database === undefined ? {} : { database: args.database }),
        columns,
        rows: page.slice(0, count),
        row_count: count,
        truncated: truncatedBy !== null,
        truncated_by: truncatedBy,
        pagination: { offset: args.offset, limit: args.max_rows, hasMore, nextOffset, wasLimited: prepared.wasLimited },
        hint: nextOffset !== null ? nextPageHint(nextOffset) : hasMore ? moreRowsThanPageableHint(type) : null,
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
  // In the database the call names, on a connection that reaches a whole server (#1530).
  let provider: DatabaseProvider;
  try {
    provider = await providerInDatabase(acquired.value, args.database);
  } catch (error) {
    if (error instanceof McpDatabaseChoiceError) return [ownWordsError(error.message), "mcp_execution_failed"];
    throw error;
  }
  const queryReadOnly = provider.queryReadOnly?.bind(provider);
  if (queryReadOnly === undefined) {
    // The profile seam refuses such a provider, so this is a server fault; query() is never the fallback.
    const refusal = profileRefusalText(
      "the acquired provider exposes no read-only execution path",
      RUN_READ_QUERY_ENGINES,
    );
    return [ownWordsError(refusal), "mcp_execution_failed"];
  }
  const offsetRefused = (): Answer => [
    ownWordsError(offsetRefusalText(args.sql, connection.type)),
    "mcp_offset_unsupported",
  ];
  let prepared: PreparedQuery;
  try {
    prepared = provider.prepareQuery(args.sql, { limit: args.max_rows + 1, offset: args.offset });
  } catch (error) {
    // An engine whose SQL cannot page refuses the offset here, and its sentence says what to do instead; any other
    // failure, and this one with no offset asked for, is the engine's, never masked as an offset refusal.
    if (error instanceof OffsetUnsupportedError && args.offset > 0) {
      return [ownWordsError(error.message), "mcp_offset_unsupported"];
    }
    throw error;
  }
  if (!prepared.wasLimited && args.offset > 0) return offsetRefused();
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
  return resultOf(args, connection.type, prepared, executed.value);
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
  // Ahead of the fence, so the answer names the engine rather than the statement, and of any
  // acquisition, so no provider is built or dialled for an engine this tool does not serve.
  if (!RUN_READ_QUERY_TYPES.includes(connection.type)) {
    const notServed = `this tool does not serve ${getDBConfig(connection.type).label}; use inspect_schema there`;
    return refuse(resolved, "mcp_execution_failed", profileRefusalText(notServed, RUN_READ_QUERY_ENGINES));
  }
  const violation = checkReadOnlyStatement(args.sql);
  if (violation !== null)
    return refuse(resolved, "mcp_statement_refused", fenceRefusalText(violation, connection.type));
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
