/**
 * Per-model settings for the agent loop: one file per model, and this is the register.
 *
 * WHY THIS DIRECTORY EXISTS, in the shape of the mistake it ends. For days this repository
 * looked for one setting that suits 25 local models on six surfaces, and every landing won
 * some cells and cost others. Sampling is the clearest case: unset, every run inherited
 * Ollama's 0.8; pinned to 0 it won five cells and cost `qwen3:8b` one. Both measurements are
 * true, and no global number holds both. A model's own file can.
 *
 * WHY THERE ARE NOT 25 FILES. A file is created when a model earns one — when a measurement
 * shows the default is wrong for it. Twenty-four files holding nothing measured would not be
 * tidiness; they would be an invitation to fill them with plausible constants nobody can
 * justify later, and the whole value of this directory is that every line in it is answerable
 * to a number. A model with no file is not unsupported: it gets the default, which is what
 * every locked cell was measured on.
 *
 * ADDING ONE. Measure the cell five times, write the file next to this one with `measured`
 * carrying the numbers, and register it below. The scope of an override is as narrow as its
 * evidence — `qwen3:8b` locks its other five surfaces deterministically, so its exception is
 * keyed to the one cell that needs it rather than to the model.
 */

import type { AgentRunWorkflowType } from "../types";
import { type AgentModelProfile, type AgentSampling, DEFAULT_SAMPLING } from "./profile";
import { QWEN3_8B } from "./qwen3-8b";

export type { AgentModelProfile } from "./profile";

/**
 * The register, keyed by lower-cased model name.
 *
 * Lower-cased because the same weights answer to more than one spelling, and a key matched
 * exactly would silently stop applying the day a tag changed.
 */
export const MODEL_PROFILES: Readonly<Record<string, AgentModelProfile>> = Object.freeze({
  "qwen3:8b": QWEN3_8B,
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
