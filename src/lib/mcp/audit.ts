import { emitAuditEvent, type AuditReason } from "@/lib/audit";

/**
 * The MCP endpoint's audit events (#246), all of type mcp_operation.
 *
 * A tool call writes its decision before any provider is reached and its outcome after, joined by
 * one correlation id; minting writes one event before the token is signed. target is a phase and
 * never a URL, action and reason are closed vocabularies, connectionName is the bare seed id of a
 * resolved connection only, and user is the token's verified username. These functions let a sink
 * failure through: the caller decides, and every caller refuses to run what it cannot record.
 */

export type McpToolAction = "list_connections" | "inspect_schema" | "run_read_query";

export const MCP_DECISION_TARGET = "mcp/decision";
export const MCP_EXECUTION_TARGET = "mcp/execution";
export const MCP_TOKEN_TARGET = "mcp/token";

export type McpToolAuditReason = Extract<
  AuditReason,
  | "mcp_invalid_arguments"
  | "mcp_connection_not_visible"
  | "mcp_statement_refused"
  | "mcp_schema_not_found"
  | "mcp_offset_unsupported"
  | "mcp_cancelled"
  | "mcp_timeout"
  | "mcp_result_too_large"
  | "mcp_execution_failed"
  | "mcp_connections_unreadable"
>;

export interface McpCallRecord {
  readonly action: McpToolAction;
  readonly user: string;
  readonly correlationId: string;
  readonly connectionName?: string;
}

export const MCP_AUDIT_FAILURE_TEXT = "The call was not run because its audit record could not be written.";

export function newMcpCorrelationId(): string {
  return crypto.randomUUID();
}

function record(call: McpCallRecord, target: string, failure: McpToolAuditReason | undefined, duration?: number): void {
  emitAuditEvent({
    type: "mcp_operation",
    action: call.action,
    target,
    user: call.user,
    correlationId: call.correlationId,
    ...(call.connectionName === undefined ? {} : { connectionName: call.connectionName }),
    ...(duration === undefined ? {} : { duration }),
    result: failure === undefined ? "success" : "failure",
    ...(failure === undefined ? {} : { reason: failure }),
  });
}

export function recordMcpDecision(call: McpCallRecord, refusal?: McpToolAuditReason): void {
  record(call, MCP_DECISION_TARGET, refusal);
}

export function recordMcpOutcome(call: McpCallRecord, durationMs: number, failure?: McpToolAuditReason): void {
  record(call, MCP_EXECUTION_TARGET, failure, durationMs);
}

export function recordMcpMint(user: string): void {
  emitAuditEvent({ type: "mcp_operation", action: "mint_token", target: MCP_TOKEN_TARGET, user, result: "success" });
}
