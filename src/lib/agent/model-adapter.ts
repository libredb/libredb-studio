/**
 * Model adapter for the agent runtime (#329, epic #325).
 *
 * The agent needs a tool-calling model, and `src/lib/llm` has no tool-calling
 * surface — its provider contract is text streaming plus config validation. So
 * the agent drives the ratified AI SDK provider packages instead, and this
 * module is where the repository's own settings resolution meets them: it
 * resolves and validates a configuration through `src/lib/llm`, hands it to the
 * kind's adapter in `provider-registry.ts`, and translates SDK failures back into
 * this repository's error vocabulary.
 *
 * Which environment variables may be read, and why each provider package's own
 * fallbacks stay unread, is the registry's concern and is documented there.
 */

import { AISDKError, APICallError, type CallWarning, LoadAPIKeyError } from "ai";
import {
  type LLMConfig,
  type LLMModelEffort,
  type LLMProviderType,
  LLMAuthError,
  LLMConfigError,
  LLMError,
  LLMRateLimitError,
  LLMStreamError,
} from "@/lib/llm/types";
import { resolveConfig, validateConfig, validModelEffort } from "@/lib/llm/utils/config";
import {
  type AgentFetch,
  type AgentLanguageModel,
  openAIResponsesRequestWarnings,
  resolveAgentProviderAdapter,
} from "./provider-registry";
import type { AgentSampling } from "./models/profile";

/** A model plus the resolved identity it was built from, for audit and logging. */
export interface AgentModel {
  readonly provider: LLMProviderType;
  readonly modelId: string;
  readonly model: AgentLanguageModel;
  /**
   * `LLM_MODEL_EFFORT`, validated, which `validateConfig` allows on the `openai` kind only.
   * Carried here so every call can send it without reading the environment outside `src/lib/llm`.
   */
  readonly effort?: LLMModelEffort;
}

export interface AgentModelOptions {
  /** Overrides handed to `resolveConfig`, the same shape `createLLMProvider` takes. */
  readonly config?: Partial<LLMConfig>;
  /**
   * The SDK providers document `fetch` as the interception point for tests and
   * proxies; injecting it keeps the suite off a global stub, which would leak
   * into every other test in the same process and has to be restored by hand.
   */
  readonly fetch?: AgentFetch;
}

/**
 * Build a model instance from the repository's resolved LLM configuration.
 *
 * @throws LLMConfigError if the configuration is one the chat surface would also
 *         refuse, if the kind has no adapter, if the SDK refuses the settings
 *         when the provider is constructed, or if the model does not take the
 *         configured reasoning effort (`effort_refused`).
 */
