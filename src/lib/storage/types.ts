import type { DatabaseConnection, QueryHistoryItem, SavedQuery, SchemaSnapshot, SavedChartConfig } from "../types";
import type { AuditEvent } from "../audit";
import type { MaskingConfig } from "../data-masking";
import type { ThresholdConfig } from "../monitoring-thresholds";

/**
 * All persistable collections and their data types.
 * Maps 1:1 with localStorage keys (minus the `libredb_` prefix).
 */
export interface StorageData {
  connections: DatabaseConnection[];
  history: QueryHistoryItem[];
  saved_queries: SavedQuery[];
  schema_snapshots: SchemaSnapshot[];
  saved_charts: SavedChartConfig[];
  active_connection_id: string | null;
  audit_log: AuditEvent[];
  masking_config: MaskingConfig;
  threshold_config: ThresholdConfig[];
  /** seedIds the user dismissed (deleted a managed:false seed copy) so it is not re-added. */
  dismissed_seeds: string[];
  /**
   * Connection ids the user has starred, kept separate from `connections` rather than as a
   * field on `DatabaseConnection`: a `managed:true` connection is always taken fresh from the
   * server on every load (see `mergeManagedConnections` in `use-connection-manager.ts`), so a
   * field on the connection object itself would be silently discarded on reload for exactly the
   * connections a user is most likely to want to favorite. A separate id list favorites
   * correctly regardless of who owns the connection, and a duplicated connection (which gets a
   * new id) does not inherit the original's favorite status for free.
   */
  favorite_connections: string[];
  /**
   * Connection ids in the user's preferred display order (#748), kept separate from
   * `connections` rather than as a field on `DatabaseConnection`: a `managed:true`
   * connection is always taken fresh from the server on every load (see
   * `mergeManagedConnections` in `use-connection-manager.ts`), so a field on the connection
   * object itself would be silently discarded on reload for exactly the connections a user
   * is most likely to have reordered.
   */
  connection_order: string[];
  /**
   * The user's own sections in the Connections panel (#1170), in display order. Kept out of
   * `DatabaseConnection` for the same reason as `favorite_connections` and `connection_order`:
   * a `managed:true` connection is replaced from the server on every load, so a group field on
   * the record would be discarded for exactly the seeded connections users most want to file.
   * Membership is a preference, not part of the connection. A connection is in at most one
   * group; one in none is "Ungrouped".
   */
  connection_groups: ConnectionGroup[];
}

export interface ConnectionGroup {
  id: string;
  name: string;
  collapsed: boolean;
  connectionIds: string[];
}

/** Collection names that can be synced to server storage */
export type StorageCollection = keyof StorageData;

/** All persistable collection names */
export const STORAGE_COLLECTIONS: StorageCollection[] = [
  "connections",
  "history",
  "saved_queries",
  "schema_snapshots",
  "saved_charts",
  "active_connection_id",
  "audit_log",
  "masking_config",
  "threshold_config",
  "dismissed_seeds",
  "favorite_connections",
  "connection_order",
  "connection_groups",
];

/**
 * Server-side storage provider interface.
 * Implements the Strategy Pattern — SQLite and PostgreSQL both implement this.
 */
