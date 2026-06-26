/**
 * LLM Provider Types & Interfaces
 * Strategy Pattern implementation for multi-provider LLM support
 */

// ============================================================================
// Provider Types
// ============================================================================

export type LLMProviderType = "gemini" | "openai" | "ollama" | "custom";

// ============================================================================
// Configuration
// ============================================================================

export interface LLMConfig {
  provider: LLMProviderType;
  apiKey?: string;
  model: string;
  apiUrl?: string;
}

// ============================================================================
// Messages
// ============================================================================

export type LLMMessageRole = "system" | "user" | "assistant";

export interface LLMMessage {
  role: LLMMessageRole;
  content: string;
}

// ============================================================================
// Stream Options
// ============================================================================

export interface LLMStreamOptions {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

// ============================================================================
// Provider Interface (Strategy Pattern)
// ============================================================================

export interface LLMProvider {
  /** Provider identifier */
  readonly name: LLMProviderType;

  /** Current configuration */
  readonly config: LLMConfig;

  /**
   * Stream a completion response
   * @param options - Stream configuration including messages
   * @returns ReadableStream of UTF-8 encoded chunks
   */
  stream(options: LLMStreamOptions): Promise<ReadableStream<Uint8Array>>;

  /**
   * Validate provider configuration
   * @throws LLMConfigError if configuration is invalid
   */
  validate(): void;
}

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Base error class for LLM-related errors
 */
export class LLMError extends Error {
  constructor(
    message: string,
    public readonly provider?: LLMProviderType,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "LLMError";
    Object.setPrototypeOf(this, LLMError.prototype);
  }
}

/**
 * Configuration error - missing or invalid config
 */
export class LLMConfigError extends LLMError {
  constructor(message: string, provider?: LLMProviderType) {
    super(message, provider);
    this.name = "LLMConfigError";
    Object.setPrototypeOf(this, LLMConfigError.prototype);
  }
}

/**
 * Authentication error - invalid API key (401/403)
 */
export class LLMAuthError extends LLMError {
  constructor(message: string, provider?: LLMProviderType) {
    super(message, provider, 401);
    this.name = "LLMAuthError";
    Object.setPrototypeOf(this, LLMAuthError.prototype);
  }
}

/**
 * Rate limit error - quota exceeded (429)
 */
export class LLMRateLimitError extends LLMError {
  constructor(message: string, provider?: LLMProviderType) {
    super(message, provider, 429);
    this.name = "LLMRateLimitError";
    Object.setPrototypeOf(this, LLMRateLimitError.prototype);
  }
}

/**
 * Safety filter error - content blocked
 */
export class LLMSafetyError extends LLMError {
  constructor(message: string, provider?: LLMProviderType) {
    super(message, provider, 400);
    this.name = "LLMSafetyError";
    Object.setPrototypeOf(this, LLMSafetyError.prototype);
  }
}

/**
 * Streaming error - connection or parsing failure
 */
export class LLMStreamError extends LLMError {
  constructor(message: string, provider?: LLMProviderType) {
    super(message, provider);
    this.name = "LLMStreamError";
    Object.setPrototypeOf(this, LLMStreamError.prototype);
  }
}

// ============================================================================
// Type Guards
// ============================================================================

function isLLMError(error: unknown): error is LLMError {
  return error instanceof LLMError;
}

export function isRetryableError(error: unknown): boolean {
  if (!isLLMError(error)) {
    // Network errors are retryable
    if (error instanceof TypeError && error.message.includes("fetch")) {
      return true;
    }
    return false;
  }

  // Auth and safety errors are not retryable
  if (error instanceof LLMAuthError || error instanceof LLMSafetyError) {
    return false;
  }

  // Config errors are not retryable
  if (error instanceof LLMConfigError) {
    return false;
  }

  // Rate limit and stream errors may be retryable
  return true;
}
