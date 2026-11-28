import type { PageBound } from "@libredb/provider-sdk/calls";
import { encodeValue, ValueCodecError, type WireValue } from "@libredb/provider-sdk/values";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type ReadOnlyPageAnswer, runReadOnlyPage } from "@/lib/api/read-only-execute";
import {
  ExecutionProfileError,
  OffsetUnsupportedError,
  QueryCancelledError,
  StudioOffsetRefusal,
  StudioTimeBudgetRefusal,
} from "@/lib/db/errors";
import {
  isStudioRefusal,
  providerAuthor,
  type ProviderTextScrub,
  providerTextScrub,
  scrubProviderText,
  withScrubbedWarnings,
} from "@/lib/db/operations/provider-text";
import { RunReadAllowance } from "@/lib/db/read-allowance";
import { servedEngineRecord } from "@/lib/db/server-catalog";
import type { DatabaseProvider } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { hostCore } from "@/lib/provider-host/instance";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseType } from "@/lib/types";
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
  MCP_CELL_FORM,
  MCP_CELL_REFUSED_PREFIX,
  MCP_ENGINE_ERROR_PREFIX,
  MCP_NOT_VISIBLE_TEXT,
  MCP_PROVIDER_BYTE_CAP,
  MCP_PROVIDER_ROW_CAP,
  MCP_READ_ONLY_ANNOTATIONS,
  MCP_RESULT_CAP_BYTES,
  ownWordsError,
  ownWordsFailure,
  providerTextError,
  recordOrRefuse,
  untrustedResult,
  withByteSize,
  type ToolResult,
} from "../output";
import { redactErrorMessage } from "../serializer";
import { databaseRequiredAnswer, McpDatabaseChoiceError, providerInDatabase } from "./database-choice";
import {
  acquireWithinCall,
  classifyReadQueryFailure,
  nextPageHint,
  offsetRefusalText,
  pagesWithOffset,
  profileRefusalText,
  type Raced,
  raceDeadline,
  timeoutText,
} from "./read-query-limits";
import {
  listedStatementArms,
  mcpStatementSurface,
  mcpStatementToolFor,
  servingStatementArms,
  type McpStatementArm,
} from "./statement-arms";