export interface ServerStorageProvider extends PasskeyStore {
  /** Create tables if they don't exist */
  initialize(): Promise<void>;
  /** Get all collections for a user */
  getAllData(userId: string): Promise<Partial<StorageData>>;
  /** Get a single collection for a user */
  getCollection<K extends StorageCollection>(userId: string, collection: K): Promise<StorageData[K] | null>;
  /** Set a single collection for a user */
  setCollection<K extends StorageCollection>(userId: string, collection: K, data: StorageData[K]): Promise<void>;
  /** Merge multiple collections (used for migration) */
  mergeData(userId: string, data: Partial<StorageData>): Promise<void>;
  /** Health check */
  isHealthy(): Promise<boolean>;
  /** Cleanup resources */
  close(): Promise<void>;
  /** Every local account. Empty until the first seed. Not used for OIDC identities. */
  listAccounts(): Promise<StoredAccount[]>;
  /** One account by its stored email, or null. */
  getAccount(email: string): Promise<StoredAccount | null>;
  /**
   * Insert. The email is the primary key. Passkey rows still stored under that email are removed
   * first, in the same transaction.
   */
  insertAccount(account: StoredAccount): Promise<void>;
  /**
   * Replace the mutable columns while the row still has options.expected; otherwise
   * AccountWriteConflict and nothing is written. Does not rename. Resolves to the number of
   * passkeys removed, 0 unless clearPasskeys.
   */
  updateAccount(account: StoredAccount, options: AccountUpdateOptions): Promise<number>;
  /**
   * Remove the account and its `user_storage` rows; its passkeys and user handle go with it
   * through the schema's foreign keys. Disabling an account does not call this: a disabled
   * account keeps its rows so re-enabling restores them.
   */
  deleteAccount(email: string, options?: AccountWriteOptions): Promise<void>;
  /**
   * The store's credential envelope state, from its `storage_meta` row `credential_envelope`: no
   * row is `v1-accepted`, `v2` is `v1-retired`, and any other value throws by name (a store written
   * by a newer format).
   */
  readEnvelopeState(): Promise<CredentialEnvelopeState>;
  /**
   * The operator re-seal (docs/STORAGE.md, "Re-sealing the store"), in one transaction holding the
   * store's write lock: on a store already retired, nothing is read, written or backed up;
   * otherwise every `connections` row and every account's factors are passed to `rewrite`,
   * `rewrite.beforeRetire` runs, a complete backup of the store as it was is written under
   * `backupLabel`, the rows the rewrite changes are written, and the state becomes `v1-retired`.
   * Any error rolls every change back and is rethrown; a throw from `rewrite` leaves no backup
   * either.
   */
  rewriteStoredCredentials(
    rewrite: StoredCredentialRewrite,
    backupLabel: string,
  ): Promise<StoredCredentialRewriteResult>;
}

/**
 * Whether the store still opens version 1 envelopes and unsealed values (`v1-accepted`), or has
 * been re-sealed and refuses them by name (`v1-retired`).
 */
export type CredentialEnvelopeState = "v1-accepted" | "v1-retired";

/** The `storage_meta` key whose row records the credential envelope state. */
export const CREDENTIAL_ENVELOPE_KEY = "credential_envelope";
/** Its value once the operator re-seal retired version 1. */
export const RETIRED_ENVELOPE_MARKER = "v2";

/**
 * The state a `credential_envelope` row records: none is `v1-accepted`, `v2` is `v1-retired`, and
 * any other value throws by name, because a store written by a newer format must not be read as one
 * this version understands. The state is read when the store is first opened, at the first request
 * that needs it (or at boot when STORAGE_ENCRYPTION_RESEAL or STORAGE_ENCRYPTION_REQUIRE_V2 is
 * set), so the throw fails those requests; the health and readiness routes do not open the store.
 */
export function envelopeStateOf(marker: string | undefined): CredentialEnvelopeState {
  if (marker === undefined) return "v1-accepted";
  if (marker === RETIRED_ENVELOPE_MARKER) return "v1-retired";
  throw new Error(
    `The store's storage_meta row ${CREDENTIAL_ENVELOPE_KEY} is ${JSON.stringify(marker)}, a credential envelope state this version does not know; it was written by a newer version, so this one refuses to open the store, and every request that needs the store fails with this error.`,
  );
}

/** The sealed factor columns of one account row, as stored. */
export interface StoredFactorRow {
  email: string;
  totpSecret: string | null;
  totpPending: string | null;
}

/**
 * What the re-seal does to each stored row, called synchronously inside the provider's transaction.
 * Each returns the replacement, or null to leave the row as it is.
 */
