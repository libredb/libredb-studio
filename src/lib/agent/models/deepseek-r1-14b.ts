/**
 * `deepseek-r1:14b` — measured at the defaults, and pinned to them.
 *
 * 1 of 6 modes locked, 12 of 30 runs passed.
 *
 *     Investigate 5/5 · Optimize 1/5 · Assess 2/5 · Operate 2/3 · Analyze 0/5 · Plan 2/5
 *
 * Still open: Optimize, Assess, Operate, Analyze, Plan.
 *
 * Investigate went from nothing to five for five on one change, and it is the cell the two
 * switches below were both written for: the first lets this model hear the report reminder
 * at all, the second stops it hearing it before there is anything to report.
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
    "1/6 modes locked, 12/30 runs passed at these settings. Investigate 5/5 · Optimize 1/5 · Assess 2/5 · Operate 2/3 · Analyze 0/5 · Plan 2/5.",
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
  /*
    And the other half of that switch, which the first measurement could not see.

    Turning the reminder on above means this model hears it on a turn where it called nothing —
    including the FIRST turn, before it has read anything. Its database-assessment ledger is
    what that costs: `report-reminder` is the first entry after the run started, then five
    `compose_report` calls declined `UNVERIFIABLE_EVIDENCE` back to back, then, after all five,
    the run's first `profile_table`. It obeyed an instruction nothing could satisfy, and the
    refusal could not even list what to cite because there was nothing to list.

    So the reminder waits here until the run holds an artifact or a snapshot. `nemotron` keeps
    hearing it unconditionally: its case is a run that answers from an inventory it is already
    holding, which is evidence, and that model does not carry this field.
  */
  requireEvidenceBeforeReminder: true,
  notices: { ...BASELINE_NOTICES },
};
