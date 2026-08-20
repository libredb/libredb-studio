/**
 * Per-model settings for the agent loop: one file per model, and this is the register.
 *
 * EVERY model has a file, including the ones the defaults already suit. That is the point. The
 * defaults are shared values, and a shared value is what has twice cost this repository a
 * locked cell — sampling pinned to 0 won five cells and lost one, a workflow rules reorder won
 * nothing and lost one. A model whose file states `temperature: 0` explicitly cannot be
 * reached by a later change to the default; a model relying on the default can.
 *
 * A file is therefore not a place for preferences. It is the record of the settings a model's
 * numbers were obtained under, so the numbers still mean something after the defaults move.
 * `measured` carries those numbers and a test refuses a profile without them.
 *
 * Two files currently differ from the defaults, and each says why in its own words:
 * `qwen3-8b.ts` samples at 0.8 on query-optimization, `gemma4-26b.ts` narrows at 9 unreported
 * calls rather than 12. Both were written from ledger readings, and both record what they are
 * working around so the next reader knows when to re-measure and delete them.
 *
 * A model with no file here is one nobody has measured yet — a genuinely new release. It gets
 * the defaults, which is the honest treatment of an unmeasured model.
 */

import type { AgentRunWorkflowType } from "../types";
import { DEEPSEEK_R1_14B } from "./deepseek-r1-14b";
import { DEEPSEEK_R1_32B } from "./deepseek-r1-32b";
import { DEEPSEEK_R1_7B } from "./deepseek-r1-7b";
import { DEEPSEEK_R1_8B } from "./deepseek-r1-8b";
import { GEMMA4_12B } from "./gemma4-12b";
import { GEMMA4_26B } from "./gemma4-26b";
import { GRANITE4_1_30B } from "./granite4-1-30b";
import { GRANITE4_1_3B } from "./granite4-1-3b";
import { GRANITE4_1_8B } from "./granite4-1-8b";
import { LFM2_24B } from "./lfm2-24b";
import { MISTRAL_SMALL3_2_24B } from "./mistral-small3-2-24b";
import { MUSE_GLIMMER_LATEST } from "./muse-glimmer-latest";
import { NEMOTRON_3_5_LIGHTNING_30B } from "./nemotron-3-5-lightning-30b";
import { NEMOTRON3_33B } from "./nemotron3-33b";
import { ORNITH_9B } from "./ornith-9b";
import { QWEN3_0_6B } from "./qwen3-0-6b";
import { QWEN3_1_7B } from "./qwen3-1-7b";
import { QWEN3_14B } from "./qwen3-14b";
import { QWEN3_4B } from "./qwen3-4b";
import { QWEN3_5_2B } from "./qwen3-5-2b";
import { QWEN3_5_4B } from "./qwen3-5-4b";
import { QWEN3_5_9B } from "./qwen3-5-9b";
import { QWEN3_6_27B } from "./qwen3-6-27b";
import { QWEN3_8_LATEST } from "./qwen3-8-latest";
import { QWEN3_8B } from "./qwen3-8b";
import {
  type AgentModelProfile,
  type AgentSampling,
  DEFAULT_PLAN_STATEMENT_RETRIES,
  DEFAULT_REPORT_REMINDER_LIMIT,
  DEFAULT_SAMPLING,
  DEFAULT_UNREPORTED_CALL_CEILING,
} from "./profile";

export type { AgentModelProfile } from "./profile";

/**
 * The register, keyed by lower-cased model name.
 *
 * Lower-cased because the same weights answer to more than one spelling, and a key matched
 * exactly would silently stop applying the day a tag changed.
 */
export const MODEL_PROFILES: Readonly<Record<string, AgentModelProfile>> = Object.freeze({
  "deepseek-r1:14b": DEEPSEEK_R1_14B,
  "deepseek-r1:32b": DEEPSEEK_R1_32B,
  "deepseek-r1:7b": DEEPSEEK_R1_7B,
  "deepseek-r1:8b": DEEPSEEK_R1_8B,
  "gemma4:12b": GEMMA4_12B,
  "gemma4:26b": GEMMA4_26B,
  "granite4.1:30b": GRANITE4_1_30B,
  "granite4.1:3b": GRANITE4_1_3B,
  "granite4.1:8b": GRANITE4_1_8B,
  "lfm2:24b": LFM2_24B,
  "mistral-small3.2:24b": MISTRAL_SMALL3_2_24B,
  "muse-glimmer:latest": MUSE_GLIMMER_LATEST,
  "nemotron-3.5-lightning:30b": NEMOTRON_3_5_LIGHTNING_30B,
  "nemotron3:33b": NEMOTRON3_33B,
  "ornith:9b": ORNITH_9B,
  "qwen3.5:2b": QWEN3_5_2B,
  "qwen3.5:4b": QWEN3_5_4B,
  "qwen3.5:9b": QWEN3_5_9B,
  "qwen3.6:27b": QWEN3_6_27B,
  "qwen3.8:latest": QWEN3_8_LATEST,
  "qwen3:0.6b": QWEN3_0_6B,
  "qwen3:1.7b": QWEN3_1_7B,
  "qwen3:14b": QWEN3_14B,
  "qwen3:4b": QWEN3_4B,
  "qwen3:8b": QWEN3_8B,
} satisfies Record<string, AgentModelProfile>);

/**
 * How many unreported calls this model may make before the run is narrowed.
 *
 * Separate from `samplingFor` because it is not sampling: the two answer to different parts of
 * the loop, and a caller wanting one has no business resolving the other.
 */
export function ceilingFor(modelId: string): number {
  return MODEL_PROFILES[modelId.toLowerCase()]?.unreportedCallCeiling ?? DEFAULT_UNREPORTED_CALL_CEILING;
}

/**
 * How many times this model may be told to report before the drive lets it stop.
 *
 * Its own resolver for the same reason `ceilingFor` is: the drive asks about one thing at a
 * time, and a function that answered two questions would be called where only one was wanted.
 */
export function reportReminderLimitFor(modelId: string): number {
  return MODEL_PROFILES[modelId.toLowerCase()]?.reportReminderLimit ?? DEFAULT_REPORT_REMINDER_LIMIT;
}

/**
 * How many extra turns this model's PLAN runs get when they named no statement.
 *
 * Zero unless a profile says otherwise, so introducing the mechanism changed no run of any
 * model but the one whose ledgers asked for it.
 */
export function planStatementRetriesFor(modelId: string): number {
  return MODEL_PROFILES[modelId.toLowerCase()]?.planStatementRetries ?? DEFAULT_PLAN_STATEMENT_RETRIES;
}

/**
 * The sampling for one model on one surface: the default, then the model's own value, then its
 * value for this surface. Later wins, and every layer is optional.
 */
export function samplingFor(modelId: string, workflow: AgentRunWorkflowType | undefined): AgentSampling {
  const profile = MODEL_PROFILES[modelId.toLowerCase()];
  if (profile === undefined) return DEFAULT_SAMPLING;
  const perWorkflow = workflow === undefined ? undefined : profile.perWorkflow?.[workflow];
  return { ...DEFAULT_SAMPLING, ...profile.sampling, ...perWorkflow };
}
