/**
 * `muse-glimmer:latest` — measured at the defaults, and pinned to them.
 *
 * 3 of 6 modes locked, 21 of 26 runs passed.
 *
 *     Investigate 5/5 · Optimize 1/5 · Assess 5/5 · Operate 5/5 · Analyze 4/4 · Plan 1/2
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
 * Its Plan cell is the last one standing between this model and every surface, and nothing in
 * this file can win it. The losing run ends `model-timeout` at 150 seconds having produced no
 * text: the turn is cut before any exists, which is why its closing statement is empty. That
 * empty close was read as an empty COMPLETION once, and the retry that took `gemma4:26b` from
 * fifteen assessment losses to 5/5 was switched on here — it never fired, and it was removed
 * rather than kept as an override no measurement exercised. Measured at a 150-second turn
 * limit against a shipped default of 90.
 */

import { BASELINE_NOTICES } from "./notices";
import { DEFAULT_SAMPLING, DEFAULT_UNREPORTED_CALL_CEILING, type AgentModelProfile } from "./profile";

export const MUSE_GLIMMER_LATEST: AgentModelProfile = {
  measured:
    "3/6 modes locked, 21/26 runs passed at these settings. Investigate 5/5 · Optimize 1/5 · Assess 5/5 · Operate 5/5 · Analyze 4/4 · Plan 1/2.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  notices: { ...BASELINE_NOTICES },
};
