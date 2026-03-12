/**
 * Ollama LLM Provider
 * Local LLM integration via OpenAI-compatible API
 */

import { BaseLLMProvider } from '../base-provider';
import {
  type LLMConfig,
  type LLMStreamOptions,
  LLMStreamError,
  LLMConfigError,
} from '../types';
import { createStreamFromSSEResponse } from '../utils/streaming';
import { DEFAULT_API_URLS } from '../utils/config';
import { logger } from '@/lib/logger';

// ============================================================================
// Ollama Provider
// ============================================================================

export class OllamaProvider extends BaseLLMProvider {
  private baseUrl: string;

  constructor(config: LLMConfig) {
    super(config);
    this.baseUrl = config.apiUrl ?? DEFAULT_API_URLS.ollama;
  }

  /**
   * Override validation - Ollama doesn't require API key
   */
  public validate(): void {
    if (!this.config.model || this.config.model.trim() === '') {
      throw new LLMConfigError(
        'Model name is required for Ollama provider.',
        'ollama'
      );
    }
  }

  /**
   * Stream completion from Ollama
   */
  public async stream(options: LLMStreamOptions): Promise<ReadableStream<Uint8Array>> {
    return this.streamWithRetry(async () => {
      const model = this.getModel(options);
      const messages = this.buildMessages(options);

      try {
        const response = await this.fetchStream(model, messages, options);
        await this.validateResponse(response);

        return createStreamFromSSEResponse(response, 'ollama');
      } catch (error) {
        throw this.mapError(error);
      }
    });
  }

  /**
   * Build messages array in OpenAI format
   */
  private buildMessages(options: LLMStreamOptions): Array<{ role: string; content: string }> {
    return options.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  /**
   * Fetch streaming response from Ollama API
   */
  private async fetchStream(
    model: string,
    messages: Array<{ role: string; content: string }>,
    options: LLMStreamOptions
  ): Promise<Response> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Ollama accepts 'ollama' or empty string as API key
        Authorization: 'Bearer ollama',
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
   * Validate response status
   */
  private async validateResponse(response: Response): Promise<void> {
    if (response.ok) {
      return;
    }

    let errorMessage = `HTTP ${response.status}`;

    try {
      const errorBody = await response.text();
      const errorJson = JSON.parse(errorBody);
      errorMessage = errorJson.error?.message ?? errorBody;
    } catch {
      logger.debug('Could not parse error response body as JSON', { provider: 'ollama' });
    }

    // Ollama-specific errors
    if (response.status === 404) {
      throw new LLMConfigError(
        `Model not found. Make sure "${this.config.model}" is pulled in Ollama.`,
        'ollama'
      );
    }

    throw new LLMStreamError(`Ollama API error: ${errorMessage}`, 'ollama');
  }

  /**
   * Map errors to LLM error types
   */
  private mapError(error: unknown): Error {
    if (error instanceof LLMConfigError || error instanceof LLMStreamError) {
      return error;
    }

    if (!(error instanceof Error)) {
      return new LLMStreamError(String(error), 'ollama');
    }

    const message = error.message.toLowerCase();

    // Connection errors - Ollama not running
    if (
      message.includes('econnrefused') ||
      message.includes('fetch failed') ||
      message.includes('network')
    ) {
      return new LLMStreamError(
        `Cannot connect to Ollama at ${this.baseUrl}. Make sure Ollama is running.`,
        'ollama'
      );
    }

    return new LLMStreamError(error.message, 'ollama');
  }
}
