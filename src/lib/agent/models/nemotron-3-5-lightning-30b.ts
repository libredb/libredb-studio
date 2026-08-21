/**
 * `nemotron-3.5-lightning:30b` — reminded to report even when it called nothing.
 *
 * Four surfaces lock 5/5. The three losses have three different causes, and only one of them
 * is ours:
 *
 *     investigate  4/5, `no-report` — answered correctly in 29 seconds and called nothing
 *     assess       4/5, `no-report` — read, counted, then stopped without filing
 *     plan         two runs `model-timeout` at 150.06 seconds — the model's first turn
 *                  outruns the turn limit, which is a speed problem and not a settings one
 *
 * The investigation loss is the one addressed here. Asked what tables exist and how they
 * relate, the run named all eight from the inventory it was handed, described the relations,
 * and reached for no tool at all. That answer is right. The drive scored it `no-report`
 * because agent mode files a report by CALLING `compose_report`, and prose is not a call.
 *
 * There is a reminder for exactly that, and this run was excluded from it by design: the
 * drive withholds it from a run that called no tool, on the reasoning that such a run is
 * stopping rather than hesitating and that a second telling costs a turn to prove it. Sound
 * for most models. Wrong for one that answers out of the inventory, which is indistinguishable
 * from stopping until you read what it said.
 *
 * `remindWithoutTools` is false everywhere else, so nothing outside this file changes. It is a
 * turn spent on a run that may well be finished, and paying that across 25 models to win one
 * cell is the trade this repository has twice lost a cell to.
 *
 * The plan timeouts are deliberately not addressed. Raising the turn limit for this model
 * would measure a run the product does not offer: the shipped limit is 90 seconds, these runs
 * died at 150, and the honest reading is that plan mode on this model is too slow rather than
 * misconfigured.
 */

import { BASELINE_NOTICES } from "./notices";
import { DEFAULT_SAMPLING, DEFAULT_UNREPORTED_CALL_CEILING, type AgentModelProfile } from "./profile";

export const NEMOTRON_3_5_LIGHTNING_30B: AgentModelProfile = {
  measured:
    "4/6 modes locked, 26/30 runs passed. Investigate 4/5 · Optimize 5/5 · Assess 4/5 · " +
    "Operate 5/5 · Analyze 5/5 · Plan 5/17. The investigation loss answered the objective " +
    "correctly in 29 seconds — all eight tables named, relations described — from the " +
    "inventory the run was handed, and called nothing, so the report reminder was withheld " +
    "from it as though it had stopped. Both plan losses are model-timeout at 150.06s on the " +
    "first turn, which no setting here fixes: the shipped turn limit is 90 seconds. The " +
    "assessment loss reads and counts and then stops without filing, the same shape as " +
    "gemma4:26b, and is not addressed yet.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  remindWithoutTools: true,
  notices: { ...BASELINE_NOTICES },
};
