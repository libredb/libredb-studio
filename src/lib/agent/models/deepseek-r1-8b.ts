/**
 * `deepseek-r1:8b` — a much larger report reserve, because its turns are minutes long.
 *
 * Five surfaces lock 5/5. `query-optimization` loses both of its failing runs the same way,
 * and neither is a failure of analysis. Timed from their ledgers, in seconds from run start:
 *
 *     run A:  81 first call · 135 statement drafted and run · 142 and 242 two index
 *             recommendations · 294 another call · 450 deadline-exceeded, nothing reported
 *     run B:  69 · 108 · 164 and 264 two recommendations · 374 and 385 statements drafted
 *             and run · 450 deadline-exceeded, nothing reported
 *
 * Both diagnosed the statement and recommended indexes. Both then ran out of clock with the
 * work done and nothing filed. The gaps between those entries are what this model's turns
 * cost: 81, 54, 100, 52, 156 seconds — a reasoning model thinking out loud before it acts.
 *
 * The loop has a mechanism for exactly this: within the reserve of a ceiling it tells the run
 * that this is its last turn and to report with what it has. The general reserve is twenty
 * seconds, sized for a turn on this workload, and this model has no twenty-second turns. The
 * notice arrives at a run that cannot complete a turn to act on it.
 *
 * 160 seconds, which is its slowest observed turn, so the sentence lands while a full turn
 * remains. That is a third of the 450-second budget spent on a warning, and it stays in this
 * file for that reason: on a model whose turns take 15 seconds the same reserve would be
 * mostly idle clock taken out of the reading half of every run.
 *
 * That alone was measured and was not enough, and the run it produced said why:
 *
 *     113s  statement drafted and run
 *     190s  a rewrite recommendation recorded
 *     383s  compose_report CALLED — and held, with the notice to inspect a plan first
 *     450s  deadline, no report
 *
 * The report was written. This server refused it and asked for a plan, and a model whose turns
 * take 100 seconds had 67 left. The hold is what teaches a run what its report is missing and
 * it has won cells doing exactly that, but a run with no turn left cannot be taught anything —
 * so `holdReportWithoutTime` is off here, and a report arriving inside this model's reserve
 * lands instead of being sent back. A report scoring one shortfall shows the user more than
 * `no-report` does.
 */

import { BASELINE_NOTICES } from "./notices";
import { DEFAULT_SAMPLING, DEFAULT_UNREPORTED_CALL_CEILING, type AgentModelProfile } from "./profile";

export const DEEPSEEK_R1_8B: AgentModelProfile = {
  measured:
    "5/6 modes locked. Investigate 5/5 · Assess 5/5 · Operate 5/5 · Analyze 5/5 · Plan 5/5 · " +
    "Optimize 2/4. Both losing optimization runs end deadline-exceeded at 450s having already " +
    "drafted and run the statement and recorded two index recommendations, so the analysis was " +
    "done and only the report was missing. Turn gaps measured from those two ledgers: 81, 54, " +
    "100, 52 and 156 seconds. The report reserve that exists for this is 20 seconds, which is " +
    "shorter than any turn this model takes, so the last-turn notice reached a run with no turn " +
    "left; it is raised to its slowest observed turn instead. That alone measured 0/1 and the " +
    "run said why: it CALLED compose_report at 383s, was held with the notice to inspect a " +
    "plan first, and had 67 seconds against a 100-second turn. So a report arriving inside " +
    "this model's reserve is no longer held.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  reportReserveMs: 160_000,
  holdReportWithoutTime: false,
  notices: { ...BASELINE_NOTICES },
};
