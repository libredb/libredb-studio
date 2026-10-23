/**
 * Provider registry for the agent runtime (#329, epic #325).
 *
 * One mapping from each provider kind the settings surface can resolve
 * (`LLMProviderType`) onto the adapter that builds an SDK model for it. It is a
 * `Record` over that union rather than a switch, so the table is total by
 * construction: adding a kind to `src/lib/llm` stops this file compiling until
 * its adapter exists, which is the same protection the switch this replaced gave
 * and the reason there is no default arm anywhere in here.
 *
 * The rule the construction functions exist to enforce: **configuration comes
 * from the repository's existing resolution and from nowhere else.** Every
 * provider package ships its own environment fallbacks — verified in the
 * installed builds, not taken from the vendors' documentation:
 *
 *  - `@ai-sdk/openai` reads `OPENAI_API_KEY` when `apiKey` is undefined and
 *    `OPENAI_BASE_URL` when `baseURL` is undefined,
 *  - `@ai-sdk/google` reads `GOOGLE_GENERATIVE_AI_API_KEY` when `apiKey` is
 *    undefined (its base URL has no environment fallback).
 *
 * Each of those is a second settings surface: an ambient key in the operator's
 * environment would silently authenticate the agent against a provider the user
 * never configured here. Every setting is therefore passed explicitly, so none of
 * those reads can ever happen — asserted on the wire in
 * `tests/isolated/agent-model-adapter.test.ts` with sentinel values.
 *
 * The two self-hosted OpenAI-compatible kinds (`ollama`, `custom`) go through the
 * OpenAI provider's `chat()` model, which posts to `{baseURL}/chat/completions` —
 * the same endpoint `src/lib/llm/providers/{ollama,custom}.ts` already post to,
 * so an `LLM_API_URL` that works for the chat surface works here too. They stay
 * off `responses()` because it is OpenAI's own API shape and a self-hosted
 * OpenAI-compatible endpoint does not serve it.
 *
 * The `openai` kind is OpenAI itself, and it uses `responses()`, posting to
 * `{baseURL}/responses`. OpenAI's GPT-6 guide routes tool calling through the
 * Responses API: GPT-6.1 Sol and GPT-6 Astra take no function tools on Chat
 * Completions at all, and GPT-6 Sol and Luna take them there only with
 * `reasoning_effort: "none"`. What every call sends with it, `store: false` among
 * it, is `agentProviderOptions` in `model-adapter.ts`. The chat surface's
 * `src/lib/llm/providers/openai.ts` sends no tools and stays on Chat Completions.
 *
 * Gemini takes `LLM_API_URL` too, on both surfaces at once (B20): the chat
 * provider passes it as this SDK family's origin-shaped `RequestOptions.baseUrl`
 * and this adapter passes the versioned form `@ai-sdk/google` expects, both
 * derived from the one variable by `src/lib/llm/utils/gemini-endpoint.ts`. Same
 * variables, same precedence means matching what the chat surface does with them,
 * not just where they come from — and the earlier arrangement, where only the
 * OpenAI-compatible kinds read the variable, meant an operator behind an egress
 * proxy configured Gemini, saw no error, and was routed to Google anyway.
 *
 * Not here: an Anthropic kind. Its package is ratified and installed, but the
 * settings surface has no `anthropic` kind, and adding one is a change to
 * `src/lib/llm`'s own union, factory, validation and providers — a chat-surface
 * feature in its own right, since `LLM_PROVIDER=anthropic` would then have to work
 * for every surface that resolves a provider, not only for a run. Deferred rather than
 * half-built; the reasoning and what closing it takes are in `docs/BACKLOG.md` B2.
 */

import type { CallWarning, LanguageModel } from "ai";
import { type LLMConfig, type LLMProviderType, LLMConfigError } from "@/lib/llm/types";
import { resolveGeminiSdkBaseUrl } from "@/lib/llm/utils/gemini-endpoint";

/**
 * A constructed model instance.
 *
 * The SDK's own `LanguageModel` also accepts a bare model-id string, which it
 * resolves through its hosted gateway — a network egress to a third party that
 * nothing in this repository configures. Excluding the string arm makes that
 * unreachable by construction rather than by convention.
 */
export type AgentLanguageModel = Exclude<LanguageModel, string>;

/**
 * Transport seam. Structural on purpose: the SDK types its own `fetch` option as
 * `typeof globalThis.fetch`, which under this repository's Bun typings also
 * demands a `preconnect` property the SDK never calls. Requiring that of every
 * caller would mean stubbing a method for nobody.
 */
export type AgentFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

