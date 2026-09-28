/**
 * SQLite Server Storage Provider
 * Uses better-sqlite3 (Node.js compatible, works in production runner).
 * WAL mode enabled for concurrent read performance.
 */

import { accountFromRow, type AccountRow } from "../account-row";
import { PASSKEY_COLUMNS, PASSKEY_COLUMNS_OF_C, passkeyFromRow, type PasskeyRow } from "../passkey-row";
import type {
  AccountUpdateOptions,
  AccountWriteOptions,
  PasskeyMatch,
  PasskeyRegistrationWrite,
  PasskeyRemovalWrite,
  PasskeySignInWrite,
  ServerStorageProvider,
  SpentChallenge,
  StorageCollection,
  StorageData,
  StoredAccount,
  StoredPasskey,
} from "../types";
import {
  AccountWriteConflict,
  LastAdminError,
  PasskeyRegistrationConflict,
  PasskeyRemovalConflict,
  PasskeySignInConflict,
  STORAGE_COLLECTIONS,
} from "../types";
import type BetterSqlite3 from "better-sqlite3";
import { logger } from "@/lib/logger";
import { DEFAULT_STORAGE_SQLITE_PATH } from "@/lib/data-dir";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Database: any;

/**
 * better-sqlite3 has shipped N-API prebuilds since v13, so its binding is no
 * longer tied to the ABI of the Node that installed it and this guard should
 * not fire through a normal install. It stays for the cases that still can:
 * a pinned older better-sqlite3 (v12 and earlier compiled per Node ABI), or a
 * node_modules assembled from mixed installs. Either way the raw failure reads
 * like an installation bug - translate it into an actionable message.
 *
 * Only the NODE_MODULE_VERSION text (emitted by Node's module-register
 * check) is treated as an ABI mismatch. A bare ERR_DLOPEN_FAILED is NOT
 * enough: missing shared libraries, a libc mismatch, or a corrupted file
 * also surface as ERR_DLOPEN_FAILED - on any Node version - and must keep
 * their original error rather than a misleading ABI claim.
 */
function isNodeAbiMismatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(message);
}

