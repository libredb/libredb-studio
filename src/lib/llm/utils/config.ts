/**
 * LLM Configuration Utilities
 * Environment variable resolution and default configuration
 */

import { type LLMConfig, type LLMProviderType, LLMConfigError } from "../types";

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_PROVIDER: LLMProviderType = "gemini";

export const DEFAULT_MODELS: Record<LLMProviderType, string> = {
  gemini: "gemini-2.5-flash",
  openai: "gpt-4o",
  ollama: "llama3.2",
  custom: "gpt-3.5-turbo",
};

export const DEFAULT_API_URLS: Record<string, string> = {
  ollama: "http://localhost:11434/v1",
  openai: "https://api.openai.com/v1",
};

// ============================================================================
// Environment Resolution
// ============================================================================

function getEnvVar(key: string): string | undefined {
  return process.env[key];
}

function resolveProvider(): LLMProviderType {
  const provider = getEnvVar("LLM_PROVIDER")?.toLowerCase();

  if (!provider) {
    return DEFAULT_PROVIDER;
  }

  const validProviders: LLMProviderType[] = ["gemini", "openai", "ollama", "custom"];

  if (!validProviders.includes(provider as LLMProviderType)) {
    console.error(`[LLM] Invalid provider "${provider}", falling back to "${DEFAULT_PROVIDER}"`);
    return DEFAULT_PROVIDER;
  }

  return provider as LLMProviderType;
}

function resolveApiKey(provider: LLMProviderType): string | undefined {
  const apiKey = getEnvVar("LLM_API_KEY");

  // Ollama doesn't require API key
  if (!apiKey && provider === "ollama") {
    return undefined;
  }

  return apiKey;
}

function resolveModel(provider: LLMProviderType): string {
  const model = getEnvVar("LLM_MODEL");
  return model || DEFAULT_MODELS[provider];
}

function resolveApiUrl(provider: LLMProviderType): string | undefined {
  // Primary: LLM_API_URL
  const apiUrl = getEnvVar("LLM_API_URL");
  if (apiUrl) {
    return apiUrl;
  }

  // Default URLs for specific providers
  if (provider === "ollama") {
    return DEFAULT_API_URLS.ollama;
  }

  if (provider === "openai") {
    return DEFAULT_API_URLS.openai;
  }

  // Custom provider requires explicit URL
  if (provider === "custom") {
    return undefined;
  }

  return undefined;
}

// ============================================================================
// Configuration Resolution
// ============================================================================

/**
 * Resolve LLM configuration from environment variables with optional overrides
 */
export function resolveConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  const provider = overrides?.provider ?? resolveProvider();

  return {
    provider,
    apiKey: overrides?.apiKey ?? resolveApiKey(provider),
    model: overrides?.model ?? resolveModel(provider),
    apiUrl: overrides?.apiUrl ?? resolveApiUrl(provider),
  };
}

// ============================================================================
// Configuration Validation
// ============================================================================

/**
 * Validate LLM configuration
 * @throws LLMConfigError if configuration is invalid
 */
export function validateConfig(config: LLMConfig): void {
  // Validate provider
  const validProviders: LLMProviderType[] = ["gemini", "openai", "ollama", "custom"];
  if (!validProviders.includes(config.provider)) {
    throw new LLMConfigError(
      `Invalid provider: ${config.provider}. Valid options: ${validProviders.join(", ")}`,
      config.provider,
    );
  }

  // Validate API key requirements
  if (config.provider === "gemini" && !config.apiKey) {
    throw new LLMConfigError("Gemini API key is required. Set LLM_API_KEY environment variable.", "gemini");
  }

  if (config.provider === "openai" && !config.apiKey) {
    throw new LLMConfigError("OpenAI API key is required. Set LLM_API_KEY environment variable.", "openai");
  }

  // Validate API URL for custom provider
  if (config.provider === "custom" && !config.apiUrl) {
    throw new LLMConfigError("Custom provider requires LLM_API_URL environment variable.", "custom");
  }

  // Validate model
  if (!config.model || config.model.trim() === "") {
    throw new LLMConfigError(`Model name is required for ${config.provider} provider.`, config.provider);
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a provider requires an API key
 */
export function requiresApiKey(provider: LLMProviderType): boolean {
  return provider === "gemini" || provider === "openai";
}

/**
 * Check if a provider requires a custom API URL
 */
export function requiresApiUrl(provider: LLMProviderType): boolean {
  return provider === "custom";
}

/**
 * Get safe config for logging (API key masked)
 */
export function getSafeConfigForLogging(config: LLMConfig): Record<string, string | undefined> {
  return {
    provider: config.provider,
    model: config.model,
    apiUrl: config.apiUrl,
    apiKey: config.apiKey ? "***" : undefined,
  };
}
