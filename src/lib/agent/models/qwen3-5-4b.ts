/**
 * `qwen3.5:4b` — measured at the defaults, and pinned to them.
 *
 * 3 of 6 modes locked, 24 of 30 runs passed.
 *
 *     Investigate 5/5 · Optimize 3/5 · Assess 5/5 · Operate 5/5 · Analyze 3/5 · Plan 3/5
 *
 * Still open: Optimize, Analyze, Plan.
 *
 * Nothing here differs from the default, and that is exactly why the file exists. The default
 * is a shared value, and a shared value is what has twice cost this repository a locked cell:
 * pinning sampling to 0 won five cells and lost one, and reordering a workflow's rules won
 * nothing and lost one. Those numbers above were obtained at temperature 0, top_p 1, and a
 * ceiling of 12 unreported calls. Writing them here means a later change to the defaults
 * cannot silently invalidate them — this model keeps what it was measured with until a new
 * measurement says otherwise.
 *
 * Its Plan cell is not a settings problem. The losing run ends `model-timeout` at 150 seconds
 * having produced no text at all, so there is nothing for the plan bar to score — not a missing
 * statement and not an empty completion, a turn that does not finish. The empty close was read
 * as an empty COMPLETION once and the retry that won `gemma4:26b` its Assess cell was switched
 * on here; it never fired, and it was removed rather than left as an override no measurement
 * exercised. Measured at a 150-second turn limit against a shipped default of 90, so the cell
 * is worse in the product than on this board.
 */

import { BASELINE_NOTICES } from "./notices";
import { DEFAULT_SAMPLING, DEFAULT_UNREPORTED_CALL_CEILING, type AgentModelProfile } from "./profile";

export const QWEN3_5_4B: AgentModelProfile = {
  measured:
    "3/6 modes locked, 24/30 runs passed at these settings. Investigate 5/5 · Optimize 3/5 · Assess 5/5 · Operate 5/5 · Analyze 3/5 · Plan 3/5.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  /*
    Eight `no such column` refusals across query-optimization and data-analysis — the most of any
    model that did not already carry this. Both of its open cells are the ones producing them,
    which is what makes it worth measuring here rather than anywhere else.
  */
  refusalExamples: true,
  notices: { ...BASELINE_NOTICES },
};
