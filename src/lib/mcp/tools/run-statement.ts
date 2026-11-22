import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getDBConfig } from "@/lib/db-ui-config";
import { ExecutionProfileError, OffsetUnsupportedError } from "@/lib/db/errors";
import {
  isStudioRefusal,
  providerAuthor,
  type ProviderTextScrub,
  providerTextScrub,
  scrubProviderText,
  withScrubbedWarnings,
} from "@/lib/db/operations/provider-text";
import { runReadOnlyStatement } from "@/lib/db/operations/read-only-statement";
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
import { mcpConnectionUnavailable } from "../availability";
import {
  MCP_CONNECTIONS_UNREADABLE,
  MCP_CONNECTIONS_UNREADABLE_TEXT,
  type McpConnectionContext,
  type McpReach,
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
  providerTextError,
  recordOrRefuse,
  untrustedResult,
  withByteSize,
  type ToolResult,
} from "../output";
import { redactErrorMessage, safeSerialize } from "../serializer";
import { McpDatabaseChoiceError, providerInDatabase } from "./database-choice";
import {
  classifyReadQueryFailure,
  nextPageHint,
  offsetRefusalText,
  pagesWithOffset,
  profileRefusalText,
  raceDeadline,
  timeoutText,
} from "./read-query-limits";
import {
  listedStatementArms,
  MCP_STATEMENT_ARMS,
  mcpStatementToolFor,
  servingStatementArms,
  type McpStatementArm,
} from "./statement-arms";

/**
 * The one core every MCP statement tool runs (#246): one read-only statement, on an engine that
 * can bound it itself, in the arm's language.
 *
 * The order is run_read_query's: signal, resolve, availability, the served-engine gate, canonicalize, fence, the decision
 * record, the open's `textScrub`, `acquire(connection, "agent-read-only")`, `providerInDatabase`, for an arm that
 * pages the provider's `prepareQuery` with the row cap and offset, `queryReadOnly` under the provider budgets through
 * `runReadOnlyStatement`, which refuses an answer past either budget again in core, the cut to max_rows and the result
 * cap, the outcome record.
 *
 * The boundary is the agent-read-only acquisition and the provider's queryReadOnly, which the factory refuses to hand
 * out for an engine without one; this module never calls query(), and that is what makes every statement tool's
 * readOnlyHint true. A profile refusal, from the acquisition or from a provider that proves its principal before every
 * statement, is answered in the tool's own sentence: Studio's own refusal in Studio's words, and a provider's behind a
 * notice naming the provider that wrote it, since it may quote database names. Every provider text an answer or a log
 * line carries passes core's scrub of the connection's credential first, taken from the open (`textScrub`) so a
 * Vault-resolved secret is covered. A connection no MCP open can serve for the caller is refused first, with the
 * sentence list_connections lists it with, naming no tool. An engine the arm does not serve is refused before anything is
 * acquired, naming the tool that does serve it, and the arm's fence then runs as defence in depth. One deadline, the
 * call's start plus timeout_ms, covers acquisition and execution; neither a cancel nor the deadline stops a statement
 * already running (docs/BACKLOG.md D128), they end the wait.
 *
 * Rows are fetched one past the page where the arm pages, so the extra row proves more exist, cut to max_rows, then
 * cut to the result cap by binary search. offset on a query the provider did not rewrite is refused before anything
 * runs, because the provider would answer the first page labelled with the requested offset; so is an offset the
 * provider's prepareQuery refuses by throwing OffsetUnsupportedError, answered in its words behind a notice naming
 * it, and any offset on an engine whose accepted-forms row says its SQL has none, refused before prepareQuery with the
 * way to page there; such an engine is never offered a next offset either. An arm that does not page sends the
 * statement as written, and the row budget, the provider's and core's, bounds it.
 *
 * A result's warnings stay off the answer, except on an arm whose facet says they are Studio's own sentences an answer
 * must carry: there they are its `notes`, in the order the provider gave them.
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
  notes: z.array(z.string()).optional(),
  byte_size: z.number().int(),
  execution_time_ms: z.number(),
});

/** A result, and the reason its outcome event records when it is a failure. */
type Answer = readonly [ToolResult, McpToolAuditReason?];

