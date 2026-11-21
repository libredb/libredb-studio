/**
 * A Gemini answer that fails after it started reaches the caller once, as the body's error, and nowhere else.
 *
 * WHY A REAL SDK AND A REAL SOCKET. `@google/generative-ai` tees the parsed answer: one branch is
 * `result.stream`, which the provider reads, and the other feeds `result.response`, a promise that
 * aggregates every chunk and rejects when the answer fails. `gemini-provider.test.ts` replaces the
 * SDK, so it has no `result.response` to leave unhandled. Here the provider talks to the real SDK,
 * which talks to an in-process stand-in for `streamGenerateContent`.
 *
 * WHAT CATCHES A REJECTION LEFT UNHANDLED. bun's test runner: it fails the case during which the
 * rejection is reported, with the rejection as the case's error. MEASURED on bun 1.4.4 without the
 * fix: all five cases fail with the SDK's error, and a `process.on("unhandledRejection")` listener
 * installed inside the case records nothing, because the runner takes the event first. So these
 * cases install no recorder of their own; they wait one turn after the body's error, which is when
 * the rejection is reported, so that it lands inside the case that caused it.
 *
 * Each case answers one chunk, waits until the caller has read it, then fails the answer its own
 * way: a reset connection, a line cut short, a line that is not JSON, bytes that are not UTF-8, and
 * a caller that aborts the request.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { GeminiProvider } from "@/lib/llm/providers/gemini";
import { NO_BACKOFF } from "../../helpers/llm-no-backoff";

const KEY = "SEED-CANARY-gemini-7f3a";

type Failure = "reset" | "truncated" | "malformed" | "invalid-utf8" | "held";

function sseLine(text: string): string {
  return `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }], role: "model" }, index: 0 }] })}\r\n\r\n`;
}

let failure: Failure = "reset";
let releaseFailure: () => void = () => undefined;
let server: http.Server;
let apiUrl = "";

beforeAll(async () => {
  server = http.createServer((request, response) => {
    request.resume();
    const mode = failure;
    const released = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sseLine("Hello"));
    void released.then(() => {
      if (mode === "reset") response.socket?.resetAndDestroy();
      else if (mode === "truncated") response.end('data: {"candidates": [');
      else if (mode === "malformed") response.end("data: {not json\r\n\r\n");
      else if (mode === "invalid-utf8") response.end(Buffer.from([0x64, 0x61, 0xff, 0xfe, 0x0a]));
      // "held" never ends: the caller aborts the request instead.
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Reads the provider's body as the AI routes hand it to Next.js, releases the stand-in's failure
 * once the first chunk is in, and returns what the caller saw.
 */
async function answerThatFails(mode: Failure): Promise<{ text: string; error: unknown }> {
  failure = mode;
  const controller = new AbortController();
  const provider = new GeminiProvider(
    { provider: "gemini", apiKey: KEY, model: "gemini-2.0-flash", apiUrl },
    NO_BACKOFF,
  );
  const body = await provider.stream({ messages: [{ role: "user", content: "Hello" }], signal: controller.signal });
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let error: unknown;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
      if (mode === "held") controller.abort();
      else releaseFailure();
    }
  } catch (caught) {
    error = caught;
  }
  // The SDK settles `result.response` in the same turn as the body's error; an unhandled
  // rejection is reported once that turn's microtasks have run, so one more turn is enough.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { text, error };
}

describe("GeminiProvider: an answer that fails after it started", () => {
  test.each([
    ["the connection is reset", "reset", "Error reading from the stream"],
    ["the last line is cut short", "truncated", "Failed to parse stream"],
    ["a line is not JSON", "malformed", 'Error parsing JSON response: "{not json"'],
    ["the bytes are not UTF-8", "invalid-utf8", "Error reading from the stream"],
    ["the caller aborts the request", "held", "Error reading from the stream"],
  ] as const)(
    "%s: the body errors with the failure and no rejection is left unhandled",
    async (_name, mode, message) => {
      const { text, error } = await answerThatFails(mode);

      expect(text).toBe("Hello");
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(message);
    },
  );
});
