/**
 * `gemma4:26b` — at the defaults, after two overrides were measured and deleted.
 *
 * Five surfaces lock 5/5. `database-assessment` has been measured fifteen times and the losing
 * runs all end the same shape: profile tables, count things, then a turn with neither a tool
 * call nor a report, and the drive concludes `model-stopped` with `no-report` unmet.
 *
 * Two fixes were tried on that reading and both are gone, because both were measured:
 *
 *     defaults              4/5
 *     ceiling of 9 calls    3/5   — every run made 8 calls, so it never fired
 *     two report reminders   2/5   — calls rose 8 to 11 and two runs hit the deadline
 *
 * The second one is the informative failure. The extra reminder does reach the model: it goes
 * back to work and profiles more tables. It does not report. So the model is not forgetting to
 * file, and it is not short of turns — it is spending the turn it was given on more reading,
 * and on two runs that spending cost the run its deadline.
 *
 * Neither call count separates the winners from the losers, which is what rules out narrowing:
 * the run that reported in 26 seconds made 11 calls, exactly as many as the run that reported
 * nothing. A ceiling low enough to catch a loser would catch a winner with it.
 *
 * So this file pins the defaults and the numbers stay recorded. What is still unread is the
 * text of the stopping turn — the ledger records calls and settlements, not what the model
 * said when it made no call — and that is what the next attempt here needs before it changes
 * anything.
 */

import { BASELINE_NOTICES } from "./notices";
import { DEFAULT_SAMPLING, DEFAULT_UNREPORTED_CALL_CEILING, type AgentModelProfile } from "./profile";

export const GEMMA4_26B: AgentModelProfile = {
  measured:
    "database-assessment, fifteen runs across three configurations: 4/5 at the defaults, 3/5 " +
    "with an unreported-call ceiling of 9 (never fired, every run made 8 calls), 2/5 with two " +
    "report reminders (calls rose from 8 to 11 and two runs hit the deadline). The losing runs " +
    "gather evidence and then produce a turn with neither a call nor a report. The second " +
    "reminder does reach the model and it goes back to reading rather than filing, so the " +
    "cause is not a forgotten call or a shortage of turns. Call count does not separate " +
    "winners from losers either: a run that reported in 26 seconds made 11 calls, as many as " +
    "one that reported nothing. Its other five surfaces lock 5/5 at these defaults. Measured " +
    "again at 4/5 once the stopping turn became readable: the losing run profiled nine tables, " +
    "ran two queries, then returned an EMPTY completion — no call, no text — at eleven calls, " +
    "one under the general ceiling. Its ceiling is 10 on that reading.",
  sampling: DEFAULT_SAMPLING,
  /*
    Ten, and this is the second time a ceiling has been set here — the first was a guess and
    this one is not.

    Earlier the same day a ceiling of 9 was set on the reading that one losing run had profiled eleven
    tables, and it was deleted a measurement later: five fresh runs all made EIGHT calls, so
    neither 12 nor 9 could have fired and what had been measured was noise.

    What was missing then was the ledger entry that now exists. The losing run in the latest
    five profiled NINE tables, ran two queries, and then returned a turn with no tool call and
    no text at all — an empty completion, which is why `model-stopped-saying` recorded nothing
    for it. Eleven calls, one under the general ceiling, and nothing left in the model to spend
    a twelfth on.

    So the distribution is now visible rather than assumed: this model's passing assessments
    finish in about eight calls and its losing one goes to eleven and empties out. Ten catches
    the second without touching the first, and the point of the number is that gap — a run
    narrowed at ten still has the turn it needs to file what it already has.
  */
  unreportedCallCeiling: 10,
  reportReminderLimit: 1,
  /*
    The illness, after two wrong medicines.

    What the file above says is still unread — "the text of the stopping turn" — turned out to
    be the answer: there is none. The losing assessments carry no `model-stopped-saying` and no
    `closing-statement`, and both are written whenever the turn holds any text at all. Ten
    seconds pass between the reminder and the end of the run.

    So it is not declining to file and it is not out of turns. It returns an EMPTY completion,
    which the loop reads as a model that chose to stop. That is why both earlier fixes made it
    worse: a second reminder and a lower ceiling are answers to a model that keeps working, and
    this one had stopped answering.
  */
  retryEmptyTurn: true,
  notices: { ...BASELINE_NOTICES },
};
