/**
 * Gemini LLM Provider
 * Google Gemini AI integration using @google/generative-ai SDK
 */

import { GoogleGenerativeAI, type GenerateContentStreamResult } from "@google/generative-ai";
import { BaseLLMProvider } from "../base-provider";
import type { RetryOptions } from "../utils/retry";
import {
  type LLMConfig,
  type LLMStreamOptions,
  LLMAuthError,
  LLMRateLimitError,
  LLMSafetyError,
  LLMStreamError,
} from "../types";
import { resolveGeminiChatBaseUrl } from "../utils/gemini-endpoint";
import { encodeText, streamFromAsyncIterable } from "../utils/streaming";

// ============================================================================
// Gemini Provider
// ============================================================================

export class GeminiProvider extends BaseLLMProvider {
  private client: GoogleGenerativeAI;

  constructor(config: LLMConfig, retryOptions?: RetryOptions) {
    super(config, retryOptions);
    this.validate();
    this.client = new GoogleGenerativeAI(this.ensureApiKey());
  }

  /**
   * Stream completion from Gemini
   */
  public async stream(options: LLMStreamOptions): Promise<ReadableStream<Uint8Array>> {
    return this.streamWithRetry(
      async () => {
        const model = this.getModel(options);
        const systemInstruction = this.getSystemMessage(options);
        const messages = this.getNonSystemMessages(options);

        // Build the prompt from messages
        const prompt = messages.map((m) => m.content).join("\n\n");

        try {
          const generativeModel = this.client.getGenerativeModel(
            { model, systemInstruction },
            // B20: `LLM_API_URL` reaches this SDK only here: the constructor takes
            // the key and nothing else. An unset value leaves `baseUrl` undefined,
            // which is what selects the SDK's own Google endpoint.
            { baseUrl: resolveGeminiChatBaseUrl(this.config.apiUrl) },
          );

          const result = await generativeModel.generateContentStream(prompt, { signal: options.signal });

          return this.createStreamFromResult(result);
        } catch (error) {
          throw this.mapError(error);
        }
      },
      { signal: options.signal },
    );
  }

  /**
   * Create ReadableStream from Gemini stream result
   */
  private createStreamFromResult(result: GenerateContentStreamResult): ReadableStream<Uint8Array> {
    // The SDK tees the parsed answer: `result.stream` is one branch, and `result.response` reads the
    // other to its end to aggregate it. The provider owns both and reports one failure, as the body's
    // error (`streamFromAsyncIterable`).
    // When the answer fails after it started (a reset or cut connection, a line that is not JSON, bytes
    // that are not UTF-8, an aborted request), both branches fail together, with the same error.
    // A chunk can also parse as JSON yet be one the SDK cannot aggregate: the stream then ends
    // normally and only `result.response` rejects. So the body awaits the aggregate once the stream
    // ends, and errors with its failure. The handler below observes `result.response` from the start,
    // so a rejection that lands while the stream is still read, or after the caller stopped reading,
    // is not reported a second time as an unhandled rejection.
    result.response.catch(() => {});
    async function* chunksThenAggregate() {
      yield* result.stream;
      await result.response;
    }
    return streamFromAsyncIterable(chunksThenAggregate(), (chunk) => {
      try {
        const text = chunk.text();
        return text ? encodeText(text) : null;
      } catch {
        // Handle safety-blocked chunks
        return null;
      }
    });
  }

  /**
   * Map Gemini errors to LLM error types
   */
  private mapError(error: unknown): Error {
    if (!(error instanceof Error)) {
      return new LLMStreamError(String(error), "gemini");
    }

    const message = error.message.toLowerCase();

    // Authentication errors
    if (
      message.includes("api key") ||
      message.includes("invalid key") ||
      message.includes("unauthorized") ||
      message.includes("permission denied")
    ) {
      return new LLMAuthError("Invalid API Key. Please check your Gemini API configuration.", "gemini");
    }

    // Rate limit errors
    if (
      message.includes("quota") ||
      message.includes("rate limit") ||
      message.includes("resource exhausted") ||
      message.includes("429")
    ) {
      return new LLMRateLimitError("AI usage limit reached. Please try again later or upgrade your plan.", "gemini");
    }

    // Safety filter errors
    if (message.includes("safety") || message.includes("blocked") || message.includes("harm")) {
      return new LLMSafetyError("The prompt was blocked by safety filters. Please modify your request.", "gemini");
    }

    // Generic stream error
    return new LLMStreamError(error.message, "gemini");
  }
}
