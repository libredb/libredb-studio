/**
 * `deepseek-r1:7b` — measured at the defaults, and pinned to them.
 *
 * 1 of 6 modes locked, 6 of 30 runs passed.
 *
 *     Investigate 1/5 · Optimize 0/5 · Assess 0/5 · Operate 0/5 · Analyze 0/5 · Plan 5/5
 *
 * Still open: Investigate, Optimize, Assess, Operate, Analyze.
 *
 * The last cell on the board to pass nothing at all. Plan locked once the worked
 * `recommend_change` call below was switched on — measured five for five where it had been
 * three for five, and it is now the model's one settled mode.
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

export const DEEPSEEK_R1_7B: AgentModelProfile = {
  measured:
    "1/6 modes locked, 6/30 runs passed at these settings. Investigate 1/5 · Optimize 0/5 · Assess 0/5 · Operate 0/5 · Analyze 0/5 · Plan 5/5.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  /*
    Twelve `INVALID_TOOL_INPUT recommend_change` in a single run — the densest refusal any one
    run on this board has produced, and the whole of this model's decline record.

    Not the evidence refusal the other two deepseeks hit: nothing here is wrong about WHAT it
    wants to recommend, only about the shape of the call carrying it. That is precisely what
    `exampleRecommendCall` answers, and it is the one refusal aid that stays off until a
    ledger asks for it. This one asked twelve times in a row.
  */
  refusalExamples: true,
  notices: { ...BASELINE_NOTICES },
};
