/**
 * LIBREDB_MCP_WRITE_ENABLED (#1774): the operator's opt-in for the MCP run_query write tool.
 * Fail closed: unset, empty, off or an unrecognized value reads as disabled, so an operator
 * opts in only with true, on or 1. It is read on every call, like the other MCP variables, so
 * a changed value is seen by the next request.
 */

export const MCP_WRITE_ENABLED_ENV = "LIBREDB_MCP_WRITE_ENABLED";

const ON_VALUES = new Set(["true", "on", "1"]);

export function readMcpWriteEnabled(): boolean {
  const raw = process.env[MCP_WRITE_ENABLED_ENV] ?? "";
  return ON_VALUES.has(raw.trim().toLowerCase());
}
