// src/exports/providers.ts
// Re-export database and LLM provider factories
// `withOneShotTunnel` is part of the surface on purpose: `createDatabaseProvider` alone
// does not open a connection's SSH tunnel (only the caching entry points do), so an
// embedder that builds a provider and connects it needs the scope to reach a tunnelled
// database at all. See its doc comment in ../lib/db/factory and issue #457.
export {
  createDatabaseProvider,
  getOrCreateProvider,
  removeProvider,
  clearProviderCache,
  getProviderCacheStats,
  withOneShotTunnel,
} from "../lib/db/factory";
export { createLLMProvider, getDefaultProvider, resetDefaultProvider } from "../lib/llm/factory";