export async function createAgentModel(options: AgentModelOptions = {}): Promise<AgentModel> {
  const config = resolveConfig(options.config);
  validateConfig(config);
  const adapter = resolveAgentProviderAdapter(config.provider);
  const effort = validModelEffort(config);

  try {
    if (effort !== undefined) await refuseUntakenEffort({ provider: config.provider, modelId: config.model, effort });
    return {
      provider: config.provider,
      modelId: config.model,
      model: await adapter.createModel(config, options.fetch),
      ...(effort === undefined ? {} : { effort }),
    };
  } catch (error) {
    if (error instanceof LLMError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new LLMConfigError(`Cannot build the ${config.provider} model: ${detail}`, config.provider);
  }
}

/**
 * What a turn asks for when this model's thinking is the thing that loses the cell: a profile's
 * quiet switch (`suppressPlanReasoning`, `suppressAgentReasoning` in `models/profile.ts`).
 *
 * A REQUEST FIELD and not a word in the prompt, which is the whole reason it is acceptable:
 * every planning rule in `investigation.ts` is wording a measured cell depends on, and nothing
 * here touches it. The in-prompt `/no_think` marker was tried first and abandoned - see the
 * model's entry.
 */
export const PLAN_NO_REASONING_EFFORT = "none";

/** Provider options in the shape the SDK takes them: one object per provider package's own key. */
export type AgentProviderOptions = Record<string, Record<string, string | boolean | null>>;

/**
 * The provider options every agent call to a model sends, built in one place so the capability
 * probe asks the model exactly what a run will ask it.
 *
 * Keyed `openai` whatever the kind is called, because the three OpenAI-compatible kinds are all
 * `@ai-sdk/openai` models and that package reads its options under its OWN key. Keying them by
 * the provider's name once passed every test and sent nothing at all on a real Ollama run.
 *
 * For the `openai` kind, which is OpenAI's Responses API:
 *
 *  - `store: false`, always: a run sends database schemas and rows, and OpenAI must not retain
 *    them. Stateless mode is also why each turn's reasoning comes back encrypted and is replayed
 *    with the next one; the SDK asks for that content itself once `store` is false.
 *  - `reasoningSummary: null`, always: the SDK otherwise asks for a detailed summary whenever an
 *    effort is set. Nothing in a run reads it, and OpenAI may require organization verification
 *    before it serves one, which would turn a setting nobody asked for into a refused request.
 *  - `reasoningEffort`: `LLM_MODEL_EFFORT` when the operator set it, which wins over a profile's
 *    quiet switch; otherwise the quiet switch's `none`; otherwise nothing, the model's default.
 *
 * For `ollama` and `custom` only the quiet switch, as before this options object existed, so the
 * options those endpoints receive do not move. (Their tool schemas did move once, with the SDK:
 * `@ai-sdk/openai` 4.0.96 strips `propertyNames` from every Chat Completions tool schema, which
 * constrains nothing on JSON object keys.) `gemini` reads its own key, so the `openai` object a
 * quiet switch builds reaches nothing there.
 *
 * @param quiet - whether the model's profile asks this turn for no reasoning
 */
export function agentProviderOptions(
  agentModel: Pick<AgentModel, "provider" | "effort">,
  quiet = false,
): AgentProviderOptions | undefined {
  const effort = agentModel.effort ?? (quiet ? PLAN_NO_REASONING_EFFORT : undefined);
  if (agentModel.provider === "openai") {
    return {
      openai: { store: false, reasoningSummary: null, ...(effort === undefined ? {} : { reasoningEffort: effort }) },
    };
  }
  return effort === undefined ? undefined : { openai: { reasoningEffort: effort } };
}

type OpenAISamplingFeature = "temperature" | "topP";

/**
 * The sampling fields the `openai` kind's SDK would drop for one model and resolved effort.
 *
 * Asked offline through `prepareRequest` and memoized by `(modelId, effort)`: the only provider
 * option that changes the answer is the resolved reasoning effort, so one preparation per pair
 * serves every turn of a run. A rejected preparation is not cached, so a transient failure is
 * retried on the next turn rather than pinned.
 */
const openAISamplingDropsCache = new Map<string, Promise<ReadonlySet<OpenAISamplingFeature>>>();

async function openAISamplingDrops(
  modelId: string,
  providerOptions: AgentProviderOptions | undefined,
): Promise<ReadonlySet<OpenAISamplingFeature>> {
  const effort = providerOptions?.openai?.reasoningEffort;
  const key = `${modelId}\u0000${String(effort ?? "")}`;
  const cached = openAISamplingDropsCache.get(key);
  if (cached !== undefined) return cached;
  const pending = computeOpenAISamplingDrops(modelId, providerOptions).catch((error: unknown) => {
    openAISamplingDropsCache.delete(key);
    throw error;
  });
  openAISamplingDropsCache.set(key, pending);
  return pending;
}

async function computeOpenAISamplingDrops(
  modelId: string,
  providerOptions: AgentProviderOptions | undefined,
): Promise<ReadonlySet<OpenAISamplingFeature>> {
  const warnings = await openAIResponsesRequestWarnings(modelId, providerOptions, { temperature: 0, topP: 1 });
  const drops = new Set<OpenAISamplingFeature>();
  for (const warning of warnings) {
    if (warning.type === "unsupported" && (warning.feature === "temperature" || warning.feature === "topP")) {
      drops.add(warning.feature);
    }
  }
  return drops;
}

/**
 * The sampling a turn sends to its model: the profile's own resolution, minus the fields the
 * `openai` kind's SDK would drop before they reach the wire.
 *
 * Only `openai` is asked, for the reason `agentProviderOptions` records: `ollama`, `custom` and
 * `gemini` must stay byte-identical, so the gate is the provider kind and nothing else. The answer
 * comes from the SDK's own offline `prepareRequest`, so its per-model table is never copied here,
 * and the provider options it is handed are the same object the call will send, so the quiet switch
 * and `LLM_MODEL_EFFORT` decide it exactly as a real request would.
 *
 * One boundary is deliberately the SDK's and not this repository's: a self-hosted
 * OpenAI-compatible endpoint whose model id literally reads as an OpenAI reasoning model (say
 * `gpt-6-luna` on `ollama` or `custom`) still has its `temperature`/`top_p` dropped by the SDK's
 * own Chat Completions table, with a warning, even though this gate is never asked. That is the
 * SDK's per-model table applied on the wire, not this decision; the openai-only gate is what this
 * repository owns.
 *
 * Deliberately not done here, and why: no capability table is copied (an SDK upgrade is caught by
 * `tests/unit/agent-dependency-boundary.test.ts`, not by a stale copy), and no global log switch is
 * touched.
 */
export async function agentSamplingFor(
  agentModel: Pick<AgentModel, "provider" | "modelId">,
  providerOptions: AgentProviderOptions | undefined,
  sampling: AgentSampling,
): Promise<AgentSampling> {
  if (agentModel.provider !== "openai") return sampling;
  if (sampling.temperature === undefined && sampling.topP === undefined) return sampling;
  const drops = await openAISamplingDrops(agentModel.modelId, providerOptions);
  return {
    ...(sampling.temperature !== undefined && !drops.has("temperature") ? { temperature: sampling.temperature } : {}),
    ...(sampling.topP !== undefined && !drops.has("topP") ? { topP: sampling.topP } : {}),
  };
}

/**
 * The SDK's refusal of a reasoning effort, as the error it has to be.
 *
 * `@ai-sdk/openai` keeps its own table of which efforts a model takes (GPT-6.1 Sol has no `none`)
 * and treats a non-reasoning model as taking none. An effort outside it is not sent and not
 * refused by the API either: the SDK drops it, warns, and sends the request at the model's
 * default effort. A run on an effort the operator did not ask for is the silent fallback this
 * repository refuses, so every caller reads the call's warnings and raises this instead.
 *
 * @returns the error to raise, or undefined when no effort was dropped
 */
export function refusedEffortError(
  warnings: readonly CallWarning[] | undefined,
  agentModel: Pick<AgentModel, "provider" | "modelId" | "effort">,
): LLMConfigError | undefined {
  const dropped = warnings?.find(
    (warning): warning is UnsupportedWarning => warning.type === "unsupported" && warning.feature === "reasoningEffort",
  );
  if (dropped === undefined) return undefined;
  return new LLMConfigError(effortRefusalMessage(agentModel, dropped.details), agentModel.provider, "effort_refused");
}

type UnsupportedWarning = Extract<CallWarning, { type: "unsupported" }>;

/**
 * Refuses a configured `LLM_MODEL_EFFORT` the model does not take, before anything is sent.
 *
 * Without this, the first thing to learn of the refusal is a paid request that went out at the
 * model's default effort, read back from its warnings: a plan run spent a turn and then failed as
 * `model-unavailable`. The SDK's own request preparation answers the same question offline
 * (`openAIResponsesRequestWarnings`), so every caller of `createAgentModel` (the start gate in every
 * mode, the classifier, a drive) is refused here with the sentence a turn would raise. The checks
 * on a turn's own warnings stay, for an effort that reaches a call some other way: a profile's quiet
 * switch, which is per turn.
 *
 * Only the `openai` kind carries `LLM_MODEL_EFFORT` (`validateConfig`), so only its wire is asked.
 */
async function refuseUntakenEffort(agentModel: Pick<AgentModel, "provider" | "modelId" | "effort">): Promise<void> {
  const warnings = await openAIResponsesRequestWarnings(agentModel.modelId, agentProviderOptions(agentModel));
  const refused = refusedEffortError(warnings, agentModel);
  if (refused !== undefined) throw refused;
}

// The sentence is one template from parts built a statement each: bun's line coverage under-counts
// the continuation lines of multi-line string concatenation.
const effortRefusalMessage = (
  agentModel: Pick<AgentModel, "provider" | "modelId" | "effort">,
  details: string | undefined,
): string => {
  const subject =
    agentModel.effort === undefined
      ? "The reasoning effort this model's profile asks for"
      : `LLM_MODEL_EFFORT "${agentModel.effort}"`;
  const reason = details === undefined ? "." : `: ${details.replace(/\.$/, "")}.`;
  const advice = agentModel.effort === undefined ? "" : " Change LLM_MODEL_EFFORT or unset it.";
  return `${subject} was refused for the model "${agentModel.modelId}" (${agentModel.provider})${reason}${advice}`;
};

/**
 * An `APICallError`'s message, plus the transport's own words when only its `cause` carries them.
 *
 * Since `@ai-sdk/provider-utils` 5.0.33 a body that breaks mid-stream (a dropped socket, an Ollama
 * server killed while answering) surfaces as "Failed to process successful response" with the
 * socket's message on `cause` alone, so the user would be told nothing about what broke. Only a
 * cause the SDK did not raise itself is appended: an SDK cause such as a JSON parse failure can
 * quote the response body, and a cause the message already quotes ("Cannot connect to API: ...")
 * is not repeated.
 */
function withTransportCause(error: APICallError): string {
  const { cause } = error;
  if (!(cause instanceof Error) || AISDKError.isInstance(cause)) return error.message;
  if (error.message.includes(cause.message)) return error.message;
  return `${error.message}: ${cause.message}`;
}

/**
 * Translate an SDK failure into this repository's error vocabulary, so the agent
 * run loop catches the same classes every other LLM caller does. Errors already
 * in that vocabulary pass through unchanged.
 */
export function mapAgentModelError(error: unknown, provider: LLMProviderType): LLMError {
  if (error instanceof LLMError) return error;

  // Marker-based checks, not instanceof: they hold across duplicate copies of
  // the SDK in a dependency tree, which instanceof does not.
  if (LoadAPIKeyError.isInstance(error)) return new LLMConfigError(error.message, provider);

  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) return new LLMAuthError(error.message, provider);
    if (error.statusCode === 429) return new LLMRateLimitError(error.message, provider);
    return new LLMStreamError(withTransportCause(error), provider);
  }

  return new LLMStreamError(error instanceof Error ? error.message : String(error), provider);
}