export interface StoredCredentialRewrite {
  /** One user_storage row of collection `connections`: its owner and its `data` text as stored. */
  connections(userId: string, data: string): string | null;
  /** One account's factor columns as stored. */
  factors(row: StoredFactorRow): Pick<StoredFactorRow, "totpSecret" | "totpPending"> | null;
  /**
   * Called once after every row and account, before the state becomes `v1-retired`, inside the same transaction: a
   * throw rolls every change back and leaves no backup, so the re-seal can refuse to retire version 1 over what the
   * rows held.
   */
  beforeRetire(): void;
}

export type StoredCredentialRewriteResult =
  | { kind: "already-retired" }
  /** `backup` names where the complete copy of the store as it was is: a file path, or a table name pattern. */
  | { kind: "rewritten"; backup: string };

export interface AccountWriteOptions {
  /**
   * Write only if an enabled admin remains afterwards, decided inside the write's own transaction
   * with the admin rows locked, so two concurrent requests cannot each remove one of the last two.
   */
  keepEnabledAdmin?: boolean;
}

/** The version fields of an account row as a writer read it. */
export interface AccountVersion {
  sessionVersion: number;
  updatedAt: string;
}

export interface AccountUpdateOptions extends AccountWriteOptions {
  /** The row as the caller read it; the write applies only while the stored row still has these values. */
  expected: AccountVersion;
  /** Delete every passkey of the account in the same transaction, after the account row is written. */
  clearPasskeys?: boolean;
}

/** A conditional account write whose expected version no longer matched the stored row. Nothing was written. */
export class AccountWriteConflict extends Error {
  constructor() {
    super("The account row changed after it was read");
    this.name = "AccountWriteConflict";
  }
}

/**
 * A connections list a write refused, because one of its connections cannot be sealed for its place: a secret that is
 * not text, or a connection that has no binding. The message names the list index and never a value; the API answers it
 * as a 400, since the request, not the server, is at fault. Nothing was written.
 */
export class ConnectionWriteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionWriteRefused";
  }
}

export const PASSKEY_TRANSPORTS = ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"] as const;
export type PasskeyTransport = (typeof PASSKEY_TRANSPORTS)[number];

