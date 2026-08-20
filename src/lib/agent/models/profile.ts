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
 * Deterministic, and the setting five locked cells were won on.
 *
 * Choosing a tool and filling in its arguments is a structural task; there is nothing a
 * sample is meant to explore, and a report wants the most likely sentence rather than a
 * surprising one. Where that reasoning fails for a particular model it fails measurably, and
 * that model's own file says so.
 */
export const DEFAULT_SAMPLING: AgentSampling = Object.freeze({ temperature: 0, topP: 1 });
