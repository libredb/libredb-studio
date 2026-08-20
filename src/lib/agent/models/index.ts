/**
 * Per-model settings for the agent loop, one file per model that needs one.
 *
 * WHY THIS EXISTS, in the shape of the mistake it ends. For days this repository looked for
 * one setting that suits 25 local models on six surfaces, and every landing won some cells
 * and cost others. Sampling is the clearest case and the reason this module was written.
 *
 * The loop set no temperature at all, so every run inherited Ollama's default of 0.8.
 * Pinning it to 0 won five cells outright — a cell locks only at 5/5 consecutive passes, so
 * the bar is a variance test as much as a capability one. It also cost `qwen3:8b` its
 * `query-optimization` cell, 3/5 down to 0/5: at 0.8 that model opened with `inspect_plan`
 * on 3 of 5 runs and won all three, and at 0 it opened with `inspect_schema` on 10 of 10 and
 * lost every one. Determinism did not make it worse at the task; it pinned it to the losing
 * branch instead of letting it wander into the winning one.
 *
 * Both measurements are true. No global number holds both.
 *
 * THE RULE THAT KEEPS THIS HONEST. The default is the whole policy. A profile may only
 * contradict the default where a measurement required it, and every override carries the
 * numbers that bought it — `measured` is not documentation, it is the admission ticket, and
 * a test refuses a profile that arrives without one. A model with no profile is not
 * unsupported; it gets the default, which is what every locked cell was measured on.
 *
 * The scope of an override is as narrow as the evidence. `qwen3:8b` locks its other five
 * surfaces deterministically, so its exception is keyed to the one cell that needs it rather
 * than to the model.
 */

import type { AgentRunWorkflowType } from "../types";

/** How a turn is sampled. Structural output, so the default explores nothing. */
export interface AgentSampling {
  readonly temperature: number;
  readonly topP: number;
}

/**
 * Deterministic, and this is the setting five locked cells were won on.
 *
 * Choosing a tool and filling in its arguments is a structural task; there is nothing a
 * sample is meant to explore, and a report wants the most likely sentence rather than a
 * surprising one. Where that reasoning fails for a particular model, it fails measurably and
 * the profile says so.
 */
const DEFAULT_SAMPLING: AgentSampling = Object.freeze({ temperature: 0, topP: 1 });

export interface AgentModelProfile {
  /**
   * What was measured to justify this profile, in numbers.
   *
   * Required, and checked by a test. An override with no measurement behind it cannot be
   * told apart from a guess, and this is the file guesses would accumulate in.
   */
  readonly measured: string;
  /** Sampling for this model on every surface, where it differs from the default. */
  readonly sampling?: Partial<AgentSampling>;
  /** Sampling for named surfaces only, which is the narrowest an override can be. */
  readonly perWorkflow?: Partial<Record<AgentRunWorkflowType, Partial<AgentSampling>>>;
}

/**
 * The profiles, keyed by lower-cased Ollama model name.
 *
 * Lower-cased because the same weights answer to more than one spelling and a key matched
 * exactly would silently stop applying the day a tag changed.
 */
export const MODEL_PROFILES: Readonly<Record<string, AgentModelProfile>> = Object.freeze({
  "qwen3:8b": {
    measured:
      "query-optimization: 3/5 at Ollama's default temperature 0.8, then 1/5 and 0/5 after " +
      "the loop pinned temperature to 0. Reading all 15 of its ledgers on that surface: at " +
      "0.8 it opened with inspect_plan on 3 of 5 runs and answered all three; at 0 it opened " +
      "with inspect_schema on 10 of 10 and lost every one. The opening move decides the run " +
      "(inspect_plan first: 3/3 answered; inspect_schema first: 1/12), and determinism pins " +
      "it to the losing one. Its other five surfaces lock 5/5 deterministically, so the " +
      "override is scoped to this cell and not to the model.",
    perWorkflow: { "query-optimization": { temperature: 0.8, topP: 0.9 } },
  },
} satisfies Record<string, AgentModelProfile>);

/**
 * The sampling for one model on one surface: the default, then the model's own override,
 * then its override for this surface. Later wins, and every layer is optional.
 */
export function samplingFor(modelId: string, workflow: AgentRunWorkflowType | undefined): AgentSampling {
  const profile = MODEL_PROFILES[modelId.toLowerCase()];
  if (profile === undefined) return DEFAULT_SAMPLING;
  const perWorkflow = workflow === undefined ? undefined : profile.perWorkflow?.[workflow];
  return { ...DEFAULT_SAMPLING, ...profile.sampling, ...perWorkflow };
}
