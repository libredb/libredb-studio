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
    "one that reported nothing. Its other five surfaces lock 5/5 at these defaults.",
  sampling: DEFAULT_SAMPLING,
  unreportedCallCeiling: DEFAULT_UNREPORTED_CALL_CEILING,
  reportReminderLimit: 1,
};
