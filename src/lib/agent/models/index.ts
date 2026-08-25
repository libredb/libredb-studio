/**
 * Per-model settings for the agent loop: this is where a run asks what it was measured with.
 *
 * The settings themselves are DATA — `../model-tuning/measured-profiles.json`, which used to be
 * ten TypeScript modules. Nothing about the discipline changed in moving them, and one part of it
 * got stronger: those modules wrote `sampling: DEFAULT_SAMPLING`, a live reference, so each one's
 * promise that a later change to the defaults could not reach its measurement was false. The
 * document states the number, so the promise holds.
 *
 * The discipline itself is unchanged and worth restating. EVERY measured model has an entry,
 * including the ones the defaults already suit, because a shared value is what has twice cost
 * this repository a locked cell — sampling pinned to 0 won five cells and lost one, a workflow
 * rules reorder won nothing and lost one. An entry is not a place for preferences: it records
 * the settings a model's numbers were obtained under, so the numbers still mean something after
 * the defaults move, and `measured` carries those numbers.
 *
 * TWO LAYERS, later winning, which is what a run resolves through:
 *
 *     compiled defaults  ->  the model's own entry
 *
 * There was briefly a third, between them: a per-PROVIDER tier, for settings that hold for
 * everything reaching one provider rather than for one set of weights. It is gone, and the reason
 * it is gone is the reason it should not come back until a measurement asks for it. Across the ten
 * measured models NO setting is shared by all models of any provider — the overrides do not
 * cluster that way — so the tier had a schema, a resolver, a merge order and tests, and no data.
 * A layer that always resolves to nothing is worse than a missing one: it reads as working. When a
 * measurement does cluster by provider, the layer is a small change to `resolve` below and a key
 * in the document; that is a better trade than carrying it empty until then.
 *
 * A model nobody has measured therefore resolves exactly to the compiled defaults, which is the
 * honest treatment of a model nobody has measured.
 */

