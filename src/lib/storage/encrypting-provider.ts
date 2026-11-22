import { logger } from "@/lib/logger";
import { decryptConnections, encryptConnections, type OmittedSecret } from "./connection-secrets";
import { readStoredSecret, sealSecret } from "./encryption";
import { type AccountFactorField, accountBinding } from "./envelope-binding";
import { requiresVersionTwo, VERSION_TWO_NOT_RECORDED } from "./envelope-settings";
import type {
  AccountUpdateOptions,
  AccountWriteOptions,
  CredentialEnvelopeState,
  PasskeyMatch,
  PasskeyRegistrationWrite,
  PasskeyRemovalWrite,
  PasskeySignInWrite,
  ServerStorageProvider,
  StorageCollection,
  StorageData,
  StoredAccount,
  StoredCredentialRewrite,
  StoredCredentialRewriteResult,
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
 *
 * Every value is sealed for its place (./envelope-binding.ts): a connection's for the row's owner
 * (the `userId` each method receives, which the route derived from the session), the connection's
 * id, the field and its identity fields; a factor for the account's email and the field. Whether a
 * version 1 envelope or an unsealed value still opens is the store's envelope state, decided ONCE, in
 * initialize: the factory memoizes one provider per process, so a read never queries it, and a
 * process observes another replica's re-seal at its next restart, which the re-seal procedure
 * performs (docs/STORAGE.md, "Re-sealing the store"). With STORAGE_ENCRYPTION_REQUIRE_V2 set, the
 * state is `v1-retired` whatever the store records.
 */

const CONNECTIONS: StorageCollection = "connections";

/**
 * Quoted verbatim in docs/STORAGE.md's troubleshooting section, and exported so the doc and the
 * code cannot drift into describing different messages.
 */
export const UNDECRYPTABLE_WARNING_PREFIX = "Stored connection secrets could not be decrypted";

/** Logged once per process, at initialize, while the store still opens version 1 envelopes and unsealed values. */
export const V1_ACCEPTED_WARNING =
  "Stored credentials still accept the version 1 envelope and unsealed values. Once every server runs this version, back up the store, start once with STORAGE_ENCRYPTION_RESEAL=true and without STORAGE_ENCRYPTION_REQUIRE_V2 to re-seal and retire version 1, then remove STORAGE_ENCRYPTION_RESEAL, set STORAGE_ENCRYPTION_REQUIRE_V2=true and start again (docs/STORAGE.md, Re-sealing the store).";

/** Logged once per process, at initialize, when the store records version 1 as retired and STORAGE_ENCRYPTION_REQUIRE_V2 is not set. */
export const RETIRED_IN_STORE_WARNING =
  "The store records that version 1 is retired, but that is recorded only in the store: remove STORAGE_ENCRYPTION_RESEAL if it is set, set STORAGE_ENCRYPTION_REQUIRE_V2=true and start again, to have the server refuse version 1 and unsealed values whatever the store holds (docs/STORAGE.md, Re-sealing the store).";

const UNOPENABLE_ADVICE =
  "A value marked unopenable does not open for the place it is stored in with the current key: restore the previous JWT_SECRET (or STORAGE_ENCRYPTION_KEY) BEFORE the app writes again, or re-enter the affected credentials.";
const RETIRED_ADVICE =
  "A value marked retired is a version 1 or unsealed value, which this store refuses since STORAGE_ENCRYPTION_RESEAL retired version 1, or because STORAGE_ENCRYPTION_REQUIRE_V2 is set. One a re-seal run with leave-unopened left because the key then in use did not open it, or one an older server wrote after a downgrade, comes back by deleting the store's storage_meta row credential_envelope with every server stopped and re-sealing under the key that sealed it in one start with STORAGE_ENCRYPTION_RESEAL set and STORAGE_ENCRYPTION_REQUIRE_V2 not set, then setting STORAGE_ENCRYPTION_REQUIRE_V2 again; any other one is re-entered (docs/STORAGE.md, Values refused as retired after the re-seal).";
const MIXED_ADVICE =
  "A value marked mixed is a version 1 or unsealed value in a connection whose other values are sealed as v2, which this version never writes: it was put there outside Studio, so re-enter the affected credentials.";
const NOT_TEXT_ADVICE =
  "A value marked not-text is a number, a boolean, a list or an object where a credential is stored as text: it was put there outside Studio, so re-enter the affected credentials.";
const UNBINDABLE_ADVICE =
  "A value marked unbindable belongs to a connection whose id or identity fields nest deeper than any connection does, so no sealed value can be bound to it: delete that connection and create it again.";

const READ_BEFORE_INITIALIZE =
  "Stored credentials were read before initialize: the store's envelope state is read there, so call initialize() first.";

/** An id as a report line names it: a string as it is, any other JSON value as its JSON text. */
function idText(id: unknown): string {
  return typeof id === "string" ? id : JSON.stringify(id);
}

/**
 * One line per read, naming every omitted value as `<connection id> <field path> (<reason>)`, not
 * one line per field. A read happens on every page load through the sync hook, and a per-field line
 * would turn a single misconfiguration into a log flood that buries the one thing the operator
 * needs to see. The advice follows the reasons present.
 */
function reportOmitted(omitted: OmittedSecret[]): void {
  if (omitted.length === 0) return;
  const names = omitted.map(({ id, path, reason }) => `${idText(id)} ${path} (${reason})`).join(", ");
  const advice = (
    [
      ["unopenable", UNOPENABLE_ADVICE],
      ["retired", RETIRED_ADVICE],
      ["mixed", MIXED_ADVICE],
      ["not-text", NOT_TEXT_ADVICE],
      ["unbindable", UNBINDABLE_ADVICE],
    ] as const
  )
    .filter(([reason]) => omitted.some((entry) => entry.reason === reason))
    .map(([, line]) => line);
  logger.warn(
    `${UNDECRYPTABLE_WARNING_PREFIX}: ${omitted.length} field(s) were omitted: ${names}. ${advice.join(" ")}`,
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

function sealFactor(value: string | null, email: string, field: AccountFactorField): string | null {
  return value === null ? null : sealSecret(value, accountBinding(email).field(field));
}

function openFactor(
  value: string | null,
  email: string,
  field: AccountFactorField,
  state: CredentialEnvelopeState,
): string | null {
  if (value === null) return null;
  const read = readStoredSecret(value, accountBinding(email).field(field), state);
  if (read.kind === "opened") return read.value;
  logger.error(
    `The stored second factor of ${email} (${field}) does not open for this account (${read.reason}), so the account cannot sign in until an admin clears it. For unopenable, restore the previous JWT_SECRET (or STORAGE_ENCRYPTION_KEY) to recover it.`,
    undefined,
    { provider: "storage-encryption" },
  );
  return UNOPENABLE_FACTOR;
}

/** Seals both factors for the account's email on every insert and update. The email never changes (updateAccount does not rename). */
function sealAccount(account: StoredAccount): StoredAccount {
  return {
    ...account,
    totpSecret: sealFactor(account.totpSecret, account.email, "totpSecret"),
    totpPending: sealFactor(account.totpPending, account.email, "totpPending"),
  };
}

function openAccount(account: StoredAccount, state: CredentialEnvelopeState): StoredAccount {
  return {
    ...account,
    totpSecret: openFactor(account.totpSecret, account.email, "totpSecret", state),
    totpPending: openFactor(account.totpPending, account.email, "totpPending", state),
  };
}

class CredentialEncryptingProvider implements ServerStorageProvider {
  /** The store's envelope state, read once by initialize; null before it. */
  private state: CredentialEnvelopeState | null = null;

  constructor(private readonly inner: ServerStorageProvider) {}

  /**
   * Opens the inner store and decides the envelope state for the life of this provider. With
   * STORAGE_ENCRYPTION_REQUIRE_V2 set, the state is `v1-retired` whatever the store's marker says, and a store with no
   * marker is refused by name whatever STORAGE_ENCRYPTION_RESEAL says, so no re-seal runs on it (./reseal-at-boot.ts).
   * Without the setting, the marker decides.
   */
  async initialize(): Promise<void> {
    const required = requiresVersionTwo();
    await this.inner.initialize();
    const recorded = await this.inner.readEnvelopeState();
    if (required) {
      if (recorded === "v1-accepted") throw new Error(VERSION_TWO_NOT_RECORDED);
      this.state = "v1-retired";
      return;
    }
    this.state = recorded;
    logger.warn(recorded === "v1-accepted" ? V1_ACCEPTED_WARNING : RETIRED_IN_STORE_WARNING, {
      provider: "storage-encryption",
    });
  }

  /** The state initialize read; a read of a credential before it is refused rather than guessed. */
  private envelopeState(): CredentialEnvelopeState {
    if (this.state === null) throw new Error(READ_BEFORE_INITIALIZE);
    return this.state;
  }

  readEnvelopeState(): Promise<CredentialEnvelopeState> {
    return this.inner.readEnvelopeState();
  }

  /** The re-seal, in the inner store; once it succeeds, this process reads version 1 as retired at once. */
  async rewriteStoredCredentials(
    rewrite: StoredCredentialRewrite,
    backupLabel: string,
  ): Promise<StoredCredentialRewriteResult> {
    const result = await this.inner.rewriteStoredCredentials(rewrite, backupLabel);
    this.state = "v1-retired";
    return result;
  }

  isHealthy(): Promise<boolean> {
    return this.inner.isHealthy();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async getAllData(userId: string): Promise<Partial<StorageData>> {
    const state = this.envelopeState();
    const data = await this.inner.getAllData(userId);
    if (!data.connections) return data;
    const { connections, omitted } = decryptConnections(userId, data.connections, state);
    reportOmitted(omitted);
    return { ...data, connections };
  }

  async getCollection<K extends StorageCollection>(userId: string, collection: K): Promise<StorageData[K] | null> {
    const state = this.envelopeState();
    const value = await this.inner.getCollection(userId, collection);
    if (collection !== CONNECTIONS || value === null) return value;
    // TypeScript cannot narrow StorageData[K] from a runtime comparison on K, so the two casts are
    // unavoidable; the runtime guard above is what makes them sound.
    const { connections, omitted } = decryptConnections(userId, value as DatabaseConnection[], state);
    reportOmitted(omitted);
    return connections as StorageData[K];
  }

  setCollection<K extends StorageCollection>(userId: string, collection: K, data: StorageData[K]): Promise<void> {
    if (collection !== CONNECTIONS) return this.inner.setCollection(userId, collection, data);
    const sealed = encryptConnections(userId, data as DatabaseConnection[]) as StorageData[K];
    return this.inner.setCollection(userId, collection, sealed);
  }

  mergeData(userId: string, data: Partial<StorageData>): Promise<void> {
    if (!data.connections) return this.inner.mergeData(userId, data);
    return this.inner.mergeData(userId, { ...data, connections: encryptConnections(userId, data.connections) });
  }

  // Account rows: the password hash is already a KDF output and passes through. The TOTP secret
  // is not: it is the shared key that mints codes, so it is sealed like a connection password.
  async listAccounts(): Promise<StoredAccount[]> {
    const state = this.envelopeState();
    return (await this.inner.listAccounts()).map((account) => openAccount(account, state));
  }

  async getAccount(email: string): Promise<StoredAccount | null> {
    const state = this.envelopeState();
    const account = await this.inner.getAccount(email);
    return account ? openAccount(account, state) : null;
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
