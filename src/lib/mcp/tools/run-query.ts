import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { inspectStatementShape, type AgentStatementViolation } from "@/lib/db/operations/statement-guard";
import type { DatabaseProvider, PreparedQuery } from "@/lib/db/types";
import { DEFAULT_SQL_GRAMMAR } from "@/lib/sql/grammar";
import { readLeadingKeyword } from "@/lib/sql/leading-keyword";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";
import type { ManagedConnection } from "@/lib/seed";
import type { QueryResult } from "@/lib/types";
import {
  newMcpCorrelationId,
  recordMcpDecision,
  recordMcpOutcome,
  type McpCallRecord,
  type McpStatementKind,
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
  MCP_CANCELLED_TEXT,
  MCP_ENGINE_ERROR_PREFIX,
  MCP_NOT_VISIBLE_TEXT,
  MCP_RESULT_CAP_BYTES,
  MCP_UNTRUSTED_NOTICE,
  MCP_WRITE_ANNOTATIONS,
  ownWordsError,
  recordOrRefuse,
  untrustedResult,
  withByteSize,
  type ToolResult,
} from "../output";
import { safeSerialize } from "../serializer";
import { DATABASE_ARGUMENT_DESCRIPTION, McpDatabaseChoiceError, providerInDatabase } from "./database-choice";
import {
  MORE_ROWS_THAN_PAGEABLE_HINT,
  nextPageHint,
  offsetRefusalText,
  raceDeadline,
  ROW_OVER_CAP_TEXT,
  timeoutText,
} from "./read-query-limits";

/**
 * run_query (#1774): one statement on a seed the operator opted in with mcp: "write", run under
 * the connection's own account, as the token owner may run it in the editor.
 *
 * The boundary is the seed opt-in, the role that reaches the seed, the global write switch and
 * the connection's own database account; this module never calls queryReadOnly, and it runs no
 * read-only fence, because a write is the point. The deadline and cancel semantics match
 * run_read_query: they end the wait, not a statement already running.
 */

const WRITE_WORDS: ReadonlySet<string> = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);
const DDL_WORDS: ReadonlySet<string> = new Set(["CREATE", "DROP", "ALTER", "TRUNCATE"]);
/** The heads known to read; any other head, such as GRANT, COPY, CALL or DO, is `other` (#1774). */
const READ_WORDS: ReadonlySet<string> = new Set(["SELECT", "VALUES", "TABLE", "SHOW", "EXPLAIN"]);
/** After EXPLAIN these execute the statement rather than explaining it, so the kind is `other`. */
const EXPLAIN_EXECUTES_WORDS: ReadonlySet<string> = new Set(["ANALYZE", "ANALYSE"]);

export const RunQueryInputSchema = z.object({
  connection_id: z.string().min(1, "connection_id is required"),
  database: z.string().min(1).optional().describe(DATABASE_ARGUMENT_DESCRIPTION),
  sql: z.string().min(1, "SQL cannot be empty"),
  max_rows: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
  timeout_ms: z.number().int().min(500).max(30000).default(10000),
});

