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

import { APICallError, LoadAPIKeyError } from "ai";
import {
  type LLMConfig,
  type LLMProviderType,
  LLMAuthError,
  LLMConfigError,
  LLMError,
  LLMRateLimitError,
  LLMStreamError,
} from "@/lib/llm/types";
import { resolveConfig, validateConfig } from "@/lib/llm/utils/config";
import { type AgentFetch, type AgentLanguageModel, resolveAgentProviderAdapter } from "./provider-registry";

/** A model plus the resolved identity it was built from, for audit and logging. */
export interface AgentModel {
  readonly provider: LLMProviderType;
  readonly modelId: string;
  readonly model: AgentLanguageModel;
}

export interface AgentModelOptions {
  /** Overrides handed to `resolveConfig`, the same shape `createLLMProvider` takes. */
  readonly config?: Partial<LLMConfig>;
  /**
   * The SDK providers document `fetch` as the interception point for tests and
   * proxies; injecting it keeps the suite off a global stub, which `bun test`
   * would leak across files sharing the process.
   */
  readonly fetch?: AgentFetch;
}

/**
 * Build a model instance from the repository's resolved LLM configuration.
 *
 * @throws LLMConfigError if the configuration is one the chat surface would also
 *         refuse, if the kind has no adapter, or if the SDK refuses the settings
 *         when the provider is constructed.
 */
export async function createAgentModel(options: AgentModelOptions = {}): Promise<AgentModel> {
  const config = resolveConfig(options.config);
  validateConfig(config);
  const adapter = resolveAgentProviderAdapter(config.provider);

  try {
    return {
      provider: config.provider,
      modelId: config.model,
      model: await adapter.createModel(config, options.fetch),
    };
  } catch (error) {
    if (error instanceof LLMError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new LLMConfigError(`Cannot build the ${config.provider} model: ${detail}`, config.provider);
  }
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
    return new LLMStreamError(error.message, provider);
  }

  return new LLMStreamError(error instanceof Error ? error.message : String(error), provider);
}
