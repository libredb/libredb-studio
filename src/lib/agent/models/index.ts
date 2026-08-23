/**
 * Per-model settings for the agent loop: this is where a run asks what it was measured with.
 *
 * The settings themselves are DATA now — `../model-tuning/measured-profiles.json`, which used to
 * be ten TypeScript modules. Nothing about the discipline changed in moving them, and one part
 * of it got stronger: those modules wrote `sampling: DEFAULT_SAMPLING`, a live reference, so
 * each one's promise that a later change to the defaults could not reach its measurement was
 * false. The document states the number, so the promise holds.
 *
 * The discipline itself is unchanged and worth restating. EVERY measured model has an entry,
 * including the ones the defaults already suit, because a shared value is what has twice cost
 * this repository a locked cell — sampling pinned to 0 won five cells and lost one, a workflow
 * rules reorder won nothing and lost one. An entry is not a place for preferences: it records
 * the settings a model's numbers were obtained under, so the numbers still mean something after
 * the defaults move, and `measured` carries those numbers.
 *
 * THREE LAYERS, later winning, which is what a run resolves through:
 *
 *     compiled defaults  ->  the provider's tier  ->  the model's own entry
 *
 * The provider tier is what a model NOBODY has measured inherits — settings that hold for
 * everything reaching a given provider rather than for one set of weights. It ships empty,
 * because across the ten measured models no setting is shared by all models of any provider:
 * the overrides do not cluster that way. So the tier is a mechanism today and not a value, and
 * an unmeasured model still resolves exactly to the defaults, which is the honest treatment of
 * a model nobody has measured.
 *
 * `provider` is optional on every resolver below. That is not shyness about the argument: it is
 * what lets `tests/unit/lib/agent/model-resolution-table.test.ts` — written against the ten
 * modules, before any of this moved — keep proving that none of these answers changed, without
 * being edited into agreement with the code it is checking.
 */

import type { LLMProviderType } from "@/lib/llm/types";
import { activeTuning, providerTier } from "../model-tuning";
import type { AgentRunWorkflowType } from "../types";
import { BASELINE_NOTICES } from "./notices";
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
 * Lower-cased because the same weights answer to more than one spelling. Note what that does and
 * does not do: `QWEN3:8B` finds `qwen3:8b`, but a bare `qwen3.8` does NOT find `qwen3.8:latest`,
 * because only the case is normalised and not the tag. The pinned table records both, so the day
 * that is fixed the fix is visible; it is not fixed here, where no run was measured against it.
 */
export function modelProfiles(): Readonly<Record<string, AgentModelProfile>> {
  return activeTuning().models;
}

/** One model's own entry, or nothing — the layer a provider tier sits under. */
function entryFor(modelId: string): AgentModelProfile | undefined {
  return activeTuning().models[modelId.toLowerCase()];
}

/**
 * One setting, resolved through the three layers.
 *
 * Written once rather than repeated in nine resolvers, because the ORDER is the contract: a
 * provider tier that beat a model's own measurement would be the bug this whole arrangement
 * exists to make impossible.
 */
function resolve<K extends keyof AgentModelProfile>(
  modelId: string,
  provider: LLMProviderType | undefined,
  key: K,
): AgentModelProfile[K] | undefined {
  return entryFor(modelId)?.[key] ?? (providerTier(provider)[key] as AgentModelProfile[K] | undefined);
}

/**
 * How many unreported calls this model may make before the run is narrowed.
 *
 * Separate from `samplingFor` because it is not sampling: the two answer to different parts of
 * the loop, and a caller wanting one has no business resolving the other.
 */
export function ceilingFor(modelId: string, provider?: LLMProviderType): number {
  return resolve(modelId, provider, "unreportedCallCeiling") ?? DEFAULT_UNREPORTED_CALL_CEILING;
}

/**
 * How many times this model may be told to report before the drive lets it stop.
 *
 * Its own resolver for the same reason `ceilingFor` is: the drive asks about one thing at a
 * time, and a function that answered two questions would be called where only one was wanted.
 */
export function reportReminderLimitFor(modelId: string, provider?: LLMProviderType): number {
  return resolve(modelId, provider, "reportReminderLimit") ?? DEFAULT_REPORT_REMINDER_LIMIT;
}

/**
 * How many extra turns this model's PLAN runs get when they named no statement.
 *
 * Zero unless a profile says otherwise, so introducing the mechanism changed no run of any
 * model but the one whose ledgers asked for it.
 */
