/**
 * `mistral-small3.2:24b` — sampled on data-analysis, because determinism pinned it to stopping.
 *
 * Four surfaces lock 5/5. `data-analysis` is 0 of 5, alternating `no-answer` and `no-report`,
 * and it took two measurements to get past the first cause and find the second.
 *
 * **First cause, fixed.** At temperature 0 the run took a reading, called `compose_report`, was
 * held with the notice to present its answer first, and STOPPED — 21 seconds into a 630-second
 * budget, so neither time nor tools were missing. Refused once, it gave up, and determinism
 * meant it gave up identically every run. That is the shape `qwen3:8b` showed on
 * query-optimization, where sampling at 0.8 recovered the cell. At 0.7 the stopping is gone:
 * the run now reads seven times, drafts a real aggregate, and composes its report.
 *
 * **Second cause, open.** It still loses, on `no-answer`, and the second measurement's ledger
 * holds no `call-held` at all — the hold that would have asked for the answer never fired.
 * The reason is a blind spot this drive documents in `answerAttempted`: a REFUSED
 * `present_answer` writes no ledger event, so a call the tool declined is indistinguishable
 * from a call never made, and the flag it sets disables the hold for the rest of the run.
 *
 * So the run almost certainly calls `present_answer`, is refused, and reports instead. Which
 * of the five refusals it hit — invalid input, an unknown artifact, an artifact that is not a
 * data read, a statement that cannot be found behind it, or a rejected chart spec — is not
 * recorded anywhere, and each one implies a different fix.
 *
 * **Third measurement, with the refusal now recorded** (`call-declined` exists because of this
 * cell). The run took a different path again: one `profile_table`, then `compose_report` held
 * with the citation notice — "you took readings and your report cited none of them" — and then
 * it stopped. No `present_answer` call at all, so no refusal to read.
 *
 * Three measurements, three different losses: stopped after a hold, reported without
 * presenting, held on citations and stopped. What they share is the shape of the first one:
 * **this model quits when it is corrected.** Sampling did not fix that, it randomised which
 * correction it quits on. That is a characteristic and not a setting, so the cell is parked.
 *
 * Nothing further is set here until that is visible. A second `presentReminderLimit` was tried
 * and removed: it aims at a hold that is not firing, so it could not have helped, and an
 * override with no measurement behind it is exactly what this directory refuses to hold.
 *
 * `query-optimization` is left alone too: its five losses spread across `no-report`,
 * `no-plan-comparison` and `empty-evidence`, which is not one cause with one setting behind it.
 */

import { BASELINE_NOTICES } from "./notices";
import { DEFAULT_UNREPORTED_CALL_CEILING, type AgentModelProfile } from "./profile";

export const MISTRAL_SMALL3_2_24B: AgentModelProfile = {
  measured:
    "4/6 modes locked. Investigate 5/5 · Assess 5/5 · Operate 5/5 · Plan 5/5 · Analyze 0/5 · " +
    "Optimize 0/5. At temperature 0 the analysis run was held once, told to present its answer " +
    "before reporting, and stopped — 21 seconds into a 630-second budget. Sampled at 0.7 that " +
    "stopping is gone: it reads seven times, drafts an aggregate and composes the report. It " +
    "still loses on no-answer, and that ledger records NO hold at all, which means present_answer " +
    "was called and refused: a refused call writes no event but still sets the flag that " +
    "disables the hold. Which of the five refusals it hit is not recorded, so nothing more is " +
    "set here. Optimize is untouched: its losses span no-report, no-plan-comparison and " +
    "empty-evidence, which is not one cause.",
  perWorkflow: { "data-analysis": { temperature: 0.7, topP: 0.9 } },
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  /*
    Third model to be given it, and on the weakest evidence of the three — said plainly so the
    next reader can delete it if the measurement does not come.
    `lfm2:24b` earned it on a loop of twenty-eight identical shape refusals collapsing to one.
    `granite4.1:3b` earned it twice over: with the example its report landed where two refusals
    had stopped it, and with the example on `recommend_change` as well the cell locked 5/5.
    This model has the same shape of loss on two cells — `present_answer` refused
    INVALID_TOOL_INPUT on data-analysis, and query-optimization losing across `no-report`,
    `no-plan-comparison` and `empty-evidence` — but no ledger yet showing it take an example and
    recover. It is switched on to find out, and the answer belongs in this comment either way.
  */
  refusalExamples: true,
  notices: { ...BASELINE_NOTICES },
};
