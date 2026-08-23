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
import { BASELINE_NOTICES } from "./notices";
import { GEMINI_3_5_FLASH_LITE } from "./gemini-3-5-flash-lite";
import { GEMMA4_26B } from "./gemma4-26b";
import { GRANITE4_1_30B } from "./granite4-1-30b";
import { GRANITE4_1_8B } from "./granite4-1-8b";
import { ORNITH_9B } from "./ornith-9b";
import { QWEN3_14B } from "./qwen3-14b";
import { QWEN3_4B } from "./qwen3-4b";
import { QWEN3_5_9B } from "./qwen3-5-9b";
import { QWEN3_8_LATEST } from "./qwen3-8-latest";
import { QWEN3_8B } from "./qwen3-8b";
import {
  type AgentModelProfile,
  type AgentNotices,
  type AgentSampling,
  DEFAULT_PLAN_STATEMENT_RETRIES,
  DEFAULT_REPORT_REMINDER_LIMIT,
  DEFAULT_REFUSAL_EXAMPLES,
  DEFAULT_PRESENT_REMINDER_LIMIT,
  DEFAULT_RETRY_EMPTY_TURN,
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
  "gemini-3.5-flash-lite": GEMINI_3_5_FLASH_LITE,
  "gemma4:26b": GEMMA4_26B,
  "granite4.1:30b": GRANITE4_1_30B,
  "granite4.1:8b": GRANITE4_1_8B,
  "ornith:9b": ORNITH_9B,
  "qwen3.5:9b": QWEN3_5_9B,
  "qwen3.8:latest": QWEN3_8_LATEST,
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
 * Whether an empty turn is asked again before this model's run is ended.
 *
 * False everywhere but the model measured returning nothing with its readings already taken,
 * so introducing the retry changed no other model's turn count.
 */
export function retriesEmptyTurn(modelId: string): boolean {
  return MODEL_PROFILES[modelId.toLowerCase()]?.retryEmptyTurn ?? DEFAULT_RETRY_EMPTY_TURN;
}

/**
 * How many times this model's report may be held to ask for the answer beside it.
 *
 * One everywhere but the model measured reporting straight through the first telling.
 */
/**
 * This model's own turn limit, or undefined where the shipped one fits it.
 *
 * Undefined rather than a default, because there IS no per-model default here: the fallback is
 * the product's setting, which the drive already reads, and returning it from this function
 * would put the same number in two places for a resolver to disagree with later.
 */
export function turnTimeoutMsFor(modelId: string): number | undefined {
  return MODEL_PROFILES[modelId.toLowerCase()]?.turnTimeoutMs;
}

export function presentReminderLimitFor(modelId: string): number {
  return MODEL_PROFILES[modelId.toLowerCase()]?.presentReminderLimit ?? DEFAULT_PRESENT_REMINDER_LIMIT;
}

/**
 * Every sentence this model is told, resolved from its own file.
 *
 * The baseline fills only what a profile leaves unsaid, and for a measured model that is
 * nothing: each carries all four, so editing one model's wording reaches no other model and no
 * regression sweep is owed. The fallback exists for a model with no file at all, which is a
 * model nobody has measured.
 */
export function noticesFor(modelId: string): AgentNotices {
  return { ...BASELINE_NOTICES, ...MODEL_PROFILES[modelId.toLowerCase()]?.notices };
}

/**
 * Whether this model's refusals carry a worked example from its own ledger.
 *
 * The tool layer asks by model id rather than being handed a flag, so a tool that refuses does
 * not need the drive to tell it who it is refusing.
 */
export function offersRefusalExamples(modelId: string): boolean {
  return MODEL_PROFILES[modelId.toLowerCase()]?.refusalExamples ?? DEFAULT_REFUSAL_EXAMPLES;
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