import { AGENT_THREAD_CONTEXT_MAX_CHARS } from "../execution-policy";
import { activeTuning } from "../model-tuning";
import type { AgentRunWorkflowType } from "../types";
import {
  type AgentModelProfile,
  type AgentSampling,
  DEFAULT_PLAN_STATEMENT_RETRIES,
  DEFAULT_REPORT_REMINDER_LIMIT,
  DEFAULT_REFUSAL_EXAMPLES,
  DEFAULT_PRESENT_REMINDER_LIMIT,
  DEFAULT_RETRY_EMPTY_TURN,
  DEFAULT_RETRY_UNREAD_STOP,
  DEFAULT_SUPPRESS_PLAN_REASONING,
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

/** One model's own entry, or nothing. */
function entryFor(modelId: string): AgentModelProfile | undefined {
  return activeTuning().models[modelId.toLowerCase()];
}

/**
 * One setting, or nothing when this model states none.
 *
 * Written once rather than repeated in nine resolvers so that each resolver below is only the
 * default it falls back to. It is also the one place a layer between the defaults and a model's
 * own entry would be added, which is why it stays a function over a direct lookup.
 */
function resolve<K extends keyof AgentModelProfile>(modelId: string, key: K): AgentModelProfile[K] | undefined {
  return entryFor(modelId)?.[key];
}

/**
 * How many unreported calls this model may make before the run is narrowed.
 *
 * Separate from `samplingFor` because it is not sampling: the two answer to different parts of
 * the loop, and a caller wanting one has no business resolving the other.
 */
export function ceilingFor(modelId: string): number {
  return resolve(modelId, "unreportedCallCeiling") ?? DEFAULT_UNREPORTED_CALL_CEILING;
}

/**
 * How many times this model may be told to report before the drive lets it stop.
 *
 * Its own resolver for the same reason `ceilingFor` is: the drive asks about one thing at a
 * time, and a function that answered two questions would be called where only one was wanted.
 */
export function reportReminderLimitFor(modelId: string): number {
  return resolve(modelId, "reportReminderLimit") ?? DEFAULT_REPORT_REMINDER_LIMIT;
}

/**
 * How many extra turns this model's PLAN runs get when they named no statement.
 *
 * Zero unless a profile says otherwise, so introducing the mechanism changed no run of any
 * model but the one whose ledgers asked for it.
 */
export function planStatementRetriesFor(modelId: string): number {
  return resolve(modelId, "planStatementRetries") ?? DEFAULT_PLAN_STATEMENT_RETRIES;
}

/**
 * Whether an empty turn is asked again before this model's run is ended.
 *
 * False everywhere but the model measured returning nothing with its readings already taken,
 * so introducing the retry changed no other model's turn count.
 */
export function retriesEmptyTurn(modelId: string): boolean {
  return resolve(modelId, "retryEmptyTurn") ?? DEFAULT_RETRY_EMPTY_TURN;
}

/**
 * Whether a stop with nothing read is answered with the instruments rather than accepted.
 *
 * False everywhere but the model measured asking its user for the statement it was sent to
 * diagnose, so introducing it changed no other model's turn count.
 */
export function retriesUnreadStop(modelId: string): boolean {
  return resolve(modelId, "retryUnreadStop") ?? DEFAULT_RETRY_UNREAD_STOP;
}

/**
 * Whether this model's plan turn is told to spend nothing on reasoning.
 *
 * Read only for a run whose mode is not `agent`; see the field's own note for why the five
 * agent cells this model already locks are left alone.
 */
export function suppressesPlanReasoning(modelId: string): boolean {
  return resolve(modelId, "suppressPlanReasoning") ?? DEFAULT_SUPPRESS_PLAN_REASONING;
}

/**
 * This model's own turn limit, or undefined where the shipped one fits it.
 *
 * Undefined rather than a default, because there IS no per-model default here: the fallback is
 * the product's setting, which the drive already reads, and returning it from this function
 * would put the same number in two places for a resolver to disagree with later.
 */
export function turnTimeoutMsFor(modelId: string): number | undefined {
  return resolve(modelId, "turnTimeoutMs");
}

/**
 * How much of a CONVERSATION this model may be handed, in characters.
 *
 * Falls back to the compiled budget, which is what drives every model today: nothing
 * measured ships for this setting, because nobody has measured one. It is per-model
 * rather than per-server because the value that is right is a function of the context
 * window, and this product runs a hosted 200k-window model and a small local one under
 * the same code.
 */
export function threadContextMaxCharsFor(modelId: string): number {
  return resolve(modelId, "threadContextMaxChars") ?? AGENT_THREAD_CONTEXT_MAX_CHARS;
}

/**
 * How many times this model's report may be held to ask for the answer beside it.
 *
 * One everywhere but the model measured reporting straight through the first telling.
 */
export function presentReminderLimitFor(modelId: string): number {
  return resolve(modelId, "presentReminderLimit") ?? DEFAULT_PRESENT_REMINDER_LIMIT;
}

/**
 * Whether this model's refusals carry a worked example from its own ledger.
 *
 * The tool layer asks by model id rather than being handed a flag, so a tool that refuses does
 * not need the drive to tell it who it is refusing.
 */
export function offersRefusalExamples(modelId: string): boolean {
  return resolve(modelId, "refusalExamples") ?? DEFAULT_REFUSAL_EXAMPLES;
}

/**
 * The sampling for one model on one surface: the default, then the model's own value, then its
 * value for this surface. Later wins, and every layer is optional.
 */
export function samplingFor(modelId: string, workflow: AgentRunWorkflowType | undefined): AgentSampling {
  const own = entryFor(modelId);
  const ownSurface = workflow === undefined ? undefined : own?.perWorkflow?.[workflow];
  return { ...DEFAULT_SAMPLING, ...own?.sampling, ...ownSurface };
}