/** How one provider kind turns a resolved configuration into a model. */
export interface AgentProviderAdapter {
  readonly kind: LLMProviderType;
  /**
   * @param config - an already-resolved, already-validated configuration
   * @param fetchImpl - transport override; the SDK providers' documented seam
   */
  createModel(config: LLMConfig, fetchImpl?: AgentFetch): Promise<AgentLanguageModel>;
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

async function createOpenAICompatibleModel(config: LLMConfig, fetchImpl?: AgentFetch): Promise<AgentLanguageModel> {
  const { createOpenAI } = await import("@ai-sdk/openai");
  const { apiKey, headers } = openAICompatibleAuth(config);

  const provider = createOpenAI({
    apiKey,
    headers,
    baseURL: config.apiUrl,
    fetch: asSdkFetch(fetchImpl),
    name: config.provider,
  });
  // The one difference between the three kinds; see the header for why only OpenAI itself
  // speaks the Responses API.
  return config.provider === "openai" ? provider.responses(config.model) : provider.chat(config.model);
}

async function createGeminiModel(config: LLMConfig, fetchImpl?: AgentFetch): Promise<AgentLanguageModel> {
  const { createGoogleGenerativeAI } = await import("@ai-sdk/google");

  return createGoogleGenerativeAI({
    // validateConfig is what refuses a keyless Gemini config, so this fallback
    // is unreachable and no test pins it; it exists so the `string | undefined`
    // the type allows can never reach the SDK and re-open its env fallback.
    apiKey: config.apiKey ?? "",
    // The versioned spelling this SDK expects; undefined when nothing is
    // configured, which selects the SDK's own Google endpoint. That is safe here
    // because this provider has no base-URL env fallback to leak into.
    baseURL: resolveGeminiSdkBaseUrl(config.apiUrl),
    fetch: asSdkFetch(fetchImpl),
  }).chat(config.model);
}

/**
 * Every provider kind the settings surface can resolve, and nothing else. Three
 * kinds share one construction function, which picks the Responses API for `openai`
 * and Chat Completions for the other two, and each still carries its own `kind`,
 * which is what makes an error or a log line name the endpoint the operator
 * configured instead of naming OpenAI for an Ollama server.
 */
export const AGENT_PROVIDER_ADAPTERS: Readonly<Record<LLMProviderType, AgentProviderAdapter>> = Object.freeze({
  gemini: { kind: "gemini", createModel: createGeminiModel },
  openai: { kind: "openai", createModel: createOpenAICompatibleModel },
  ollama: { kind: "ollama", createModel: createOpenAICompatibleModel },
  custom: { kind: "custom", createModel: createOpenAICompatibleModel },
});

/**
 * Look up the adapter for a resolved provider kind.
 *
 * @throws LLMConfigError if the kind has no adapter. Only a cast reaches that:
 *         `resolveConfig` falls back to the default provider for junk and
 *         `validateConfig` refuses an unknown one. It still fails loud rather
 *         than choosing a provider on the caller's behalf.
 */
export function resolveAgentProviderAdapter(kind: LLMProviderType): AgentProviderAdapter {
  // Asks about OWN keys, not about truthiness: a cast-in "constructor" or
  // "toString" reads truthy off the prototype, and a presence test alone would
  // hand the caller `Object` and fail later as a TypeError instead of here as the
  // typed error this function documents.
  if (!Object.hasOwn(AGENT_PROVIDER_ADAPTERS, kind)) throw new LLMConfigError(noAdapterMessage(kind), kind);
  return AGENT_PROVIDER_ADAPTERS[kind];
}

// Built on one line: bun's line coverage under-counts the continuation lines of
// multi-line string concatenation.
const noAdapterMessage = (kind: string): string =>
  `No agent provider adapter for "${kind}". Configured kinds: ${Object.keys(AGENT_PROVIDER_ADAPTERS).join(", ")}.`;

/**
 * The warnings the SDK raises while it PREPARES a Responses request for `modelId` with these
 * provider options, without sending it.
 *
 * `prepareRequest` is the step every Responses call runs before its first byte leaves: it reads the
 * SDK's per-model capability table and drops, with a warning, a reasoning effort the model does not
 * take. Calling it on its own asks that table the question with no network call and no copy of the
 * table here. It is a public static on the Responses model in the package's `internal` entry point,
 * and the package is pinned to an exact version (`tests/unit/agent-dependency-boundary.test.ts`), so
 * an upgrade that moved it fails the typecheck and the tests that pin its sentence to a real call's.
 *
 * The optional `sampling` is handed to the same preparation step, so a caller can learn offline
 * whether the SDK would keep or drop `temperature`/`topP` for this model and effort. The SDK drops
 * both for reasoning models unless the resolved effort is `none` and the model takes non-reasoning
 * parameters; the warning it raises is exactly the one a real call would log, so reading it here is
 * the whole decision with no capability table copied into this repository.
 */
export async function openAIResponsesRequestWarnings(
  modelId: string,
  providerOptions: Record<string, Record<string, string | boolean | null>> | undefined,
  sampling?: { readonly temperature?: number; readonly topP?: number },
): Promise<CallWarning[]> {
  const { OpenAIResponsesLanguageModel } = await import("@ai-sdk/openai/internal");
  const prepared = await OpenAIResponsesLanguageModel.prepareRequest({
    modelId,
    // No `fetch` and no real URL: preparation reads neither, and nothing here sends what it builds.
    config: { provider: "openai.responses", url: () => "" },
    options: {
      prompt: [],
      providerOptions,
      ...(sampling?.temperature !== undefined ? { temperature: sampling.temperature } : {}),
      ...(sampling?.topP !== undefined ? { topP: sampling.topP } : {}),
    },
  });
  return prepared.warnings;
}