/**
 * The one core every MCP statement tool runs (#246): one read-only statement, on an engine that
 * can bound it itself, in the arm's language.
 *
 * The order is run_read_query's: the host core, signal, resolve, availability, the served-engine gate, canonicalize,
 * fence, the decision record, the open's `textScrub`, the acquisition under "agent-read-only" within the call
 * (`acquireWithinCall`), `providerInDatabase`, whose database listing is a host core tree call under the call's
 * deadline and the request's signal (clause C-82) while its catalog session open is not yet bounded, the page, the
 * statement through the host core's read-only execute with that page (`runReadOnlyPage`) under the provider budgets,
 * which refuses an answer past either budget again in core, the cut to max_rows and the result cap, the outcome record
 * (docs/providers/CONTRACT.md, clauses C-81 and C-85). An arm that pages asks for one row past max_rows from the
 * offset, and the read-only statement session applies it through the provider's own paging; no module of MCP calls a
 * provider's `prepareQuery`. The host core
 * is read before anything else, so a call made before its install throws `HostCoreBootOrderError` by name, with no
 * record written and nothing opened.
 *
 * The boundary is the agent-read-only acquisition, which the factory refuses to hand out for an engine without a
 * read-only statement path, and the read-only statement session the legacy bridge opens over the provider, which
 * refuses one without `queryReadOnly` by name (clause C-39); this module never calls query(), and that is what makes
 * every statement tool's readOnlyHint true. A profile refusal, from the acquisition or from a provider that proves its principal before every
 * statement, is answered in the tool's own sentence: Studio's own refusal in Studio's words, and a provider's behind a
 * notice naming the provider that wrote it, since it may quote database names. Every provider text an answer or a log
 * line carries passes core's scrub of the connection's credential first, taken from the open (`textScrub`) so a
 * Vault-resolved secret is covered. A connection no MCP open can serve for the caller is refused first, with the
 * sentence list_connections lists it with, naming no tool. An engine the arm does not serve is refused before anything is
 * acquired, naming the tool that does serve it, and the arm's fence then runs as defence in depth. One deadline, the
 * call's start plus timeout_ms, covers acquisition and execution: the acquisition hands the open the call's wait, and
 * the statement runs under the host core's deadline, the time left, and the request's signal. Neither a cancel nor the
 * deadline stops a statement already running (backlog D128), they end the wait; a statement that fails after
 * the wait ended is logged under `/api/mcp` by kind and code, never its text.
 *
 * Rows are fetched one past the page where the arm pages, so the extra row proves more exist, cut to max_rows, then
 * cut to the result cap by binary search. The rows an answer can carry, the first max_rows, are written in the value
 * codec's wire form (`encodeValue` of `@libredb/provider-sdk/values`, `MCP_CELL_FORM`), in structuredContent and in the
 * JSON text block alike; a value outside the codec refuses the whole answer by the codec's sentence, behind the notice
 * naming the provider, since its place quotes column names and document keys, and so does a value the host core's
 * page refuses as it measures the rows. offset on a query the provider did not rewrite is refused by the read-only
 * statement session before anything runs, because the provider would answer the first page labelled with the requested
 * offset, Studio's `StudioOffsetRefusal`, answered in Studio's words; so is an offset the provider refuses by throwing
 * OffsetUnsupportedError, answered in its words behind a notice naming it, and any offset on an engine whose
 * accepted-forms row says its SQL has none, refused before the statement's execute with the way to page there; such
 * an engine is never offered a next offset either. An arm that does not page sends every row as its page and the
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
  rows: z.array(z.record(z.string(), z.unknown())).describe(MCP_CELL_FORM),
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
 * The answer to a step that failed, with the failure's error record. A failure that settled at or after the deadline is
 * answered as the deadline itself is, Studio's own answer with no record; it can be a real engine or connection error,
 * so the provider's own message, redacted, goes to the server log with the call's correlation id, and never to the
 * client. A time budget refusal before the deadline is answered with the same text and its record.
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
  if (failure.kind === "deadline" || failure.kind === "timeout") {
    logger.warn(`MCP ${call.arm.tool} answered a provider failure as the timeout`, {
      route: "/api/mcp",
      error: redactErrorMessage(scrubProviderText(scrub, error instanceof Error ? error.message : String(error))),
      connection: record.connectionName,
      correlationId: record.correlationId,
    });
    const text = timeoutText(call.args.timeout_ms);
    return [failure.kind === "deadline" ? ownWordsError(text) : ownWordsFailure(text, error, scrub), "mcp_timeout"];
  }
  // Studio's words, scrubbed: the read allowance's sentence splices the provider's charge label.
  if (failure.kind === "too-large")
    return [ownWordsFailure(scrubProviderText(scrub, failure.text), error, scrub), "mcp_result_too_large"];
  if (failure.kind === "not-sent") {
    return [providerTextError(NOT_SENT_LEAD, failure.error, scrub, providerAuthor(call.type)), "mcp_statement_refused"];
  }
  return [
    engineError(MCP_ENGINE_ERROR_PREFIX, failure.error, scrub, providerAuthor(call.type)),
    "mcp_execution_failed",
  ];
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
      ownWordsFailure(profileRefusalText(scrubProviderText(scrub, error.message), arm.engines, arm.tool), error, scrub),
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

function resultOf(
  call: StatementCall,
  type: DatabaseType,
  answer: ReadOnlyPageAnswer,
  scrub: ProviderTextScrub,
): Answer {
  const { args, arm, offset } = call;
  const { result: raw, pageApplied } = answer;
  // Only the rows an answer can carry: a value in the row past the page, which proves more exist, never refuses it.
  let page: { [column: string]: WireValue }[];
  try {
    page = encodeValue(raw.rows.slice(0, args.max_rows)) as { [column: string]: WireValue }[];
  } catch (error) {
    return [engineError(MCP_CELL_REFUSED_PREFIX, error, scrub, providerAuthor(type)), "mcp_execution_failed"];
  }
  const columns = raw.fields.map((name) => {
    const type = raw.columnTypes?.[name];
    return type === undefined ? { name } : { name, type };
  });
  const build = (count: number) => {
    const truncatedBy = count < page.length ? "result_bytes" : raw.rows.length > args.max_rows ? "max_rows" : null;
    const hasMore = raw.rows.length > count;
    // Only a query the provider paged, on an engine whose SQL has an offset to page the next call with.
    const nextOffset = hasMore && pageApplied && pagesWithOffset(type) ? offset + count : null;
    return withByteSize(
      {
        connection_id: args.connection_id,
        ...(args.database === undefined ? {} : { database: args.database }),
        columns,
        rows: page.slice(0, count),
        row_count: count,
        truncated: truncatedBy !== null,
        truncated_by: truncatedBy,
        pagination: { offset, limit: args.max_rows, hasMore, nextOffset, wasLimited: pageApplied },
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
      (structured) => untrustedResult(structured, providerAuthor(type)),
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

/**
 * The page the statement asks the host core's read-only execute for (clause C-85): every row where the arm does not
 * page, and otherwise one row past max_rows from the offset, which the read-only statement session applies through the
 * provider's own paging. An offset on an engine whose SQL has none is refused before anything is acquired for the
 * statement, in the words that say how to page there instead.
 */
