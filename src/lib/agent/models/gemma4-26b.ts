/**
 * `gemma4:26b` — told to report twice, because once is not how this model stops.
 *
 * Five surfaces lock 5/5. `database-assessment` has been measured ten times and sits around
 * three or four, and every losing ledger ends the same shape:
 *
 *     profile 4 tables · count 4 things · a turn with no call and no report · model-stopped
 *
 * It is not failing to assess. It gathers the evidence and then declines to file it. The drive
 * already answers that turn with the report reminder, and this model takes the reminder and
 * stops again — the losing runs spend 36 seconds of a budget measured in minutes, so what they
 * run out of is not time. Two reminders, so the run gets a second chance at the one call left.
 *
 * A ceiling of 9 unreported calls was tried here first, on the reading that an earlier losing
 * run had profiled eleven tables and left itself nothing to report with. Five runs at 9 came
 * back 3 of 5, and their ledgers showed why the change could not have mattered: every one made
 * eight calls, so the ceiling never fired at 12 and would not have fired at 9. That override
 * is deleted rather than kept. The eleven-table run was one run, and the difference between
 * 4/5 and 3/5 on five runs is noise — reading a mechanism into it was the mistake.
 *
 * Per-model rather than global for both. A second reminder spends a turn out of every run's
 * fixed budget, and paying that on 25 models to win one cell is the trade this repository has
 * already lost twice — a rules reorder took this same model from 5/5 to 3/5 on another surface
 * and had to be reverted. Nothing outside this file changes.
 */

import type { AgentModelProfile } from "./profile";

export const GEMMA4_26B: AgentModelProfile = {
  measured:
    "database-assessment, ten runs, three or four passing. Every losing run profiles its " +
    "tables, runs its counts, then produces a turn with neither a tool call nor a report and " +
    "ends model-stopped with no-report unmet, having used 36 seconds of the run budget. It " +
    "takes the single report reminder and stops again, so it is given two. A ceiling of 9 " +
    "unreported calls was measured here first and deleted: five runs came back 3/5 and all " +
    "five made eight calls, so neither 12 nor 9 could have fired. Its other five surfaces " +
    "lock 5/5 at every default, so nothing else is overridden here.",
  reportReminderLimit: 2,
};
