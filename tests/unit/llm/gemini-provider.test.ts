import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  LLMAuthError,
  LLMRateLimitError,
  LLMSafetyError,
  LLMStreamError,
  LLMConfigError,
  type LLMConfig,
  type LLMStreamOptions,
} from "@/lib/llm/types";

// ============================================================================
// Mock State
// ============================================================================

let mockGenerateContentStream: (prompt: string) => Promise<unknown>;
let capturedModelParams: Record<string, unknown> | undefined;
let capturedRequestOptions: Record<string, unknown> | undefined;
let capturedStreamRequestOptions: { signal?: AbortSignal } | undefined;

// ============================================================================
// Module Mocks (must be before await import)
// ============================================================================

mock.module("@google/generative-ai", () => ({
  GoogleGenerativeAI: function () {
    return {
      getGenerativeModel: function (modelParams: Record<string, unknown>, requestOptions?: Record<string, unknown>) {
        capturedModelParams = modelParams;
        capturedRequestOptions = requestOptions;
        return {
          generateContentStream: async (prompt: string, streamRequestOptions?: { signal?: AbortSignal }) => {
            capturedStreamRequestOptions = streamRequestOptions;
            return mockGenerateContentStream(prompt);
          },
        };
      },
    };
  },
}));

// ============================================================================
// Import module under test (after mocks)
// ============================================================================

const { GeminiProvider } = await import("@/lib/llm/providers/gemini");

// ============================================================================
// Helpers
// ============================================================================

async function* mockStreamChunks(texts: string[]) {
  for (const t of texts) {
    yield { text: () => t };
  }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value);
  }
  return result;
}

function makeConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    provider: "gemini",
    apiKey: "test-gemini-api-key",
    model: "gemini-2.0-flash",
    ...overrides,
  };
}