function pageOf(call: StatementCall, type: DatabaseType): { readonly page: PageBound } | { readonly refused: Answer } {
  const { args, offset, statement } = call;
  if (call.arm.paging === "none") return { page: { unlimited: true } };
  if (offset > 0 && !pagesWithOffset(type)) {
    return { refused: [ownWordsError(offsetRefusalText(statement, type)), "mcp_offset_unsupported"] };
  }
  return { page: { limit: args.max_rows + 1, offset } };
}

/**
 * A statement that failed on the host core's read-only execute, answered in this order: a value the host's page cannot
 * carry by the codec's sentence behind the notice; Studio's refusal of an offset the provider did not apply in Studio's
 * words, which say which case kept the provider from paging; a provider's refusal of a non-zero offset, from its
 * prepare or its read path, in its own words behind the notice; anything else as a failed acquisition is. Both offset
 * refusals are answered by class before the settle-time rule, as the refusals of a synchronous prepare always were.
 */
function statementFailure(
  call: StatementCall,
  failed: { readonly error: unknown; readonly settledAt: number },
  deadline: number,
  record: McpCallRecord,
  scrub: ProviderTextScrub,
): Answer {
  const { error } = failed;
  if (error instanceof ValueCodecError) {
    return [engineError(MCP_CELL_REFUSED_PREFIX, error, scrub, providerAuthor(call.type)), "mcp_execution_failed"];
  }
  if (error instanceof StudioOffsetRefusal) {
    return [ownWordsError(offsetRefusalText(call.statement, call.type)), "mcp_offset_unsupported"];
  }
  // An engine whose SQL cannot page refuses the offset, and its sentence says what to do instead. Any other failure,
  // and this one with no offset asked for, is the engine's, never masked as an offset refusal.
  if (error instanceof OffsetUnsupportedError && call.offset > 0) {
    return [providerTextError(OFFSET_REFUSED_LEAD, error, scrub, providerAuthor(call.type)), "mcp_offset_unsupported"];
  }
  return acquisitionFailure(call, failed, deadline, record, scrub);
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
    return acquisitionFailure(call, opened, deadline, record, providerTextScrub(connection, "profiled"));
  const scrub = opened.value;
  try {
    return await executeOpened(call, tool, connection, record, deadline, scrub);
  } catch (error) {
    return [engineError(MCP_ENGINE_ERROR_PREFIX, error, scrub, providerAuthor(call.type)), "mcp_execution_failed"];
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

/**
 * The provider in the database the call names, on a connection that reaches a whole server (#1530), or the answer that
 * ends the call there: the listing's cancel or timeout, the provider's refusal, the databases the call could name, or
 * Studio's own choice refusal. Any other failure is thrown, the engine's.
 */
async function callDatabase(
  call: StatementCall,
  tool: McpToolCall,
  acquired: DatabaseProvider,
  deadline: number,
  scrub: ProviderTextScrub,
): Promise<{ readonly provider: DatabaseProvider } | { readonly answer: Answer }> {
  try {
    const choice = await providerInDatabase(acquired, call.args.database, tool.signal, deadline);
    switch (choice.kind) {
      case "chosen":
        return { provider: choice.provider };
      case "cancelled":
        return { answer: [ownWordsError(MCP_CANCELLED_TEXT), "mcp_cancelled"] };
      case "timeout":
        return { answer: [ownWordsError(timeoutText(call.args.timeout_ms)), "mcp_timeout"] };
      case "provider-refused":
        return {
          answer: [
            providerTextError(DATABASE_REFUSED_LEAD, choice.error, scrub, providerAuthor(call.type)),
            "mcp_execution_failed",
          ],
        };
      // The databases the call could name are database content: behind the notice naming the provider, never spliced
      // into Studio's sentence.
      case "database-required":
        return { answer: [databaseRequiredAnswer(choice, providerAuthor(call.type)), "mcp_execution_failed"] };
    }
  } catch (error) {
    if (error instanceof McpDatabaseChoiceError)
      return { answer: [ownWordsError(error.message), "mcp_execution_failed"] };
    throw error;
  }
}

async function executeOpened(
  call: StatementCall,
  tool: McpToolCall,
  connection: ManagedConnection,
  record: McpCallRecord,
  deadline: number,
  scrub: ProviderTextScrub,
): Promise<Answer> {
  const { args } = call;
  const acquired = await acquireWithinCall(tool, connection, "agent-read-only", deadline);
  if (acquired.kind === "cancelled") return [ownWordsError(MCP_CANCELLED_TEXT), "mcp_cancelled"];
  if (acquired.kind === "timeout") return [ownWordsError(timeoutText(args.timeout_ms)), "mcp_timeout"];
  if (acquired.kind === "failed") return acquisitionFailure(call, acquired, deadline, record, scrub);
  const chosen = await callDatabase(call, tool, acquired.value, deadline, scrub);
  if ("answer" in chosen) return chosen.answer;
  const { provider } = chosen;
  const paged = pageOf(call, connection.type);
  if ("refused" in paged) return paged.refused;
  const executed = await statementOnHost(tool, provider, connection.type, call.statement, paged.page, deadline);
  if (executed.kind === "cancelled") return [ownWordsError(MCP_CANCELLED_TEXT), "mcp_cancelled"];
  if (executed.kind === "timeout") return [ownWordsError(timeoutText(args.timeout_ms)), "mcp_timeout"];
  // A provider whose principal check runs before every statement, rather than at the open, refuses there, in the
  // tool's sentence. That refusal quotes names any user of the database may have chosen (a function, a view, a role),
  // so it goes behind a notice naming the provider, scrubbed, redacted and cut as an engine message is. A value the
  // host core's page cannot carry, refused by the value codec as the host measures the rows, is refused as the answer's
  // own cut refuses one, by the codec's sentence behind the notice.
  if (executed.kind === "failed") return statementFailure(call, executed, deadline, record, scrub);
  const { result, pageApplied } = executed.value;
  // The notes an arm answers are the provider's text too, scrubbed before the answer is built.
  return resultOf(call, connection.type, { result: withScrubbedWarnings(scrub, result), pageApplied }, scrub);
}

/**
 * The statement through the host core's read-only execute with its page (`runReadOnlyPage`, docs/providers/CONTRACT.md,
 * clauses C-79, C-81 and C-85), which opens the legacy bridge's read-only statement session over the provider, refusing
 * one without `queryReadOnly` by name, applies a bounded page through the provider's own paging or refuses an offset it
 * did not apply, and holds the answer to the read budget before it is cut to max_rows and the answer cap. Its
 * deadline is the call's, as the time left, and its caller is the request's signal, so the host core ends the wait and
 * no race of this module's runs beside it. A call whose request left, or whose deadline passed while the connection
 * opened, sends nothing, as a raced step starts nothing late. The facade's ends are read into the race's kinds: its
 * time refusal, which on this path only the call's deadline builds, is the timeout; a cancel while the request has left
 * is the request leaving; any other error is a failure with its settle time, a provider's by reference.
 */
async function statementOnHost(
  tool: McpToolCall,
  provider: DatabaseProvider,
  type: DatabaseType,
  statement: string,
  page: PageBound,
  deadline: number,
): Promise<Raced<ReadOnlyPageAnswer>> {
  if (tool.signal.aborted) return { kind: "cancelled" };
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) return { kind: "timeout" };
  try {
    const value = await runReadOnlyPage(provider, {
      type,
      statement,
      page,
      budget: {
        maxResultRows: MCP_PROVIDER_ROW_CAP,
        maxResultBytes: MCP_PROVIDER_BYTE_CAP,
        statementTimeoutMs: remaining,
        // A call is its own run here: a fresh allowance per call, so one call's billed reads never reach the next.
        readAllowance: new RunReadAllowance(MCP_CALL_READ_ALLOWANCE, { scope: "call" }),
      },
      caller: tool.signal,
      route: "/api/mcp",
    });
    return { kind: "settled", value };
  } catch (error) {
    if (error instanceof StudioTimeBudgetRefusal) return { kind: "timeout" };
    if (error instanceof QueryCancelledError && tool.signal.aborted) return { kind: "cancelled" };
    return { kind: "failed", error, settledAt: Date.now() };
  }
}

/**
 * The sentence an engine this arm does not serve is refused with, naming it by its record's display name, a legacy
 * engine's connection form label, and the tool that does serve it, or `inspect_schema` where none does, as for a
 * provider package's engine, whose record offers no execution profile.
 */
function notServedText(arm: McpStatementArm, type: DatabaseType): string {
  const elsewhere = mcpStatementToolFor(type) ?? "inspect_schema";
  return profileRefusalText(
    `this tool does not serve ${servedEngineRecord(type).displayName}; use ${elsewhere} there`,
    arm.engines,
    arm.tool,
  );
}

export async function runStatement(
  arm: McpStatementArm,
  args: McpStatementInput,
  tool: McpToolCall,
): Promise<ToolResult> {
  // First: a call made before the host core is installed throws by name, with no record written and nothing opened, so
  // Studio's boot-order defect is never answered as the database's error.
  hostCore();
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
  if (!arm.types.some((id) => id === connection.type)) {
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
 * engine; an arm that serves none is never listed. The arms are read when the tools register, from the composition of
 * the installed catalog (`mcpStatementSurface`), since each request builds its own server.
 *
 * @throws {McpCompositionOrderError} While boot has begun and not yet installed the server's engine catalog.
 * @throws {McpCatalogBootUnfinishedError} After a boot that ended by an error before it installed the server's engine
 *   catalog.
 */
export function registerStatementTools(
  server: McpServer,
  context: McpConnectionContext,
  reach?: McpReach,
  arms: Parameters<typeof servingStatementArms>[0] = mcpStatementSurface().arms,
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