export function planStatementRetriesFor(modelId: string, provider?: LLMProviderType): number {
  return resolve(modelId, provider, "planStatementRetries") ?? DEFAULT_PLAN_STATEMENT_RETRIES;
}

/**
 * Whether an empty turn is asked again before this model's run is ended.
 *
 * False everywhere but the model measured returning nothing with its readings already taken,
 * so introducing the retry changed no other model's turn count.
 */
export function retriesEmptyTurn(modelId: string, provider?: LLMProviderType): boolean {
  return resolve(modelId, provider, "retryEmptyTurn") ?? DEFAULT_RETRY_EMPTY_TURN;
}

/**
 * This model's own turn limit, or undefined where the shipped one fits it.
 *
 * Undefined rather than a default, because there IS no per-model default here: the fallback is
 * the product's setting, which the drive already reads, and returning it from this function
 * would put the same number in two places for a resolver to disagree with later.
 */
export function turnTimeoutMsFor(modelId: string, provider?: LLMProviderType): number | undefined {
  return resolve(modelId, provider, "turnTimeoutMs");
}

/**
 * How many times this model's report may be held to ask for the answer beside it.
 *
 * One everywhere but the model measured reporting straight through the first telling.
 */
export function presentReminderLimitFor(modelId: string, provider?: LLMProviderType): number {
  return resolve(modelId, provider, "presentReminderLimit") ?? DEFAULT_PRESENT_REMINDER_LIMIT;
}

/**
 * Every sentence this model is told.
 *
 * The WORDING stays in code — `notices.ts` — and no entry in the document carries any. Two
 * reasons, and the second is why it is a rule rather than a convenience: `planStatement`
 * interpolates `PLAN_NO_STATEMENT_MARKER`, so a copy in data would drift from the marker the
 * verifier looks for; and the document is shaped to be supplied from outside Studio, where
 * carrying prompt text would mean whoever writes it decides what Studio says to a model.
 *
 * The merge stays, so a measured per-model wording still has somewhere to go — it would arrive
 * as an override in code, beside the baseline it differs from. The ten measured models all
 * resolve to the baseline today, and the pinned table records their digests, so an edit to a
 * shared sentence turns a test red instead of quietly re-taking cells this repository has
 * already won twice.
 */
export function noticesFor(modelId: string, provider?: LLMProviderType): AgentNotices {
  return { ...BASELINE_NOTICES, ...resolve(modelId, provider, "notices") };
}

/**
 * Whether this model's refusals carry a worked example from its own ledger.
 *
 * The tool layer asks by model id rather than being handed a flag, so a tool that refuses does
 * not need the drive to tell it who it is refusing.
 */
export function offersRefusalExamples(modelId: string, provider?: LLMProviderType): boolean {
  return resolve(modelId, provider, "refusalExamples") ?? DEFAULT_REFUSAL_EXAMPLES;
}

/**
 * The sampling for one model on one surface: the default, then the model's own value, then its
 * value for this surface. Later wins, and every layer is optional.
 */
export function samplingFor(
  modelId: string,
  workflow: AgentRunWorkflowType | undefined,
  provider?: LLMProviderType,
): AgentSampling {
  const tier = providerTier(provider);
  const own = entryFor(modelId);
  /*
    Each source's surface value sits with that source, and NOT collapsed into one `surface`
    picked before the spread.

    The collapsed form is wrong and was written here first: `own?.perWorkflow?.[w] ??
    tier.perWorkflow?.[w]` spread last means that a model stating no value for this surface gets
    the TIER's — spread after its own general sampling, so a provider's per-surface guess beats a
    model's own measurement. That is the one thing this file's contract says must be impossible,
    and it is the only merge that does not go through `resolve`.

    Latent rather than live when it was found: no call site passes `provider` yet and every
    shipped tier is empty. Fixed anyway, and pinned below, because "wrong but unreachable" is how
    a defect waits for the commit that reaches it.
  */
  const tierSurface = workflow === undefined ? undefined : tier.perWorkflow?.[workflow];
  const ownSurface = workflow === undefined ? undefined : own?.perWorkflow?.[workflow];
  return { ...DEFAULT_SAMPLING, ...tier.sampling, ...tierSurface, ...own?.sampling, ...ownSurface };
}
