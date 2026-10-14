/**
 * The agent's read of a cluster: one kubectl statement, or one curated reading, run in a MACHINE context.
 *
 * What makes it the agent's and not the editor's: it refuses unless the provider was opened under the agent read-only
 * profile; the statement's whole time, discovery included, is the budget's `statementTimeoutMs`, not the connection's
 * query timeout; a command stops reading at `maxRows + 1` where it can; the result is refused, never truncated, past
 * the row or byte budget, in the SQL providers' own sentences; and the output projection is masked. `query()` never
 * comes here, so the editor's console is unchanged.
 *
 * The deadline is a race, not a signal alone: a cold or expired discovery load is shared by every caller of the
 * session, so one caller's deadline stops that caller waiting and never cancels the load the others are waiting on.
 */
import { QueryError } from "@/lib/db/errors";
import { assertReadOnlyBudget, measureResultBytes } from "@/lib/db/providers/sql/read-only-budget";
import type { QueryResult, ReadOnlyStatementBudget, ReadOnlyStatementMode } from "@/lib/db/types";
import type { KubernetesSeams } from "./client";
import {
  byteBudgetSentence,
  type ExplainCache,
  type KubectlContext,
  resultOf,
  rowBudgetSentence,
  statementCall,
} from "./console/context";
import { runKubectl } from "./console/run";
import { KUBERNETES_TYPE } from "./limits";
import type { KubernetesSurface } from "./objects";

export { MACHINE_WATCH_SENTENCE } from "./console/run";

export const MACHINE_PROFILE_SENTENCE =
  "Read-only execution requires a provider opened under the agent read-only profile";
export const MACHINE_ESTIMATE_SENTENCE =
  "kubectl has no estimated plan: an agent read runs the read itself. Nothing was sent.";
export const MACHINE_DEADLINE_SENTENCE =
  "The statement reached the agent's statement time limit before it finished, discovery included: narrow it with -n, -l or --field-selector.";

export interface MachineSession {
  readonly surface: KubernetesSurface;
  readonly explainCache: ExplainCache;
  /** Aborted at disconnect, so no request outlives its session. */
  readonly lifetime: AbortSignal;
}

export interface MachineOptions {
  /** Whether the provider was opened under the agent read-only profile. */
  readonly readOnly: boolean;
  readonly seams: Pick<KubernetesSeams, "now" | "sleep">;
  readonly appVersion: string | null;
}

const EXPIRED = Symbol("expired");

export async function withMachineContext<T>(
  session: MachineSession,
  budget: ReadOnlyStatementBudget,
  options: MachineOptions,
  work: (context: KubectlContext) => Promise<T>,
): Promise<T> {
  assertReadOnlyBudget(budget, KUBERNETES_TYPE);
  if (!options.readOnly) throw new QueryError(MACHINE_PROFILE_SENTENCE, KUBERNETES_TYPE);
  const stop = new AbortController();
  const signal = AbortSignal.any([session.lifetime, stop.signal]);
  const context: KubectlContext = {
    surface: session.surface,
    call: statementCall(signal, options.seams.now() + budget.statementTimeoutMs, options.seams.now),
    now: options.seams.now,
    explainCache: session.explainCache,
    queryTimeoutMs: budget.statementTimeoutMs,
    appVersion: options.appVersion,
    machine: { maxRows: budget.maxResultRows, maxBytes: budget.maxResultBytes },
  };
  const timer = new AbortController();
  // Settles only when the time is up; an aborted timer leaves it pending for ever, which nothing awaits after the race.
  const expiry = options.seams.sleep(budget.statementTimeoutMs, timer.signal).then(
    (): typeof EXPIRED => EXPIRED,
    () => new Promise<never>(() => {}),
  );
  const pending = work(context);
  // A read abandoned at the deadline rejects once its requests are aborted; that rejection is expected, not unhandled.
  pending.catch(() => {});
  try {
    const answer = await Promise.race([pending, expiry]);
    if (answer === EXPIRED) {
      stop.abort();
      throw new QueryError(MACHINE_DEADLINE_SENTENCE, KUBERNETES_TYPE);
    }
    return answer;
  } finally {
    timer.abort();
  }
}

/** The result as the agent may receive it: refused, never truncated, past either budget. */
function withinBudget(result: QueryResult, budget: ReadOnlyStatementBudget): QueryResult {
  if (result.rows.length > budget.maxResultRows)
    throw new QueryError(rowBudgetSentence(result.rows.length, budget.maxResultRows), KUBERNETES_TYPE);
  const bytes = measureResultBytes(result.rows);
  if (bytes > budget.maxResultBytes)
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), KUBERNETES_TYPE);
  return result;
}

export async function readKubectlForMachine(
  session: MachineSession,
  statement: string,
  budget: ReadOnlyStatementBudget,
  mode: ReadOnlyStatementMode | undefined,
  options: MachineOptions,
): Promise<QueryResult> {
  if (mode === "estimate-plan") throw new QueryError(MACHINE_ESTIMATE_SENTENCE, KUBERNETES_TYPE);
  return withMachineContext(session, budget, options, async (context) => {
    const started = context.now();
    const grid = await runKubectl(context, statement);
    return withinBudget(resultOf(grid, context.now() - started), budget);
  });
}
