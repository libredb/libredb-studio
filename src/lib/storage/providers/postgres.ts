/**
 * PostgreSQL Server Storage Provider
 * Uses the existing `pg` package (already a project dependency).
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
import { logger } from "@/lib/logger";

let Pool: typeof import("pg").Pool;
type PoolClient = import("pg").PoolClient;

const PERMISSION_PROBLEM =
  "PostgreSQL storage cannot create or check its tables: the user in STORAGE_POSTGRES_URL lacks a privilege. It needs CREATE on the schema, and REFERENCES on accounts to create the passkey tables, or a DBA creates passkey_users, passkey_credentials and passkey_spent_challenges with their two indexes first (docs/STORAGE.md, Manual Table Creation).";

// PostgreSQL checks that the caller owns the table before it honours IF NOT EXISTS on CREATE
// INDEX, so an app user that does not own a DBA-created table fails on an index that exists.
// initialize() therefore creates an index only when the schema lacks it.
const PASSKEY_INDEXES: Record<string, string> = {
  passkey_credentials_account:
    "CREATE INDEX IF NOT EXISTS passkey_credentials_account ON passkey_credentials (account_email)",
  passkey_spent_challenges_expiry:
    "CREATE INDEX IF NOT EXISTS passkey_spent_challenges_expiry ON passkey_spent_challenges (expires_at)",
};

// PostgreSQL SQLSTATE insufficient_privilege.
const INSUFFICIENT_PRIVILEGE = "42501";

export class PostgresStorageProvider implements ServerStorageProvider {
  private pool: InstanceType<typeof import("pg").Pool> | null = null;
  private connectionString: string;

  constructor(connectionString?: string) {
    this.connectionString = connectionString || process.env.STORAGE_POSTGRES_URL || "";
  }

  async initialize(): Promise<void> {
    if (!this.connectionString) {
      throw new Error("STORAGE_POSTGRES_URL is required when STORAGE_PROVIDER=postgres");
    }

    // Dynamic import to avoid requiring pg when not needed
    if (!Pool) {
      const pg = await import("pg");
      Pool = pg.Pool;
    }

    this.pool = new Pool({
      connectionString: this.connectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      ssl: this.buildSSLConfig(),
    });

    // An idle client the server drops has no query to reject, so `pg` destroys it and
    // emits on the pool; an `error` event with no listener is an uncaught exception. This
    // pool is long-lived and serves every request while STORAGE_PROVIDER=postgres, so
    // without this handler a dropped idle connection crashes the server (#298). The
    // client is already gone — log it and let the pool open a fresh one on next acquire.
    this.pool.on("error", (error: unknown) => {
      logger.error("PostgreSQL storage pool client error", error, { provider: "postgres" });
    });

    // Create table
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS user_storage (
          user_id    TEXT NOT NULL,
          collection TEXT NOT NULL,
          data       TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
          sign_count      BIGINT NOT NULL,
          transports      TEXT NOT NULL,
          backup_eligible INTEGER NOT NULL,
          backup_state    INTEGER NOT NULL,
          rp_id           TEXT NOT NULL,
          name            TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          last_used_at    TEXT
        );
        CREATE TABLE IF NOT EXISTS passkey_spent_challenges (
          challenge_hash TEXT PRIMARY KEY,
          expires_at     TEXT NOT NULL
        )
      `);
      const missing = await this.pool.query(
        "SELECT index_name FROM unnest($1::text[]) AS wanted(index_name) WHERE to_regclass(index_name) IS NULL",
        [Object.keys(PASSKEY_INDEXES)],
      );
      for (const { index_name } of missing.rows as { index_name: string }[]) {
        // oxlint-disable-next-line no-await-in-loop -- one DDL statement at a time on the pool, in a fixed order.
        await this.pool.query(PASSKEY_INDEXES[index_name]);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("does not support SSL")) {
        throw new Error(
          "PostgreSQL storage connection failed: server does not support SSL. Add ?sslmode=disable to STORAGE_POSTGRES_URL for local PostgreSQL.",
          { cause: error },
        );
      }
      logger.error("PostgreSQL storage initialization failed", error, { provider: "postgres" });
      // PostgreSQL checks CREATE on the schema even when every table already exists, so a
      // missing grant stops every start; say which grants and where the manual DDL lives.
      if ((error as { code?: string }).code === INSUFFICIENT_PRIVILEGE) {
        throw new Error(PERMISSION_PROBLEM, { cause: error });
      }
      throw error;
    }
  }

  async getAllData(userId: string): Promise<Partial<StorageData>> {
    this.ensurePool();
    const { rows } = await this.pool!.query("SELECT collection, data FROM user_storage WHERE user_id = $1", [userId]);

    const result: Partial<StorageData> = {};
    for (const row of rows) {
      try {
        (result as Record<string, unknown>)[row.collection] = JSON.parse(row.data);
      } catch {
        logger.warn("Skipping corrupted storage data", { provider: "postgres", collection: row.collection });
      }
    }
    return result;
  }

  async getCollection<K extends StorageCollection>(userId: string, collection: K): Promise<StorageData[K] | null> {
    this.ensurePool();
    const { rows } = await this.pool!.query("SELECT data FROM user_storage WHERE user_id = $1 AND collection = $2", [
      userId,
      collection,
    ]);
    if (rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].data) as StorageData[K];
    } catch {
      logger.warn("Corrupted data in storage collection", { provider: "postgres", collection });
      return null;
    }
  }

  async setCollection<K extends StorageCollection>(userId: string, collection: K, data: StorageData[K]): Promise<void> {
    this.ensurePool();
    await this.pool!.query(
      `INSERT INTO user_storage (user_id, collection, data, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, collection)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [userId, collection, JSON.stringify(data)],
    );
  }

  async mergeData(userId: string, data: Partial<StorageData>): Promise<void> {
    this.ensurePool();
    await this.transaction(async (client) => {
      for (const collection of STORAGE_COLLECTIONS) {
        const collectionData = (data as Record<string, unknown>)[collection];
        if (collectionData !== undefined) {
          await client.query(
            `INSERT INTO user_storage (user_id, collection, data, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (user_id, collection)
             DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
            [userId, collection, JSON.stringify(collectionData)],
          );
        }
      }
    });
  }

  async listAccounts(): Promise<StoredAccount[]> {
    this.ensurePool();
    const { rows } = await this.pool!.query(
      `SELECT email, password_hash, role, totp_secret, totp_pending, disabled, session_version, created_at, updated_at
       FROM accounts ORDER BY email`,
    );
    return (rows as AccountRow[]).map(accountFromRow);
  }

  async getAccount(email: string): Promise<StoredAccount | null> {
    this.ensurePool();
    const { rows } = await this.pool!.query(
      `SELECT email, password_hash, role, totp_secret, totp_pending, disabled, session_version, created_at, updated_at
       FROM accounts WHERE email = $1`,
      [email],
    );
    const row = (rows as AccountRow[])[0];
    return row ? accountFromRow(row) : null;
  }

  async insertAccount(account: StoredAccount): Promise<void> {
    this.ensurePool();
    // Passkey rows under this email exist only when a delete outside Studio skipped the foreign
    // keys, as a session with session_replication_role = replica does; they must not pass to the
    // new account. The purge runs first and a failed insert rolls both back. It cannot deadlock
    // with insertPasskey, which locks the account row first: no account row exists under this
    // email until this insert, so no passkey write holds a lock this transaction waits behind.
    const removed = await this.transaction(async (client) => {
      const credentials = await client.query("DELETE FROM passkey_credentials WHERE account_email = $1", [
        account.email,
      ]);
      const users = await client.query("DELETE FROM passkey_users WHERE account_email = $1", [account.email]);
      await client.query(
        `INSERT INTO accounts (email, password_hash, role, totp_secret, totp_pending, disabled, session_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          account.email,
          account.passwordHash,
          account.role,
          account.totpSecret,
          account.totpPending,
          account.disabled ? 1 : 0,
          account.sessionVersion,
          account.createdAt,
          account.updatedAt,
        ],
      );
      return (credentials.rowCount ?? 0) + (users.rowCount ?? 0);
    });
    if (removed > 0) {
      logger.warn(
        "Removed passkey rows that an account deleted outside Studio left under a reused email; PostgreSQL deletes outside Studio must keep session_replication_role = origin",
        { provider: "postgres", removed },
      );
    }
  }

  async updateAccount(account: StoredAccount, options: AccountUpdateOptions): Promise<number> {
    this.ensurePool();
    // The account row is written before any passkey row, the one lock order every account and
    // passkey write follows, so an owner removal and an admin clear cannot deadlock.
    return this.accountWrite(options, async (client) => {
      const applied = await client.query(
        `UPDATE accounts
         SET password_hash = $1, role = $2, totp_secret = $3, totp_pending = $4, disabled = $5, session_version = $6,
             updated_at = $7
         WHERE email = $8 AND session_version = $9 AND updated_at = $10`,
        [
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
        ],
      );
      if (!applied.rowCount) throw new AccountWriteConflict();
      if (!options.clearPasskeys) return 0;
      const cleared = await client.query("DELETE FROM passkey_credentials WHERE account_email = $1", [account.email]);
      return cleared.rowCount ?? 0;
    });
  }

  async deleteAccount(email: string, options: AccountWriteOptions = {}): Promise<void> {
    this.ensurePool();
    // One transaction: an account removed without its rows would hand them to the next account
    // created with the same email.
    await this.accountWrite(options, async (client) => {
      await client.query("DELETE FROM accounts WHERE email = $1", [email]);
      await client.query("DELETE FROM user_storage WHERE user_id = $1", [email]);
    });
  }

  async listPasskeys(email: string): Promise<StoredPasskey[]> {
    this.ensurePool();
    const { rows } = await this.pool!.query(
      `SELECT ${PASSKEY_COLUMNS} FROM passkey_credentials WHERE account_email = $1 ORDER BY created_at, id`,
      [email],
    );
    return (rows as PasskeyRow[]).map(passkeyFromRow);
  }

  async countPasskeys(): Promise<Map<string, number>> {
    this.ensurePool();
    // COUNT(*) is bigint, which pg returns as a string.
    const { rows } = await this.pool!.query(
      "SELECT account_email, COUNT(*) AS n FROM passkey_credentials GROUP BY account_email",
    );
    return new Map((rows as { account_email: string; n: string }[]).map((row) => [row.account_email, Number(row.n)]));
  }

  async getPasskeyUserHandle(email: string): Promise<string | null> {
    this.ensurePool();
    const { rows } = await this.pool!.query("SELECT user_handle FROM passkey_users WHERE account_email = $1", [email]);
    const row = (rows as { user_handle: string }[])[0];
    return row ? row.user_handle : null;
  }

  async findPasskey(credentialId: string): Promise<PasskeyMatch | null> {
    this.ensurePool();
    const { rows } = await this.pool!.query(
      `SELECT ${PASSKEY_COLUMNS_OF_C}, u.user_handle
       FROM passkey_credentials c JOIN passkey_users u ON u.account_email = c.account_email
       WHERE c.credential_id = $1`,
      [credentialId],
    );
    const row = (rows as (PasskeyRow & { user_handle: string })[])[0];
    return row ? { passkey: passkeyFromRow(row), userHandle: row.user_handle } : null;
  }

  async insertPasskey(write: PasskeyRegistrationWrite): Promise<void> {
    this.ensurePool();
    const { passkey } = write;
    await this.transaction(async (client) => {
      // The account row is locked before any passkey statement: the one lock order, and what
      // keeps two concurrent registrations from both passing the limit.
      const account = await client.query("SELECT session_version FROM accounts WHERE email = $1 FOR UPDATE", [
        passkey.accountEmail,
      ]);
      const locked = (account.rows as { session_version: number }[])[0];
      if (!locked) throw new PasskeyRegistrationConflict("account_missing");
      if (Number(locked.session_version) !== write.expectedSessionVersion) {
        throw new PasskeyRegistrationConflict("session_changed");
      }
      if (!(await this.spendChallenge(client, write.challenge, write.purgeSpentBefore))) {
        throw new PasskeyRegistrationConflict("challenge_spent");
      }
      const held = await client.query("SELECT COUNT(*) AS n FROM passkey_credentials WHERE account_email = $1", [
        passkey.accountEmail,
      ]);
      if (Number((held.rows as { n: string }[])[0].n) >= write.maxPasskeys) {
        throw new PasskeyRegistrationConflict("passkey_limit");
      }
      await client.query(
        "INSERT INTO passkey_users (account_email, user_handle, created_at) VALUES ($1, $2, $3) ON CONFLICT (account_email) DO NOTHING",
        [passkey.accountEmail, write.userHandle, passkey.createdAt],
      );
      const bound = await client.query("SELECT user_handle FROM passkey_users WHERE account_email = $1", [
        passkey.accountEmail,
      ]);
      if ((bound.rows as { user_handle: string }[])[0].user_handle !== write.userHandle) {
        throw new PasskeyRegistrationConflict("user_handle_changed");
      }
      const inserted = await client.query(
        `INSERT INTO passkey_credentials (${PASSKEY_COLUMNS})
         VALUES ($1, $2, $3, $4, $5::bigint, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (credential_id) DO NOTHING`,
        [
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
        ],
      );
      if (!inserted.rowCount) throw new PasskeyRegistrationConflict("credential_registered");
    });
  }

  async recordPasskeySignIn(write: PasskeySignInWrite): Promise<void> {
    this.ensurePool();
    await this.transaction(async (client) => {
      if (!(await this.spendChallenge(client, write.challenge, write.purgeSpentBefore))) {
        throw new PasskeySignInConflict("challenge_spent");
      }
      // One guarded statement, so two sign-ins racing on one credential can never lower the
      // counter. An untyped parameter compared with 0 is inferred as integer and fails above
      // 2147483647, so every use of the counter is cast.
      const advanced = await client.query(
        "UPDATE passkey_credentials SET sign_count = $1::bigint, backup_state = $2, last_used_at = $3 WHERE id = $4 AND ((sign_count = 0 AND $1::bigint = 0) OR sign_count < $1::bigint)",
        [write.signCount, write.backupState ? 1 : 0, write.usedAt, write.id],
      );
      if (advanced.rowCount) return;
      const exists = await client.query("SELECT 1 FROM passkey_credentials WHERE id = $1", [write.id]);
      throw new PasskeySignInConflict(exists.rows.length > 0 ? "counter_not_increased" : "credential_missing");
    });
  }

  async renamePasskey(email: string, id: string, name: string): Promise<boolean> {
    this.ensurePool();
    const renamed = await this.pool!.query(
      "UPDATE passkey_credentials SET name = $1 WHERE id = $2 AND account_email = $3",
      [name, id, email],
    );
    return (renamed.rowCount ?? 0) > 0;
  }

  async deletePasskey(write: PasskeyRemovalWrite): Promise<void> {
    this.ensurePool();
    // The account row first, then the credential: the lock order of every account and passkey write.
    await this.transaction(async (client) => {
      const moved = await client.query(
        "UPDATE accounts SET session_version = $1, updated_at = $2 WHERE email = $3 AND session_version = $4",
        [write.nextSessionVersion, write.updatedAt, write.email, write.expectedSessionVersion],
      );
      if (!moved.rowCount) throw new PasskeyRemovalConflict("session_changed");
      const deleted = await client.query("DELETE FROM passkey_credentials WHERE id = $1 AND account_email = $2", [
        write.id,
        write.email,
      ]);
      if (!deleted.rowCount) throw new PasskeyRemovalConflict("credential_missing");
    });
  }

  /** Inside a transaction: purge old spent rows, then spend this one; false when it was spent. */
  private async spendChallenge(client: PoolClient, challenge: SpentChallenge, purgeSpentBefore: string) {
    await client.query("DELETE FROM passkey_spent_challenges WHERE expires_at < $1", [purgeSpentBefore]);
    const spent = await client.query(
      "INSERT INTO passkey_spent_challenges (challenge_hash, expires_at) VALUES ($1, $2) ON CONFLICT (challenge_hash) DO NOTHING",
      [challenge.hash, challenge.expiresAt],
    );
    return (spent.rowCount ?? 0) > 0;
  }

  /** Run in one transaction on one pool client: commit and return the run's value, or roll back and rethrow. */
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool!.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Run an account write in one transaction. With keepEnabledAdmin the enabled admin rows are
   * locked first, so a concurrent guarded write waits for this one to commit and then sees what
   * it left; the write is rolled back if no enabled admin remains.
   */
  private async accountWrite<T>(options: AccountWriteOptions, write: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(async (client) => {
      if (options.keepEnabledAdmin) {
        await client.query(
          "SELECT email FROM accounts WHERE role = 'admin' AND disabled = 0 ORDER BY email FOR UPDATE",
        );
      }
      const result = await write(client);
      if (options.keepEnabledAdmin) {
        const { rows } = await client.query(
          "SELECT COUNT(*)::int AS n FROM accounts WHERE role = 'admin' AND disabled = 0",
        );
        if (Number((rows as { n: number | string }[])[0]?.n) === 0) throw new LastAdminError();
      }
      return result;
    });
  }

  async isHealthy(): Promise<boolean> {
    try {
      this.ensurePool();
      const { rows } = await this.pool!.query("SELECT 1 as ok");
      return rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  private ensurePool(): void {
    if (!this.pool) {
      throw new Error("PostgreSQL storage not initialized. Call initialize() first.");
    }
  }

  private buildSSLConfig(): boolean | { rejectUnauthorized: boolean } {
    const { host, searchParams } = this.parseConnectionString(this.connectionString);

    const sslMode = searchParams.get("sslmode")?.toLowerCase();
    if (sslMode === "disable") return false;
    // `verify-system` is not a libpq sslmode - it is this product's own mode name
    // (src/lib/types.ts), and someone configuring STORAGE_POSTGRES_URL from the connection
    // form's vocabulary will write it. It means "verify against the runtime's trust store",
    // so it is the one value here that turns verification ON; without this branch it fell
    // through to the non-local default below and got `rejectUnauthorized: false`, i.e. the
    // opposite of what it says (D26). The libpq spellings keep their existing behaviour: this
    // pool has no channel for a CA PEM, so a verifying default would break every deployment
    // whose storage database presents a self-signed certificate.
    if (sslMode === "verify-system") return { rejectUnauthorized: true };
    if (sslMode === "require" || sslMode === "prefer" || sslMode === "verify-ca" || sslMode === "verify-full") {
      return { rejectUnauthorized: false };
    }

    const sslParam = searchParams.get("ssl")?.toLowerCase();
    if (sslParam === "false" || sslParam === "0" || sslParam === "no") {
      return false;
    }
    if (sslParam === "true" || sslParam === "1" || sslParam === "yes") {
      return { rejectUnauthorized: false };
    }

    if (this.isLocalHost(host)) return false;
    return { rejectUnauthorized: false };
  }

  private parseConnectionString(connectionString: string): {
    host: string;
    searchParams: URLSearchParams;
  } {
    try {
      const parsed = new URL(connectionString);
      return {
        host: parsed.hostname.toLowerCase(),
        searchParams: parsed.searchParams,
      };
    } catch {
      return {
        host: "",
        searchParams: new URLSearchParams(),
      };
    }
  }

  private isLocalHost(host: string): boolean {
    const localHosts = new Set([
      "localhost",
      "::1",
      "host.docker.internal",
      "docker.for.mac.localhost",
      "docker.for.win.localhost",
      "gateway.docker.internal",
    ]);
    if (localHosts.has(host)) return true;
    if (host.startsWith("127.")) return true;
    return false;
  }
}
