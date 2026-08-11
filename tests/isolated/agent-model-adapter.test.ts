import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { generateText, streamText, stepCountIs, tool, LoadAPIKeyError } from "ai";
import { z } from "zod";
import { createAgentModel, mapAgentModelError } from "@/lib/agent/model-adapter";
import type { AgentFetch } from "@/lib/agent/provider-registry";
import {
  type LLMConfig,
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
 * This file lives in `tests/isolated/` — its own group in
 * `tests/run-components.sh` — because every `tests/api/ai/*.test.ts` replaces
 * `@/lib/llm/types` with stub error classes whose constructors take a message
 * only. `mock.module` is process-wide, so in a shared process the mapper's
 * provider tag silently vanishes while the class identity still matches, and
 * the assertions below would fail against perfectly correct code.
 */

// ─── environment isolation ──────────────────────────────────────────────────

/** The existing settings surface — the only variables the adapter may honour. */
const LLM_ENV_KEYS = ["LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL", "LLM_API_URL"] as const;

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

    const recording = recordingFetch(chatCompletion({ role: "assistant", content: "pong" }));
    const agentModel = await createAgentModel({ fetch: recording.fetch });
    await generateText({ model: agentModel.model, prompt: "ping", maxRetries: 0 });

    expect(agentModel.provider).toBe("openai");
    expect(agentModel.modelId).toBe("gpt-4.1-mini");
    expect(recording.requests[0]?.url).toBe("https://proxy.example.com/v1/chat/completions");
    expect(recording.requests[0]?.headers.authorization).toBe("Bearer sk-from-env");
    expect(recording.requests[0]?.body.model).toBe("gpt-4.1-mini");
  });

  test("explicit overrides win over the environment, exactly as createLLMProvider's do", async () => {
    process.env.LLM_PROVIDER = "gemini";
    process.env.LLM_API_KEY = "gemini-key";

    const request = await firstRequest(OPENAI_CONFIG, chatCompletion({ role: "assistant", content: "pong" }));

    expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
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

  test("Gemini ignores LLM_API_URL, exactly as the chat surface's provider does", async () => {
    // .env.example documents LLM_API_URL for the Ollama and custom kinds, and
    // src/lib/llm/providers/gemini.ts never reads it. Honouring it here would let
    // a value left over from a custom setup redirect a keyed Gemini request.
    process.env.LLM_API_KEY = "gemini-key";
    process.env.LLM_API_URL = "https://left-over-proxy.example.com/v1";

    const request = await firstRequest({}, geminiCompletion("pong"));

    expect(request.url).toStartWith("https://generativelanguage.googleapis.com/v1beta/");
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

    const request = await firstRequest(OPENAI_CONFIG, chatCompletion({ role: "assistant", content: "pong" }));

    expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
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
      const response = config.provider === "gemini" ? geminiCompletion("pong") : chatCompletion({ content: "pong" });

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

    const { model } = await createAgentModel({ config: OPENAI_CONFIG, fetch: recording.fetch });
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
    const { model } = await createAgentModel({ config: OPENAI_CONFIG, fetch: recording.fetch });

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
  const { model } = await createAgentModel({ config: OPENAI_CONFIG, fetch: recording.fetch });
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

  test("every mapped failure is an LLMError, so callers need one catch shape", async () => {
    const mapped = mapAgentModelError(await sdkFailure(jsonResponse({}, 503)), "openai");

    expect(mapped).toBeInstanceOf(LLMError);
  });
});
