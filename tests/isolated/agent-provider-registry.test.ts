import { describe, test, expect } from "bun:test";
import { streamText } from "ai";
import {
  AGENT_PROVIDER_ADAPTERS,
  type AgentProviderAdapter,
  resolveAgentProviderAdapter,
} from "@/lib/agent/provider-registry";
import { type LLMConfig, type LLMProviderType, LLMConfigError } from "@/lib/llm/types";
import { DEFAULT_MODELS } from "@/lib/llm/utils/config";
import { type CapturedRequest, chatTextStream, geminiTextStream, recordingFetch } from "./fixtures/agent-transport";

/**
 * T5's registry half in one sentence: every provider kind the settings surface can
 * resolve has exactly one agent adapter, and the registry is the only place that
 * mapping lives.
 *
 * The totality assertion below is the point of the file. `src/lib/llm` decides
 * which kinds exist (`LLMProviderType`); if a kind is ever added there, the
 * registry's `Record<LLMProviderType, ...>` stops compiling — but a compile error
 * is only felt by whoever runs `tsc`, so the runtime assertion states the same
 * invariant as a test a reader can see failing.
 *
 * This file shares Group 0f with the other agent model tests: it needs the REAL
 * `@/lib/llm` error classes, and every `tests/api/ai/*.test.ts` replaces them with
 * stubs through process-wide `mock.module`.
 */

// ─── the table is total over the settings surface ───────────────────────────

/**
 * The kinds `src/lib/llm/utils/config.ts` can resolve. Derived from the shipped
 * `DEFAULT_MODELS` map rather than re-typed here, so this list cannot drift from
 * the settings surface it is checking the registry against.
 */
const SETTINGS_SURFACE_KINDS = Object.keys(DEFAULT_MODELS).sort() as LLMProviderType[];

describe("the agent provider registry covers every configurable provider kind", () => {
  test("the adapter table's keys are exactly the settings surface's kinds", () => {
    expect(Object.keys(AGENT_PROVIDER_ADAPTERS).sort()).toEqual(SETTINGS_SURFACE_KINDS);
  });

  test("every entry reports the kind it is registered under", () => {
    // Guards the copy-paste failure a Record cannot: an adapter filed under the
    // wrong key would build the wrong endpoint while type-checking cleanly.
    const mismatched = Object.entries(AGENT_PROVIDER_ADAPTERS)
      .filter(([kind, adapter]) => (adapter as AgentProviderAdapter).kind !== kind)
      .map(([kind]) => kind);

    expect(mismatched).toEqual([]);
  });

  test("resolving each configurable kind yields that kind's adapter", () => {
    for (const kind of SETTINGS_SURFACE_KINDS) {
      expect(resolveAgentProviderAdapter(kind).kind).toBe(kind);
    }
  });

  test("a kind the settings surface cannot resolve is refused, not defaulted", () => {
    // Only a cast reaches here: resolveConfig falls back to the default provider
    // and validateConfig throws. The registry still refuses rather than picking a
    // provider on the caller's behalf.
    const unregisteredKind = "anthropic" as LLMProviderType;

    let caught: unknown;
    try {
      resolveAgentProviderAdapter(unregisteredKind);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LLMConfigError);
    expect((caught as LLMConfigError).message).toContain("anthropic");
    // The refused kind is carried on the error, not just in its text.
    expect((caught as LLMConfigError).provider).toBe(unregisteredKind);
  });

  test("an inherited property name is refused the same way a missing kind is", () => {
    // A truthiness test would answer `Object` for these and fail later as a
    // TypeError instead of here as the documented typed error.
    for (const inherited of ["constructor", "toString", "__proto__"]) {
      expect(() => resolveAgentProviderAdapter(inherited as LLMProviderType)).toThrow(LLMConfigError);
    }
  });
});

// ─── each adapter reaches its own endpoint ──────────────────────────────────

