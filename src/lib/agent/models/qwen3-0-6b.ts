/**
 * `qwen3:0.6b` — measured at the defaults, and pinned to them.
 *
 * 1 of 6 modes locked, 5 of 29 runs passed.
 *
 *     Investigate 0/4 · Optimize 0/5 · Assess 0/5 · Operate 0/5 · Analyze 0/5 · Plan 5/5
 *
 * Still open: Investigate, Optimize, Assess, Operate, Analyze.
 *
 * Nothing here differs from the default, and that is exactly why the file exists. The default
 * is a shared value, and a shared value is what has twice cost this repository a locked cell:
 * pinning sampling to 0 won five cells and lost one, and reordering a workflow's rules won
 * nothing and lost one. Those numbers above were obtained at temperature 0, top_p 1, and a
 * ceiling of 12 unreported calls. Writing them here means a later change to the defaults
 * cannot silently invalidate them — this model keeps what it was measured with until a new
 * measurement says otherwise.
 */

import { DEFAULT_SAMPLING, DEFAULT_UNREPORTED_CALL_CEILING, type AgentModelProfile } from "./profile";

export const QWEN3_0_6B: AgentModelProfile = {
  measured:
    "1/6 modes locked, 5/29 runs passed at these settings. Investigate 0/4 · Optimize 0/5 · Assess 0/5 · Operate 0/5 · Analyze 0/5 · Plan 5/5.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
};
