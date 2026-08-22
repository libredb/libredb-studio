/**
 * `granite4.1:3b` — measured at the defaults, and pinned to them.
 *
 * 4 of 6 modes locked, 23 of 30 runs passed.
 *
 *     Investigate 5/5 · Optimize 3/5 · Assess 5/5 · Operate 5/5 · Analyze 0/5 · Plan 5/5
 *
 * Still open: Optimize, Analyze.
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

export const GRANITE4_1_3B: AgentModelProfile = {
  measured:
    "4/6 modes locked, 23/30 runs passed at these settings. Investigate 5/5 · Optimize 3/5 · Assess 5/5 · Operate 5/5 · Analyze 0/5 · Plan 5/5.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  /*
    The second model to earn this, and its ledger is the clearest case yet.

    One query-optimization run, read end to end now that declines, reminders and stopping prose
    are all recorded:

        run_read_query   refused by the database
        inspect_plan     one plan
        compare_plans    IDENTICAL_PLANS — it compared the plan with itself
        recommend_change INVALID_TOOL_INPUT, three times
        compose_report   held (one plan), then INVALID_TOOL_INPUT, twice
        and then it wrote the whole report as PROSE — claim, evidence, and the real
        artifact id of the plan it had inspected

    So it knows the content and cannot produce the shape: five schema refusals in one run, and
    a paragraph at the end that says exactly what `compose_report` was asking for. An example
    is the one thing it was never given, and on `lfm2:24b` an example collapsed a loop of
    twenty-eight identical refusals into one.
  */
  refusalExamples: true,
  /*
    Five losing data-analysis runs, all the same shape as the one that cost `gemma4:26b` its
    Assess cell fifteen times: the run establishes something, then a turn comes back with no
    call and NO TEXT — neither stopping prose nor a closing statement, both of which are
    written whenever a turn holds any — and the loop reads that as a model that chose to stop.

    Counted per cell before switching it on, which is what makes this the right place: those
    five are all on data-analysis, and that cell is 4/5. Every other empty-turn loss on the
    board is one or two runs scattered across surfaces.
  */
  retryEmptyTurn: true,
  notices: { ...BASELINE_NOTICES },
};
