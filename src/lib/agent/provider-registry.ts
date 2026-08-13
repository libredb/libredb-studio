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
 * The three OpenAI-compatible kinds (`openai`, `ollama`, `custom`) go through the
 * OpenAI provider's `chat()` model, which posts to `{baseURL}/chat/completions` —
 * the same endpoint `src/lib/llm/providers/{openai,ollama,custom}.ts` already post
 * to, so an `LLM_API_URL` that works for the chat surface works here too.
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
 * Not here: an Anthropic kind. Its package is ratified and installed, but the
 * settings surface has no `anthropic` kind, and adding one is a change to
 * `src/lib/llm`'s own union, factory, validation and providers — a chat-surface
 * feature in its own right, since `LLM_PROVIDER=anthropic` would then have to work
 * for every surface that resolves a provider, not only for a run. Deferred rather than
 * half-built; the reasoning and what closing it takes are in `docs/BACKLOG.md` B2.
 */

import type { LanguageModel } from "ai";
import { type LLMConfig, type LLMProviderType, LLMConfigError } from "@/lib/llm/types";

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

  return createOpenAI({
    apiKey,
    headers,
    baseURL: config.apiUrl,
    fetch: asSdkFetch(fetchImpl),
    name: config.provider,
  }).chat(config.model);
}

async function createGeminiModel(config: LLMConfig, fetchImpl?: AgentFetch): Promise<AgentLanguageModel> {
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
 * Every provider kind the settings surface can resolve, and nothing else. Three
 * kinds share one construction function and still carry their own `kind`, which
 * is what makes an error or a log line name the endpoint the operator configured
 * instead of naming OpenAI for an Ollama server.
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
