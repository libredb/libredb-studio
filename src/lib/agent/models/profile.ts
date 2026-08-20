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
}

/**
 * Deterministic, and the setting five locked cells were won on.
 *
 * Choosing a tool and filling in its arguments is a structural task; there is nothing a
 * sample is meant to explore, and a report wants the most likely sentence rather than a
 * surprising one. Where that reasoning fails for a particular model it fails measurably, and
 * that model's own file says so.
 */
export const DEFAULT_SAMPLING: AgentSampling = Object.freeze({ temperature: 0, topP: 1 });
