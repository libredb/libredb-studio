import { describe, test, expect } from "bun:test";
import { encodeText, decodeText, createSSEParser, createErrorStream } from "@/lib/llm/utils/streaming";

// ============================================================================
// Helper: read all chunks from a ReadableStream
// ============================================================================

async function readAllChunks(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decodeText(value);
  }
  return result;
}

async function pipeSSE(input: string): Promise<string> {
  const parser = createSSEParser();
  const inputStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeText(input));
      controller.close();
    },
  });
  const outputStream = inputStream.pipeThrough(parser);
  return readAllChunks(outputStream);
}

// ============================================================================
// encodeText / decodeText
// ============================================================================

describe("encodeText", () => {
  test("converts string to Uint8Array", () => {
    const result = encodeText("hello");
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("decodeText", () => {
  test("converts Uint8Array back to string", () => {
    const bytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    expect(decodeText(bytes)).toBe("hello");
  });
});

describe("encodeText + decodeText roundtrip", () => {
  test("roundtrip preserves the string", () => {
    const original = "Hello, World! 123 @#$";
    const encoded = encodeText(original);
    const decoded = decodeText(encoded);
    expect(decoded).toBe(original);
  });

  test("roundtrip handles unicode characters", () => {
    const original = "Merhaba dunya";
    const encoded = encodeText(original);
    const decoded = decodeText(encoded);
    expect(decoded).toBe(original);
  });
});

// ============================================================================
// createSSEParser
// ============================================================================

describe("createSSEParser", () => {
  test("parses OpenAI-format SSE data line and extracts content", async () => {
    const input = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
    const output = await pipeSSE(input);
    expect(output).toBe("hello");
  });

  test("handles [DONE] marker without producing output", async () => {
    const input = 'data: {"choices":[{"delta":{"content":"hi"}}]}\ndata: [DONE]\n\n';
    const output = await pipeSSE(input);
    expect(output).toBe("hi");
  });

  test("skips malformed JSON lines", async () => {
    const input = 'data: not-valid-json\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n';
    const output = await pipeSSE(input);
    expect(output).toBe("ok");
  });

  test("handles multiple data chunks and concatenates content", async () => {
    const input = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" World"}}]}',
      "data: [DONE]",
      "",
    ].join("\n");

    const output = await pipeSSE(input);
    expect(output).toBe("Hello World");
  });

  test('skips comment lines starting with ":"', async () => {
    const input = [": this is a comment", 'data: {"choices":[{"delta":{"content":"content"}}]}', ""].join("\n");

    const output = await pipeSSE(input);
    expect(output).toBe("content");
  });

  test("skips empty lines", async () => {
    const input = ["", 'data: {"choices":[{"delta":{"content":"value"}}]}', "", ""].join("\n");

    const output = await pipeSSE(input);
    expect(output).toBe("value");
  });

  test("skips data lines whose JSON is not an object", async () => {
    const input = ["data: null", 'data: "plain string"', 'data: {"choices":[{"delta":{"content":"obj"}}]}', ""].join(
      "\n",
    );

    const output = await pipeSSE(input);
    expect(output).toBe("obj");
  });

  test("skips data lines where delta has no content field", async () => {
    const input = ['data: {"choices":[{"delta":{}}]}', 'data: {"choices":[{"delta":{"content":"real"}}]}', ""].join(
      "\n",
    );

    const output = await pipeSSE(input);
    expect(output).toBe("real");
  });
});

// ============================================================================
// createErrorStream
// ============================================================================

describe("createErrorStream", () => {
  test('emits "Error: <message>" and closes', async () => {
    const stream = createErrorStream("something went wrong");
    const output = await readAllChunks(stream);
    expect(output).toBe("Error: something went wrong");
  });

  test("stream is finite (closes after emitting)", async () => {
    const stream = createErrorStream("test");
    const reader = stream.getReader();

    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decodeText(first.value!)).toBe("Error: test");

    const second = await reader.read();
    expect(second.done).toBe(true);
  });
});

// ============================================================================
// streamFromAsyncIterable
// ============================================================================

import { streamFromAsyncIterable, createStreamFromSSEResponse, mergeStreams, isStreamCancelled } from "@/lib/llm/utils/streaming";

describe("streamFromAsyncIterable", () => {
  test("transforms async iterable items into stream chunks", async () => {
    async function* generate() {
      yield "hello";
      yield " world";
    }

    const stream = streamFromAsyncIterable(generate(), (item) => encodeText(item));
    const output = await readAllChunks(stream);
    expect(output).toBe("hello world");
  });

  test("skips null transform results", async () => {
    async function* generate() {
      yield "keep";
      yield "skip";
      yield "also-keep";
    }

    const stream = streamFromAsyncIterable(generate(), (item) => (item === "skip" ? null : encodeText(item)));
    const output = await readAllChunks(stream);
    expect(output).toBe("keepalso-keep");
  });

  test("handles empty iterable", async () => {
    async function* generate(): AsyncGenerator<string> {
      // empty
    }

    const stream = streamFromAsyncIterable(generate(), (item) => encodeText(item));
    const output = await readAllChunks(stream);
    expect(output).toBe("");
  });

  test("handles error in iterable", async () => {
    async function* generate() {
      yield "ok";
      throw new Error("iteration error");
    }

    const stream = streamFromAsyncIterable(generate(), (item) => encodeText(item));
    const reader = stream.getReader();

    // First chunk should be 'ok'
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decodeText(first.value!)).toBe("ok");

    // Next read should error
    try {
      await reader.read();
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toBe("iteration error");
    }
  });

  /**
   * A consumer that cancels mid-stream is a non-event, not an error. The
   * pull loop used to keep consuming the source iterable — generating a
   * full completion nobody reads — until an enqueue threw TypeError into
   * the generic catch and surfaced as a spurious stream error.
   */
  test("stops consuming the iterable when the consumer cancels", async () => {
    let pulled = 0;
    async function* generate() {
      // Far more items than the consumer reads: if the loop keeps pulling
      // after cancel, pulled grows well past what was consumed.
      for (let i = 0; i < 100; i++) {
        pulled += 1;
        yield `chunk-${i}`;
      }
    }

    const stream = streamFromAsyncIterable(generate(), (item) => encodeText(item));
    const reader = stream.getReader();

    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decodeText(first.value!)).toBe("chunk-0");

    await reader.cancel();

    // Give the pull loop a chance to (wrongly) keep draining the iterable.
    await new Promise((r) => setTimeout(r, 50));
    // Only the item in flight when the cancel landed may be pulled after the
    // read of chunk-0 — not the whole iterable.
    expect(pulled).toBeLessThan(5);
  });
});

