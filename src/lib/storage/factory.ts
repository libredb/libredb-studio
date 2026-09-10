/**
 * Storage Provider Factory
 * Creates the appropriate server storage provider based on STORAGE_PROVIDER env var.
 * Uses singleton pattern — one provider instance per process.
 */

import type { ServerStorageProvider, StorageConfigResponse } from "./types";
import { withCredentialEncryption } from "./encrypting-provider";

let _provider: ServerStorageProvider | null = null;
let _initialized = false;
/**
 * The in-flight initialization, if any. The first caller to arrive when no
 * provider exists starts exactly one build+initialize and every concurrent
 * caller awaits the SAME promise — otherwise two overlapping first requests
 * (e.g. the page-load `GET /api/storage` racing a `PUT /api/storage/[collection]`)
 * each construct and initialize a provider, and the second assignment silently
 * overwrites the first mid-initialize, leaking its connections.
 */
let _initPromise: Promise<ServerStorageProvider | null> | null = null;

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

  // Concurrent first callers share one build+initialize: the promise is
  // memoized the moment the first caller starts it, so there is no window in
  // which a second caller can fall through and build a duplicate provider.
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
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
  })();

  // A failed initialization must not be memoized: the next request should
  // retry from scratch rather than await a rejected promise forever.
  try {
    return await _initPromise;
  } catch (error) {
    _initPromise = null;
    throw error;
  }
}

/**
 * Close and reset the singleton provider. Used for testing/cleanup.
 */
export async function closeStorageProvider(): Promise<void> {
  _initPromise = null;
  if (_provider) {
    await _provider.close();
    _provider = null;
    _initialized = false;
  }
}
