import { inspectAgentStatement, type AgentStatementViolation } from "@/lib/db/operations/statement-guard";

class McpSecurityViolationError extends Error {
  public readonly code: AgentStatementViolation;

  constructor(code: AgentStatementViolation, details?: string) {
    super(`MCP execution fence rejected statement: ${code}${details ? ` (${details})` : ""}`);
    this.name = "McpSecurityViolationError";
    this.code = code;
  }
}

/**
 * Validates that an SQL statement is strictly safe for read-only execution via MCP.
 * Reuses LibreDB Studio's native execution fence (`inspectAgentStatement`), blocking DDL, DML,
 * multi-statements, manual transactions, and side-effect keywords.
 *
 * @param sql SQL statement to inspect
 * @throws McpSecurityViolationError if any violation is detected
 */
export function assertReadOnlyStatement(sql: string): void {
  const violation = inspectAgentStatement(sql, { allowPlanExecution: false });
  if (violation !== null) {
    throw new McpSecurityViolationError(violation);
  }
}

/**
 * Non-throwing version of the execution fence.
 * Returns null if safe, or the violation code if rejected.
 */
export function checkReadOnlyStatement(sql: string): AgentStatementViolation | null {
  return inspectAgentStatement(sql, { allowPlanExecution: false });
}
