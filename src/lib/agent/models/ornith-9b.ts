/**
 * `ornith:9b` — measured at the defaults, and pinned to them.
 *
 * 2 of 6 modes locked, 25 of 30 runs passed.
 *
 *     Investigate 4/5 · Optimize 3/5 · Assess 4/5 · Operate 5/5 · Analyze 5/5 · Plan 4/5
 *
 * Still open: Investigate, Optimize, Assess, Plan.
 *
 * Nothing here differs from the default, and that is exactly why the file exists. The default
 * is a shared value, and a shared value is what has twice cost this repository a locked cell:
 * pinning sampling to 0 won five cells and lost one, and reordering a workflow's rules won
 * nothing and lost one. Those numbers above were obtained at temperature 0, top_p 1, and a
 * ceiling of 12 unreported calls. Writing them here means a later change to the defaults
 * cannot silently invalidate them — this model keeps what it was measured with until a new
 * measurement says otherwise.
 */

import { BASELINE_NOTICES } from "./notices";
import { DEFAULT_SAMPLING, DEFAULT_UNREPORTED_CALL_CEILING, type AgentModelProfile } from "./profile";

export const ORNITH_9B: AgentModelProfile = {
  measured:
    "2/6 modes locked, 25/30 runs passed at these settings. Investigate 4/5 · Optimize 3/5 · Assess 4/5 · Operate 5/5 · Analyze 5/5 · Plan 4/5.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  /*
    Its last open cell, and the loss is `no-statement` twice over.

    The closing prose is not a bad plan — it names all eight tables, their columns and their
    keys, correctly. What it never writes is a runnable statement or the explicit `NO
    STATEMENT:` refusal, and plan mode's bar is one of those two. `qwen3:14b` lost the same
    cell the same way and the extra turn won it.
  */
  planStatementRetries: 1,
  notices: { ...BASELINE_NOTICES },
};
