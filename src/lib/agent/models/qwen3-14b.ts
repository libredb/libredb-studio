/**
 * `qwen3:14b` — one extra plan turn, to ask for the deliverable it skipped.
 *
 * Five surfaces lock 5/5. `plan` is 4 of 5 and loses on one shortfall, `no-statement`, and the
 * losing run is not a bad plan. It lists all eight tables with their columns, names both join
 * tables, says which key every relation travels on, and marks the two column-less tables as
 * views. It answers the objective completely.
 *
 * What it never writes is the deliverable. Plan mode scores one of exactly two endings — a
 * fenced statement this engine could run, or the explicit `NO STATEMENT:` refusal for a
 * question the inventory cannot support — and this run wrote prose and stopped. Its other four
 * runs fenced a statement, so the model can do it; on one run in five it answers the question
 * and forgets what the answer is for.
 *
 * Planning had no notice for that: the prose arrives, `conclude` files it as the closing
 * statement, and the run is over. So the mechanism is new, and it is off by default — a plan
 * run that produced prose has answered or it has not, and 24 models clear this bar unaided.
 * One turn, offered to this model only, costing 15 seconds of a run that spends 15.
 *
 * The notice offers the refusal as plainly as the statement. Asking only for SQL would push a
 * model whose inventory cannot answer into inventing a table name to satisfy the bar, which is
 * the failure the verifier accepts refusals to avoid.
 */

import { BASELINE_NOTICES } from "./notices";
import { DEFAULT_SAMPLING, DEFAULT_UNREPORTED_CALL_CEILING, type AgentModelProfile } from "./profile";

export const QWEN3_14B: AgentModelProfile = {
  measured:
    "5/6 modes locked, 29/30 runs passed. Investigate 5/5 · Optimize 5/5 · Assess 5/5 · " +
    "Operate 5/5 · Analyze 5/5 · Plan 4/5. The single loss is no-statement on plan: the run " +
    "described all eight tables, both join tables and the key each relation travels on, then " +
    "stopped without a fenced statement or the NO STATEMENT refusal that plan mode scores. Its " +
    "other four plan runs fenced a statement, so it gets one extra turn to be asked for the " +
    "deliverable — a planning run costs 15 seconds, and no other model is offered it.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  planStatementRetries: 1,
  notices: { ...BASELINE_NOTICES },
};
