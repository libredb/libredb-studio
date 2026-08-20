/**
 * The shape a per-model file may declare, and the rule every one of them obeys.
 *
 * Separate from `index.ts` so a model file imports the contract without importing the
 * registry that lists it — otherwise every profile would depend on every other profile
 * through the barrel, and adding one would be a change to all of them.
 */

import type { AgentRunWorkflowType } from "../types";

/** How a turn is sampled. Structural output, so the default explores nothing. */
export interface AgentSampling {
  readonly temperature: number;
  readonly topP: number;
}

export interface AgentModelProfile {
  /**
   * What was measured to justify this profile, in numbers.
   *
   * Required, and a test refuses a profile whose measurement is too short to be one. An
   * override with no measurement behind it cannot be told apart from a guess, and a
   * directory of per-model settings is exactly where guesses would accumulate unnoticed:
   * each one looks local and harmless, and together they become a configuration nobody can
   * justify or delete.
   */
  readonly measured: string;
  /** Sampling for this model on every surface, where it differs from the default. */
  readonly sampling?: Partial<AgentSampling>;
  /** Sampling for named surfaces only, which is the narrowest an override can be. */
  readonly perWorkflow?: Partial<Record<AgentRunWorkflowType, Partial<AgentSampling>>>;
  /**
   * How many calls this model may make without reporting before the run is narrowed to the
   * tools that would finish it.
   *
   * A model that reads more thoroughly than the run has room for needs this lower than the
   * default. `gemma4:26b` is the measured case: its passing assessments profile four tables,
   * and the one that lost profiled eleven and had nothing left to report with — one call
   * under the general ceiling of 12, so the guard never fired.
   */
  readonly unreportedCallCeiling?: number;
  /**
   * How many times a drive may answer a no-call turn with the report reminder.
   *
   * One is enough for a model that stopped because it forgot; it is not enough for a model
   * that stops as its habit. `gemma4:26b` is the measured case: across ten assessments every
   * losing run gathered its evidence, produced a turn with neither a call nor a report, took
   * the single reminder, and stopped again — with most of the run's time still unspent.
   */
  readonly reportReminderLimit?: number;
  /**
   * How many extra turns a PLAN run gets when its prose named no statement and no refusal.
   *
   * Zero by default, because a run that answered its objective is not obviously owed another
   * turn, and 24 models clear this bar unaided. `qwen3:14b` is the measured case: its losing
   * plan describes all eight tables and every relation and then stops without the fenced
   * statement or the explicit refusal that plan mode scores.
   */
  readonly planStatementRetries?: number;
  /**
   * How much of the run's clock is reserved for the report, in milliseconds.
   *
   * The general reserve is sized for a turn on this workload, and a reasoning model's turn is
   * not that turn. `deepseek-r1:8b` is the measured case: its query-optimization runs spend
   * 50 to 160 seconds inside a single model call, so a notice delivered with 20 seconds left
   * arrives at a run that cannot complete a turn to act on it. Both of its losing runs had
   * already drafted the statement and recorded two index recommendations, and died on the
   * deadline with the analysis done and nothing filed.
   */
  readonly reportReserveMs?: number;
  /**
   * Whether a report may be held for the verdict it would earn when no turn is left to act on
   * the holding.
   *
   * True everywhere, because the hold is what teaches a run what its report is missing. False
   * where the teaching cannot land: `deepseek-r1:8b` called `compose_report` at 383 seconds of
   * a 450-second run, was held and told to inspect a plan first, and had no 100-second turn
   * left to do it in. The hold turned a report that would have scored one shortfall into no
   * report at all.
   */
  readonly holdReportWithoutTime?: boolean;
}

/**
 * The general ceiling, which is what every locked cell was measured against.
 *
 * Twelve is deliberately generous: it is a backstop against a run that is looping rather than
 * a budget for a run that is working, and a model that needs it lower says so in its own file
 * rather than lowering it for everyone.
 */
export const DEFAULT_UNREPORTED_CALL_CEILING = 12;

/**
 * One reminder, which is what every locked cell was measured against.
 *
 * A reminder costs a turn out of a fixed run budget, so a second one is not free: it is time
 * taken from a run that might have used it to read. A model that needs two says so in its own
 * file, where the cost lands on that model's runs alone.
 */
export const DEFAULT_REPORT_REMINDER_LIMIT = 1;

/**
 * No extra turn, which is what every locked plan cell was measured against.
 *
 * A plan run that produced prose has answered or it has not, and the verifier reads that for
 * itself. Offering another turn to every model would change 24 models' runs to reach one.
 */
export const DEFAULT_PLAN_STATEMENT_RETRIES = 0;

/**
 * Twenty seconds, which is what `AGENT_REPORT_RESERVE_MS` has always been and what every
 * locked cell was measured against.
 *
 * Held here as well so a profile overriding it is read next to the value it replaces. Raising
 * it for everyone would move the reserve on 24 models to rescue one, and the reserve is time
 * taken out of the reading half of every run.
 */
export const DEFAULT_REPORT_RESERVE_MS = 20_000;

/**
 * Held, which is what every locked cell was measured against.
 *
 * A run that is told what its report is missing usually fixes it, and that is where several
 * locked cells came from. The exception is a run with no turn left, and only a model whose
 * turns are long enough to hit that says so in its own file.
 */
export const DEFAULT_HOLD_REPORT_WITHOUT_TIME = true;

/**
 * Deterministic, and the setting five locked cells were won on.
 *
 * Choosing a tool and filling in its arguments is a structural task; there is nothing a
 * sample is meant to explore, and a report wants the most likely sentence rather than a
 * surprising one. Where that reasoning fails for a particular model it fails measurably, and
 * that model's own file says so.
 */
export const DEFAULT_SAMPLING: AgentSampling = Object.freeze({ temperature: 0, topP: 1 });
