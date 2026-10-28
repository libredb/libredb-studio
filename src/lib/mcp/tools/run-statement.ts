import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getDBConfig } from "@/lib/db-ui-config";
import { ExecutionProfileError, OffsetUnsupportedError } from "@/lib/db/errors";
import { RunReadAllowance } from "@/lib/db/read-allowance";
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
import {
  engineError,
  MCP_CALL_READ_ALLOWANCE,
  MCP_CANCELLED_TEXT,
  MCP_ENGINE_ERROR_PREFIX,
  MCP_NOT_VISIBLE_TEXT,
  MCP_PROVIDER_BYTE_CAP,
  MCP_PROVIDER_ROW_CAP,
  MCP_READ_ONLY_ANNOTATIONS,
  MCP_RESULT_CAP_BYTES,
  ownWordsError,
  recordOrRefuse,
  untrustedResult,
  withByteSize,
  type ToolResult,
} from "../output";
import { redactError, safeSerialize } from "../serializer";
import { McpDatabaseChoiceError, providerInDatabase } from "./database-choice";
import {
  classifyReadQueryFailure,
  nextPageHint,
  offsetRefusalText,
  profileRefusalText,
  raceDeadline,
  timeoutText,
} from "./read-query-limits";
import { MCP_STATEMENT_ARMS, mcpStatementToolFor, servingStatementArms, type McpStatementArm } from "./statement-arms";

/**
 * The one core every MCP statement tool runs (#246): one read-only statement, on an engine that
 * can bound it itself, in the arm's language.
 *
 * The order is run_read_query's, unchanged: signal, resolve, the served-engine gate, canonicalize, fence, the decision
 * record, `acquire(connection, "agent-read-only")`, `providerInDatabase`, for an arm that pages the provider's
 * `prepareQuery` with the row cap and offset, `queryReadOnly` under the provider budgets, the cut to max_rows and the
 * result cap, the outcome record.
 *
 * The boundary is the agent-read-only acquisition and the provider's queryReadOnly, which the factory refuses to hand
 * out for an engine without one; this module never calls query(), and that is what makes every statement tool's
 * readOnlyHint true. An engine the arm does not serve is refused before anything is acquired, naming the tool that
 * does serve it, and the arm's fence then runs as defence in depth. One deadline, the call's start plus timeout_ms,
 * covers acquisition and execution; neither a cancel nor the deadline stops a statement already running
 * (docs/BACKLOG.md D128), they end the wait.
 *
 * Rows are fetched one past the page where the arm pages, so the extra row proves more exist, cut to max_rows, then
 * cut to the result cap by binary search. offset on a query the provider did not rewrite is refused before anything
 * runs, because the provider would answer the first page labelled with the requested offset; so is an offset the
 * provider's prepareQuery refuses by throwing OffsetUnsupportedError, as the Elasticsearch and Cassandra overrides do,
 * answered in their own words. An arm that does not page sends the statement as written, and the provider's row
 * budget bounds it.
 */

/** What the core reads from a call's parsed arguments; the statement itself is under the arm's own key. */
export interface McpStatementInput {
  readonly connection_id: string;
  readonly database?: string;
  readonly max_rows: number;
  readonly offset?: number;
  readonly timeout_ms: number;
  readonly [argument: string]: unknown;
}