/** One call: its arm, its arguments, the statement text the arm read from them, and the offset it pages from. */
interface StatementCall {
  readonly arm: McpStatementArm;
  readonly type: DatabaseType;
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
  scrub: ProviderTextScrub,
): Answer {
  const failure = classifyReadQueryFailure(error, settledAt, deadline, call.arm.tooLarge(call.statement, call.type));
  if (failure.kind === "timeout") {
    logger.warn(`MCP ${call.arm.tool} answered a provider failure as the timeout`, {
      route: "/api/mcp",
      error: redactErrorMessage(scrubProviderText(scrub, error instanceof Error ? error.message : String(error))),
      connection: record.connectionName,
      correlationId: record.correlationId,
    });
    return [ownWordsError(timeoutText(call.args.timeout_ms)), "mcp_timeout"];
  }
  // Studio's words, scrubbed: the read allowance's sentence splices the provider's charge label.
  if (failure.kind === "too-large")
    return [ownWordsError(scrubProviderText(scrub, failure.text)), "mcp_result_too_large"];
  if (failure.kind === "not-sent") {
    return [providerTextError(NOT_SENT_LEAD, failure.error, scrub, providerAuthor(call.type)), "mcp_statement_refused"];
  }
  return [engineError(MCP_ENGINE_ERROR_PREFIX, failure.error, scrub), "mcp_execution_failed"];
}

const NOT_SENT_LEAD = "The statement was refused before it reached the database: ";
const DATABASE_REFUSED_LEAD = "The database could not be opened: ";
const OFFSET_REFUSED_LEAD = "The offset was refused before the statement was sent: ";

/**
 * A profile refusal, at the open or by the statement call: Studio's own (`isStudioRefusal`) in the tool's sentence,
 * scrubbed; a provider's behind a notice naming it, in the same sentence.
 */