export class SQLiteStorageProvider implements ServerStorageProvider {
  private db: BetterSqlite3.Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || process.env.STORAGE_SQLITE_PATH || DEFAULT_STORAGE_SQLITE_PATH;
  }

  async initialize(): Promise<void> {
    try {
      // Dynamic import to avoid requiring better-sqlite3 when not needed
      if (!Database) {
        const mod = await import("better-sqlite3");
        Database = mod.default;
      }

      // Ensure directory exists
      const path = await import("path");
      const fs = await import("fs");
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.db = new Database(this.dbPath) as BetterSqlite3.Database;

      // Enable WAL mode for better concurrent read performance
      this.db!.pragma("journal_mode = WAL");

      // Passkeys follow their account only through ON DELETE CASCADE. better-sqlite3 13 is built
      // with SQLITE_DEFAULT_FOREIGN_KEYS=1, but enforcement is a per-connection setting, so it is
      // set and read back here rather than trusted to a build define.
      this.db!.pragma("foreign_keys = ON");
      if (this.db!.pragma("foreign_keys", { simple: true }) !== 1) {
        throw new Error("SQLite storage cannot enforce foreign keys, which passkeys need to follow their account");
      }

      // user_storage is per-user product data. accounts is the local identity registry (#784).
      this.db!.exec(`
        CREATE TABLE IF NOT EXISTS user_storage (
          user_id    TEXT NOT NULL,
          collection TEXT NOT NULL,
          data       TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, collection)
        );
        CREATE TABLE IF NOT EXISTS accounts (
          email         TEXT PRIMARY KEY,
          password_hash TEXT NOT NULL,
          role          TEXT NOT NULL,
          totp_secret   TEXT,
          totp_pending  TEXT,
          disabled      INTEGER NOT NULL DEFAULT 0,
          session_version INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS passkey_users (
          account_email TEXT PRIMARY KEY REFERENCES accounts(email) ON DELETE CASCADE,
          user_handle   TEXT NOT NULL UNIQUE,
          created_at    TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS passkey_credentials (
          id              TEXT PRIMARY KEY,
          credential_id   TEXT NOT NULL UNIQUE,
          account_email   TEXT NOT NULL REFERENCES passkey_users(account_email) ON DELETE CASCADE,
          public_key      TEXT NOT NULL,
          sign_count      INTEGER NOT NULL,
          transports      TEXT NOT NULL,
          backup_eligible INTEGER NOT NULL,
          backup_state    INTEGER NOT NULL,
          rp_id           TEXT NOT NULL,
          name            TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          last_used_at    TEXT
        );
        CREATE INDEX IF NOT EXISTS passkey_credentials_account ON passkey_credentials (account_email);
        CREATE TABLE IF NOT EXISTS passkey_spent_challenges (
          challenge_hash TEXT PRIMARY KEY,
          expires_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS passkey_spent_challenges_expiry ON passkey_spent_challenges (expires_at)
      `);
    } catch (error) {
      logger.error("SQLite storage initialization failed", error, { provider: "sqlite", path: this.dbPath });
      if (isNodeAbiMismatch(error)) {
        throw new Error(
          // Deliberately NOT phrased as a floor ("Node 24 or newer"): a native
          // binding loads only on the exact ABI it was built against, so a
          // NEWER Node fails here too and would read such a message as already
          // satisfied.
          `Server-side SQLite storage (STORAGE_PROVIDER=sqlite) cannot start on Node ${process.versions.node}: the better-sqlite3 native module in this install was built for a different Node ABI and cannot load here. ` +
            "better-sqlite3 13 ships N-API prebuilds that work across Node majors, so this normally means a pinned older better-sqlite3 or an incomplete node_modules - reinstall dependencies, or use STORAGE_PROVIDER=postgres or STORAGE_PROVIDER=local instead. " +
            `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async getAllData(userId: string): Promise<Partial<StorageData>> {
    this.ensureDb();
    const stmt = this.db!.prepare("SELECT collection, data FROM user_storage WHERE user_id = ?");
    const rows = stmt.all(userId) as { collection: string; data: string }[];

    const result: Partial<StorageData> = {};
    for (const row of rows) {
      try {
        (result as Record<string, unknown>)[row.collection] = JSON.parse(row.data);
      } catch {
        logger.warn("Skipping corrupted storage data", { provider: "sqlite", collection: row.collection });
      }
    }
    return result;
  }

  async getCollection<K extends StorageCollection>(userId: string, collection: K): Promise<StorageData[K] | null> {
    this.ensureDb();
    const stmt = this.db!.prepare("SELECT data FROM user_storage WHERE user_id = ? AND collection = ?");
    const row = stmt.get(userId, collection) as { data: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as StorageData[K];
    } catch {
      logger.warn("Corrupted data in storage collection", { provider: "sqlite", collection });
      return null;
    }
  }

  async setCollection<K extends StorageCollection>(userId: string, collection: K, data: StorageData[K]): Promise<void> {
    this.ensureDb();
    const stmt = this.db!.prepare(`
      INSERT INTO user_storage (user_id, collection, data, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT (user_id, collection)
      DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);
    stmt.run(userId, collection, JSON.stringify(data));
  }

  async mergeData(userId: string, data: Partial<StorageData>): Promise<void> {
    this.ensureDb();
    const stmt = this.db!.prepare(`
      INSERT INTO user_storage (user_id, collection, data, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT (user_id, collection)
      DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);

    const tx = this.db!.transaction(() => {
      for (const collection of STORAGE_COLLECTIONS) {
        const collectionData = (data as Record<string, unknown>)[collection];
        if (collectionData !== undefined) {
          stmt.run(userId, collection, JSON.stringify(collectionData));
        }
      }
    });
    tx();
  }

  async listAccounts(): Promise<StoredAccount[]> {
    this.ensureDb();
    const rows = this.db!.prepare(
      `SELECT email, password_hash, role, totp_secret, totp_pending, disabled, session_version, created_at, updated_at
       FROM accounts ORDER BY email`,
    ).all() as AccountRow[];
    return rows.map(accountFromRow);
  }

  async getAccount(email: string): Promise<StoredAccount | null> {
    this.ensureDb();
    const row = this.db!.prepare(
      `SELECT email, password_hash, role, totp_secret, totp_pending, disabled, session_version, created_at, updated_at
       FROM accounts WHERE email = ?`,
    ).get(email) as AccountRow | undefined;
    return row ? accountFromRow(row) : null;
  }

  async insertAccount(account: StoredAccount): Promise<void> {
    this.ensureDb();
    // Passkey rows under this email exist only when a writer outside Studio deleted the account
    // without foreign keys; they must not pass to the new account. A failed insert rolls both back.
    const insert = this.db!.transaction((): number => {
      const removed =
        this.db!.prepare("DELETE FROM passkey_credentials WHERE account_email = ?").run(account.email).changes +
        this.db!.prepare("DELETE FROM passkey_users WHERE account_email = ?").run(account.email).changes;
      this.db!.prepare(
        `INSERT INTO accounts (email, password_hash, role, totp_secret, totp_pending, disabled, session_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        account.email,
        account.passwordHash,
        account.role,
        account.totpSecret,
        account.totpPending,
        account.disabled ? 1 : 0,
        account.sessionVersion,
        account.createdAt,
        account.updatedAt,
      );
      return removed;
    });
    const removed = insert.immediate();
    if (removed > 0) {
      logger.warn(
        "Removed passkey rows that an account deleted outside Studio left under a reused email; SQLite deletes outside Studio must run PRAGMA foreign_keys = ON first",
        { provider: "sqlite", removed },
      );
    }
  }

  async updateAccount(account: StoredAccount, options: AccountUpdateOptions): Promise<number> {
    this.ensureDb();
    // IMMEDIATE takes the write lock before the check reads, so a second writer, in this process or
    // another, waits for the first to commit and then counts what it left. The account row is
    // written before any passkey row, the one lock order every account and passkey write follows.
    const write = this.db!.transaction((): number => {
      const applied = this.db!.prepare(
        `UPDATE accounts
         SET password_hash = ?, role = ?, totp_secret = ?, totp_pending = ?, disabled = ?, session_version = ?,
             updated_at = ?
         WHERE email = ? AND session_version = ? AND updated_at = ?`,
      ).run(
        account.passwordHash,
        account.role,
        account.totpSecret,
        account.totpPending,
        account.disabled ? 1 : 0,
        account.sessionVersion,
        account.updatedAt,
        account.email,
        options.expected.sessionVersion,
        options.expected.updatedAt,
      );
      if (applied.changes === 0) throw new AccountWriteConflict();
      const removed = options.clearPasskeys
        ? this.db!.prepare("DELETE FROM passkey_credentials WHERE account_email = ?").run(account.email).changes
        : 0;
      if (options.keepEnabledAdmin) this.assertEnabledAdmin();
      return removed;
    });
    return write.immediate();
  }

  async deleteAccount(email: string, options: AccountWriteOptions = {}): Promise<void> {
    this.ensureDb();
    // One transaction: an account removed without its rows would hand them to the next account
    // created with the same email.
    const tx = this.db!.transaction(() => {
      this.db!.prepare("DELETE FROM accounts WHERE email = ?").run(email);
      this.db!.prepare("DELETE FROM user_storage WHERE user_id = ?").run(email);
      if (options.keepEnabledAdmin) this.assertEnabledAdmin();
    });
    tx.immediate();
  }

  async listPasskeys(email: string): Promise<StoredPasskey[]> {
    this.ensureDb();
    const rows = this.db!.prepare(
      `SELECT ${PASSKEY_COLUMNS} FROM passkey_credentials WHERE account_email = ? ORDER BY created_at, id`,
    ).all(email) as PasskeyRow[];
    return rows.map(passkeyFromRow);
  }

  async countPasskeys(): Promise<Map<string, number>> {
    this.ensureDb();
    const rows = this.db!.prepare(
      "SELECT account_email, COUNT(*) AS n FROM passkey_credentials GROUP BY account_email",
    ).all() as { account_email: string; n: number }[];
    return new Map(rows.map((row) => [row.account_email, Number(row.n)]));
  }

  async getPasskeyUserHandle(email: string): Promise<string | null> {
    this.ensureDb();
    const row = this.db!.prepare("SELECT user_handle FROM passkey_users WHERE account_email = ?").get(email) as
      | { user_handle: string }
      | undefined;
    return row ? row.user_handle : null;
  }

  async findPasskey(credentialId: string): Promise<PasskeyMatch | null> {
    this.ensureDb();
    const row = this.db!.prepare(
      `SELECT ${PASSKEY_COLUMNS_OF_C}, u.user_handle
       FROM passkey_credentials c JOIN passkey_users u ON u.account_email = c.account_email
       WHERE c.credential_id = ?`,
    ).get(credentialId) as (PasskeyRow & { user_handle: string }) | undefined;
    return row ? { passkey: passkeyFromRow(row), userHandle: row.user_handle } : null;
  }

  async insertPasskey(write: PasskeyRegistrationWrite): Promise<void> {
    this.ensureDb();
    const { passkey } = write;
    // IMMEDIATE holds the write lock from the account read on, which is SQLite's form of locking
    // the account row first; any throw rolls every statement back.
    const register = this.db!.transaction(() => {
      const account = this.db!.prepare("SELECT session_version FROM accounts WHERE email = ?").get(
        passkey.accountEmail,
      ) as { session_version: number } | undefined;
      if (!account) throw new PasskeyRegistrationConflict("account_missing");
      if (Number(account.session_version) !== write.expectedSessionVersion) {
        throw new PasskeyRegistrationConflict("session_changed");
      }
      if (!this.spendChallenge(write.challenge, write.purgeSpentBefore)) {
        throw new PasskeyRegistrationConflict("challenge_spent");
      }
      const held = this.db!.prepare("SELECT COUNT(*) AS n FROM passkey_credentials WHERE account_email = ?").get(
        passkey.accountEmail,
      ) as { n: number };
      if (held.n >= write.maxPasskeys) throw new PasskeyRegistrationConflict("passkey_limit");
      this.db!.prepare(
        "INSERT INTO passkey_users (account_email, user_handle, created_at) VALUES (?, ?, ?) ON CONFLICT (account_email) DO NOTHING",
      ).run(passkey.accountEmail, write.userHandle, passkey.createdAt);
      const bound = this.db!.prepare("SELECT user_handle FROM passkey_users WHERE account_email = ?").get(
        passkey.accountEmail,
      ) as { user_handle: string };
      if (bound.user_handle !== write.userHandle) throw new PasskeyRegistrationConflict("user_handle_changed");
      const inserted = this.db!.prepare(
        `INSERT INTO passkey_credentials (${PASSKEY_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (credential_id) DO NOTHING`,
      ).run(
        passkey.id,
        passkey.credentialId,
        passkey.accountEmail,
        passkey.publicKey,
        passkey.signCount,
        JSON.stringify(passkey.transports),
        passkey.backupEligible ? 1 : 0,
        passkey.backupState ? 1 : 0,
        passkey.rpId,
        passkey.name,
        passkey.createdAt,
        passkey.lastUsedAt,
      );
      if (inserted.changes === 0) throw new PasskeyRegistrationConflict("credential_registered");
    });
    register.immediate();
  }

  async recordPasskeySignIn(write: PasskeySignInWrite): Promise<void> {
    this.ensureDb();
    const record = this.db!.transaction(() => {
      if (!this.spendChallenge(write.challenge, write.purgeSpentBefore)) {
        throw new PasskeySignInConflict("challenge_spent");
      }
      // One guarded statement, so two sign-ins racing on one credential can never lower the counter.
      const advanced = this.db!.prepare(
        `UPDATE passkey_credentials SET sign_count = ?, backup_state = ?, last_used_at = ?
         WHERE id = ? AND ((sign_count = 0 AND ? = 0) OR sign_count < ?)`,
      ).run(write.signCount, write.backupState ? 1 : 0, write.usedAt, write.id, write.signCount, write.signCount);
      if (advanced.changes > 0) return;
      const exists = this.db!.prepare("SELECT 1 FROM passkey_credentials WHERE id = ?").get(write.id);
      throw new PasskeySignInConflict(exists ? "counter_not_increased" : "credential_missing");
    });
    record.immediate();
  }

  async renamePasskey(email: string, id: string, name: string): Promise<boolean> {
    this.ensureDb();
    const renamed = this.db!.prepare("UPDATE passkey_credentials SET name = ? WHERE id = ? AND account_email = ?").run(
      name,
      id,
      email,
    );
    return renamed.changes > 0;
  }

  async deletePasskey(write: PasskeyRemovalWrite): Promise<void> {
    this.ensureDb();
    // The account row first, then the credential: the lock order of every account and passkey write.
    const remove = this.db!.transaction(() => {
      const moved = this.db!.prepare(
        "UPDATE accounts SET session_version = ?, updated_at = ? WHERE email = ? AND session_version = ?",
      ).run(write.nextSessionVersion, write.updatedAt, write.email, write.expectedSessionVersion);
      if (moved.changes === 0) throw new PasskeyRemovalConflict("session_changed");
      const deleted = this.db!.prepare("DELETE FROM passkey_credentials WHERE id = ? AND account_email = ?").run(
        write.id,
        write.email,
      );
      if (deleted.changes === 0) throw new PasskeyRemovalConflict("credential_missing");
    });
    remove.immediate();
  }

  /** Inside a write transaction: purge old spent rows, then spend this one; false when it was spent. */
  private spendChallenge(challenge: SpentChallenge, purgeSpentBefore: string): boolean {
    this.db!.prepare("DELETE FROM passkey_spent_challenges WHERE expires_at < ?").run(purgeSpentBefore);
    const spent = this.db!.prepare(
      "INSERT INTO passkey_spent_challenges (challenge_hash, expires_at) VALUES (?, ?) ON CONFLICT (challenge_hash) DO NOTHING",
    ).run(challenge.hash, challenge.expiresAt);
    return spent.changes > 0;
  }

  /** Inside a write transaction: throwing rolls the write back. */
  private assertEnabledAdmin(): void {
    const row = this.db!.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND disabled = 0").get() as {
      n: number;
    };
    if (row.n === 0) throw new LastAdminError();
  }

  async isHealthy(): Promise<boolean> {
    try {
      this.ensureDb();
      const result = this.db!.prepare("SELECT 1 as ok").get() as { ok: number };
      return result?.ok === 1;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureDb(): void {
    if (!this.db) {
      throw new Error("SQLite storage not initialized. Call initialize() first.");
    }
  }
}
