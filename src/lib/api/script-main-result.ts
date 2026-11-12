export interface ScriptStatementOutcome {
  status: "success" | "error";
  rows?: Record<string, unknown>[];
  fields?: string[];
  rowCount?: number;
}

function lastSuccessful<T extends ScriptStatementOutcome>(results: readonly T[]): T | undefined {
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].status === "success") return results[i];
  }
  return undefined;
}

function exposesResultGrid(outcome: ScriptStatementOutcome): boolean {
  return (outcome.fields?.length ?? 0) > 0 || (outcome.rows?.length ?? 0) > 0;
}

function priorRowset<T extends ScriptStatementOutcome>(results: readonly T[], skip: T): T | undefined {
  for (let i = results.length - 1; i >= 0; i--) {
    const candidate = results[i];
    if (candidate.status !== "success" || candidate === skip) continue;
    if (exposesResultGrid(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Which statement of a script supplies the top-level `rows` / `fields` the Results grid reads.
 *
 * A final SELECT that returned zero rows still carries column names and must win over an earlier
 * nonempty SELECT (#2271). A final write that matched no rows must win for the same reason. When the
 * final write did change rows but produced no grid, the last earlier rowset is kept so a read
 * followed by an INSERT does not erase the read (`docs/editor/query-optimization.md`).
 */
export function pickScriptMainResult<T extends ScriptStatementOutcome>(results: readonly T[]): T | undefined {
  if (results.length === 0) return undefined;

  const lastSuccess = lastSuccessful(results);
  if (lastSuccess === undefined) return results[results.length - 1];

  if (exposesResultGrid(lastSuccess)) return lastSuccess;

  const affectedRows = lastSuccess.rowCount ?? 0;
  if (affectedRows === 0) return lastSuccess;

  return priorRowset(results, lastSuccess) ?? lastSuccess;
}

export function mainResultRowCount(result: ScriptStatementOutcome | undefined): number {
  if (result === undefined) return 0;
  if (typeof result.rowCount === "number") return result.rowCount;
  return result.rows?.length ?? 0;
}
