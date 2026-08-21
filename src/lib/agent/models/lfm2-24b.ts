/**
 * `lfm2:24b` — measured at the defaults, and pinned to them.
 *
 * 1 of 6 modes locked, 12 of 30 runs passed.
 *
 *     Investigate 5/5 · Optimize 1/5 · Assess 3/5 · Operate 0/5 · Analyze 0/5 · Plan 3/5
 *
 * Still open: Optimize, Assess, Operate, Analyze, Plan.
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

export const LFM2_24B: AgentModelProfile = {
  measured:
    "1/6 modes locked. Investigate 5/5 · Optimize 1/5 · Assess 3/5 · Operate 0/5 · Analyze 0/5 · " +
    "Plan 3/5. Optimize was measured four times in one evening and every fix moved it one bar " +
    "further rather than winning it. Two compare-before-report holds took it from 1/5 to 3/4. A " +
    "worked call for compare_plans turned its shape refusals into an id refusal " +
    "(UNVERIFIABLE_PLAN) and it recorded a recommendation for the first time. The run after that " +
    "lost on empty-evidence, held with the notice that every result its report cited came back " +
    "with NO rows. So the protocol failures are gone — it can build the calls now — and what is " +
    "left is that its statements return nothing, which no setting in this file reaches.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  /*
    Two tellings, on three runs that read the same way.

    Every one of its losing optimization runs holds exactly one plan, is held once with the
    notice naming both ways through — a second plan to compare, or an index recommendation
    citing the plan it already has — and then reports without doing either. The hold is a
    one-shot by default, so the second report lands and the run scores `no-plan-comparison`.

    Measured alongside: the worked example this model earned deleted its
    `RECOMMENDATION_SHAPE_MISMATCH` refusals outright, five to zero, so what remains is not the
    shape of the call but the decision to make it at all.
  */
  compareReminderLimit: 2,
  // Earned on one ledger: refused `INVALID_TOOL_INPUT` twenty-eight times in a row on a
  // data-analysis run without ever changing the shape it sent, and with a worked example in the
  // refusal it took one and got the shape right on the next turn. Measured again on
  // query-optimization: its `RECOMMENDATION_SHAPE_MISMATCH` refusals went five to zero.
  refusalExamples: true,
  notices: { ...BASELINE_NOTICES },
};
