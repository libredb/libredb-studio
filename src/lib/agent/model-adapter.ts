/**
 * Model adapter for the agent runtime (#329, epic #325).
 *
 * The agent needs a tool-calling model, and `src/lib/llm` has no tool-calling
 * surface — its provider contract is text streaming plus config validation. So
 * the agent drives the ratified AI SDK provider packages instead, and this
 * module is the only place where the two meet.
 *
 * The rule it exists to enforce: **configuration comes from the repository's
 * existing resolution and from nowhere else.** Every provider package ships its
 * own environment fallbacks — verified in the installed builds:
 *
 *  - `@ai-sdk/openai` reads `OPENAI_API_KEY` when `apiKey` is undefined and
 *    `OPENAI_BASE_URL` when `baseURL` is undefined,
 *  - `@ai-sdk/google` reads `GOOGLE_GENERATIVE_AI_API_KEY` when `apiKey` is
 *    undefined (its base URL has no environment fallback).
 *
 * Each of those is a second settings surface: an ambient key in the operator's
 * environment would silently authenticate the agent against a provider the
 * user never configured here. Every setting is therefore passed explicitly, so
 * none of those reads can ever happen — asserted on the wire in
 * `tests/isolated/agent-model-adapter.test.ts` with sentinel values.
 *
 * The three OpenAI-compatible kinds (`openai`, `ollama`, `custom`) go through
 * the OpenAI provider's `chat()` model, which posts to `{baseURL}/chat/completions`
 * — the same endpoint `src/lib/llm/providers/{openai,ollama,custom}.ts` already
 * post to, so an `LLM_API_URL` that works for the chat surface works here too.
 * `responses()` is deliberately not used: it is OpenAI's own API shape and a
 * self-hosted OpenAI-compatible endpoint does not serve it.
 *
 * Gemini deliberately does NOT take `LLM_API_URL`: `src/lib/llm/providers/gemini.ts`
 * ignores it, and `.env.example` documents the variable as needed for the Ollama
 * and custom kinds only. Honouring it here would mean a value left over from a
 * custom setup silently redirects Gemini traffic — carrying the configured key —
 * to that host on the agent path while the chat surface still talks to Google.
 * Same variables, same precedence means matching what the chat surface does with
 * them, not just where they come from.
 *
 * Not here: the Anthropic kind. Its package is ratified and installed, but the
 * settings surface has no `anthropic` provider kind yet, and adding one touches
 * `src/lib/llm`'s factory, providers and validation. T5 owns that.
 */

import { APICallError, LoadAPIKeyError, type LanguageModel } from "ai";
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

/**
 * A constructed model instance.
 *
 * The SDK's own `LanguageModel` also accepts a bare model-id string, which it
 * resolves through its hosted gateway — a network egress to a third party that
 * nothing in this repository configures. Excluding the string arm makes that
 * unreachable by construction rather than by convention.
 */
export type AgentLanguageModel = Exclude<LanguageModel, string>;

/** A model plus the resolved identity it was built from, for audit and logging. */
export interface AgentModel {
  readonly provider: LLMProviderType;
  readonly modelId: string;
  readonly model: AgentLanguageModel;
}

/**
 * Transport seam. Structural on purpose: the SDK types its own `fetch` option as
 * `typeof globalThis.fetch`, which under this repository's Bun typings also
 * demands a `preconnect` property the SDK never calls. Requiring that of every
 * caller would mean stubbing a method for nobody.
 */
export type AgentFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

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
 * What `src/lib/llm/providers/ollama.ts` sends as its bearer token. Ollama needs
 * no credential, but the OpenAI provider always builds an Authorization header,
 * and leaving `apiKey` undefined is what would let `OPENAI_API_KEY` through.
 */
const OLLAMA_PLACEHOLDER_KEY = "ollama";

/**
 * Suppresses the Authorization header entirely, matching
 * `src/lib/llm/providers/custom.ts`, which omits it when no key is configured.
 * `@ai-sdk/provider-utils`' `normalizeHeaders` drops null and undefined entries
 * before the request is built, so an undefined value removes the header the
 * provider would otherwise add. The cast is needed because the settings type
 * declares `Record<string, string>`; a test pins the behaviour so an upgrade
 * that changed it cannot pass silently.
 */
const NO_AUTHORIZATION_HEADER = { Authorization: undefined } as unknown as Record<string, string>;

interface OpenAICompatibleAuth {
  readonly apiKey: string;
  readonly headers?: Record<string, string>;
}

/** Auth settings for the OpenAI-compatible kinds; never leaves `apiKey` undefined. */
function openAICompatibleAuth(config: LLMConfig): OpenAICompatibleAuth {
  if (config.apiKey) return { apiKey: config.apiKey };
  if (config.provider === "ollama") return { apiKey: OLLAMA_PLACEHOLDER_KEY };
  // Only a keyless custom endpoint reaches here: validateConfig has already
  // refused OpenAI and Gemini without a key.
  return { apiKey: "", headers: NO_AUTHORIZATION_HEADER };
}

/**
 * The SDK's `fetch` option is `typeof globalThis.fetch`; see `AgentFetch` for
 * why the seam is narrower than that, and why widening it here is safe.
 */
function asSdkFetch(fetchImpl: AgentFetch | undefined): typeof globalThis.fetch | undefined {
  return fetchImpl as typeof globalThis.fetch | undefined;
}

async function createOpenAICompatibleModel(
  config: LLMConfig,
  fetchImpl: AgentFetch | undefined,
): Promise<AgentLanguageModel> {
  const { createOpenAI } = await import("@ai-sdk/openai");
  const { apiKey, headers } = openAICompatibleAuth(config);

  return createOpenAI({
    apiKey,
    headers,
    baseURL: config.apiUrl,
    fetch: asSdkFetch(fetchImpl),
    name: config.provider,
  }).chat(config.model);
}

async function createGeminiModel(config: LLMConfig, fetchImpl: AgentFetch | undefined): Promise<AgentLanguageModel> {
  const { createGoogleGenerativeAI } = await import("@ai-sdk/google");

  return createGoogleGenerativeAI({
    // validateConfig is what refuses a keyless Gemini config, so this fallback
    // is unreachable and no test pins it; it exists so the `string | undefined`
    // the type allows can never reach the SDK and re-open its env fallback.
    apiKey: config.apiKey ?? "",
    // No baseURL: see the header. Leaving it undefined selects the SDK's own
    // Google endpoint, and this provider has no base-URL env fallback to leak into.
    fetch: asSdkFetch(fetchImpl),
  }).chat(config.model);
}

/**
 * Builds the model for a validated config.
 *
 * The switch has no default arm on purpose: it is exhaustive over
 * `LLMProviderType`, so adding a kind (T5's Anthropic) stops compiling here
 * instead of silently falling into the OpenAI-compatible branch.
 */
async function buildModel(config: LLMConfig, fetchImpl: AgentFetch | undefined): Promise<AgentLanguageModel> {
  switch (config.provider) {
    case "gemini":
      return await createGeminiModel(config, fetchImpl);
    case "openai":
    case "ollama":
    case "custom":
      return await createOpenAICompatibleModel(config, fetchImpl);
  }
}

/**
 * Build a model instance from the repository's resolved LLM configuration.
 *
 * @throws LLMConfigError if the configuration is one the chat surface would also
 *         refuse, or one the SDK refuses when the provider is constructed.
 */
export async function createAgentModel(options: AgentModelOptions = {}): Promise<AgentModel> {
  const config = resolveConfig(options.config);
  validateConfig(config);

  try {
    return { provider: config.provider, modelId: config.model, model: await buildModel(config, options.fetch) };
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
