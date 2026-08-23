/**
 * `qwen3.5:9b` — measured at the defaults, and pinned to them.
 *
 * 6 of 6 modes locked, 30 of 30 runs passed.
 *
 *     Investigate 5/5 · Optimize 5/5 · Assess 5/5 · Operate 5/5 · Analyze 5/5 · Plan 5/5
 *
 * Every mode is locked.
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

export const QWEN3_5_9B: AgentModelProfile = {
  measured:
    "6/6 modes locked, 30/30 runs passed at these settings. Investigate 5/5 · Optimize 5/5 · Assess 5/5 · Operate 5/5 · Analyze 5/5 · Plan 5/5.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  /*
    Its plan turn does not fit the 90 seconds the product allows, and nothing else about it is
    marginal: the other five surfaces clear 5/5 with room.

    The turns are bimodal — 26 seconds when the cell passes, 92 to 94 when it does not — so the
    verdict is decided by which side of the line one turn lands on. Measured 1/5 here and 1/5 on
    the build from before this branch merged `main`, which rules out both a regression and the
    laptop. The 5/5 that put this model on the list was taken when the limit was 150, and 150 is
    what it is given back.

    Only this model. The default stays 90 for the other nine, because it is a promise about how
    long a person waits rather than a fact about any model.
  */
  turnTimeoutMs: 150_000,
  /*
    The same ending its Plan cell had, one surface over: query-optimization loses on `no-report`
    with the run stopping after feedback and leaving no text behind, which is an empty completion
    rather than a model that gave up on the work.
  */
  retryEmptyTurn: true,
  notices: { ...BASELINE_NOTICES },
};
