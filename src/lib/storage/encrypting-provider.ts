import { logger } from "@/lib/logger";
import { decryptConnections, encryptConnections } from "./connection-secrets";
import { encryptSecret, readSecret } from "./encryption";
import type {
  AccountUpdateOptions,
  AccountWriteOptions,
  PasskeyMatch,
  PasskeyRegistrationWrite,
  PasskeyRemovalWrite,
  PasskeySignInWrite,
  ServerStorageProvider,
  StorageCollection,
  StorageData,
  StoredAccount,
  StoredPasskey,
} from "./types";
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
 * Of the collections, only `connections` is touched. No other collection carries a credential
 * field: history and saved_queries hold SQL text (the product's data, not its secrets), audit_log
 * is already sanitized by src/lib/audit.ts, and the remaining eight hold metadata. Of the account
 * registry, only the TOTP secrets are sealed (see openFactor below). Nothing passkey-related is
 * sealed: a public key, a user handle and a name are not secrets.
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

/**
 * Not base32, so verifyTotp() rejects every code against it. A sealed factor the current key cannot
 * open must never read as null: null means "no second factor", and a rotated key would silently
 * turn MFA off. It reads as this instead, the account keeps asking for a code no one can produce,
 * and signs in again once an admin clears the factor (or ADMIN_PASSWORD_RESET does, for the env
 * admin). Written back by a later update, it stays unusable.
 */
const UNOPENABLE_FACTOR = "!unopenable";

function sealFactor(value: string | null): string | null {
  return value === null ? null : encryptSecret(value);
}

function openFactor(value: string | null, email: string): string | null {
  if (value === null) return null;
  const result = readSecret(value);
  if (result.kind !== "undecryptable") return result.value;
  logger.error(
    `The stored second factor of ${email} does not open with the current storage key, so the account cannot sign in until an admin clears it. Restore the previous JWT_SECRET (or STORAGE_ENCRYPTION_KEY) to recover it.`,
    undefined,
    { provider: "storage-encryption" },
  );
  return UNOPENABLE_FACTOR;
}

function sealAccount(account: StoredAccount): StoredAccount {
  return { ...account, totpSecret: sealFactor(account.totpSecret), totpPending: sealFactor(account.totpPending) };
}

function openAccount(account: StoredAccount): StoredAccount {
  return {
    ...account,
    totpSecret: openFactor(account.totpSecret, account.email),
    totpPending: openFactor(account.totpPending, account.email),
  };
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

  // Account rows: the password hash is already a KDF output and passes through. The TOTP secret
  // is not: it is the shared key that mints codes, so it is sealed like a connection password.
  async listAccounts(): Promise<StoredAccount[]> {
    return (await this.inner.listAccounts()).map(openAccount);
  }

  async getAccount(email: string): Promise<StoredAccount | null> {
    const account = await this.inner.getAccount(email);
    return account ? openAccount(account) : null;
  }

  insertAccount(account: StoredAccount): Promise<void> {
    return this.inner.insertAccount(sealAccount(account));
  }

  updateAccount(account: StoredAccount, options: AccountUpdateOptions): Promise<number> {
    return this.inner.updateAccount(sealAccount(account), options);
  }

  deleteAccount(email: string, options?: AccountWriteOptions): Promise<void> {
    return this.inner.deleteAccount(email, options);
  }

  listPasskeys(email: string): Promise<StoredPasskey[]> {
    return this.inner.listPasskeys(email);
  }

  countPasskeys(): Promise<Map<string, number>> {
    return this.inner.countPasskeys();
  }

  getPasskeyUserHandle(email: string): Promise<string | null> {
    return this.inner.getPasskeyUserHandle(email);
  }

  findPasskey(credentialId: string): Promise<PasskeyMatch | null> {
    return this.inner.findPasskey(credentialId);
  }

  insertPasskey(write: PasskeyRegistrationWrite): Promise<void> {
    return this.inner.insertPasskey(write);
  }

  recordPasskeySignIn(write: PasskeySignInWrite): Promise<void> {
    return this.inner.recordPasskeySignIn(write);
  }

  renamePasskey(email: string, id: string, name: string): Promise<boolean> {
    return this.inner.renamePasskey(email, id, name);
  }

  deletePasskey(write: PasskeyRemovalWrite): Promise<void> {
    return this.inner.deletePasskey(write);
  }
}

export function withCredentialEncryption(provider: ServerStorageProvider): ServerStorageProvider {
  return new CredentialEncryptingProvider(provider);
}
