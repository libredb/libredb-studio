/**
 * Storage Provider Factory
 * Creates the appropriate server storage provider based on STORAGE_PROVIDER env var.
 * Uses singleton pattern — one provider instance per process.
 */

import type { ServerStorageProvider, StorageConfigResponse } from './types';

let _provider: ServerStorageProvider | null = null;
let _initialized = false;

export type StorageProviderType = 'local' | 'sqlite' | 'postgres';

/**
 * Get the configured storage provider type from environment.
 * Returns 'local' if not set or invalid.
 */
export function getStorageProviderType(): StorageProviderType {
  const env = process.env.STORAGE_PROVIDER?.toLowerCase();
  if (env === 'sqlite' || env === 'postgres') return env;
  return 'local';
}

/**
 * Check if server-side storage is enabled.
 */
export function isServerStorageEnabled(): boolean {
  return getStorageProviderType() !== 'local';
}

/**
 * Get the storage configuration for the /api/storage/config endpoint.
 */
export function getStorageConfig(): StorageConfigResponse {
  const provider = getStorageProviderType();
  return {
    provider,
    serverMode: provider !== 'local',
  };
}

/**
 * Get or create the singleton server storage provider.
 * Returns null if STORAGE_PROVIDER is 'local' or not set.
 * The provider is automatically initialized on first call.
 */
export async function getStorageProvider(): Promise<ServerStorageProvider | null> {
  const providerType = getStorageProviderType();

  if (providerType === 'local') return null;

  if (_provider && _initialized) return _provider;

  switch (providerType) {
    case 'sqlite': {
      const { SQLiteStorageProvider } = await import('./providers/sqlite');
      _provider = new SQLiteStorageProvider();
      break;
    }
    case 'postgres': {
      const { PostgresStorageProvider } = await import('./providers/postgres');
      _provider = new PostgresStorageProvider();
      break;
    }
  }

  if (_provider && !_initialized) {
    await _provider.initialize();
    _initialized = true;
  }

  return _provider;
}

/**
 * Close and reset the singleton provider. Used for testing/cleanup.
 */
export async function closeStorageProvider(): Promise<void> {
  if (_provider) {
    await _provider.close();
    _provider = null;
    _initialized = false;
  }
}