function makeStreamOptions(overrides?: Partial<LLMStreamOptions>): LLMStreamOptions {
  return {
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("GeminiProvider", () => {
  beforeEach(() => {
    capturedModelParams = undefined;
    capturedRequestOptions = undefined;
    mockGenerateContentStream = async () => ({
      stream: mockStreamChunks(["Hello", " World"]),
    });
  });

  // --------------------------------------------------------------------------
  // constructor
  // --------------------------------------------------------------------------

  describe("constructor", () => {
    test("creates instance with valid config", () => {
      const provider = new GeminiProvider(makeConfig());
      expect(provider.name).toBe("gemini");
      expect(provider.config.model).toBe("gemini-2.0-flash");
    });

    test("throws LLMConfigError without apiKey", () => {
      expect(() => new GeminiProvider(makeConfig({ apiKey: undefined }))).toThrow(LLMConfigError);
    });
  });

  // --------------------------------------------------------------------------
  // stream()
  // --------------------------------------------------------------------------

  describe("stream()", () => {
    test("returns ReadableStream on success", async () => {
      const provider = new GeminiProvider(makeConfig());
      const stream = await provider.stream(makeStreamOptions());

      expect(stream).toBeInstanceOf(ReadableStream);
      const text = await readStream(stream);
      expect(text).toBe("Hello World");
    });

    test("passes model from options", async () => {
      const provider = new GeminiProvider(makeConfig());
      const stream = await provider.stream(makeStreamOptions({ model: "gemini-pro" }));
      expect(stream).toBeInstanceOf(ReadableStream);
    });

    test("passes system instruction", async () => {
      const provider = new GeminiProvider(makeConfig());
      const stream = await provider.stream(
        makeStreamOptions({
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Hello" },
          ],
        }),
      );
      expect(stream).toBeInstanceOf(ReadableStream);
    });

    // B20: an operator behind an egress proxy or on a regional endpoint sets
    // LLM_API_URL and this SDK's RequestOptions.baseUrl is where it has to land.
    test("routes through config.apiUrl when one is configured", async () => {
      const provider = new GeminiProvider(makeConfig({ apiUrl: "https://proxy.example.com/v1beta" }));
      await provider.stream(makeStreamOptions());

      // The origin, not the versioned URL: this SDK appends the version itself.
      expect(capturedRequestOptions?.baseUrl).toBe("https://proxy.example.com");
    });

    test("leaves baseUrl unset when no apiUrl is configured, keeping the SDK's Google default", async () => {
      const provider = new GeminiProvider(makeConfig());
      await provider.stream(makeStreamOptions());

      expect(capturedRequestOptions?.baseUrl).toBeUndefined();
      expect(capturedModelParams?.model).toBe("gemini-2.0-flash");
    });

    test("handles empty stream", async () => {
      mockGenerateContentStream = async () => ({
        stream: mockStreamChunks([]),
      });

      const provider = new GeminiProvider(makeConfig());
      const stream = await provider.stream(makeStreamOptions());
      const text = await readStream(stream);
      expect(text).toBe("");
    });
  });

  // --------------------------------------------------------------------------
  // error mapping
  // --------------------------------------------------------------------------

  describe("error mapping", () => {
    test("api key error maps to LLMAuthError", async () => {
      mockGenerateContentStream = async () => {
        throw new Error("Invalid API key provided");
      };

      const provider = new GeminiProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(LLMAuthError);
    });

    test("unauthorized error maps to LLMAuthError", async () => {
      mockGenerateContentStream = async () => {
        throw new Error("Unauthorized access");
      };

      const provider = new GeminiProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(LLMAuthError);
    });

    test("quota error maps to LLMRateLimitError", async () => {
      mockGenerateContentStream = async () => {
        throw new Error("Quota exceeded for this project");
      };

      const provider = new GeminiProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(LLMRateLimitError);
    });

    test("rate limit error maps to LLMRateLimitError", async () => {
      mockGenerateContentStream = async () => {
        throw new Error("Rate limit reached");
      };

      const provider = new GeminiProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(LLMRateLimitError);
    });

    test("safety error maps to LLMSafetyError", async () => {
      mockGenerateContentStream = async () => {
        throw new Error("Content blocked by safety filters");
      };

      const provider = new GeminiProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(LLMSafetyError);
    });

    test("blocked error maps to LLMSafetyError", async () => {
      mockGenerateContentStream = async () => {
        throw new Error("Response was blocked");
      };

      const provider = new GeminiProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(LLMSafetyError);
    });

    test("generic error maps to LLMStreamError", async () => {
      mockGenerateContentStream = async () => {
        throw new Error("Something unexpected happened");
      };

      const provider = new GeminiProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(LLMStreamError);
    });

    test("non-Error value maps to LLMStreamError", async () => {
      mockGenerateContentStream = async () => {
        throw "string error value";
      };

      const provider = new GeminiProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(LLMStreamError);
    });
  });
});

// The SDK takes the signal per request, beside the prompt: a signal left out of that call bounds nothing,
// and the query safety route relies on it to stop a model that does not answer.
describe("GeminiProvider abort signal", () => {
  beforeEach(() => {
    capturedStreamRequestOptions = undefined;
    mockGenerateContentStream = async () => ({ stream: mockStreamChunks(["Hi"]) });
  });

  test("hands the caller's signal to the SDK request", async () => {
    const controller = new AbortController();
    await new GeminiProvider(makeConfig()).stream(makeStreamOptions({ signal: controller.signal }));
    expect(capturedStreamRequestOptions?.signal).toBe(controller.signal);
  });

  // The real SDK (0.24.1) only listens for the abort event, so a signal that already aborted does not stop
  // its request. This stand-in behaves the same: it ignores the signal and answers.
  test("a request whose signal already aborted is never sent, though the SDK would send it", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    mockGenerateContentStream = async () => {
      calls += 1;
      return { stream: mockStreamChunks(["sent anyway"]) };
    };
    await expect(
      new GeminiProvider(makeConfig()).stream(makeStreamOptions({ signal: controller.signal })),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("an abort during the retry backoff sends no second request", async () => {
    const controller = new AbortController();
    let calls = 0;
    mockGenerateContentStream = async () => {
      calls += 1;
      setTimeout(() => controller.abort(), 10);
      throw new Error("upstream connection reset");
    };
    const started = Date.now();
    await expect(
      new GeminiProvider(makeConfig()).stream(makeStreamOptions({ signal: controller.signal })),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(900);
  });
});
