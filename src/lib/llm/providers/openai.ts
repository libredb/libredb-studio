/**
 * OpenAI LLM Provider
 * OpenAI Chat Completions API with SSE streaming
 */

import { BaseLLMProvider } from '../base-provider';
import {
  type LLMConfig,
  type LLMStreamOptions,
  LLMAuthError,
  LLMRateLimitError,
  LLMStreamError,
} from '../types';
import { createStreamFromSSEResponse } from '../utils/streaming';
import { DEFAULT_API_URLS } from '../utils/config';
import { logger } from '@/lib/logger';

// ============================================================================
// OpenAI Provider
// ============================================================================

export class OpenAIProvider extends BaseLLMProvider {
  protected baseUrl: string;

  constructor(config: LLMConfig) {
    super(config);
    this.validate();
    this.baseUrl = config.apiUrl ?? DEFAULT_API_URLS.openai;
  }

  /**
   * Stream completion from OpenAI
   */
  public async stream(options: LLMStreamOptions): Promise<ReadableStream<Uint8Array>> {
    return this.streamWithRetry(async () => {
      const model = this.getModel(options);
      const messages = this.buildMessages(options);

      try {
        const response = await this.fetchStream(model, messages, options);
        await this.validateResponse(response);

        return createStreamFromSSEResponse(response, this.name);
      } catch (error) {
        if (error instanceof LLMAuthError || error instanceof LLMRateLimitError) {
          throw error;
        }
        throw this.mapError(error);
      }
    });
  }

  /**
   * Build messages array in OpenAI format
   */
  protected buildMessages(options: LLMStreamOptions): Array<{ role: string; content: string }> {
    return options.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  /**
   * Fetch streaming response from OpenAI API
   */
  protected async fetchStream(
    model: string,
    messages: Array<{ role: string; content: string }>,
    options: LLMStreamOptions
  ): Promise<Response> {
    const apiKey = this.ensureApiKey();

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.maxTokens !== undefined && { max_tokens: options.maxTokens }),
      }),
    });

    return response;
  }

  /**
   * Validate response status and throw appropriate errors
   */
  protected async validateResponse(response: Response): Promise<void> {
    if (response.ok) {
      return;
    }

    let errorMessage = `HTTP ${response.status}`;

    try {
      const errorBody = await response.text();
      const errorJson = JSON.parse(errorBody);
      errorMessage = errorJson.error?.message ?? errorBody;
    } catch {
      logger.debug('Could not parse error response body as JSON', { provider: 'openai' });
    }

    if (response.status === 401 || response.status === 403) {
      throw new LLMAuthError(
        'Invalid API Key. Please check your OpenAI API configuration.',
        'openai'
      );
    }

    if (response.status === 429) {
      throw new LLMRateLimitError(
        'Rate limit exceeded. Please try again later or upgrade your plan.',
        'openai'
      );
    }

    throw new LLMStreamError(`OpenAI API error: ${errorMessage}`, 'openai');
  }

  /**
   * Map errors to LLM error types
   */
  protected mapError(error: unknown): Error {
    if (!(error instanceof Error)) {
      return new LLMStreamError(String(error), 'openai');
    }

    const message = error.message.toLowerCase();

    // Network errors
    if (message.includes('fetch') || message.includes('network')) {
      return new LLMStreamError(
        'Network error. Please check your connection.',
        'openai'
      );
    }

    return new LLMStreamError(error.message, 'openai');
  }
}
