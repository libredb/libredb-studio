import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { generateText, streamText, stepCountIs, tool, LoadAPIKeyError } from "ai";
import { z } from "zod";
import {
  type AgentModel,
  agentProviderOptions,
  agentSamplingFor,
  createAgentModel,
  mapAgentModelError,
  refusedEffortError,
} from "@/lib/agent/model-adapter";
import type { AgentFetch } from "@/lib/agent/provider-registry";
import * as providerRegistry from "@/lib/agent/provider-registry";
import { classifyAgentWorkflow } from "@/lib/agent/workflow-classifier";
import { logger } from "@/lib/logger";
import {
  type LLMConfig,
  type LLMModelEffort,
  LLMAuthError,
  LLMConfigError,
  LLMError,
  LLMRateLimitError,
  LLMStreamError,
} from "@/lib/llm/types";

/**
 * T4's bar in one sentence: the agent's model instances are built from the
 * repository's EXISTING settings resolution and from nothing else.
 *
 * Every ratified provider package ships its own environment fallbacks
 * (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `GOOGLE_GENERATIVE_AI_API_KEY`, ...).
 * Those would be a second settings surface, so the suite sets each of them to a
 * sentinel value and asserts the sentinel never leaves the process: what goes on
 * the wire is what `resolveConfig` resolved from `LLM_*`, or nothing.
 *
 * This file may not share a process with `tests/api/ai/*.test.ts`, every one of
 * which replaces `@/lib/llm/types` with stub error classes whose constructors
 * take a message only. `mock.module` is process-wide, so in a shared process the
 * mapper's provider tag silently vanishes while the class identity still
 * matches, and the assertions below would fail against perfectly correct code.
 * The runner gives every test file a process of its own, so that is already the
 * case and this paragraph, not a directory or a registration, records why.
 */

// ─── environment isolation ──────────────────────────────────────────────────

/** The existing settings surface — the only variables the adapter may honour. */
const LLM_ENV_KEYS = ["LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL", "LLM_API_URL", "LLM_MODEL_EFFORT"] as const;

/** Vendor fallbacks the ratified packages read when a setting is left undefined. */
const VENDOR_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
] as const;

const SENTINEL = "AMBIENT-VENDOR-VALUE-MUST-NOT-BE-USED";

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of [...LLM_ENV_KEYS, ...VENDOR_ENV_KEYS]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of [...LLM_ENV_KEYS, ...VENDOR_ENV_KEYS]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function setVendorSentinels(): void {
  for (const key of VENDOR_ENV_KEYS) process.env[key] = SENTINEL;
}

/**
 * Records every environment key read while `fn` runs.
 *
 * The sentinel assertions below prove no vendor value reaches the wire, but they
 * can only refuse the fallbacks known today. This trap is the universal form of
 * the same question — it names what WAS read instead of enumerating what must
 * not be — so a fallback introduced by a future package upgrade surfaces here.
 */
async function recordEnvReads(fn: () => Promise<unknown>): Promise<Set<string>> {
  const seen = new Set<string>();
  const real = process.env;
  const trapped = new Proxy(real, {
    get(target, key) {
      if (typeof key === "string") seen.add(key);
      return Reflect.get(target, key) as unknown;
    },
  });

  Object.defineProperty(process, "env", { value: trapped, configurable: true });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, "env", { value: real, configurable: true });
  }
  return seen;
}

// ─── transport doubles ──────────────────────────────────────────────────────

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface Recording {
  fetch: AgentFetch;
  requests: CapturedRequest[];
}