const StatementOutputSchema = z.object({
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

/** A result, and the reason its outcome event records when it is a failure. */
type Answer = readonly [ToolResult, McpToolAuditReason?];

/** One call: its arm, its arguments, the statement text the arm read from them, and the offset it pages from. */
interface StatementCall {
  readonly arm: McpStatementArm;
  readonly args: McpStatementInput;
  readonly statement: string;
  readonly offset: number;
}

/**
 * The answer to a step that failed. A failure answered as the timeout can be a real engine or connection error that
 * settled after the deadline, so the provider's own message, redacted, goes to the server log with the call's
 * correlation id, and never to the client.
 */
function failureAnswer(
  call: StatementCall,
  error: unknown,
  settledAt: number,
  deadline: number,
  record: McpCallRecord,
): Answer {
  const failure = classifyReadQueryFailure(error, settledAt, deadline, call.arm.tooLarge(call.statement));
  if (failure.kind === "timeout") {
    logger.warn(`MCP ${call.arm.tool} answered a provider failure as the timeout`, {
      route: "/api/mcp",
      error: redactError(error).message,
      connection: record.connectionName,
      correlationId: record.correlationId,
    });
    return [ownWordsError(timeoutText(call.args.timeout_ms)), "mcp_timeout"];
  }
  if (failure.kind === "too-large") return [ownWordsError(failure.text), "mcp_result_too_large"];
  return [engineError(MCP_ENGINE_ERROR_PREFIX, failure.error), "mcp_execution_failed"];
}

function resultOf(call: StatementCall, type: DatabaseType, prepared: PreparedQuery, raw: QueryResult): Answer {
  const { args, arm, offset } = call;
  const all = safeSerialize(raw.rows);
  const page = all.slice(0, args.max_rows);
  const columns = raw.fields.map((name) => {
    const type = raw.columnTypes?.[name];
    return type === undefined ? { name } : { name, type };
  });
  const build = (count: number) => {
    const truncatedBy = count < page.length ? "result_bytes" : all.length > args.max_rows ? "max_rows" : null;
    const hasMore = all.length > count;
    const nextOffset = hasMore && prepared.wasLimited ? offset + count : null;
    return withByteSize(
      {
        connection_id: args.connection_id,
        ...(args.database === undefined ? {} : { database: args.database }),
        columns,
        rows: page.slice(0, count),
        row_count: count,
        truncated: truncatedBy !== null,
        truncated_by: truncatedBy,
        pagination: { offset, limit: args.max_rows, hasMore, nextOffset, wasLimited: prepared.wasLimited },
        hint:
          nextOffset !== null
            ? nextPageHint(nextOffset)
            : truncatedBy !== null
              ? arm.moreRows(call.statement, type, { maxRows: args.max_rows, shown: count, cut: truncatedBy })
              : null,
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
  return fits === 0 ? [ownWordsError(arm.rowOverCap), "mcp_result_too_large"] : [build(fits).result];
}

/** The statement as the provider runs it: paged by its own prepareQuery where the arm pages, or as written. */
function prepare(
  call: StatementCall,
  provider: DatabaseProvider,
  type: DatabaseType,
): { readonly prepared: PreparedQuery } | { readonly refused: Answer } {
  const { args, offset, statement } = call;
  if (call.arm.paging === "none") {
    return { prepared: { query: statement, wasLimited: false, limit: args.max_rows, offset: 0 } };
  }
  let prepared: PreparedQuery;
  try {
    prepared = provider.prepareQuery(statement, { limit: args.max_rows + 1, offset });
  } catch (error) {
    // An engine whose SQL cannot page refuses the offset here, and its sentence says what to do instead; any other
    // failure, and this one with no offset asked for, is the engine's, never masked as an offset refusal.
    if (error instanceof OffsetUnsupportedError && offset > 0) {
      return { refused: [ownWordsError(error.message), "mcp_offset_unsupported"] };
    }
    throw error;
  }
  if (!prepared.wasLimited && offset > 0) {
    return { refused: [ownWordsError(offsetRefusalText(statement, type)), "mcp_offset_unsupported"] };
  }
  return { prepared };
}

async function execute(
  call: StatementCall,
  tool: McpToolCall,
  connection: ManagedConnection,
  record: McpCallRecord,
  deadline: number,
): Promise<Answer> {
  const { arm, args } = call;
  const acquired = await raceDeadline(() => tool.context.acquire(connection, "agent-read-only"), tool.signal, deadline);
  if (acquired.kind === "cancelled") return [ownWordsError(MCP_CANCELLED_TEXT), "mcp_cancelled"];
  if (acquired.kind === "timeout") return [ownWordsError(timeoutText(args.timeout_ms)), "mcp_timeout"];
  if (acquired.kind === "failed") {
    return acquired.error instanceof ExecutionProfileError
      ? [ownWordsError(profileRefusalText(acquired.error.message, arm.engines, arm.tool)), "mcp_execution_failed"]
      : failureAnswer(call, acquired.error, acquired.settledAt, deadline, record);
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
      arm.engines,
      arm.tool,
    );
    return [ownWordsError(refusal), "mcp_execution_failed"];
  }
  const prepared = prepare(call, provider, connection.type);
  if ("refused" in prepared) return prepared.refused;
  const { query } = prepared.prepared;
  const executed = await raceDeadline(
    () =>
      queryReadOnly(query, {
        maxResultRows: MCP_PROVIDER_ROW_CAP,
        maxResultBytes: MCP_PROVIDER_BYTE_CAP,
        statementTimeoutMs: Math.max(1, Math.floor(deadline - Date.now())),
        // A call is its own run here: a fresh allowance per call, so one call's billed reads never reach the next.
        readAllowance: new RunReadAllowance(MCP_CALL_READ_ALLOWANCE),
      }),
    tool.signal,
    deadline,
  );
  if (executed.kind === "cancelled") return [ownWordsError(MCP_CANCELLED_TEXT), "mcp_cancelled"];
  if (executed.kind === "timeout") return [ownWordsError(timeoutText(args.timeout_ms)), "mcp_timeout"];
  if (executed.kind === "failed") return failureAnswer(call, executed.error, executed.settledAt, deadline, record);
  return resultOf(call, connection.type, prepared.prepared, executed.value);
}

/** The sentence an engine this arm does not serve is refused with, naming the tool that does serve it. */
function notServedText(arm: McpStatementArm, type: DatabaseType): string {
  const elsewhere = mcpStatementToolFor(type) ?? "inspect_schema";
  return profileRefusalText(
    `this tool does not serve ${getDBConfig(type).label}; use ${elsewhere} there`,
    arm.engines,
    arm.tool,
  );
}

export async function runStatement(
  arm: McpStatementArm,
  args: McpStatementInput,
  tool: McpToolCall,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const deadline = startedAt + args.timeout_ms;
  const record: McpCallRecord = {
    action: arm.tool,
    user: tool.context.caller.username,
    correlationId: newMcpCorrelationId(),
  };
  const refuse = (target: McpCallRecord, reason: McpToolAuditReason, text: string) =>
    recordOrRefuse(() => recordMcpDecision(target, reason)) ?? ownWordsError(text);

  if (tool.signal.aborted) return refuse(record, "mcp_cancelled", MCP_CANCELLED_TEXT);
  const connection = await tool.context.resolve(args.connection_id);
  if (connection === MCP_CONNECTIONS_UNREADABLE)
    return refuse(record, "mcp_connections_unreadable", MCP_CONNECTIONS_UNREADABLE_TEXT);
  if (connection === null) return refuse(record, "mcp_connection_not_visible", MCP_NOT_VISIBLE_TEXT);
  const resolved: McpCallRecord = { ...record, connectionName: connection.seedId };
  // Ahead of the fence, so the answer names the engine rather than the statement, and of any
  // acquisition, so no provider is built or dialled for an engine this tool does not serve.
  if (!arm.types.includes(connection.type)) {
    return refuse(resolved, "mcp_execution_failed", notServedText(arm, connection.type));
  }
  const statement = arm.canonicalize(args[arm.argument]);
  if (statement === null) {
    return refuse(resolved, "mcp_statement_refused", `The ${arm.argument} carries no statement, and nothing was sent.`);
  }
  const fenced = arm.fence(statement, connection.type);
  if (fenced !== null) return refuse(resolved, "mcp_statement_refused", fenced);
  const unrecorded = recordOrRefuse(() => recordMcpDecision(resolved));
  if (unrecorded !== null) return unrecorded;

  const call: StatementCall = { arm, args, statement, offset: args.offset ?? 0 };
  const finish = ([result, failure]: Answer): ToolResult =>
    recordOrRefuse(() => recordMcpOutcome(resolved, Date.now() - startedAt, failure)) ?? result;
  try {
    return finish(await execute(call, tool, connection, resolved, deadline));
  } catch (error) {
    return finish([engineError(MCP_ENGINE_ERROR_PREFIX, error), "mcp_execution_failed"]);
  }
}

/** Every statement tool whose arm serves an engine, in record order; an arm that serves none is never listed. */
export function registerStatementTools(
  server: McpServer,
  context: McpConnectionContext,
  arms: Parameters<typeof servingStatementArms>[0] = MCP_STATEMENT_ARMS,
): void {
  for (const arm of servingStatementArms(arms)) {
    server.registerTool(
      arm.tool,
      {
        title: arm.title,
        description: arm.description,
        inputSchema: arm.inputSchema,
        outputSchema: StatementOutputSchema,
        annotations: MCP_READ_ONLY_ANNOTATIONS,
      },
      (args, ctx) => runStatement(arm, args as McpStatementInput, { context, signal: ctx.mcpReq.signal }),
    );
  }
}