/** Drives one streamed call through a resolved adapter and returns what it asked. */
async function firstRequestThroughRegistry(config: LLMConfig, response: Response): Promise<CapturedRequest> {
  const recording = recordingFetch(response);
  const model = await resolveAgentProviderAdapter(config.provider).createModel(config, recording.fetch);

  // Consuming the stream is what makes the request happen.
  await streamText({ model, prompt: "ping", maxRetries: 0 }).consumeStream();

  const request = recording.requests[0];
  if (!request) throw new Error("the resolved adapter made no request");
  return request;
}

describe("each resolved adapter builds a model for its own endpoint", () => {
  test("gemini reaches Google's own endpoint with the configured key", async () => {
    const request = await firstRequestThroughRegistry(
      { provider: "gemini", apiKey: "gemini-key", model: "gemini-2.5-flash" },
      geminiTextStream("pong"),
    );

    expect(request.url).toStartWith("https://generativelanguage.googleapis.com/v1beta/");
    expect(request.url).toContain("gemini-2.5-flash");
    expect(request.headers["x-goog-api-key"]).toBe("gemini-key");
  });

  // B20: the adapter used to pass no baseURL at all, so an operator behind an
  // egress proxy set LLM_API_URL, saw no error, and was routed to Google.
  test("gemini reaches a configured endpoint, keeping the version segment it was given", async () => {
    const request = await firstRequestThroughRegistry(
      {
        provider: "gemini",
        apiKey: "gemini-key",
        model: "gemini-2.5-flash",
        apiUrl: "https://gemini-proxy.internal/v1beta",
      },
      geminiTextStream("pong"),
    );

    expect(request.url).toStartWith("https://gemini-proxy.internal/v1beta/");
    expect(request.headers["x-goog-api-key"]).toBe("gemini-key");
  });

  test("gemini reaches a configured bare origin, the version segment composed for it", async () => {
    const request = await firstRequestThroughRegistry(
      { provider: "gemini", apiKey: "gemini-key", model: "gemini-2.5-flash", apiUrl: "https://gemini-proxy.internal" },
      geminiTextStream("pong"),
    );

    expect(request.url).toStartWith("https://gemini-proxy.internal/v1beta/");
  });

  test("openai reaches the configured OpenAI-compatible endpoint with a bearer key", async () => {
    const request = await firstRequestThroughRegistry(
      { provider: "openai", apiKey: "sk-configured", model: "gpt-4o-mini", apiUrl: "https://api.openai.com/v1" },
      chatTextStream("pong"),
    );

    expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer sk-configured");
  });

  test("ollama reaches its local endpoint with the chat surface's placeholder token", async () => {
    const request = await firstRequestThroughRegistry(
      { provider: "ollama", model: "llama3.2", apiUrl: "http://localhost:11434/v1" },
      chatTextStream("pong"),
    );

    expect(request.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer ollama");
  });

  test("a keyless custom endpoint reaches its URL with no Authorization header", async () => {
    const request = await firstRequestThroughRegistry(
      { provider: "custom", model: "mixtral", apiUrl: "https://llm.internal/v1" },
      chatTextStream("pong"),
    );

    expect(request.url).toBe("https://llm.internal/v1/chat/completions");
    expect(Object.keys(request.headers)).not.toContain("authorization");
  });
});

describe("a built model names the kind the operator configured", () => {
  const KINDS: readonly { config: LLMConfig; tag: string }[] = [
    { config: { provider: "gemini", apiKey: "k", model: "gemini-2.5-flash" }, tag: "google.generative-ai" },
    { config: { provider: "openai", apiKey: "k", model: "gpt-4o-mini" }, tag: "openai.chat" },
    { config: { provider: "ollama", model: "llama3.2", apiUrl: "http://localhost:11434/v1" }, tag: "ollama.chat" },
    { config: { provider: "custom", model: "mixtral", apiUrl: "https://llm.internal/v1" }, tag: "custom.chat" },
  ];

  for (const { config, tag } of KINDS) {
    test(`the ${config.provider} adapter's model reports "${tag}"`, async () => {
      const model = await resolveAgentProviderAdapter(config.provider).createModel(config);

      // Three kinds share one adapter, so without this the provider tag on an
      // error or a log line would name "openai" for an Ollama endpoint.
      expect(model.provider).toBe(tag);
      expect(model.modelId).toBe(config.model);
    });
  }
});
