/**
 * Custom LLM Provider
 * Generic OpenAI-compatible endpoint for LiteLLM, LMStudio, vLLM, etc.
 */

import { BaseLLMProvider } from '../base-provider';
import {
  type LLMConfig,
  type LLMStreamOptions,
  LLMAuthError,
  LLMRateLimitError,
  LLMStreamError,
  LLMConfigError,
} from '../types';
import { createStreamFromSSEResponse } from '../utils/streaming';
import { logger } from '@/lib/logger';

// ============================================================================
// Custom Provider
// ============================================================================

export class CustomProvider extends BaseLLMProvider {
  private baseUrl: string;

  constructor(config: LLMConfig) {
    super(config);
    this.validate();
    this.baseUrl = this.ensureApiUrl();
  }

  /**
   * Validate configuration - requires API URL
   */
  public validate(): void {
    if (!this.config.apiUrl || this.config.apiUrl.trim() === '') {
      throw new LLMConfigError(
        'Custom provider requires LLM_API_URL environment variable.',
        'custom'
      );
    }

    if (!this.config.model || this.config.model.trim() === '') {
      throw new LLMConfigError(
        'Model name is required for Custom provider.',
        'custom'
      );
    }
  }

  /**
   * Stream completion from custom endpoint
   */
  public async stream(options: LLMStreamOptions): Promise<ReadableStream<Uint8Array>> {
    return this.streamWithRetry(async () => {
      const model = this.getModel(options);
      const messages = this.buildMessages(options);

      try {
        const response = await this.fetchStream(model, messages, options);
        await this.validateResponse(response);

        return createStreamFromSSEResponse(response, 'custom');
      } catch (error) {
        if (
          error instanceof LLMAuthError ||
          error instanceof LLMRateLimitError ||
          error instanceof LLMConfigError
        ) {
          throw error;
        }
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
   * Fetch streaming response from custom endpoint
   */
  private async fetchStream(
    model: string,
    messages: Array<{ role: string; content: string }>,
    options: LLMStreamOptions
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add API key if provided
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
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
      logger.debug('Could not parse error response body as JSON', { provider: 'custom' });
    }

    if (response.status === 401 || response.status === 403) {
      throw new LLMAuthError(
        'Authentication failed. Check your API key configuration.',
        'custom'
      );
    }

    if (response.status === 429) {
      throw new LLMRateLimitError(
        'Rate limit exceeded. Please try again later.',
        'custom'
      );
    }

    throw new LLMStreamError(`Custom API error: ${errorMessage}`, 'custom');
  }

  /**
   * Map errors to LLM error types
   */
  private mapError(error: unknown): Error {
    if (error instanceof LLMStreamError) {
      return error;
    }

    if (!(error instanceof Error)) {
      return new LLMStreamError(String(error), 'custom');
    }

    const message = error.message.toLowerCase();

    // Connection errors
    if (
      message.includes('econnrefused') ||
      message.includes('fetch failed') ||
      message.includes('network')
    ) {
      return new LLMStreamError(
        `Cannot connect to custom endpoint at ${this.baseUrl}. Make sure the service is running.`,
        'custom'
      );
    }

    return new LLMStreamError(error.message, 'custom');
  }
}
