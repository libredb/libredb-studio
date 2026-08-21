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

import { BASELINE_NOTICES } from "./notices";
import { DEFAULT_SAMPLING, DEFAULT_UNREPORTED_CALL_CEILING, type AgentModelProfile } from "./profile";

export const QWEN3_0_6B: AgentModelProfile = {
  measured:
    "1/6 modes locked, 5/29 runs passed at these settings. Investigate 0/4 · Optimize 0/5 · Assess 0/5 · Operate 0/5 · Analyze 0/5 · Plan 5/5.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  /*
    The smallest model on the board, and it answered the investigation in prose on its first
    turn: "The tables in the database are: `current_dept_emp` (no columns derivable from stored
    definition), `department` (columns: dept_no, dept_name), `dept_emp` (emp_no, dept_no,
    from_date, to_date), `dept_manager`..." — the inventory read correctly, including the two
    column-less views.

    No tool call, so no reminder: the drive treats a run that called nothing as one that
    stopped. That reading has now been measured wrong twice — `nemotron-3.5-lightning:30b` won
    two cells when this was switched on, and `deepseek-r1:14b` produces the same paragraph.
  */
  remindWithoutTools: true,
  notices: { ...BASELINE_NOTICES },
};