/** A fetch that answers the given responses in order and records what it was asked. */
function recordingFetch(...responses: Response[]): Recording {
  const requests: CapturedRequest[] = [];
  let served = 0;

  const fetchImpl: AgentFetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({
      url: typeof input === "string" ? input : String(input),
      headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    });

    const response = responses[served++];
    if (!response) throw new Error(`unexpected request #${served} to ${String(input)}`);
    return response;
  };

  return { fetch: fetchImpl, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** One OpenAI-compatible chat completion. */
function chatCompletion(message: Record<string, unknown>, finishReason = "stop"): Response {
  return jsonResponse({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/** One OpenAI Responses API answer carrying prose. */
function responsesCompletion(text: string): Response {
  return jsonResponse({
    id: "resp_1",
    created_at: 1,
    model: "test-model",
    output: [
      {
        type: "message",
        role: "assistant",
        id: "msg_1",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
    incomplete_details: null,
  });
}

/** One OpenAI Responses API answer: an encrypted reasoning item, then the given output items. */
function responsesTurn(reasoning: { id: string; encrypted: string }, ...output: Record<string, unknown>[]): Response {
  return jsonResponse({
    id: "resp_1",
    created_at: 1,
    model: "test-model",
    output: [{ type: "reasoning", id: reasoning.id, encrypted_content: reasoning.encrypted, summary: [] }, ...output],
    usage: { input_tokens: 1, output_tokens: 1 },
    incomplete_details: null,
  });
}

/** One Gemini generateContent response. */
function geminiCompletion(text: string): Response {
  return jsonResponse({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  });
}

/** An OpenAI-compatible chat completion stream. */
function chatCompletionStream(...deltas: string[]): Response {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null): string =>
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

  const events = [
    chunk({ role: "assistant", content: "" }, null),
    ...deltas.map((content) => chunk({ content }, null)),
    chunk({}, "stop"),
    "[DONE]",
  ];

  return new Response(events.map((event) => `data: ${event}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// ─── configuration fixtures ─────────────────────────────────────────────────

const OPENAI_CONFIG: Partial<LLMConfig> = { provider: "openai", apiKey: "sk-configured", model: "gpt-4o-mini" };

/**
 * An OpenAI-compatible endpoint on the Chat Completions wire, for the tests about what the SDK
 * does rather than which endpoint a kind reaches: `ollama` and `custom` stay on that wire, and the
 * `openai` kind left it for the Responses API.
 */
const CHAT_CONFIG: Partial<LLMConfig> = {
  provider: "custom",
  apiKey: "sk-configured",
  model: "gpt-4o-mini",
  apiUrl: "https://llm.internal/v1",
};

async function firstRequest(config: Partial<LLMConfig>, ...responses: Response[]): Promise<CapturedRequest> {
  const recording = recordingFetch(...responses);
  const { model } = await createAgentModel({ config, fetch: recording.fetch });
  await generateText({ model, prompt: "ping", maxRetries: 0 });
  const request = recording.requests[0];
  if (!request) throw new Error("the adapter's model made no request");
  return request;
}

// ─── configuration comes only from the existing surface ─────────────────────

describe("createAgentModel reads the existing LLM settings surface", () => {
  test("resolves provider, model, key and base URL from the LLM_* variables", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_MODEL = "gpt-4.1-mini";
    process.env.LLM_API_KEY = "sk-from-env";
    process.env.LLM_API_URL = "https://proxy.example.com/v1";

    const recording = recordingFetch(responsesCompletion("pong"));
    const agentModel = await createAgentModel({ fetch: recording.fetch });
    await generateText({ model: agentModel.model, prompt: "ping", maxRetries: 0 });

    expect(agentModel.provider).toBe("openai");
    expect(agentModel.modelId).toBe("gpt-4.1-mini");
    expect(recording.requests[0]?.url).toBe("https://proxy.example.com/v1/responses");
    expect(recording.requests[0]?.headers.authorization).toBe("Bearer sk-from-env");
    expect(recording.requests[0]?.body.model).toBe("gpt-4.1-mini");
  });

  test("explicit overrides win over the environment, exactly as createLLMProvider's do", async () => {
    process.env.LLM_PROVIDER = "gemini";
    process.env.LLM_API_KEY = "gemini-key";

    const request = await firstRequest(OPENAI_CONFIG, responsesCompletion("pong"));

    expect(request.url).toBe("https://api.openai.com/v1/responses");
    expect(request.headers.authorization).toBe("Bearer sk-configured");
  });

  test("defaults to Gemini — the repository's default provider — and calls Google's endpoint", async () => {
    process.env.LLM_API_KEY = "gemini-key";

    const recording = recordingFetch(geminiCompletion("pong"));
    const agentModel = await createAgentModel({ fetch: recording.fetch });
    const result = await generateText({ model: agentModel.model, prompt: "ping", maxRetries: 0 });

    expect(agentModel.provider).toBe("gemini");
    expect(agentModel.modelId).toBe("gemini-2.5-flash");
    expect(result.text).toBe("pong");
    expect(recording.requests[0]?.url).toStartWith("https://generativelanguage.googleapis.com/v1beta/");
    expect(recording.requests[0]?.url).toContain("gemini-2.5-flash");
    expect(recording.requests[0]?.headers["x-goog-api-key"]).toBe("gemini-key");
  });

  test("Gemini reads LLM_API_URL, exactly as the chat surface's provider now does (B20)", async () => {
    // Both Gemini consumers take the variable; src/lib/llm/utils/gemini-endpoint.ts
    // is what turns one value into the two spellings the SDKs disagree about.
    process.env.LLM_API_KEY = "gemini-key";
    process.env.LLM_API_URL = "https://gemini-proxy.example.com/v1beta";

    const request = await firstRequest({}, geminiCompletion("pong"));

    expect(request.url).toStartWith("https://gemini-proxy.example.com/v1beta/");
    expect(request.headers["x-goog-api-key"]).toBe("gemini-key");
  });

  test("Ollama reaches the local default endpoint through the OpenAI-compatible surface", async () => {
    const recording = recordingFetch(chatCompletion({ role: "assistant", content: "pong" }));
    const agentModel = await createAgentModel({
      config: { provider: "ollama", model: "llama3.2" },
      fetch: recording.fetch,
    });
    await generateText({ model: agentModel.model, prompt: "ping", maxRetries: 0 });

    expect(recording.requests[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    // Mirrors src/lib/llm/providers/ollama.ts, which sends the same placeholder.
    expect(recording.requests[0]?.headers.authorization).toBe("Bearer ollama");
    // The model reports the configured kind rather than "openai", so an error or
    // a log line names the endpoint the operator configured.
    expect(agentModel.model.provider).toBe("ollama.chat");
  });

  test("Ollama uses a configured key when the operator set one", async () => {
    const request = await firstRequest(
      { provider: "ollama", model: "llama3.2", apiKey: "ollama-secret" },
      chatCompletion({ role: "assistant", content: "pong" }),
    );

    expect(request.headers.authorization).toBe("Bearer ollama-secret");
  });

  test("a custom OpenAI-compatible endpoint uses its configured URL and key", async () => {
    const request = await firstRequest(
      { provider: "custom", model: "mixtral", apiKey: "proxy-key", apiUrl: "https://llm.internal/v1" },
      chatCompletion({ role: "assistant", content: "pong" }),
    );

    expect(request.url).toBe("https://llm.internal/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer proxy-key");
  });

  test("a keyless custom endpoint sends no Authorization header at all", async () => {
    const request = await firstRequest(
      { provider: "custom", model: "mixtral", apiUrl: "https://llm.internal/v1" },
      chatCompletion({ role: "assistant", content: "pong" }),
    );

    expect(Object.keys(request.headers)).not.toContain("authorization");
  });
});

// ─── the vendor packages' own environment fallbacks stay unread ─────────────

describe("no environment variable outside the existing set reaches the wire", () => {
  test("an ambient OPENAI_API_KEY and OPENAI_BASE_URL are both ignored", async () => {
    setVendorSentinels();

    const request = await firstRequest(OPENAI_CONFIG, responsesCompletion("pong"));

    expect(request.url).toBe("https://api.openai.com/v1/responses");
    expect(request.headers.authorization).toBe("Bearer sk-configured");
    expect(JSON.stringify(request)).not.toContain(SENTINEL);
  });

  test("an ambient GOOGLE_GENERATIVE_AI_API_KEY is ignored", async () => {
    setVendorSentinels();
    process.env.LLM_API_KEY = "gemini-key";

    const request = await firstRequest({}, geminiCompletion("pong"));

    expect(request.headers["x-goog-api-key"]).toBe("gemini-key");
    expect(JSON.stringify(request)).not.toContain(SENTINEL);
  });

  test("a keyless Ollama endpoint does not pick up an ambient OPENAI_API_KEY", async () => {
    setVendorSentinels();

    const request = await firstRequest(
      { provider: "ollama", model: "llama3.2" },
      chatCompletion({ role: "assistant", content: "pong" }),
    );

    expect(request.headers.authorization).toBe("Bearer ollama");
    expect(JSON.stringify(request)).not.toContain(SENTINEL);
  });

  test("a keyless custom endpoint does not pick up an ambient OPENAI_API_KEY", async () => {
    setVendorSentinels();

    const request = await firstRequest(
      { provider: "custom", model: "mixtral", apiUrl: "https://llm.internal/v1" },
      chatCompletion({ role: "assistant", content: "pong" }),
    );

    expect(JSON.stringify(request)).not.toContain(SENTINEL);
  });

  const KINDS: readonly { label: string; config: Partial<LLMConfig> }[] = [
    { label: "gemini", config: { provider: "gemini", apiKey: "gemini-key", model: "gemini-2.5-flash" } },
    { label: "openai", config: OPENAI_CONFIG },
    { label: "keyless ollama", config: { provider: "ollama", model: "llama3.2" } },
    { label: "custom", config: { provider: "custom", model: "mixtral", apiUrl: "https://llm.internal/v1" } },
  ];

  for (const { label, config } of KINDS) {
    test(`building and calling the ${label} kind reads no key outside the existing set`, async () => {
      setVendorSentinels();
      const response =
        config.provider === "gemini"
          ? geminiCompletion("pong")
          : config.provider === "openai"
            ? responsesCompletion("pong")
            : chatCompletion({ content: "pong" });

      const read = await recordEnvReads(() => firstRequest(config, response));

      // NODE_ENV is the SDK's only other read and is not a settings surface.
      const allowed = new Set<string>([...LLM_ENV_KEYS, "NODE_ENV"]);
      expect([...read].filter((key) => !allowed.has(key)).sort()).toEqual([]);
    });
  }
});

// ─── invalid configuration is refused by the existing validation ────────────

describe("createAgentModel refuses a configuration the chat surface would also refuse", () => {
  test("OpenAI without an API key", async () => {
    await expect(createAgentModel({ config: { provider: "openai" } })).rejects.toBeInstanceOf(LLMConfigError);
  });

  test("Gemini without an API key", async () => {
    await expect(createAgentModel({ config: { provider: "gemini" } })).rejects.toBeInstanceOf(LLMConfigError);
  });

  test("a custom endpoint without a URL", async () => {
    await expect(createAgentModel({ config: { provider: "custom", apiKey: "k" } })).rejects.toBeInstanceOf(
      LLMConfigError,
    );
  });

  test("a provider kind the settings surface does not know", async () => {
    const config = { provider: "claude" } as unknown as Partial<LLMConfig>;
    await expect(createAgentModel({ config })).rejects.toBeInstanceOf(LLMConfigError);
  });

  test("a base URL the SDK itself rejects surfaces as a configuration error, not a raw SDK error", async () => {
    const config: Partial<LLMConfig> = { provider: "custom", model: "m", apiUrl: "   " };
    await expect(createAgentModel({ config })).rejects.toBeInstanceOf(LLMConfigError);
  });

  test("a failure while the SDK prepares the effort check is a configuration error, not a raw SDK error", async () => {
    // Unreachable with the options built here today; stubbed so the @throws contract covers the
    // effort check as it covers the provider's construction.
    const prepare = spyOn(providerRegistry, "openAIResponsesRequestWarnings").mockRejectedValue(
      new TypeError("prepareRequest broke"),
    );
    try {
      const failure = createAgentModel({ config: { ...OPENAI_CONFIG, model: "gpt-6-luna", modelEffort: "low" } });

      await expect(failure).rejects.toBeInstanceOf(LLMConfigError);
      await expect(failure).rejects.toThrow("Cannot build the openai model: prepareRequest broke");
    } finally {
      prepare.mockRestore();
    }
  });
});

// ─── real behaviour through the SDK ─────────────────────────────────────────

describe("the adapted model drives the SDK's agentic loop", () => {
  test("completes a tool-call round trip: the model asks, the tool answers, the model continues", async () => {
    const executed: string[] = [];
    const recording = recordingFetch(
      chatCompletion(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "rowCount", arguments: JSON.stringify({ table: "users" }) },
            },
          ],
        },
        "tool_calls",
      ),
      chatCompletion({ role: "assistant", content: "users holds 42 rows" }),
    );

    const { model } = await createAgentModel({ config: CHAT_CONFIG, fetch: recording.fetch });
    const result = await generateText({
      model,
      prompt: "how many rows does users hold?",
      maxRetries: 0,
      stopWhen: stepCountIs(3),
      tools: {
        rowCount: tool({
          description: "row count for one table",
          inputSchema: z.object({ table: z.string() }),
          execute: async ({ table }) => {
            executed.push(table);
            return { rows: 42 };
          },
        }),
      },
    });

    expect(executed).toEqual(["users"]);
    expect(result.text).toBe("users holds 42 rows");
    expect(recording.requests).toHaveLength(2);
    // The second call carries the tool's answer back to the model.
    expect(JSON.stringify(recording.requests[1]?.body)).toContain("call_1");
    expect(JSON.stringify(recording.requests[1]?.body)).toContain("42");
  });

  test("streams a text response", async () => {
    const recording = recordingFetch(chatCompletionStream("Hello", " world"));
    const { model } = await createAgentModel({ config: CHAT_CONFIG, fetch: recording.fetch });

    const chunks: string[] = [];
    const stream = streamText({ model, prompt: "greet", maxRetries: 0 });
    for await (const chunk of stream.textStream) chunks.push(chunk);

    expect(chunks.join("")).toBe("Hello world");
    expect(recording.requests[0]?.body.stream).toBe(true);
  });
});

// ─── SDK failures map onto the existing error classes ───────────────────────

/** Drives one failing call and hands back whatever the SDK threw. */
async function sdkFailure(response: Response): Promise<unknown> {
  const recording = recordingFetch(response);
  const { model } = await createAgentModel({ config: CHAT_CONFIG, fetch: recording.fetch });
  try {
    await generateText({ model, prompt: "ping", maxRetries: 0 });
  } catch (error) {
    return error;
  }
  throw new Error("expected the SDK call to fail");
}

describe("mapAgentModelError maps SDK failures onto src/lib/llm's error classes", () => {
  test.each([401, 403])("HTTP %i becomes an auth error", async (status) => {
    const mapped = mapAgentModelError(
      await sdkFailure(jsonResponse({ error: { message: "bad key" } }, status)),
      "openai",
    );

    expect(mapped).toBeInstanceOf(LLMAuthError);
    expect(mapped.provider).toBe("openai");
  });

  test("HTTP 429 becomes a rate-limit error", async () => {
    const mapped = mapAgentModelError(
      await sdkFailure(jsonResponse({ error: { message: "slow down" } }, 429)),
      "gemini",
    );

    expect(mapped).toBeInstanceOf(LLMRateLimitError);
    expect(mapped.provider).toBe("gemini");
  });

  test("any other HTTP failure becomes a stream error", async () => {
    const mapped = mapAgentModelError(await sdkFailure(jsonResponse({ error: { message: "boom" } }, 500)), "openai");

    expect(mapped).toBeInstanceOf(LLMStreamError);
    expect(mapped).not.toBeInstanceOf(LLMRateLimitError);
  });

  test("a malformed response body becomes a stream error rather than escaping raw", async () => {
    const malformed = new Response("<html>not json</html>", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const mapped = mapAgentModelError(await sdkFailure(malformed), "custom");

    expect(mapped).toBeInstanceOf(LLMStreamError);
    expect(mapped.provider).toBe("custom");
  });

  test("a missing-key failure from the SDK becomes a configuration error", () => {
    const mapped = mapAgentModelError(new LoadAPIKeyError({ message: "key missing" }), "openai");

    expect(mapped).toBeInstanceOf(LLMConfigError);
    expect(mapped.message).toContain("key missing");
  });

  test("an error that is already one of ours passes through untouched", () => {
    const original = new LLMRateLimitError("already mapped", "ollama");

    expect(mapAgentModelError(original, "openai")).toBe(original);
  });

  test("an unrecognised Error keeps its message as a stream error", () => {
    const mapped = mapAgentModelError(new Error("socket hang up"), "ollama");

    expect(mapped).toBeInstanceOf(LLMStreamError);
    expect(mapped.message).toBe("socket hang up");
    expect(mapped.provider).toBe("ollama");
  });

  test("a thrown non-Error value is stringified rather than dropped", () => {
    const mapped = mapAgentModelError("kernel panic", "custom");

    expect(mapped).toBeInstanceOf(LLMStreamError);
    expect(mapped.message).toBe("kernel panic");
  });

  test("a body that breaks mid-stream keeps the transport's own words", async () => {
    // The SDK wraps a failed body read in a generic "Failed to process successful response"
    // and keeps the socket's message only on `cause`; without it the user is told nothing.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(await chatCompletionStream("partial").text()));
        controller.error(new Error("socket reset mid-stream"));
      },
    });
    const broken = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    const { model } = await createAgentModel({ config: CHAT_CONFIG, fetch: recordingFetch(broken).fetch });

    let failure: unknown;
    const stream = streamText({ model, prompt: "ping", maxRetries: 0, onError: () => {} });
    for await (const part of stream.fullStream) if (part.type === "error") failure ??= part.error;
    const mapped = mapAgentModelError(failure, "ollama");

    expect(mapped).toBeInstanceOf(LLMStreamError);
    expect(mapped.message).toContain("socket reset mid-stream");
  });

  test("a cause the message already quotes is not repeated", async () => {
    const recording: AgentFetch = async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:11434") });
    };
    const { model } = await createAgentModel({ config: CHAT_CONFIG, fetch: recording });

    let failure: unknown;
    try {
      await generateText({ model, prompt: "ping", maxRetries: 0 });
    } catch (error) {
      failure = error;
    }
    const mapped = mapAgentModelError(failure, "ollama");

    expect(mapped.message).toBe("Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434");
  });

  test("a cause the SDK itself raised is not appended, since it can quote the response body", async () => {
    const malformed = new Response("<html>not json</html>", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const mapped = mapAgentModelError(await sdkFailure(malformed), "custom");

    expect(mapped.message).not.toContain("not json");
  });

  test("every mapped failure is an LLMError, so callers need one catch shape", async () => {
    const mapped = mapAgentModelError(await sdkFailure(jsonResponse({}, 503)), "openai");

    expect(mapped).toBeInstanceOf(LLMError);
  });
});

// ─── the openai kind speaks the Responses API, statelessly ──────────────────

/** Builds the kind from `config` and sends one prompt with the options every agent call sends. */
async function agentRequest(config: Partial<LLMConfig>, response: Response, quiet = false): Promise<CapturedRequest> {
  const recording = recordingFetch(response);
  const agentModel = await createAgentModel({ config, fetch: recording.fetch });
  await generateText({
    model: agentModel.model,
    prompt: "ping",
    maxRetries: 0,
    providerOptions: agentProviderOptions(agentModel, quiet),
  });
  const request = recording.requests[0];
  if (!request) throw new Error("the adapter's model made no request");
  return request;
}

describe("the openai kind calls the Responses API with store: false", () => {
  const LUNA: Partial<LLMConfig> = { provider: "openai", apiKey: "sk-configured", model: "gpt-6-luna" };

  test("posts to {baseURL}/responses, asks OpenAI to keep nothing, and sends no effort when none is set", async () => {
    const request = await agentRequest(LUNA, responsesCompletion("pong"));

    expect(request.url).toBe("https://api.openai.com/v1/responses");
    expect(request.body.store).toBe(false);
    expect(Object.keys(request.body)).not.toContain("reasoning");
    // Asked for by the SDK itself once store is false on a reasoning model; pinned so an upgrade
    // that stopped asking would fail here instead of breaking the replay of the next turn.
    expect(request.body.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("sends LLM_MODEL_EFFORT as reasoning.effort, and no reasoning summary", async () => {
    const request = await agentRequest({ ...LUNA, modelEffort: "low" }, responsesCompletion("pong"));

    // No `summary`: the SDK asks for a detailed one whenever an effort is set, nothing in a run
    // reads it, and OpenAI may require organization verification before it serves one.
    expect(request.body.reasoning).toEqual({ effort: "low" });
  });

  test("an explicit effort wins over a profile's quiet switch", async () => {
    const request = await agentRequest({ ...LUNA, modelEffort: "high" }, responsesCompletion("pong"), true);

    expect(request.body.reasoning).toEqual({ effort: "high" });
  });

  test("with no explicit effort the profile's quiet switch still applies", async () => {
    const request = await agentRequest(LUNA, responsesCompletion("pong"), true);

    expect(request.body.reasoning).toEqual({ effort: "none" });
  });

  test("a non-reasoning model is sent store: false and nothing about reasoning", async () => {
    const request = await agentRequest(OPENAI_CONFIG, responsesCompletion("pong"));

    expect(request.body.store).toBe(false);
    expect(Object.keys(request.body)).not.toContain("reasoning");
    expect(Object.keys(request.body)).not.toContain("include");
  });

  test("the model reports the openai kind on the Responses API", async () => {
    const agentModel = await createAgentModel({ config: LUNA, fetch: recordingFetch().fetch });

    expect(agentModel.model.provider).toBe("openai.responses");
    expect(agentModel.effort).toBeUndefined();
    expect((await createAgentModel({ config: { ...LUNA, modelEffort: "max" } })).effort).toBe("max");
  });

  test("the encrypted reasoning item of one turn is replayed in the next, so a tool loop keeps its thinking", async () => {
    const recording = recordingFetch(
      responsesTurn(
        { id: "rs_1", encrypted: "ENCRYPTED-REASONING-1" },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "rowCount",
          arguments: JSON.stringify({ table: "users" }),
          status: "completed",
        },
      ),
      responsesCompletion("users holds 42 rows"),
    );
    const agentModel = await createAgentModel({ config: LUNA, fetch: recording.fetch });

    const result = await generateText({
      model: agentModel.model,
      prompt: "how many rows does users hold?",
      maxRetries: 0,
      stopWhen: stepCountIs(3),
      providerOptions: agentProviderOptions(agentModel),
      tools: {
        rowCount: tool({
          description: "row count for one table",
          inputSchema: z.object({ table: z.string() }),
          execute: async () => ({ rows: 42 }),
        }),
      },
    });

    expect(result.text).toBe("users holds 42 rows");
    const second = recording.requests[1]?.body;
    expect(second?.store).toBe(false);
    expect(second?.input).toContainEqual(
      expect.objectContaining({ type: "reasoning", id: "rs_1", encrypted_content: "ENCRYPTED-REASONING-1" }),
    );
  });
});

describe("the workflow classifier sends a run's options too", () => {
  test("its one call is a stateless Responses request at the configured effort", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_API_KEY = "sk-configured";
    process.env.LLM_MODEL = "gpt-6-luna";
    process.env.LLM_MODEL_EFFORT = "low";
    const recording = recordingFetch(responsesCompletion("operations"));

    const classification = await classifyAgentWorkflow("vacuum the orders table", { fetch: recording.fetch });

    expect(classification).toEqual({ workflowType: "operations", outcome: "classified" });
    expect(recording.requests[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(recording.requests[0]?.body.store).toBe(false);
    expect(recording.requests[0]?.body.reasoning).toEqual({ effort: "low" });
    // The Responses API counts reasoning against this cap, so the field on the wire is the fix.
    expect(recording.requests[0]?.body.max_output_tokens).toBe(1024);
  });

  test("an effort the model refuses leaves the run unclassified, and no request goes out", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_API_KEY = "sk-configured";
    process.env.LLM_MODEL = "gpt-6.1-sol";
    process.env.LLM_MODEL_EFFORT = "none";
    const recording = recordingFetch(responsesCompletion("operations"));
    const warn = spyOn(logger, "warn");

    try {
      const classification = await classifyAgentWorkflow("vacuum the orders table", { fetch: recording.fetch });

      expect(classification).toEqual({ workflowType: "investigation", outcome: "unclassified" });
      // Why it fell back: the model was refused when it was built, so there was nothing to ask.
      // The start that follows answers the same configuration error with its sentence, and the
      // log says the effort was refused rather than that no model is configured.
      expect(recording.requests).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        "The configured LLM_MODEL_EFFORT was refused for the model, so the objective was not classified; the run opens as an unclassified investigation",
        { route: "agent/workflow-classifier", error: "LLMConfigError" },
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("ollama and custom stay on Chat Completions, with the options they had", () => {
  const CASES: readonly { label: string; config: Partial<LLMConfig>; url: string }[] = [
    { label: "ollama", config: { provider: "ollama", model: "qwen3:8b" }, url: "http://localhost:11434/v1" },
    { label: "custom", config: CHAT_CONFIG, url: "https://llm.internal/v1" },
  ];

  for (const { label, config, url } of CASES) {
    test(`${label} posts to /chat/completions with no store and no effort`, async () => {
      const request = await agentRequest(config, chatCompletion({ role: "assistant", content: "pong" }));

      expect(request.url).toBe(`${url}/chat/completions`);
      expect(Object.keys(request.body).sort()).toEqual(["messages", "model"]);
    });

    test(`${label} still sends a profile's quiet switch as reasoning_effort`, async () => {
      const request = await agentRequest(config, chatCompletion({ role: "assistant", content: "pong" }), true);

      expect(request.body.reasoning_effort).toBe("none");
      expect(Object.keys(request.body)).not.toContain("store");
    });
  }

  test("gemini is sent no OpenAI options it could misread", () => {
    expect(agentProviderOptions({ provider: "gemini" })).toBeUndefined();
  });
});

describe("a reasoning effort the SDK drops is raised, not sent at another effort", () => {
  const SOL: Partial<LLMConfig> = { provider: "openai", apiKey: "sk", model: "gpt-6.1-sol" };

  /**
   * The model as a turn holds it once the build check is behind it. `createAgentModel` refuses
   * these configurations itself (below), so the defence a turn keeps for anything that slips
   * past it is exercised on a model built without the effort and handed it afterwards.
   */
  async function builtPastTheCheck(
    config: Partial<LLMConfig>,
    effort: LLMModelEffort,
    fetchImpl: AgentFetch,
  ): Promise<AgentModel> {
    return { ...(await createAgentModel({ config, fetch: fetchImpl })), effort };
  }

  test("the SDK's own refusal names the effort, the model and the efforts it takes", async () => {
    const recording = recordingFetch(responsesCompletion("pong"));
    const agentModel = await builtPastTheCheck(SOL, "none", recording.fetch);
    const result = await generateText({
      model: agentModel.model,
      prompt: "ping",
      maxRetries: 0,
      providerOptions: agentProviderOptions(agentModel),
    });

    // The request went out without the effort, which is exactly what must not pass in silence.
    expect(Object.keys(recording.requests[0]?.body ?? {})).not.toContain("reasoning");
    const error = refusedEffortError(result.warnings, agentModel);
    expect(error).toBeInstanceOf(LLMConfigError);
    expect(error?.provider).toBe("openai");
    expect(error?.message).toBe(
      'LLM_MODEL_EFFORT "none" was refused for the model "gpt-6.1-sol" (openai): gpt-6.1-sol only supports the following reasoning efforts: low, medium, high, xhigh, max. Change LLM_MODEL_EFFORT or unset it.',
    );
  });

  test("a non-reasoning model refuses any effort the same way", async () => {
    const recording = recordingFetch(responsesCompletion("pong"));
    const agentModel = await builtPastTheCheck(OPENAI_CONFIG, "low", recording.fetch);
    const result = await generateText({
      model: agentModel.model,
      prompt: "ping",
      maxRetries: 0,
      providerOptions: agentProviderOptions(agentModel),
    });

    expect(refusedEffortError(result.warnings, agentModel)?.message).toContain(
      "reasoningEffort is not supported for non-reasoning models",
    );
  });

  test("a profile's quiet switch that is dropped is named as the profile's, not as LLM_MODEL_EFFORT", () => {
    const agentModel: AgentModel = { provider: "openai", modelId: "gpt-4o", model: {} as AgentModel["model"] };
    const error = refusedEffortError([{ type: "unsupported", feature: "reasoningEffort" }], agentModel);

    expect(error?.message).toBe(
      'The reasoning effort this model\'s profile asks for was refused for the model "gpt-4o" (openai).',
    );
  });

  test("other warnings are not errors", () => {
    const agentModel: AgentModel = { provider: "openai", modelId: "gpt-4o", model: {} as AgentModel["model"] };

    expect(refusedEffortError(undefined, agentModel)).toBeUndefined();
    expect(refusedEffortError([{ type: "unsupported", feature: "temperature" }], agentModel)).toBeUndefined();
    expect(refusedEffortError([{ type: "other", message: "reasoningEffort" }], agentModel)).toBeUndefined();
  });
});

describe("an effort the model refuses is refused when the model is built, before any request", () => {
  const SOL_MODEL: Partial<LLMConfig> = { provider: "openai", apiKey: "sk", model: "gpt-6.1-sol" };
  const SOL: Partial<LLMConfig> = { ...SOL_MODEL, modelEffort: "none" };

  /** Builds `config` over a transport that records and answers nothing. */
  async function buildFailure(config: Partial<LLMConfig>): Promise<{ error: unknown; requests: CapturedRequest[] }> {
    const recording = recordingFetch();
    try {
      await createAgentModel({ config, fetch: recording.fetch });
    } catch (error) {
      return { error, requests: recording.requests };
    }
    throw new Error("expected the build to refuse the configured effort");
  }

  test("GPT-6.1 Sol with LLM_MODEL_EFFORT=none is a configuration error, and nothing is sent", async () => {
    const { error, requests } = await buildFailure(SOL);

    expect(error).toBeInstanceOf(LLMConfigError);
    expect((error as LLMConfigError).provider).toBe("openai");
    expect((error as LLMConfigError).reason).toBe("effort_refused");
    expect((error as LLMConfigError).message).toBe(
      'LLM_MODEL_EFFORT "none" was refused for the model "gpt-6.1-sol" (openai): gpt-6.1-sol only supports the following reasoning efforts: low, medium, high, xhigh, max. Change LLM_MODEL_EFFORT or unset it.',
    );
    // The point of refusing here: no paid request at an effort nobody configured.
    expect(requests).toHaveLength(0);
  });

  test("the build check and a real request read the SDK's one table, so they say the same sentence", async () => {
    // The check prepares the request the SDK would send and reads its warnings; a turn reads the
    // warnings of the request it did send. Two readings of one table, pinned to agree.
    const recording = recordingFetch(responsesCompletion("pong"));
    const built = await createAgentModel({ config: SOL_MODEL, fetch: recording.fetch });
    const agentModel: AgentModel = { ...built, effort: "none" };
    const result = await generateText({
      model: agentModel.model,
      prompt: "ping",
      maxRetries: 0,
      providerOptions: agentProviderOptions(agentModel),
    });

    expect(refusedEffortError(result.warnings, agentModel)?.message).toBe(
      ((await buildFailure(SOL)).error as Error).message,
    );
  });

  test("a non-reasoning model is refused any effort at build time too", async () => {
    const { error, requests } = await buildFailure({ ...OPENAI_CONFIG, modelEffort: "low" });

    expect((error as LLMConfigError).reason).toBe("effort_refused");
    expect((error as Error).message).toContain("reasoningEffort is not supported for non-reasoning models");
    expect(requests).toHaveLength(0);
  });

  test.each([
    ["gpt-6-luna", "none"],
    ["gpt-6.1-sol", "low"],
    // The SDK has no effort table for GPT-5.x and passes any effort through; measured on
    // 2026-10-19, gpt-5.4-mini takes "none" on the Responses API.
    ["gpt-5.4-mini", "none"],
  ] as const)("%s takes %s, and building it sends nothing", async (model, modelEffort) => {
    const recording = recordingFetch();

    const agentModel = await createAgentModel({
      config: { provider: "openai", apiKey: "sk", model, modelEffort },
      fetch: recording.fetch,
    });

    expect(agentModel.effort).toBe(modelEffort);
    expect(recording.requests).toHaveLength(0);
  });

  test("a model outside the SDK's table is built at an effort OpenAI refuses, so the refusal is OpenAI's", async () => {
    // The limit docs/llms/setup.md and .env.example state. Measured on 2026-10-19: gpt-5.4-mini
    // answers "minimal" with a 400 naming the efforts it takes, which the build cannot know.
    const recording = recordingFetch();

    const agentModel = await createAgentModel({
      config: { provider: "openai", apiKey: "sk", model: "gpt-5.4-mini", modelEffort: "minimal" },
      fetch: recording.fetch,
    });

    expect(agentModel.effort).toBe("minimal");
    expect(recording.requests).toHaveLength(0);
  });
});

// ─── sampling is filtered only for the openai kind ─────────────────────────

describe("agentSamplingFor keeps only the sampling the openai kind's SDK would send", () => {
  const SAMPLING = { temperature: 0, topP: 1 };
  const LUNA = { provider: "openai", modelId: "gpt-6-luna" } as const;

  test("an openai reasoning model with no effort drops both", async () => {
    await expect(agentSamplingFor(LUNA, agentProviderOptions(LUNA), SAMPLING)).resolves.toEqual({});
  });

  test("an openai reasoning model at a non-none effort drops both", async () => {
    const model = { provider: "openai", modelId: "gpt-6-luna", effort: "low" } as const;

    await expect(agentSamplingFor(model, agentProviderOptions(model), SAMPLING)).resolves.toEqual({});
  });

  test("gpt-6-luna at effort none keeps both", async () => {
    const model = { provider: "openai", modelId: "gpt-6-luna", effort: "none" } as const;

    await expect(agentSamplingFor(model, agentProviderOptions(model), SAMPLING)).resolves.toEqual(SAMPLING);
  });

  test("the quiet switch, which sends effort none, keeps sampling on gpt-6-luna", async () => {
    await expect(agentSamplingFor(LUNA, agentProviderOptions(LUNA, true), SAMPLING)).resolves.toEqual(SAMPLING);
  });

  test("gpt-6-sol at effort none keeps both", async () => {
    const model = { provider: "openai", modelId: "gpt-6-sol", effort: "none" } as const;

    await expect(agentSamplingFor(model, agentProviderOptions(model), SAMPLING)).resolves.toEqual(SAMPLING);
  });

  test("gpt-6.1-sol at effort none drops both, because only gpt-6-sol and gpt-6-luna keep them", async () => {
    const model = { provider: "openai", modelId: "gpt-6.1-sol", effort: "none" } as const;

    await expect(agentSamplingFor(model, agentProviderOptions(model), SAMPLING)).resolves.toEqual({});
  });

  test("gpt-5.4-mini at effort none keeps both", async () => {
    const model = { provider: "openai", modelId: "gpt-5.4-mini", effort: "none" } as const;

    await expect(agentSamplingFor(model, agentProviderOptions(model), SAMPLING)).resolves.toEqual(SAMPLING);
  });

  test("gpt-5 at effort none drops both, because its minor version is absent", async () => {
    const model = { provider: "openai", modelId: "gpt-5", effort: "none" } as const;

    await expect(agentSamplingFor(model, agentProviderOptions(model), SAMPLING)).resolves.toEqual({});
  });

  test("an o-series model drops both at effort none", async () => {
    const model = { provider: "openai", modelId: "o3", effort: "none" } as const;

    await expect(agentSamplingFor(model, agentProviderOptions(model), SAMPLING)).resolves.toEqual({});
  });

  test("a non-reasoning model keeps sampling untouched", async () => {
    const model = { provider: "openai", modelId: "gpt-4o-mini" } as const;

    await expect(agentSamplingFor(model, agentProviderOptions(model), SAMPLING)).resolves.toEqual(SAMPLING);
  });

  test("a gpt-5 chat variant keeps sampling untouched", async () => {
    const model = { provider: "openai", modelId: "gpt-5-chat-latest" } as const;

    await expect(agentSamplingFor(model, agentProviderOptions(model), SAMPLING)).resolves.toEqual(SAMPLING);
  });

  test("a partial sampling drops only the field that is present", async () => {
    await expect(agentSamplingFor(LUNA, agentProviderOptions(LUNA), { temperature: 0 })).resolves.toEqual({});
  });

  test("a partial sampling with only topP drops only topP", async () => {
    await expect(agentSamplingFor(LUNA, agentProviderOptions(LUNA), { topP: 1 })).resolves.toEqual({});
  });

  test("an o4-mini model drops both at any effort", async () => {
    for (const effort of ["none", "low"] as const) {
      const model = { provider: "openai", modelId: "o4-mini", effort } as const;
      await expect(agentSamplingFor(model, agentProviderOptions(model), SAMPLING)).resolves.toEqual({});
    }
  });

  test("gpt-5.4-mini at a non-none effort drops both", async () => {
    const model = { provider: "openai", modelId: "gpt-5.4-mini", effort: "minimal" } as const;
    await expect(agentSamplingFor(model, agentProviderOptions(model), SAMPLING)).resolves.toEqual({});
  });

  // Future gpt-5.x names are not copied into any table here: the SDK is asked, so each keeps
  // sampling at `none` (minor >= 1) and drops it at the model's default effort.
  for (const modelId of ["gpt-5.1", "gpt-5.2-pro", "gpt-5.4-nano", "gpt-5.6-luna"] as const) {
    test(`${modelId} drops both without effort and keeps both at none`, async () => {
      const noEffort = { provider: "openai", modelId } as const;
      const atNone = { provider: "openai", modelId, effort: "none" } as const;
      await expect(agentSamplingFor(noEffort, agentProviderOptions(noEffort), SAMPLING)).resolves.toEqual({});
      await expect(agentSamplingFor(atNone, agentProviderOptions(atNone), SAMPLING)).resolves.toEqual(SAMPLING);
    });
  }

  test("an ollama or custom endpoint named like a reasoning model is never asked", async () => {
    const prepare = spyOn(providerRegistry, "openAIResponsesRequestWarnings");
    try {
      for (const model of [
        { provider: "ollama", modelId: "gpt-6-luna" },
        { provider: "custom", modelId: "gpt-6-luna" },
      ] as const) {
        await expect(
          agentSamplingFor(model, agentProviderOptions({ provider: model.provider }), SAMPLING),
        ).resolves.toEqual(SAMPLING);
      }
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  });

  test("an empty sampling is returned without asking the SDK", async () => {
    // A model id no other test resolves, so this test owns the cache entry: the early return for
    // empty sampling is what keeps `prepareRequest` uncalled, not a memoized answer from an
    // earlier test.
    const model = { provider: "openai", modelId: "gpt-6-luna-empty-sampling" } as const;
    const prepare = spyOn(providerRegistry, "openAIResponsesRequestWarnings");
    try {
      await expect(agentSamplingFor(model, agentProviderOptions(model), {})).resolves.toEqual({});
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  });

  for (const [label, model] of [
    ["ollama", { provider: "ollama", modelId: "qwen3:8b" }],
    ["custom", { provider: "custom", modelId: "mixtral" }],
    ["gemini", { provider: "gemini", modelId: "gemini-2.5-flash" }],
  ] as const) {
    test(`${label} keeps sampling untouched and never asks the SDK`, async () => {
      const prepare = spyOn(providerRegistry, "openAIResponsesRequestWarnings");
      try {
        await expect(
          agentSamplingFor(model, agentProviderOptions({ provider: model.provider }), SAMPLING),
        ).resolves.toEqual(SAMPLING);
        expect(prepare).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
      }
    });
  }

  test("the SDK is asked once per model and effort, then the answer is reused", async () => {
    // A model id no other test resolves, so this test owns the cache entry for it.
    const model = { provider: "openai", modelId: "gpt-6-terra" } as const;
    const prepare = spyOn(providerRegistry, "openAIResponsesRequestWarnings");
    try {
      await agentSamplingFor(model, agentProviderOptions(model), SAMPLING);
      await agentSamplingFor(model, agentProviderOptions(model), SAMPLING);

      expect(prepare).toHaveBeenCalledTimes(1);
    } finally {
      prepare.mockRestore();
    }
  });

  test("a preparation failure is raised and not cached, so the next turn retries", async () => {
    const model = { provider: "openai", modelId: "gpt-6-luna-retry-test" } as const;
    const prepare = spyOn(providerRegistry, "openAIResponsesRequestWarnings").mockRejectedValue(
      new TypeError("prepareRequest broke"),
    );
    try {
      await expect(agentSamplingFor(model, agentProviderOptions(model), SAMPLING)).rejects.toThrow(
        "prepareRequest broke",
      );
    } finally {
      prepare.mockRestore();
    }

    await expect(agentSamplingFor(model, agentProviderOptions(model), SAMPLING)).resolves.toEqual({});
  });
});

describe("the openai kind's wire sends no sampling the SDK would drop", () => {
  test("gpt-6-luna with the default sampling sends neither field and warns about neither", async () => {
    const config: Partial<LLMConfig> = { provider: "openai", apiKey: "sk-configured", model: "gpt-6-luna" };
    const recording = recordingFetch(responsesCompletion("pong"));
    const agentModel = await createAgentModel({ config, fetch: recording.fetch });
    const providerOptions = agentProviderOptions(agentModel);
    const sampling = await agentSamplingFor(agentModel, providerOptions, { temperature: 0, topP: 1 });

    const result = await generateText({
      model: agentModel.model,
      prompt: "ping",
      maxRetries: 0,
      ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
      ...(sampling.topP !== undefined ? { topP: sampling.topP } : {}),
      providerOptions,
    });

    expect(recording.requests[0]?.body).not.toHaveProperty("temperature");
    expect(recording.requests[0]?.body).not.toHaveProperty("top_p");
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ feature: "temperature" }));
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ feature: "topP" }));
  });

  test("gpt-6-luna at effort none keeps the default sampling on the wire", async () => {
    const config: Partial<LLMConfig> = {
      provider: "openai",
      apiKey: "sk-configured",
      model: "gpt-6-luna",
      modelEffort: "none",
    };
    const recording = recordingFetch(responsesCompletion("pong"));
    const agentModel = await createAgentModel({ config, fetch: recording.fetch });
    const providerOptions = agentProviderOptions(agentModel);
    const sampling = await agentSamplingFor(agentModel, providerOptions, { temperature: 0, topP: 1 });

    await generateText({
      model: agentModel.model,
      prompt: "ping",
      maxRetries: 0,
      ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
      ...(sampling.topP !== undefined ? { topP: sampling.topP } : {}),
      providerOptions,
    });

    expect(recording.requests[0]?.body.temperature).toBe(0);
    expect(recording.requests[0]?.body.top_p).toBe(1);
  });

  test("ollama and custom send the default sampling unchanged", async () => {
    for (const config of [{ provider: "ollama", model: "qwen3:8b" }, CHAT_CONFIG] as const) {
      const recording = recordingFetch(chatCompletion({ role: "assistant", content: "pong" }));
      const agentModel = await createAgentModel({ config, fetch: recording.fetch });
      const providerOptions = agentProviderOptions(agentModel);
      const sampling = await agentSamplingFor(agentModel, providerOptions, { temperature: 0, topP: 1 });

      await generateText({
        model: agentModel.model,
        prompt: "ping",
        maxRetries: 0,
        ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
        ...(sampling.topP !== undefined ? { topP: sampling.topP } : {}),
        providerOptions,
      });

      // Key order is the wire byte order: sampling still sits where the SDK always put it.
      expect(Object.keys(recording.requests[0]?.body ?? {})).toEqual(["model", "temperature", "top_p", "messages"]);
      expect(recording.requests[0]?.body.temperature).toBe(0);
      expect(recording.requests[0]?.body.top_p).toBe(1);
    }
  });

  // The openai-only gate is pinned at the unit level above ("an ollama or custom endpoint named
  // like a reasoning model is never asked"). What a self-hosted endpoint NAMED `gpt-6-luna`
  // actually receives is the SDK's own Chat Completions table, not this repository's decision:
  // the SDK recognises the name and drops the fields with a warning. That is not asserted here
  // because it is the SDK's behaviour, not the code under test.

  test("gemini sends the default sampling under its own field names", async () => {
    const config: Partial<LLMConfig> = { provider: "gemini", apiKey: "gemini-key", model: "gemini-2.5-flash" };
    const recording = recordingFetch(geminiCompletion("pong"));
    const agentModel = await createAgentModel({ config, fetch: recording.fetch });
    const providerOptions = agentProviderOptions(agentModel);
    const sampling = await agentSamplingFor(agentModel, providerOptions, { temperature: 0, topP: 1 });

    await generateText({
      model: agentModel.model,
      prompt: "ping",
      maxRetries: 0,
      ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
      ...(sampling.topP !== undefined ? { topP: sampling.topP } : {}),
      providerOptions,
    });

    const generationConfig = recording.requests[0]?.body.generationConfig as
      | { temperature?: number; topP?: number }
      | undefined;
    expect(generationConfig?.temperature).toBe(0);
    expect(generationConfig?.topP).toBe(1);
  });
});
