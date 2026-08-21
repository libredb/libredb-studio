/**
 * `qwen3.6:27b` — measured at the defaults, and pinned to them.
 *
 * 0 of 6 modes locked, 1 of 2 runs passed.
 *
 *     Investigate 1/1 · Optimize 0/1
 *
 * Still open: Investigate, Optimize, Assess, Operate, Analyze, Plan.
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

export const QWEN3_6_27B: AgentModelProfile = {
  measured: "0/6 modes locked, 1/2 runs passed at these settings. Investigate 1/1 · Optimize 0/1.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  notices: { ...BASELINE_NOTICES },
};
