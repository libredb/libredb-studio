/**
 * `gemini-3.5-flash-lite` — measured at the defaults, and pinned to them.
 *
 * 6 of 6 modes locked, 30 of 30 runs passed.
 *
 *     Investigate 5/5 · Optimize 5/5 · Assess 5/5 · Operate 5/5 · Analyze 5/5 · Plan 5/5
 *
 * Every mode is locked.
 *
 * The one HOSTED model in this directory, and the only reason that is worth saying here is that
 * its numbers were obtained the same way as the nine local ones — same six surfaces, same five
 * consecutive passes per surface, same shipped turn limit — so the ten are one table and not two.
 *
 * Nothing here differs from the default, and that is exactly why the file exists. The default is
 * a shared value, and a shared value is what has twice cost this repository a locked cell:
 * pinning sampling to 0 won five cells and lost one, and reordering a workflow's rules won
 * nothing and lost one. Those numbers above were obtained at temperature 0, top_p 1, and a
 * ceiling of 12 unreported calls. Writing them here means a later change to the defaults cannot
 * silently invalidate them — this model keeps what it was measured with until a new measurement
 * says otherwise.
 */

import { BASELINE_NOTICES } from "./notices";
import { DEFAULT_SAMPLING, DEFAULT_UNREPORTED_CALL_CEILING, type AgentModelProfile } from "./profile";

export const GEMINI_3_5_FLASH_LITE: AgentModelProfile = {
  measured:
    "6/6 modes locked, 30/30 runs passed at these settings. Investigate 5/5 · Optimize 5/5 · Assess 5/5 · Operate 5/5 · Analyze 5/5 · Plan 5/5.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  /*
    Its one loss in thirty, and it is the shape this switch was written for.

    Query-optimization: the report is refused once — `claims.0.evidence.0.source` naming neither
    of the two forms evidence takes — then held for the plan the surface is scored on, and then
    the run ends `model-stopped` carrying no text at all. Neither `model-stopped-saying` nor
    `closing-statement`, and both are written whenever a turn holds any.

    So it is not declining to fix the call; it stops answering after being corrected.
  */
  retryEmptyTurn: true,
  notices: { ...BASELINE_NOTICES },
};
