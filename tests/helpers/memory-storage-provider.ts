import type {
  AccountUpdateOptions,
  CredentialEnvelopeState,
  ServerStorageProvider,
  StorageCollection,
  StorageData,
  StoredAccount,
  StoredCredentialRewrite,
  StoredCredentialRewriteResult,
} from "@/lib/storage/types";
import { AccountWriteConflict } from "@/lib/storage/types";

/**
 * A ServerStorageProvider held in memory that keeps each row as a real provider stores it: a user_storage row as the
 * JSON text of its collection, per owner and collection, and an account row by email. It records the store's envelope
 * state as a `storage_meta` row would, and `rewriteStoredCredentials` is transactional the way the shipped providers
 * are: a snapshot is taken first and recorded as the backup, and any throw restores it.
 *
 * For the decorator, re-seal and security tests, which need the store's behaviour without a database. Passkeys are not
 * modelled: each passkey method throws, by name.
 */
export class MemoryStorageProvider implements ServerStorageProvider {
  /** `${owner}\u0000${collection}` to the stored JSON text. */
  readonly rows = new Map<string, string>();
  readonly accounts = new Map<string, StoredAccount>();
  /** The `credential_envelope` row of `storage_meta`, or undefined when there is none. */
  marker: string | undefined;
  /** Every backup a re-seal wrote, with the rows and accounts it holds. */
  readonly backups: { label: string; rows: Map<string, string>; accounts: Map<string, StoredAccount> }[] = [];

  private key(owner: string, collection: string): string {
    return `${owner}\u0000${collection}`;
  }

  /** Writes a raw row, as SQL against the store would. */
  putRow(owner: string, collection: StorageCollection, text: string): void {
    this.rows.set(this.key(owner, collection), text);
  }

  /** Reads a raw row, as SQL against the store would. */
  row(owner: string, collection: StorageCollection): string | undefined {
    return this.rows.get(this.key(owner, collection));
  }

  async initialize(): Promise<void> {}

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}

  async getAllData(userId: string): Promise<Partial<StorageData>> {
    const data: Record<string, unknown> = {};
    for (const [key, text] of this.rows) {
      const [owner, collection] = key.split("\u0000");
      if (owner === userId) data[collection] = JSON.parse(text);
    }
    return data as Partial<StorageData>;
  }

  async getCollection<K extends StorageCollection>(userId: string, collection: K): Promise<StorageData[K] | null> {
    const text = this.row(userId, collection);
    return text === undefined ? null : (JSON.parse(text) as StorageData[K]);
  }

  async setCollection<K extends StorageCollection>(userId: string, collection: K, data: StorageData[K]): Promise<void> {
    this.putRow(userId, collection, JSON.stringify(data));
  }

  async mergeData(userId: string, data: Partial<StorageData>): Promise<void> {
    for (const [collection, value] of Object.entries(data)) {
      if (value !== undefined) this.putRow(userId, collection as StorageCollection, JSON.stringify(value));
    }
  }

  async listAccounts(): Promise<StoredAccount[]> {
    return [...this.accounts.values()].map((account) => ({ ...account }));
  }

  async getAccount(email: string): Promise<StoredAccount | null> {
    const account = this.accounts.get(email);
    return account ? { ...account } : null;
  }

  async insertAccount(account: StoredAccount): Promise<void> {
    if (this.accounts.has(account.email)) throw new Error(`An account ${account.email} is already stored`);
    this.accounts.set(account.email, { ...account });
  }

  async updateAccount(account: StoredAccount, options: AccountUpdateOptions): Promise<number> {
    const stored = this.accounts.get(account.email);
    if (
      !stored ||
      stored.sessionVersion !== options.expected.sessionVersion ||
      stored.updatedAt !== options.expected.updatedAt
    ) {
      throw new AccountWriteConflict();
    }
    this.accounts.set(account.email, { ...account });
    return 0;
  }

  async deleteAccount(email: string): Promise<void> {
    this.accounts.delete(email);
    for (const key of [...this.rows.keys()]) {
      if (key.split("\u0000")[0] === email) this.rows.delete(key);
    }
  }

  async readEnvelopeState(): Promise<CredentialEnvelopeState> {
    if (this.marker === undefined) return "v1-accepted";
    if (this.marker === "v2") return "v1-retired";
    throw new Error(`Unknown credential envelope marker ${this.marker}`);
  }

  async rewriteStoredCredentials(
    rewrite: StoredCredentialRewrite,
    backupLabel: string,
  ): Promise<StoredCredentialRewriteResult> {
    if ((await this.readEnvelopeState()) === "v1-retired") return { kind: "already-retired" };
    const rows = new Map(this.rows);
    const accounts = new Map([...this.accounts].map(([email, account]) => [email, { ...account }]));
    this.backups.push({ label: backupLabel, rows: new Map(rows), accounts: new Map(accounts) });
    try {
      for (const [key, text] of rows) {
        const [owner, collection] = key.split("\u0000");
        if (collection !== "connections") continue;
        const next = rewrite.connections(owner, text);
        if (next !== null) this.rows.set(key, next);
      }
      for (const account of accounts.values()) {
        const next = rewrite.factors({
          email: account.email,
          totpSecret: account.totpSecret,
          totpPending: account.totpPending,
        });
        if (next !== null) this.accounts.set(account.email, { ...account, ...next });
      }
      this.marker = "v2";
      return { kind: "rewritten", backup: `memory:${backupLabel}` };
    } catch (error) {
      this.rows.clear();
      for (const [key, text] of rows) this.rows.set(key, text);
      this.accounts.clear();
      for (const [email, account] of accounts) this.accounts.set(email, account);
      throw error;
    }
  }

  private noPasskeys(method: string): never {
    throw new Error(`MemoryStorageProvider does not model passkeys (${method})`);
  }

  listPasskeys(): never {
    return this.noPasskeys("listPasskeys");
  }

  countPasskeys(): never {
    return this.noPasskeys("countPasskeys");
  }

  getPasskeyUserHandle(): never {
    return this.noPasskeys("getPasskeyUserHandle");
  }

  findPasskey(): never {
    return this.noPasskeys("findPasskey");
  }

  insertPasskey(): never {
    return this.noPasskeys("insertPasskey");
  }

  recordPasskeySignIn(): never {
    return this.noPasskeys("recordPasskeySignIn");
  }

  renamePasskey(): never {
    return this.noPasskeys("renamePasskey");
  }

  deletePasskey(): never {
    return this.noPasskeys("deletePasskey");
  }
}