function profileRefusal(call: StatementCall, error: ExecutionProfileError, scrub: ProviderTextScrub): Answer {
  const { arm } = call;
  if (isStudioRefusal(error)) {
    return [
      ownWordsError(profileRefusalText(scrubProviderText(scrub, error.message), arm.engines, arm.tool)),
      "mcp_execution_failed",
    ];
  }
  return [
    providerTextError(
      `${arm.tool} cannot run on this connection: `,
      error,
      scrub,
      providerAuthor(call.type),
      `It runs on ${arm.engines}.`,
    ),
    "mcp_execution_failed",
  ];
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
    // Only a query the provider paged, on an engine whose SQL has an offset to page the next call with.
    const nextOffset = hasMore && prepared.wasLimited && pagesWithOffset(type) ? offset + count : null;
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
        ...(arm.answersWarnings && raw.warnings !== undefined && raw.warnings.length > 0
          ? { notes: raw.warnings.map((warning) => warning.message) }
          : {}),
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
  scrub: ProviderTextScrub,
): { readonly prepared: PreparedQuery } | { readonly refused: Answer } {
  const { args, offset, statement } = call;
  if (call.arm.paging === "none") {
    return { prepared: { query: statement, wasLimited: false, limit: args.max_rows, offset: 0 } };
  }
  // An engine whose SQL has no offset takes none: refused before the provider is asked, in the words that say how to
  // page there instead.
  if (offset > 0 && !pagesWithOffset(type)) {
    return { refused: [ownWordsError(offsetRefusalText(statement, type)), "mcp_offset_unsupported"] };
  }
  let prepared: PreparedQuery;
  try {
    prepared = provider.prepareQuery(statement, { limit: args.max_rows + 1, offset });
  } catch (error) {
    // An engine whose SQL cannot page refuses the offset here, and its sentence says what to do instead: the
    // provider's text, behind a notice naming it. Any other failure, and this one with no offset asked for, is the
    // engine's, never masked as an offset refusal.
    if (error instanceof OffsetUnsupportedError && offset > 0) {
      return {
        refused: [providerTextError(OFFSET_REFUSED_LEAD, error, scrub, providerAuthor(type)), "mcp_offset_unsupported"],
      };
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
  const { args } = call;
  // The open first: its scrub of the connection's credential, Vault-resolved secrets included, is what every provider
  // text this call carries passes. A refusal of the open itself is Studio's, scrubbed with the listed connection's own
  // values, the only ones held before the open read Vault.
  const opened = await raceDeadline(() => tool.context.textScrub(connection), tool.signal, deadline);
  if (opened.kind === "cancelled") return [ownWordsError(MCP_CANCELLED_TEXT), "mcp_cancelled"];
  if (opened.kind === "timeout") return [ownWordsError(timeoutText(args.timeout_ms)), "mcp_timeout"];
  if (opened.kind === "failed")
    return acquisitionFailure(call, opened, deadline, record, providerTextScrub(connection));
  const scrub = opened.value;
  try {
    return await executeOpened(call, tool, connection, record, deadline, scrub);
  } catch (error) {
    return [engineError(MCP_ENGINE_ERROR_PREFIX, error, scrub), "mcp_execution_failed"];
  }
}

/** A failed open or acquisition: a profile refusal by its author, any other failure as a statement's. */
function acquisitionFailure(
  call: StatementCall,
  failed: { readonly error: unknown; readonly settledAt: number },
  deadline: number,
  record: McpCallRecord,
  scrub: ProviderTextScrub,
): Answer {
  return failed.error instanceof ExecutionProfileError
    ? profileRefusal(call, failed.error, scrub)
    : failureAnswer(call, failed.error, failed.settledAt, deadline, record, scrub);
}

async function executeOpened(
  call: StatementCall,
  tool: McpToolCall,
  connection: ManagedConnection,
  record: McpCallRecord,
  deadline: number,
  scrub: ProviderTextScrub,
): Promise<Answer> {
  const { arm, args } = call;
  const acquired = await raceDeadline(() => tool.context.acquire(connection, "agent-read-only"), tool.signal, deadline);
  if (acquired.kind === "cancelled") return [ownWordsError(MCP_CANCELLED_TEXT), "mcp_cancelled"];
  if (acquired.kind === "timeout") return [ownWordsError(timeoutText(args.timeout_ms)), "mcp_timeout"];
  if (acquired.kind === "failed") return acquisitionFailure(call, acquired, deadline, record, scrub);
  // In the database the call names, on a connection that reaches a whole server (#1530).
  let provider: DatabaseProvider;
  try {
    const choice = await providerInDatabase(acquired.value, args.database);
    if (choice.kind === "provider-refused") {
      return [
        providerTextError(DATABASE_REFUSED_LEAD, choice.error, scrub, providerAuthor(call.type)),
        "mcp_execution_failed",
      ];
    }
    provider = choice.provider;
  } catch (error) {
    if (error instanceof McpDatabaseChoiceError) return [ownWordsError(error.message), "mcp_execution_failed"];
    throw error;
  }
  if (typeof provider.queryReadOnly !== "function") {
    // The profile seam refuses such a provider, so this is a server fault; query() is never the fallback.
    const refusal = profileRefusalText(
      "the acquired provider exposes no read-only execution path",
      arm.engines,
      arm.tool,
    );
    return [ownWordsError(refusal), "mcp_execution_failed"];
  }
  const prepared = prepare(call, provider, connection.type, scrub);
  if ("refused" in prepared) return prepared.refused;
  const { query } = prepared.prepared;
  // Through the one core call of the read-only path, which holds the answer to the read budget before it is cut to
  // max_rows and the answer cap; this call's own deadline bounds the wait, so that function sets no timer of its own.
  const executed = await raceDeadline(
    () =>
      runReadOnlyStatement(provider, {
        type: connection.type,
        scrub,
        statement: query,
        budget: {
          maxResultRows: MCP_PROVIDER_ROW_CAP,
          maxResultBytes: MCP_PROVIDER_BYTE_CAP,
          statementTimeoutMs: Math.max(1, Math.floor(deadline - Date.now())),
          // A call is its own run here: a fresh allowance per call, so one call's billed reads never reach the next.
          readAllowance: new RunReadAllowance(MCP_CALL_READ_ALLOWANCE, { scope: "call" }),
        },
        wait: "caller-deadline",
      }),
    tool.signal,
    deadline,
  );
  if (executed.kind === "cancelled") return [ownWordsError(MCP_CANCELLED_TEXT), "mcp_cancelled"];
  if (executed.kind === "timeout") return [ownWordsError(timeoutText(args.timeout_ms)), "mcp_timeout"];
  // A provider whose principal check runs before every statement, rather than at the open, refuses there, in the
  // tool's sentence. That refusal quotes names any user of the database may have chosen (a function, a view, a role),
  // so it goes behind a notice naming the provider, scrubbed, redacted and cut as an engine message is.
  if (executed.kind === "failed") return acquisitionFailure(call, executed, deadline, record, scrub);
  // The notes an arm answers are the provider's text too, scrubbed before the answer is built.
  return resultOf(call, connection.type, prepared.prepared, withScrubbedWarnings(scrub, executed.value));
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
  // Ahead of the served-engine gate and of any acquisition: a connection no MCP open can serve for this caller is
  // refused with the sentence list_connections lists it with, whichever tool is called, and no provider is built.
  const unavailable = mcpConnectionUnavailable(tool.context.caller, connection);
  if (unavailable !== null) return refuse(resolved, "mcp_execution_failed", unavailable);
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

  const call: StatementCall = { arm, type: connection.type, args, statement, offset: args.offset ?? 0 };
  const finish = ([result, failure]: Answer): ToolResult =>
    recordOrRefuse(() => recordMcpOutcome(resolved, Date.now() - startedAt, failure)) ?? result;
  return finish(await execute(call, tool, connection, resolved, deadline));
}

/**
 * Every statement tool whose arm serves an engine, in record order, or with `reach` only those that serve a reached
 * engine; an arm that serves none is never listed.
 */
export function registerStatementTools(
  server: McpServer,
  context: McpConnectionContext,
  reach?: McpReach,
  arms: Parameters<typeof servingStatementArms>[0] = MCP_STATEMENT_ARMS,
): void {
  for (const arm of reach === undefined ? servingStatementArms(arms) : listedStatementArms(reach, arms)) {
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
