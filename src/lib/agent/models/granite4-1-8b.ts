/**
 * `granite4.1:8b` — measured at the defaults, and pinned to them.
 *
 * 3 of 6 modes locked, 24 of 30 runs passed.
 *
 *     Investigate 3/5 · Optimize 2/5 · Assess 5/5 · Operate 4/5 · Analyze 5/5 · Plan 5/5
 *
 * Still open: Investigate, Optimize, Operate.
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

export const GRANITE4_1_8B: AgentModelProfile = {
  measured:
    "3/6 modes locked, 24/30 runs passed at these settings. Investigate 3/5 · Optimize 2/5 · Assess 5/5 · Operate 4/5 · Analyze 5/5 · Plan 5/5.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  /*
    Three `no such column` refusals on data-analysis. The smallest of the four cases selected this
    way and recorded as such: if the advice moves nothing here it is the weakest evidence of the
    set, not a verdict on the advice.
  */
  refusalExamples: true,
  /*
    Its query-optimization losses are one shape, and it is a shape with a measured cure.

    The cell reads 3/5 on a rested machine and 4/5 on the build from before this branch merged
    `main`, so it is the model rather than the laptop and rather than anything changed here —
    its 5/5 came from one lucky five. Both losing ledgers read identically: a statement drafted,
    the read completed, the report reminder delivered, and the run ends `model-stopped` carrying
    no text at all — neither `model-stopped-saying` nor `closing-statement`, and both are written
    whenever a turn holds any. An EMPTY completion, which the loop reads as a model that chose
    to stop.

    That is what took `gemma4:26b` from fifteen losses on one cell to 5/5. Same signature, same
    switch, and the same bound: once per drive.
  */
  retryEmptyTurn: true,
  notices: { ...BASELINE_NOTICES },
};
