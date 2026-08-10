import { logger } from "@/lib/logger";
import { decryptConnections, encryptConnections } from "./connection-secrets";
import type { ServerStorageProvider, StorageCollection, StorageData } from "./types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * Credential encryption, applied ABOVE the ServerStorageProvider boundary.
 *
 * Why here and not inside each provider: one implementation means sqlite and postgres cannot
 * drift, a third provider inherits the control instead of having to remember it, and the
 * ciphertext stays portable so copying rows from a SQLite store into PostgreSQL still opens.
 * Neither shipped provider knows this exists; both simply receive a connection list whose secret
 * fields are already sealed and JSON.stringify it into their `data` column.
 *
 * Only `connections` is touched. No other collection carries a credential field: history and
 * saved_queries hold SQL text (the product's data, not its secrets), audit_log is already
 * sanitized by src/lib/audit.ts, and the remaining six hold metadata.
 */

const CONNECTIONS: StorageCollection = "connections";

/**
 * Quoted verbatim in docs/STORAGE.md's troubleshooting section, and exported so the doc and the
 * code cannot drift into describing different messages.
 */
export const UNDECRYPTABLE_WARNING_PREFIX = "Stored connection secrets could not be decrypted";

/**
 * One line per read, carrying a count - not one line per field. A read happens on every page load
 * through the sync hook, and a per-field line would turn a single misconfiguration into a log
 * flood that buries the one thing the operator needs to see.
 */
function reportUndecryptable(count: number): void {
  if (count === 0) return;
  logger.warn(
    `${UNDECRYPTABLE_WARNING_PREFIX}: ${count} field(s) were omitted. Restore the previous JWT_SECRET (or STORAGE_ENCRYPTION_KEY) BEFORE the app writes again, or re-enter the affected credentials.`,
    { provider: "storage-encryption" },
  );
}

class CredentialEncryptingProvider implements ServerStorageProvider {
  constructor(private readonly inner: ServerStorageProvider) {}

  initialize(): Promise<void> {
    return this.inner.initialize();
  }

  isHealthy(): Promise<boolean> {
    return this.inner.isHealthy();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async getAllData(userId: string): Promise<Partial<StorageData>> {
    const data = await this.inner.getAllData(userId);
    if (!data.connections) return data;
    const { connections, undecryptable } = decryptConnections(data.connections);
    reportUndecryptable(undecryptable);
    return { ...data, connections };
  }

  async getCollection<K extends StorageCollection>(userId: string, collection: K): Promise<StorageData[K] | null> {
    const value = await this.inner.getCollection(userId, collection);
    if (collection !== CONNECTIONS || value === null) return value;
    // TypeScript cannot narrow StorageData[K] from a runtime comparison on K, so the two casts are
    // unavoidable; the runtime guard above is what makes them sound.
    const { connections, undecryptable } = decryptConnections(value as DatabaseConnection[]);
    reportUndecryptable(undecryptable);
    return connections as StorageData[K];
  }

  setCollection<K extends StorageCollection>(userId: string, collection: K, data: StorageData[K]): Promise<void> {
    if (collection !== CONNECTIONS) return this.inner.setCollection(userId, collection, data);
    const sealed = encryptConnections(data as DatabaseConnection[]) as StorageData[K];
    return this.inner.setCollection(userId, collection, sealed);
  }

  mergeData(userId: string, data: Partial<StorageData>): Promise<void> {
    if (!data.connections) return this.inner.mergeData(userId, data);
    return this.inner.mergeData(userId, { ...data, connections: encryptConnections(data.connections) });
  }
}

export function withCredentialEncryption(provider: ServerStorageProvider): ServerStorageProvider {
  return new CredentialEncryptingProvider(provider);
}