// ============================================================================
// isStreamCancelled (direct branch coverage; the race it guards is
// timing-dependent — see the export's doc comment)
// ============================================================================

describe("isStreamCancelled", () => {
  /** A live controller: desiredSize is a number and real errors are not cancels. */
  test("returns false for a real error on a live controller", () => {
    // Reach the controller via a stream whose start() captures it; a held
    // reader keeps desiredSize non-null (stream is live, not closed).
    let captured: ReadableStreamDefaultController<Uint8Array> | null = null;
    const probe = new ReadableStream<Uint8Array>({ start(c) { captured = c; } });
    const probeReader = probe.getReader(); // keep desiredSize non-null
    void probeReader;

    expect(isStreamCancelled(captured!, new Error("iteration error"))).toBe(false);
    expect(isStreamCancelled(captured!, new TypeError("network hiccup"))).toBe(false);
    expect(isStreamCancelled(captured!, "not an error")).toBe(false);
  });

  /** A TypeError whose message names the cancelled/closed controller state. */
  test("returns true for a TypeError naming cancellation or closed state", () => {
    let captured: ReadableStreamDefaultController<Uint8Array> | null = null;
    const probe = new ReadableStream<Uint8Array>({ start(c) { captured = c; } });
    const probeReader = probe.getReader();
    void probeReader;

    expect(isStreamCancelled(captured!, new TypeError("Cannot enqueue on a canceled stream"))).toBe(true);
    expect(isStreamCancelled(captured!, new TypeError("Controller is already closed"))).toBe(true);
    expect(isStreamCancelled(captured!, new TypeError("The stream is in an invalid state"))).toBe(true);
  });

  /** A closed/cancelled stream: desiredSize is null regardless of error shape. */
  test("returns true when desiredSize is null (closed/cancelled stream)", async () => {
    let captured: ReadableStreamDefaultController<Uint8Array> | null = null;
    const probe = new ReadableStream<Uint8Array>({ start(c) { captured = c; } });
    const reader = probe.getReader();
    await reader.cancel();

    expect(captured!.desiredSize).toBeNull();
    expect(isStreamCancelled(captured!, new Error("anything"))).toBe(true);
  });
});

// ============================================================================
// createStreamFromSSEResponse
// ============================================================================

describe("createStreamFromSSEResponse", () => {
  test("parses SSE response body and extracts content", async () => {
    const sseData = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" World"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encodeText(sseData));
        controller.close();
      },
    });

    const response = new Response(body);
    const stream = createStreamFromSSEResponse(response, "openai");
    const output = await readAllChunks(stream);
    expect(output).toBe("Hello World");
  });

  test("throws LLMStreamError when body is null", () => {
    const response = new Response(null);
    // Force body to be null
    Object.defineProperty(response, "body", { value: null });

    expect(() => createStreamFromSSEResponse(response, "openai")).toThrow("Response body is empty");
  });
});

// ============================================================================
// mergeStreams
// ============================================================================

describe("mergeStreams", () => {
  test("merges multiple streams into one", async () => {
    const stream1 = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encodeText("Hello"));
        controller.close();
      },
    });

    const stream2 = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encodeText(" World"));
        controller.close();
      },
    });

    const merged = mergeStreams([stream1, stream2]);
    const output = await readAllChunks(merged);
    expect(output).toBe("Hello World");
  });

  test("handles empty streams array", async () => {
    const merged = mergeStreams([]);
    const output = await readAllChunks(merged);
    expect(output).toBe("");
  });

  test("handles single stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encodeText("only"));
        controller.close();
      },
    });

    const merged = mergeStreams([stream]);
    const output = await readAllChunks(merged);
    expect(output).toBe("only");
  });

  test("preserves order of streams", async () => {
    const streams = ["first", "second", "third"].map(
      (text) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encodeText(text));
            controller.close();
          },
        }),
    );

    const merged = mergeStreams(streams);
    const output = await readAllChunks(merged);
    expect(output).toBe("firstsecondthird");
  });
});

// ============================================================================
// SSE Parser flush behavior
// ============================================================================

describe("createSSEParser flush", () => {
  test("flushes remaining buffered data", async () => {
    // Send data without trailing newline — should be flushed
    const input = 'data: {"choices":[{"delta":{"content":"flushed"}}]}';
    const output = await pipeSSE(input);
    expect(output).toBe("flushed");
  });

  test("flush ignores [DONE] in buffer", async () => {
    const input = "data: [DONE]";
    const output = await pipeSSE(input);
    expect(output).toBe("");
  });

  test("flush ignores malformed JSON in buffer", async () => {
    const input = "data: {invalid-json}";
    const output = await pipeSSE(input);
    expect(output).toBe("");
  });
});
