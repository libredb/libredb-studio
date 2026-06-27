/**
 * LLM Provider Module
 * Strategy Pattern implementation for multi-provider LLM support
 *
 * @example
 * import { createLLMProvider } from '@/lib/llm';
 *
 * const provider = createLLMProvider();
 *
 * const stream = await provider.stream({
 *   messages: [
 *     { role: 'system', content: 'You are a helpful assistant.' },
 *     { role: 'user', content: 'Hello!' }
 *   ]
 * });
 */

// ============================================================================
// Factory (Primary API)
// ============================================================================

export { createLLMProvider } from "./factory";

// ============================================================================
// Types & Interfaces
// ============================================================================

export type {
  LLMProviderType,
  LLMConfig,
  LLMMessage,
  LLMMessageRole,
  LLMStreamOptions,
  LLMProvider,
} from "./types";

// ============================================================================
// Provider Classes (Lazy Loaded)
// ============================================================================
// NOTE: Individual providers are NOT exported statically to reduce memory usage.
// They are dynamically imported when needed via createLLMProvider().
//
// If you need direct access to a provider class, import it explicitly:
//   import { GeminiProvider } from '@/lib/llm/providers/gemini';
//   import { OpenAIProvider } from '@/lib/llm/providers/openai';
//   import { OllamaProvider } from '@/lib/llm/providers/ollama';
//   import { CustomProvider } from '@/lib/llm/providers/custom';
// ============================================================================
