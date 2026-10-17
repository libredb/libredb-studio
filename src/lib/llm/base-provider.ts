/**
 * Base LLM Provider
 * Abstract class implementing common provider functionality
 */

import { type LLMConfig, type LLMProvider, type LLMProviderType, type LLMStreamOptions, LLMConfigError } from "./types";
import { validateConfig, getSafeConfigForLogging, unconfiguredReason } from "./utils/config";
import { withRetry, type RetryOptions } from "./utils/retry";

// ============================================================================
// Base Provider Class
// ============================================================================

export abstract class BaseLLMProvider implements LLMProvider {
  public readonly name: LLMProviderType;
  public readonly config: LLMConfig;

  /**
   * The retry settings every stream of this provider goes through, or none for the defaults.
   *
   * A SEAM, the way `KubernetesSeams` is one (`platform/kubernetes/client.ts:37`, whose own
   * docblock says "a test hands in a recording one"): the backoff is real waiting, and a unit test
   * that asserts how an error is MAPPED should not spend it. MEASURED on main: the four provider
   * test files spend 12,2 to 18,3 s each, and ~20 of their cases take 3.004 ms apiece - 1.000 +
   * 2.000 ms of `sleep`, not work, because `withRetry` retries a retryable failure twice before it
   * gives up. Those cases ran at 60% of bun's 5.000 ms per-test budget for no measured reason.
   *
   * Optional, so a call site that passes nothing keeps the real defaults - which is what
   * `factory.ts` does at every one of its four, so no shipped behaviour changes.
   */
  protected readonly retryOptions: RetryOptions | undefined;

  protected constructor(config: LLMConfig, retryOptions?: RetryOptions) {
    this.name = config.provider;
    this.config = config;
    this.retryOptions = retryOptions;
  }

  /**
   * Validate provider configuration
   * Can be overridden by subclasses for provider-specific validation
   */
  public validate(): void {
    validateConfig(this.config);
  }

  /**
   * Stream completion - must be implemented by subclasses
   */
  public abstract stream(options: LLMStreamOptions): Promise<ReadableStream<Uint8Array>>;

  /**
   * Execute stream with retry logic
   */
  protected async streamWithRetry(
    streamFn: () => Promise<ReadableStream<Uint8Array>>,
    retryOptions?: RetryOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    return withRetry(streamFn, {
      provider: this.name,
      operation: "stream",
      ...this.retryOptions,
      // Last, so a per-call setting still wins over the one the provider was built with.
      ...retryOptions,
    });
  }

  /**
   * Get the model to use (from options or config)
   */
  protected getModel(options: LLMStreamOptions): string {
    return options.model ?? this.config.model;
  }

  /**
   * Build system message from messages array
   */
  protected getSystemMessage(options: LLMStreamOptions): string | undefined {
    const systemMessage = options.messages.find((m) => m.role === "system");
    return systemMessage?.content;
  }

  /**
   * Build user/assistant messages (excluding system)
   */
  protected getNonSystemMessages(options: LLMStreamOptions): Array<{ role: "user" | "assistant"; content: string }> {
    return options.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
  }

  /**
   * Log error with safe config
   */
  protected logError(operation: string, error: unknown): void {
    const safeConfig = getSafeConfigForLogging(this.config);
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[LLM:${this.name}] ${operation} failed:`, errorMessage, safeConfig);
  }

  /**
   * Ensure API key is available
   */
  protected ensureApiKey(): string {
    if (!this.config.apiKey) {
      throw new LLMConfigError(
        `API key is required for ${this.name} provider`,
        this.name,
        unconfiguredReason(this.config),
      );
    }
    return this.config.apiKey;
  }

  /**
   * Ensure API URL is available
   */
  protected ensureApiUrl(): string {
    if (!this.config.apiUrl) {
      throw new LLMConfigError(`API URL is required for ${this.name} provider`, this.name);
    }
    return this.config.apiUrl;
  }
}
