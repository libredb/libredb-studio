/**
 * Gemini LLM Provider
 * Google Gemini AI integration using @google/generative-ai SDK
 */

import { GoogleGenerativeAI, type GenerateContentStreamResult } from "@google/generative-ai";
import { BaseLLMProvider } from "../base-provider";
import {
  type LLMConfig,
  type LLMStreamOptions,
  LLMAuthError,
  LLMRateLimitError,
  LLMSafetyError,
  LLMStreamError,
} from "../types";
import { encodeText, streamFromAsyncIterable } from "../utils/streaming";

// ============================================================================
// Gemini Provider
// ============================================================================

export class GeminiProvider extends BaseLLMProvider {
  private client: GoogleGenerativeAI;

  constructor(config: LLMConfig) {
    super(config);
    this.validate();
    this.client = new GoogleGenerativeAI(this.ensureApiKey());
  }

  /**
   * Stream completion from Gemini
   */
  public async stream(options: LLMStreamOptions): Promise<ReadableStream<Uint8Array>> {
    return this.streamWithRetry(async () => {
      const model = this.getModel(options);
      const systemInstruction = this.getSystemMessage(options);
      const messages = this.getNonSystemMessages(options);

      // Build the prompt from messages
      const prompt = messages.map((m) => m.content).join("\n\n");

      try {
        const generativeModel = this.client.getGenerativeModel({
          model,
          systemInstruction,
        });

        const result = await generativeModel.generateContentStream(prompt);

        return this.createStreamFromResult(result);
      } catch (error) {
        throw this.mapError(error);
      }
    });
  }

  /**
   * Create ReadableStream from Gemini stream result
   */
  private createStreamFromResult(result: GenerateContentStreamResult): ReadableStream<Uint8Array> {
    return streamFromAsyncIterable(result.stream, (chunk) => {
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
