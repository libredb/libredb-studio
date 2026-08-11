/**
 * Transport doubles for the agent's model-facing tests (#329, T5).
 *
 * The agent's provider registry and capability probe both drive the ratified AI
 * SDK provider packages over an injected `fetch`, so their tests need wire-level
 * fixtures in the two shapes those packages speak: OpenAI-compatible chat
 * completions (the `openai`, `ollama` and `custom` kinds) and Google's
 * `streamGenerateContent` SSE (the `gemini` kind, the repository's default).
 *
 * Every fixture below was checked against the installed packages rather than
 * written from the vendors' documentation — the frame shapes here are the ones
 * `@ai-sdk/openai@4.0.37` and `@ai-sdk/google@4.0.40` actually parse.
 *
 * `tests/isolated/agent-model-adapter.test.ts` (T4) keeps its own local copies of
 * the doubles it needs: rewriting a reviewed test file to import from here would
 * be churn outside this task's scope, and its copies still assert the same wire.
 */

export interface CapturedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/** The transport seam the adapters take; kept structural, matching `AgentFetch`. */
export type FetchDouble = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export interface Recording {
  readonly fetch: FetchDouble;
  readonly requests: CapturedRequest[];
}

/** A fetch that answers the given responses in order and records what it was asked. */
export function recordingFetch(...responses: Response[]): Recording {
  const requests: CapturedRequest[] = [];
  let served = 0;

  const fetchImpl: FetchDouble = async (input, init) => {
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

/** A fetch that rejects the way a refused TCP connection does. */
export function failingFetch(message: string): FetchDouble {
  return async () => {
    throw new TypeError(message);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** An endpoint refusal carrying the endpoint's own words, the way both vendors shape it. */
export function endpointError(status: number, message: string): Response {
  return jsonResponse({ error: { message } }, status);
}

function sseResponse(...events: unknown[]): Response {
  const body = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chatChunk(delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function chatToolCallDelta(name: string, argumentsChunk: string, callId = "call_1"): Record<string, unknown> {
  return {
    tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: argumentsChunk } }],
  };
}

/**
 * An OpenAI-compatible stream carrying one tool call whose arguments arrive in a
 * single frame — the shape a server that buffers its own generation sends.
 *
 * `callId` is settable because a multi-turn run accumulates every turn's messages
 * in one transcript, and two turns sharing a tool-call id would be a transcript no
 * real endpoint would accept back.
 */
export function chatToolCallStream(name: string, argumentsJson: string, callId?: string): Response {
  return sseResponse(
    chatChunk({ role: "assistant", content: null, ...chatToolCallDelta(name, argumentsJson, callId) }),
    chatChunk({}, "tool_calls"),
    "[DONE]",
  );
}

/** The same tool call with its arguments split across frames, as a token-streaming server sends. */
export function chatToolCallStreamInChunks(name: string, argumentChunks: readonly string[]): Response {
  return sseResponse(
    chatChunk({ role: "assistant", content: null, ...chatToolCallDelta(name, "") }),
    ...argumentChunks.map((chunk) => chatChunk(chatToolCallDelta(name, chunk))),
    chatChunk({}, "tool_calls"),
    "[DONE]",
  );
}

/** An OpenAI-compatible stream that answers in prose instead of calling the tool. */
export function chatTextStream(...deltas: string[]): Response {
  return sseResponse(
    chatChunk({ role: "assistant", content: "" }),
    ...deltas.map((content) => chatChunk({ content })),
    chatChunk({}, "stop"),
    "[DONE]",
  );
}

/**
 * A whole chat completion answered to a streamed request — what an endpoint that
 * ignores `stream: true` sends. The SDK's SSE parser finds no frames in it, so
 * the response arrives with no incremental part at all.
 */
export function chatBufferedCompletion(content: string): Response {
  return jsonResponse({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/** A Google `streamGenerateContent` SSE stream carrying prose. */
export function geminiTextStream(...deltas: string[]): Response {
  return sseResponse(
    ...deltas.map((text) => ({
      candidates: [{ content: { role: "model", parts: [{ text }] } }],
    })),
    {
      candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    },
  );
}

/** A Google `streamGenerateContent` SSE frame carrying one function call. */
export function geminiToolCallStream(name: string, args: Record<string, unknown>): Response {
  return sseResponse({
    candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  });
}

/**
 * A Google function call carrying no `args` at all. `@ai-sdk/google` recognises
 * this shape as a complete no-argument call and emits the tool call with no delta
 * part, which is why the probe counts `tool-input-start` as streaming evidence.
 */
export function geminiArgumentlessToolCallStream(name: string): Response {
  return sseResponse({
    candidates: [{ content: { role: "model", parts: [{ functionCall: { name } }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  });
}

/**
 * A response that never answers, and that ends the way a REAL `fetch` ends one:
 * by erroring its body with an `AbortError` once the caller's signal fires.
 *
 * The signal has to be threaded in because a body that ignores it does not model
 * a slow endpoint at all — it models a transport that cannot be cancelled, which
 * no platform `fetch` is. Verified against the installed SDK: with the signal
 * honoured it emits an `abort` part and closes the stream (which is what a caller
 * timing a request out has to handle), while a body that ignores the signal hangs
 * for as long as the test runner allows and proves only that the fixture ignored it.
 */
export function chatNeverAnswers(signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => {
        controller.error(new DOMException("The operation was aborted.", "AbortError"));
      });
    },
  });

  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A stream that breaks after delivering one valid frame. */
export function brokenMidStream(firstFrame: Response, message: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(await firstFrame.text()));
      controller.error(new Error(message));
    },
  });

  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
