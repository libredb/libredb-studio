/**
 * `gemma4:26b` — a lower unreported-call ceiling, because it reads past its budget.
 *
 * Five surfaces lock 5/5. `database-assessment` is 4 of 5, and its two ledgers side by side
 * say exactly what the fifth run did differently:
 *
 *     passed:  profiled 4 tables, then reported
 *     lost:    profiled 11 — employee, department, dept_emp, dept_manager, salary, title,
 *              several of them twice — then ended `model-stopped` with no report at all
 *
 * It is not failing to assess. It assesses more thoroughly than the run has room for, and
 * then has nothing left to report with. The mechanism written for precisely this is the
 * unreported-call ceiling: once a run has made that many calls without reporting, it is
 * narrowed to the tools that would finish it. The general ceiling is 12. The losing run
 * stopped at 11 — one call under, so the guard it needed never fired.
 *
 * Nine, not eleven, and the margin is the point: the passing run finished in four calls, so
 * there is a wide gap between what this model needs and where the ceiling has to sit. Setting
 * it at 11 would have caught this one run and left no room for the next one to be slightly
 * greedier.
 *
 * Deliberately in this file rather than in the global constant. Lowering the ceiling for
 * everyone would change every run of every model to win one cell, and that trade has already
 * been paid for twice here — a rules reorder took this same model from 5/5 to 3/5 on another
 * surface and had to be reverted. Nothing outside this file changes.
 */

import type { AgentModelProfile } from "./profile";

export const GEMMA4_26B: AgentModelProfile = {
  measured:
    "database-assessment 4/5. The four passing runs profile 3-4 tables and report; the losing " +
    "run profiled 11 (six tables, several twice) and ended model-stopped with no report. The " +
    "unreported-call ceiling that exists for this is 12 and the run stopped at 11, one under, " +
    "so it never fired. Its other five surfaces lock 5/5 at every default, so nothing else is " +
    "overridden here.",
  unreportedCallCeiling: 9,
};
