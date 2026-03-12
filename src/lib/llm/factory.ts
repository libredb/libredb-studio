/**
 * LLM Provider Factory
 * Creates appropriate provider instance based on configuration
 * Uses dynamic imports to reduce memory footprint - providers are loaded on demand
 */

import { type LLMConfig, type LLMProvider, LLMConfigError } from './types';
import { resolveConfig, getSafeConfigForLogging } from './utils/config';

// ============================================================================
// Provider Factory
// ============================================================================

/**
 * Create an LLM provider based on configuration
 * Uses dynamic imports to load providers on-demand, reducing initial memory usage
 *
 * @param config - Optional configuration overrides. If not provided,
 *                 configuration is resolved from environment variables.
 * @returns Promise<LLMProvider> instance
 * @throws LLMConfigError if configuration is invalid
 *
 * @example
 * // Use environment configuration
 * const provider = await createLLMProvider();
 *
 * @example
 * // Override specific settings
 * const provider = await createLLMProvider({
 *   provider: 'openai',
 *   model: 'gpt-4-turbo',
 * });
 */
export async function createLLMProvider(config?: Partial<LLMConfig>): Promise<LLMProvider> {
  const resolvedConfig = resolveConfig(config);

  // Log configuration (safely)
  const safeConfig = getSafeConfigForLogging(resolvedConfig);
  console.log(`[LLM] Creating provider:`, safeConfig);

  try {
    switch (resolvedConfig.provider) {
      case 'gemini': {
        const { GeminiProvider } = await import('./providers/gemini');
        return new GeminiProvider(resolvedConfig);
      }

      case 'openai': {
        const { OpenAIProvider } = await import('./providers/openai');
        return new OpenAIProvider(resolvedConfig);
      }

      case 'ollama': {
        const { OllamaProvider } = await import('./providers/ollama');
        return new OllamaProvider(resolvedConfig);
      }

      case 'custom': {
        const { CustomProvider } = await import('./providers/custom');
        return new CustomProvider(resolvedConfig);
      }

      default:
        throw new LLMConfigError(
          `Unknown provider: ${resolvedConfig.provider}. Valid options: gemini, openai, ollama, custom`,
          resolvedConfig.provider
        );
    }
  } catch (error) {
    if (error instanceof LLMConfigError) {
      throw error;
    }
    throw new LLMConfigError(
      `Failed to load ${resolvedConfig.provider} provider: ${error instanceof Error ? error.message : String(error)}`,
      resolvedConfig.provider
    );
  }
}

// ============================================================================
// Singleton Instance (Optional)
// ============================================================================

let defaultProvider: LLMProvider | null = null;

/**
 * Get the default LLM provider instance (singleton)
 * Creates a new instance if one doesn't exist
 */
export async function getDefaultProvider(): Promise<LLMProvider> {
  if (!defaultProvider) {
    defaultProvider = await createLLMProvider();
  }
  return defaultProvider;
}

/**
 * Reset the default provider (useful for testing or config changes)
 */
export function resetDefaultProvider(): void {
  defaultProvider = null;
}
