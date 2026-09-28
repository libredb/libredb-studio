/**
 * The configured storage provider type.
 * Import-free, so the proxy's security header reading can ask for the storage type without loading storage.
 */

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
