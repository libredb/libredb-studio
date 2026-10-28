import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { LLMStreamError, LLMConfigError, type LLMConfig, type LLMStreamOptions } from "@/lib/llm/types";
import { NO_BACKOFF } from "../../helpers/llm-no-backoff";

// ============================================================================
// Import module under test (no mock.module needed — Ollama uses globalThis.fetch)
// ============================================================================

const { OllamaProvider } = await import("@/lib/llm/providers/ollama");

// ============================================================================
// Helpers
// ============================================================================

function makeSSEChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function createSSEResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function createJsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
    provider: "ollama",
    model: "llama3.2",
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

describe("OllamaProvider", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // constructor
  // --------------------------------------------------------------------------

  describe("constructor", () => {
    test("creates without apiKey (not required for Ollama)", () => {
      const provider = new OllamaProvider(makeConfig(), NO_BACKOFF);
      expect(provider.name).toBe("ollama");
      expect(provider.config.apiKey).toBeUndefined();
    });

    test("uses default Ollama URL (localhost:11434)", () => {
      const provider = new OllamaProvider(makeConfig(), NO_BACKOFF);
      // The default URL is set internally; config.apiUrl remains undefined
      expect(provider.config.apiUrl).toBeUndefined();
    });

    test("uses custom apiUrl", () => {
      const provider = new OllamaProvider(makeConfig({ apiUrl: "http://remote-ollama:11434/v1" }), NO_BACKOFF);
      expect(provider.config.apiUrl).toBe("http://remote-ollama:11434/v1");
    });
  });

  // --------------------------------------------------------------------------
  // validate()
  // --------------------------------------------------------------------------

  describe("validate()", () => {
    test("throws LLMConfigError without model", () => {
      // Ollama constructor does NOT call validate() automatically,
      // so we call it explicitly
      const provider = new OllamaProvider(makeConfig({ model: undefined as unknown as string }), NO_BACKOFF);
      expect(() => provider.validate()).toThrow(LLMConfigError);
    });

    test("throws LLMConfigError with empty model", () => {
      const provider = new OllamaProvider(makeConfig({ model: "" }), NO_BACKOFF);
      expect(() => provider.validate()).toThrow(LLMConfigError);
    });

    test("refuses LLM_MODEL_EFFORT, which only the openai provider sends", () => {
      // Refused in the constructor as well as here: nothing on the chat surface calls this
      // provider's validate(), so a check only here would leave the setting silently unsent.
      const config = makeConfig({ modelEffort: "low" });
      expect(() => new OllamaProvider(config, NO_BACKOFF)).toThrow(
        "LLM_MODEL_EFFORT applies to LLM_PROVIDER=openai only; unset it for the ollama provider.",
      );
      const built = new OllamaProvider(makeConfig(), NO_BACKOFF);
      Object.assign(built.config, { modelEffort: "low" });
      expect(() => built.validate()).toThrow(LLMConfigError);
    });
  });

  // --------------------------------------------------------------------------
  // stream()
  // --------------------------------------------------------------------------

  describe("stream()", () => {
    test("sends Bearer ollama auth header", async () => {
      const sseData = [makeSSEChunk("Hi"), "data: [DONE]\n\n"];
      fetchSpy.mockResolvedValueOnce(createSSEResponse(sseData));

      const provider = new OllamaProvider(makeConfig(), NO_BACKOFF);
      await provider.stream(makeStreamOptions());

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ollama");
    });

    test("returns parsed stream content", async () => {
      const sseData = [makeSSEChunk("Hello"), makeSSEChunk(" from"), makeSSEChunk(" Ollama"), "data: [DONE]\n\n"];
      fetchSpy.mockResolvedValueOnce(createSSEResponse(sseData));

      const provider = new OllamaProvider(makeConfig(), NO_BACKOFF);
      const stream = await provider.stream(makeStreamOptions());

      expect(stream).toBeInstanceOf(ReadableStream);
      const text = await readStream(stream);
      expect(text).toBe("Hello from Ollama");
    });

    test("passes model and messages", async () => {
      const sseData = [makeSSEChunk("ok"), "data: [DONE]\n\n"];
      fetchSpy.mockResolvedValueOnce(createSSEResponse(sseData));

      const provider = new OllamaProvider(makeConfig(), NO_BACKOFF);
      await provider.stream(
        makeStreamOptions({
          messages: [
            { role: "system", content: "Be concise" },
            { role: "user", content: "Hi" },
          ],
        }),
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(body.model).toBe("llama3.2");
      expect(body.messages).toHaveLength(2);
      expect(body.stream).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // validateResponse()
  // --------------------------------------------------------------------------

  describe("validateResponse()", () => {
    test("404 throws LLMConfigError with model pull message", async () => {
      fetchSpy.mockImplementation(async () => createJsonResponse({ error: { message: "model not found" } }, 404));

      const provider = new OllamaProvider(makeConfig(), NO_BACKOFF);
      try {
        await provider.stream(makeStreamOptions());
        expect(true).toBe(false); // should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(LLMConfigError);
        expect((err as Error).message).toContain("pulled");
      }
    });

    test("500 throws LLMStreamError", async () => {
      fetchSpy.mockImplementation(async () => createJsonResponse({ error: { message: "Internal error" } }, 500));

      const provider = new OllamaProvider(makeConfig(), NO_BACKOFF);
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(LLMStreamError);
    });

    test("a non-JSON error body falls back to the HTTP status", async () => {
      // A proxy in front of the endpoint answers with an HTML page, not the API's JSON error.
      fetchSpy.mockImplementation(async () => new Response("<html>Bad Gateway</html>", { status: 502 }));

      const provider = new OllamaProvider(makeConfig(), NO_BACKOFF);
      const error = await provider.stream(makeStreamOptions()).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(LLMStreamError);
      expect((error as Error).message).toBe("Ollama API error: HTTP 502");
    });
  });

  // --------------------------------------------------------------------------
  // error mapping
  // --------------------------------------------------------------------------

  describe("error mapping", () => {
    test("ECONNREFUSED maps to connection error", async () => {
      fetchSpy.mockImplementation(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      });

      const provider = new OllamaProvider(makeConfig(), NO_BACKOFF);
      try {
        await provider.stream(makeStreamOptions());
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(LLMStreamError);
        expect((err as Error).message).toContain("Cannot connect to Ollama");
      }
    });

    test("fetch failed maps to connection error", async () => {
      fetchSpy.mockImplementation(async () => {
        throw new TypeError("fetch failed");
      });

      const provider = new OllamaProvider(makeConfig(), NO_BACKOFF);
      try {
        await provider.stream(makeStreamOptions());
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(LLMStreamError);
        expect((err as Error).message).toContain("Cannot connect to Ollama");
      }
    });

    test("LLMConfigError passes through", async () => {
      fetchSpy.mockImplementation(async () => createJsonResponse({ error: { message: "not found" } }, 404));

      const provider = new OllamaProvider(makeConfig(), NO_BACKOFF);
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(LLMConfigError);
    });

    test("generic error maps to LLMStreamError", async () => {
      fetchSpy.mockImplementation(async () => {
        throw new Error("Unexpected error");
      });

      const provider = new OllamaProvider(makeConfig(), NO_BACKOFF);
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(LLMStreamError);
    });

    test("non-Error maps to LLMStreamError", async () => {
      fetchSpy.mockImplementation(async () => {
        throw "string error value";
      });

      const provider = new OllamaProvider(makeConfig(), NO_BACKOFF);
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(LLMStreamError);
    });
  });
});

// A caller that bounds its wait (the query safety route does) hands a signal in, and a signal that never
// reaches fetch bounds nothing: the request would keep the endpoint busy after the caller gave up.
describe("OllamaProvider abort signal", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("hands the caller's signal to fetch", async () => {
    fetchSpy.mockResolvedValueOnce(createSSEResponse([makeSSEChunk("Hi"), "data: [DONE]\n\n"]));
    const controller = new AbortController();
    await new OllamaProvider(makeConfig(), NO_BACKOFF).stream(makeStreamOptions({ signal: controller.signal }));
    expect((fetchSpy.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });

  test("a request whose signal already aborted is never sent", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new OllamaProvider(makeConfig(), NO_BACKOFF).stream(makeStreamOptions({ signal: controller.signal })),
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("an abort during the retry backoff sends no second request", async () => {
    // THE ONE CASE HERE THAT KEEPS THE REAL BACKOFF, because the backoff is what it asserts: the
    // abort has to land inside the wait, and `NO_BACKOFF` leaves no wait to land in. With a zero
    // delay the second attempt goes out before the 10 ms abort and `toHaveBeenCalledTimes(1)`
    // reads 3 (MEASURED - all four provider files failed exactly this case).
    const controller = new AbortController();
    fetchSpy.mockImplementation(async () => {
      setTimeout(() => controller.abort(), 10);
      throw new TypeError("fetch failed");
    });
    const started = Date.now();
    await expect(
      new OllamaProvider(makeConfig()).stream(makeStreamOptions({ signal: controller.signal })),
    ).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(900);
  });
});
