/**
 * `deepseek-r1:14b` — measured at the defaults, and pinned to them.
 *
 * 0 of 6 modes locked, 9 of 30 runs passed.
 *
 *     Investigate 0/5 · Optimize 1/5 · Assess 2/5 · Operate 4/5 · Analyze 0/5 · Plan 2/5
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

export const DEEPSEEK_R1_14B: AgentModelProfile = {
  measured:
    "0/6 modes locked, 9/30 runs passed at these settings. Investigate 0/5 · Optimize 1/5 · Assess 2/5 · Operate 4/5 · Analyze 0/5 · Plan 2/5.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  /*
    Answered in prose on its FIRST turn, correctly, and was told nothing.

    Its investigation run, read whole: no tool call, and a closing paragraph naming the tables
    and their keys — "To determine the tables in the database and their relationships, I
    analyzed the provided schema inventory and foreign key relations. Tables in the Database: 1.
    department: Contains dept_no (Primary Key) and dept..." That is the objective, answered.

    The drive withholds the report reminder from a run that called no tool, on the reasoning
    that such a run has stopped rather than hesitated. `nemotron-3.5-lightning:30b` was the
    first model measured breaking that reasoning, and this switch won it two cells. Same shape
    here, and nothing outside this file changes.
  */
  remindWithoutTools: true,
  notices: { ...BASELINE_NOTICES },
};
