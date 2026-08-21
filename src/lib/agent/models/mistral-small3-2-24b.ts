/**
 * `mistral-small3.2:24b` — sampled on data-analysis, because determinism pins it to stopping.
 *
 * Four surfaces lock 5/5. Two do not, and both lose to the same thing: the model narrates or
 * gives up rather than filing. `data-analysis` is 0 of 5, alternating `no-answer` and
 * `no-report`, and one of its ledgers is the whole diagnosis:
 *
 *     took a reading · called compose_report · HELD, told to present the answer first
 *     · stopped. 21 seconds of a 630-second budget.
 *
 * It had the time and it had the tools. Refused once, it stops — and at temperature 0 it stops
 * every time, because there is no other branch for it to find. That is the shape `qwen3:8b`
 * showed on query-optimization, where determinism pinned it to a losing opening in 10 runs out
 * of 10 and sampling at 0.8 recovered the cell.
 *
 * So 0.7 here, on this surface only. Its four locked surfaces keep the deterministic default,
 * because a cell that locks 5/5 deterministically has nothing to gain from variance and
 * something to lose.
 *
 * Measured at 0.7: the stopping is gone. The run took its reading, was held, and composed the
 * report on the very next turn instead of giving up — which is what the sampling was for. It
 * still lost, on `no-answer`, because it never called `present_answer`.
 *
 * That is a second, separate refusal and it gets a second telling. The hold that asks for the
 * answer fires once by default, and this model reports straight through it: held, told to
 * present first, it files the report anyway and the answer pane lands empty. Two holds here,
 * one everywhere else, because a second is a turn spent arguing with a model that has already
 * declined.
 *
 * `query-optimization` is left alone for now: its five losses spread across three different
 * shortfalls (`no-report`, `no-plan-comparison`, `empty-evidence`), which is not one cause
 * with one setting behind it.
 */

import { DEFAULT_UNREPORTED_CALL_CEILING, type AgentModelProfile } from "./profile";

export const MISTRAL_SMALL3_2_24B: AgentModelProfile = {
  measured:
    "4/6 modes locked. Investigate 5/5 · Assess 5/5 · Operate 5/5 · Plan 5/5 · Analyze 0/5 · " +
    "Optimize 0/5. The analysis ledgers alternate no-answer and no-report, and one shows the " +
    "mechanism: it took a reading, called compose_report, was held with the notice to present " +
    "the answer first, and stopped — 21 seconds into a 630-second budget, so neither time nor " +
    "tools were missing. At temperature 0 it stops the same way every run, which is the shape " +
    "qwen3:8b showed before sampling recovered its cell, so this surface samples at 0.7. " +
    "Optimize is untouched: its five losses span no-report, no-plan-comparison and " +
    "empty-evidence, which is not one cause. At 0.7 the stopping stopped — the run composed its " +
    "report on the turn after the hold rather than giving up — and it lost on no-answer " +
    "instead, having never called present_answer through a hold that fires once, so it is " +
    "given two.",
  perWorkflow: { "data-analysis": { temperature: 0.7, topP: 0.9 } },
  presentReminderLimit: 2,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
};
