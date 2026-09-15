/**
 * Streaming Utilities for LLM Providers
 * SSE parsing and stream transformation helpers
 */

import { LLMStreamError, type LLMProviderType } from "../types";
import { logger } from "@/lib/logger";

// ============================================================================
// Text Encoding/Decoding
// ============================================================================

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeText(text: string): Uint8Array {
  return textEncoder.encode(text);
}

export function decodeText(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

// ============================================================================
// SSE (Server-Sent Events) Parser
// ============================================================================

/**
 * Parse SSE formatted response for OpenAI-compatible APIs
 * Handles chunked responses and extracts content from delta objects
 */
export function createSSEParser(): TransformStream<Uint8Array, Uint8Array> {
  let buffer = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decodeText(chunk);

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith(":")) {
          continue;
        }

        // Handle data lines
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6);

          // Handle stream end marker
          if (data === "[DONE]") {
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = extractContent(parsed);

            if (content) {
              controller.enqueue(encodeText(content));
            }
          } catch {
            logger.debug("Skipping malformed JSON chunk in SSE stream");
          }
        }
      }
    },

    flush(controller) {
      // Process any remaining data in buffer
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data: ") && trimmed.slice(6) !== "[DONE]") {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const content = extractContent(parsed);
            if (content) {
              controller.enqueue(encodeText(content));
            }
          } catch {
            logger.debug("Skipping malformed JSON chunk in SSE stream flush");
          }
        }
      }
    },
  });
}

/**
 * Extract content from parsed SSE data based on provider format
 */
function extractContent(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const obj = data as Record<string, unknown>;

  // OpenAI format: choices[0].delta.content
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const choice = obj.choices[0] as Record<string, unknown>;
    const delta = choice.delta as Record<string, unknown> | undefined;

    if (delta && typeof delta.content === "string") {
      return delta.content;
    }
  }

  return null;
}

// ============================================================================
// Stream Utilities
// ============================================================================

/**
 * Create a ReadableStream from an async iterable
 */
export function streamFromAsyncIterable<T>(
  iterable: AsyncIterable<T>,
  transform: (item: T) => Uint8Array | null,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const item of iterable) {
          const chunk = transform(item);
          if (chunk) {
            controller.enqueue(chunk);
          }
        }
        controller.close();
      } catch (error) {
        // A consumer that cancelled mid-stream makes the next enqueue (or the
        // close above) throw TypeError — the consumer is gone, not broken.
        // Surfacing that as a stream error turned every client-side abort of
        // a Gemini completion into a spurious error; treating cancellation as
        // a normal exit also stops the loop from pulling the rest of the SDK
        // iterable (a full completion generated — and billed — for nobody).
        if (isStreamCancelled(controller, error)) {
          return;
        }
        controller.error(error);
      }
    },
  });
}

/**
 * Distinguish "the consumer cancelled/errored this stream" from a real
 * pipeline failure. A cancel mid-stream makes the next enqueue/close throw a
 * TypeError whose message names the stream's unusable state (wording varies
 * across runtimes: "canceled", "closed", "invalid state"). An errored stream
 * also reports desiredSize === null per the WHATWG spec — the only state
 * where that is true. Both signals are checked.
 *
 * Exported for direct unit testing: the cancel race it guards (a cancel
 * landing between two enqueues) is timing-dependent and cannot be made
 * deterministic from the stream's public surface alone.
 */
export function isStreamCancelled(controller: ReadableStreamDefaultController<Uint8Array>, error: unknown): boolean {
  if (controller.desiredSize === null) {
    // The stream was errored: no reader will ever come.
    return true;
  }
  return error instanceof TypeError && /cancel|closed|invalid state/i.test(error.message);
}

/**
 * Create a ReadableStream from a fetch Response with SSE parsing
 */
export function createStreamFromSSEResponse(response: Response, provider: LLMProviderType): ReadableStream<Uint8Array> {
  const body = response.body;

  if (!body) {
    throw new LLMStreamError("Response body is empty", provider);
  }

  return body.pipeThrough(createSSEParser());
}

/**
 * Merge multiple streams into one (useful for multi-part responses)
 */
export function mergeStreams(streams: ReadableStream<Uint8Array>[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const stream of streams) {
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      controller.close();
    },
  });
}

/**
 * Create an error stream that emits a single error message
 */
export function createErrorStream(message: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeText(`Error: ${message}`));
      controller.close();
    },
  });
}