const RunQueryOutputSchema = z.object({
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

export type RunQueryInput = z.infer<typeof RunQueryInputSchema>;

const RUN_QUERY_TITLE = "Run a query";
const RUN_QUERY_DESCRIPTION = `Run one SQL statement on a connection the operator opted in with mcp: "write", under the token owner's role and the seed's own account. Runs what the owner may run in the editor: a SELECT (a WITH is fine), or a write such as INSERT, UPDATE, DELETE, CREATE, DROP or ALTER. Returns at most max_rows rows (default 100, at most 500) and at most 32 KiB; truncated and pagination.hasMore say when rows were cut, and pagination.nextOffset is the offset of the next page when the query can be paged. timeout_ms ends the wait, not the statement: a write that times out may still commit, so do not retry a timed-out write blindly. ${MCP_UNTRUSTED_NOTICE}`;

/** The fixed refusal for a connection the operator opted in as read only. */
export const WRITE_NOT_OPTED_IN_TEXT =
  'run_query is not available on this connection: the operator opted it in with mcp: true, which is read only. Use run_read_query for reads, or ask the operator to set mcp: "write" on this seed.';

/**
 * The kind a statement is, read from its operative keyword, so the audit event names whether the
 * call read, wrote or defined something (#1774). `readOperativeKeyword` crosses a WITH preamble,
 * so `WITH t AS (...) INSERT ...` is classified as a write. The read kind is an allowlist; any
 * other head, such as GRANT, COPY, CALL or DO, is `other`.
 */
function classifyStatementKind(sql: string): McpStatementKind {
  const operative = readOperativeKeyword(sql, DEFAULT_SQL_GRAMMAR);
  if (operative === null) return "other";
  if (WRITE_WORDS.has(operative.keyword)) return "write";
  if (DDL_WORDS.has(operative.keyword)) return "ddl";
  if (READ_WORDS.has(operative.keyword)) {
    // EXPLAIN ANALYZE executes the statement, and an option-list form this reader cannot settle
    // as a plain word is not trusted as a read either (#1774).
    if (operative.keyword === "EXPLAIN") {
      const next = readLeadingKeyword(sql.slice(operative.end), DEFAULT_SQL_GRAMMAR);
      if (next === null || EXPLAIN_EXECUTES_WORDS.has(next.keyword)) return "other";
    }
    return "read";
  }
  return "other";
}

/** The refusal for a text that is not exactly one statement, named by its shape violation. */
function shapeRefusalText(code: AgentStatementViolation): string {
  return `The statement was refused before it reached the database (${code}). run_query runs exactly one SQL statement.`;
}

/** A result, and the reason its outcome event records when it is a failure. */
type Answer = readonly [ToolResult, McpToolAuditReason?];

/** The answer to a step that failed: the engine's own message, redacted, never the client's text. */
function failureAnswer(error: unknown): Answer {
  return [engineError(MCP_ENGINE_ERROR_PREFIX, error), "mcp_execution_failed"];
}

function resultOf(args: RunQueryInput, prepared: PreparedQuery, raw: QueryResult): Answer {
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
  args: RunQueryInput,
  call: McpToolCall,
  connection: ManagedConnection,
  deadline: number,
): Promise<Answer> {
  const acquired = await raceDeadline(() => call.context.acquire(connection, "mcp-write"), call.signal, deadline);
  if (acquired.kind === "cancelled") return [ownWordsError(MCP_CANCELLED_TEXT), "mcp_cancelled"];
  if (acquired.kind === "timeout") return [ownWordsError(timeoutText(args.timeout_ms)), "mcp_timeout"];
  if (acquired.kind === "failed") return failureAnswer(acquired.error);
  // In the database the call names, on a connection that reaches a whole server (#1530).
  let provider: DatabaseProvider;
  try {
    provider = await providerInDatabase(acquired.value, args.database);
  } catch (error) {
    if (error instanceof McpDatabaseChoiceError) return [ownWordsError(error.message), "mcp_execution_failed"];
    return failureAnswer(error);
  }
  let prepared: PreparedQuery;
  try {
    prepared = provider.prepareQuery(args.sql, { limit: args.max_rows + 1, offset: args.offset });
  } catch (error) {
    return failureAnswer(error);
  }
  if (!prepared.wasLimited && args.offset > 0) {
    return [ownWordsError(offsetRefusalText(args.sql, connection.type)), "mcp_offset_unsupported"];
  }
  const executed = await raceDeadline(() => provider.query(prepared.query), call.signal, deadline);
  if (executed.kind === "cancelled") return [ownWordsError(MCP_CANCELLED_TEXT), "mcp_cancelled"];
  if (executed.kind === "timeout") return [ownWordsError(timeoutText(args.timeout_ms)), "mcp_timeout"];
  if (executed.kind === "failed") return failureAnswer(executed.error);
  return resultOf(args, prepared, executed.value);
}

export async function runQuery(args: RunQueryInput, call: McpToolCall): Promise<ToolResult> {
  const startedAt = Date.now();
  const deadline = startedAt + args.timeout_ms;
  const record: McpCallRecord = {
    action: "run_query",
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
  if (connection.mcp !== "write") {
    return refuse(resolved, "mcp_statement_refused", WRITE_NOT_OPTED_IN_TEXT);
  }
  const shapeViolation = inspectStatementShape(args.sql);
  if (shapeViolation !== null) {
    return refuse(resolved, "mcp_statement_refused", shapeRefusalText(shapeViolation));
  }
  const classified: McpCallRecord = { ...resolved, statementKind: classifyStatementKind(args.sql) };
  const unrecorded = recordOrRefuse(() => recordMcpDecision(classified));
  if (unrecorded !== null) return unrecorded;

  const finish = ([result, failure]: Answer): ToolResult =>
    recordOrRefuse(() => recordMcpOutcome(classified, Date.now() - startedAt, failure)) ?? result;
  return finish(await execute(args, call, connection, deadline));
}

export function registerRunQuery(server: McpServer, context: McpConnectionContext): void {
  server.registerTool(
    "run_query",
    {
      title: RUN_QUERY_TITLE,
      description: RUN_QUERY_DESCRIPTION,
      inputSchema: RunQueryInputSchema,
      outputSchema: RunQueryOutputSchema,
      annotations: MCP_WRITE_ANNOTATIONS,
    },
    (args, ctx) => runQuery(args, { context, signal: ctx.mcpReq.signal }),
  );
}
