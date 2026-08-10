/**
 * Storage Provider Factory
 * Creates the appropriate server storage provider based on STORAGE_PROVIDER env var.
 * Uses singleton pattern — one provider instance per process.
 */

import type { ServerStorageProvider, StorageConfigResponse } from "./types";
import { withCredentialEncryption } from "./encrypting-provider";

let _provider: ServerStorageProvider | null = null;
let _initialized = false;

export type StorageProviderType = "local" | "sqlite" | "postgres";

/**
 * Get the configured storage provider type from environment.
 * Returns 'local' if not set or invalid.
 */
export function getStorageProviderType(): StorageProviderType {
  const env = process.env.STORAGE_PROVIDER?.toLowerCase();
  if (env === "sqlite" || env === "postgres") return env;
  return "local";
}

/**
 * Check if server-side storage is enabled.
 */
export function isServerStorageEnabled(): boolean {
  return getStorageProviderType() !== "local";
}

/**
 * Get the storage configuration for the /api/storage/config endpoint.
 */
export function getStorageConfig(): StorageConfigResponse {
  const provider = getStorageProviderType();
  return {
    provider,
    serverMode: provider !== "local",
  };
}

/**
 * Get or create the singleton server storage provider.
 * Returns null if STORAGE_PROVIDER is 'local' or not set.
 * The provider is automatically initialized on first call.
 */
export async function getStorageProvider(): Promise<ServerStorageProvider | null> {
  const providerType = getStorageProviderType();

  if (providerType === "local") return null;

  if (_provider && _initialized) return _provider;

  // Credential encryption is installed HERE, at the one choke point every storage route goes
  // through, rather than inside the providers. Three call sites obtain a provider, all under
  // src/app/api/storage/, and all of them call this function - so there is no route-level way to
  // reach an unencrypted store, and a provider added later inherits the control by construction.
  switch (providerType) {
    case "sqlite": {
      const { SQLiteStorageProvider } = await import("./providers/sqlite");
      _provider = withCredentialEncryption(new SQLiteStorageProvider());
      break;
    }
    case "postgres": {
      const { PostgresStorageProvider } = await import("./providers/postgres");
      _provider = withCredentialEncryption(new PostgresStorageProvider());
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