/** One WebAuthn credential of a stored account. `id` is internal; `credentialId` never leaves the server. */
export interface StoredPasskey {
  id: string;
  credentialId: string;
  accountEmail: string;
  /** base64url COSE_Key */
  publicKey: string;
  /** WebAuthn signature counter, unsigned 32-bit */
  signCount: number;
  transports: PasskeyTransport[];
  backupEligible: boolean;
  backupState: boolean;
  rpId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PasskeyMatch {
  passkey: StoredPasskey;
  userHandle: string;
}

export interface SpentChallenge {
  hash: string;
  expiresAt: string;
}

export interface PasskeyRegistrationWrite {
  passkey: StoredPasskey;
  userHandle: string;
  /** The account's session version the registration was confirmed under; the write refuses when the stored one differs. */
  expectedSessionVersion: number;
  /** The most passkeys the account may hold; the write refuses the one past it. */
  maxPasskeys: number;
  challenge: SpentChallenge;
  /** Spent challenges whose expiry is before this instant are purged first. */
  purgeSpentBefore: string;
}

export interface PasskeySignInWrite {
  id: string;
  /** The account the service read and will mint the session for; the write refuses unless it is unchanged. */
  email: string;
  expectedSessionVersion: number;
  expectedRole: StoredAccount["role"];
  signCount: number;
  backupState: boolean;
  usedAt: string;
  challenge: SpentChallenge;
  /** Spent challenges whose expiry is before this instant are purged first. */
  purgeSpentBefore: string;
}

export interface PasskeyRemovalWrite {
  email: string;
  id: string;
  /** The caller's session version; nothing is written unless the account still has it. */
  expectedSessionVersion: number;
  /** The session version the account moves to, decided by the service. */
  nextSessionVersion: number;
  updatedAt: string;
}

export type PasskeyRegistrationConflictReason =
  | "account_missing"
  | "session_changed"
  | "challenge_spent"
  | "passkey_limit"
  | "user_handle_changed"
  | "credential_registered";
export type PasskeySignInConflictReason =
  | "account_changed"
  | "challenge_spent"
  | "counter_not_increased"
  | "credential_missing";
export type PasskeyRemovalConflictReason = "session_changed" | "credential_missing";

/** A registration the store refused on its own invariants. Nothing was written. */
export class PasskeyRegistrationConflict extends Error {
  constructor(readonly reason: PasskeyRegistrationConflictReason) {
    super(`passkey registration refused: ${reason}`);
    this.name = "PasskeyRegistrationConflict";
  }
}

/** A sign-in the store refused on its own invariants. Nothing was written. */
export class PasskeySignInConflict extends Error {
  constructor(readonly reason: PasskeySignInConflictReason) {
    super(`passkey sign-in refused: ${reason}`);
    this.name = "PasskeySignInConflict";
  }
}

/** A removal the store refused on its own invariants. Nothing was written. */
export class PasskeyRemovalConflict extends Error {
  constructor(readonly reason: PasskeyRemovalConflictReason) {
    super(`passkey removal refused: ${reason}`);
    this.name = "PasskeyRemovalConflict";
  }
}

export interface PasskeyStore {
  /** The account's passkeys, oldest first. */
  listPasskeys(email: string): Promise<StoredPasskey[]>;
  /** Passkey count per account email; accounts with none are absent. */
  countPasskeys(): Promise<Map<string, number>>;
  /** The account's user handle, or null before its first passkey. */
  getPasskeyUserHandle(email: string): Promise<string | null>;
  /** One credential by its WebAuthn credential ID, with its owner's user handle, or null. */
  findPasskey(credentialId: string): Promise<PasskeyMatch | null>;
  /**
   * Check the account and its session version, purge old spent rows, spend the challenge, check
   * the limit, bind the user handle if the account has none, insert the credential: one transaction.
   */
  insertPasskey(write: PasskeyRegistrationWrite): Promise<void>;
  /**
   * Check the account is present, enabled and at the role and session version the caller read, purge
   * old spent rows, spend the challenge, advance counter, backup state and last use while the counter
   * increases: one transaction.
   */
  recordPasskeySignIn(write: PasskeySignInWrite): Promise<void>;
  /** Rename one passkey of the account; false when it has none with that id. */
  renamePasskey(email: string, id: string, name: string): Promise<boolean>;
  /** Move the account to the next session version while it has the caller's, then remove the passkey: one transaction. */
  deletePasskey(write: PasskeyRemovalWrite): Promise<void>;
}

/** A guarded account write that would have left no enabled admin. Nothing was written. */
export class LastAdminError extends Error {
  constructor() {
    super("The write would leave no enabled admin");
    this.name = "LastAdminError";
  }
}

/**
 * One local email/password account on the server store.
 * `passwordHash` is the scrypt encoding from src/lib/password-hash.ts, never the password; for an account
 * a launch created it is `launch-identity$<issuer>$<subject>` instead, each part base64url, which no password
 * matches (provisionLaunchAccount in src/lib/local-accounts.ts).
 * `totpPending` is an enrolment that has not been confirmed; login ignores it.
 */
export interface StoredAccount {
  email: string;
  passwordHash: string;
  role: "admin" | "user";
  totpSecret: string | null;
  totpPending: string | null;
  disabled: boolean;
  /**
   * Copied into each session token at login. Disabling, a role change and a password change
   * increment it, which ends every session minted before the change at its next request.
   */
  sessionVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** Storage config returned by /api/storage/config */
export interface StorageConfigResponse {
  provider: "local" | "sqlite" | "postgres";
  serverMode: boolean;
}

/** Event dispatched on storage mutations */
export interface StorageChangeDetail {
  collection: StorageCollection;
  data: unknown;
}
