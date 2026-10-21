// The libredb.connections setting and the secrets of its connections (part 2, "Reading and writing", "Secrets",
// "Housekeeping" and "Refresh"): what the host lists, each connection's revision, and every write, each of which
// reads the raw setting again just before it changes it. No log line or error here carries a secret value.
import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import { type ProfileEntry, type ProfileItem, readProfiles } from "./profile";
import { idOfSecretKey, isPlainObject, secretKey } from "./secret-keys";

/** The one setting the store reads and writes; extension.ts builds it from vscode.workspace. */
export interface ConnectionsSetting {
  /** workspace.getConfiguration("libredb").get("connections") */
  read(): unknown;
  /** ...update("connections", value, ConfigurationTarget.Global) */
  write(value: readonly unknown[]): Thenable<void>;
  /** onDidChangeConfiguration events that affectsConfiguration("libredb.connections") */
  readonly onDidChange: vscode.Event<void>;
}

export function connectionsSetting(
  workspace: Pick<typeof vscode.workspace, "getConfiguration" | "onDidChangeConfiguration">,
): ConnectionsSetting & vscode.Disposable {
  const changes = new vscode.EventEmitter<void>();
  const subscription = workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("libredb.connections")) changes.fire();
  });
  return {
    read: () => workspace.getConfiguration("libredb").get("connections"),
    // An application setting can only be configured in user settings.
    write: (value) =>
      workspace.getConfiguration("libredb").update("connections", value, vscode.ConfigurationTarget.Global),
    onDidChange: changes.event,
    dispose: () => {
      subscription.dispose();
      changes.dispose();
    },
  };
}

export interface ConnectionsChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/**
 * A change of the setting that did not happen, which the person fixes in their user settings: VS Code refused the
 * write ("LibreDB could not write libredb.connections in your user settings: <VS Code's message>"), or the setting is
 * not an array (SETTING_NOT_AN_ARRAY).
 */
export class SettingWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingWriteError";
  }
}

/** A secret VS Code's secret storage did not store; the message is secretStoreFailed(<the storage's message>). */
export class SecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreError";
  }
}

/** "The connection <id> is no longer in libredb.connections." */
export class UnknownConnectionError extends Error {
  constructor(readonly connectionId: string) {
    super(`The connection ${connectionId} is no longer in libredb.connections.`);
    this.name = "UnknownConnectionError";
  }
}

export const SETTING_NOT_AN_ARRAY =
  "libredb.connections in your user settings is not an array, so LibreDB cannot change it. Fix it in your user settings first.";

/** <message> is the storage's own error message. */
export function secretStoreFailed(message: string): string {
  return `LibreDB could not store a secret in VS Code's secret storage, so it saved nothing: ${message}. On Linux, VS Code's secret storage needs a keyring; see "Configure a keyring backend" in VS Code's Settings Sync documentation.`;
}

export interface StoreDeps {
  readonly setting: ConnectionsSetting;
  readonly secrets: vscode.SecretStorage;
  readonly log: Pick<vscode.LogOutputChannel, "warn">;
}

/** An element's id when it is an object, else undefined. */
function idOf(element: unknown): unknown {
  return isPlainObject(element) ? element.id : undefined;
}

/** An element as reconciliation compares it: secretFields sorted on a copy, so an order-only edit is no change. */
function comparable(element: Record<string, unknown>): unknown {
  const { secretFields } = element;
  return Array.isArray(secretFields) ? { ...element, secretFields: [...secretFields].sort() } : element;
}

export class ConnectionStore implements vscode.Disposable {
  private items: readonly ProfileItem[] = [];
  private entries = new Map<string, ProfileEntry>();
  /** Each usable id's raw element (rule 3 passed), as reconciliation compares it. */
  private snapshot: Map<string, unknown>;
  /** By id, from its first sighting: never reset within an activation, so an id that comes back is a change. */
  private readonly revisions = new Map<string, number>();
  /** The keys this store is writing, from before secrets.store until that key's event arrives or the write settles. */
  private readonly ownKeys = new Set<string>();
  private readonly changes = new vscode.EventEmitter<ConnectionsChange>();
  private readonly subscriptions: vscode.Disposable[];
  readonly onDidChange = this.changes.event;

  /** Reads the setting once; needs no backend and fires nothing. */
  constructor(private readonly deps: StoreDeps) {
    this.snapshot = this.load();
    for (const id of this.snapshot.keys()) this.advance(id);
    this.subscriptions = [
      deps.setting.onDidChange(() => this.reload()),
      deps.secrets.onDidChange(({ key }) => this.secretChanged(key)),
    ];
  }

  /** In setting order, invalid items included. */
  list(): readonly ProfileItem[] {
    return this.items;
  }

  /** Valid entries only. */
  get(id: string): ProfileEntry | undefined {
    return this.entries.get(id);
  }

  /** 0 when an id is first seen, +1 per change; throws UnknownConnectionError off the valid ids. */
  revision(id: string): number {
    if (!this.entries.has(id)) throw new UnknownConnectionError(id);
    return this.revisions.get(id) as number;
  }

  /** Secrets first, then the setting, so a listed profile always has its secrets; each failure undoes what this call stored. */
  async add(entry: ProfileEntry, secrets: Readonly<Record<string, string>>): Promise<void> {
    const raw = this.readArray();
    if (raw.some((element) => idOf(element) === entry.id)) {
      throw new Error(`A connection with id ${entry.id} is already saved.`);
    }
    const [item] = readProfiles([entry]);
    if (item.kind === "invalid") throw new Error(item.reason);
    const paths = entry.secretFields ?? [];
    if (
      !isDeepStrictEqual([...paths].sort(), Object.keys(secrets).sort()) ||
      paths.some((path) => secrets[path] === "")
    ) {
      throw new Error(`The secrets given for ${entry.id} are not the ones its secretFields lists.`);
    }
    await this.storeEach(
      entry.id,
      paths.map((path) => [path, secrets[path]]),
    );
    try {
      // Read again just before the write: an edit another window made a moment ago, and elements this store cannot
      // read, stay where they are.
      await this.write([...this.readArray(), entry]);
    } catch (error) {
      this.logUndeleted(await this.deleteKeys(await this.keysOf(entry.id)));
      throw error;
    }
    this.reload();
  }

  /** The setting without every element of the id, then every key of the id; removing an id that is not there does nothing. */
  async remove(id: string): Promise<{ removed: boolean; undeletedKeys: readonly string[] }> {
    const raw = this.readArray();
    const kept = raw.filter((element) => idOf(element) !== id);
    if (kept.length === raw.length) return { removed: false, undeletedKeys: [] };
    // A failed write deletes no key: the secrets stay with the entry that stays.
    await this.write(kept);
    this.reload();
    return { removed: true, undeletedKeys: await this.deleteKeys(await this.keysOf(id)) };
  }

  /**
   * Reads the setting again and reports what changed since the last load: a new id is added, a vanished one removed
   * (its secrets and its revision counter kept), a different one changed with its revision raised; one event per load
   * with any id in it.
   */
  reload(): void {
    const before = this.snapshot;
    const after = this.load();
    this.snapshot = after;
    const added: string[] = [];
    const changed: string[] = [];
    for (const [id, element] of after) {
      if (!before.has(id)) {
        added.push(id);
        this.advance(id);
      } else if (!isDeepStrictEqual(before.get(id), element)) {
        changed.push(id);
        this.advance(id);
      }
    }
    const removed = [...before.keys()].filter((id) => !after.has(id));
    if (added.length + removed.length + changed.length > 0) this.changes.fire({ added, removed, changed });
  }

  /** The stored value of each path the entry's secretFields lists; undefined or "" is missing. */
  async readSecrets(id: string): Promise<{ values: Record<string, string>; missing: string[] }> {
    const entry = this.entries.get(id);
    if (entry === undefined) throw new UnknownConnectionError(id);
    const paths = entry.secretFields ?? [];
    const stored = await Promise.all(paths.map((path) => this.deps.secrets.get(secretKey(id, path))));
    const values: Record<string, string> = {};
    const missing: string[] = [];
    paths.forEach((path, index) => {
      const value = stored[index];
      if (value === undefined || value === "") missing.push(path);
      else values[path] = value;
    });
    return { values, missing };
  }

  /**
   * As add's secret step: an empty value is neither stored nor listed. Rejects UnknownConnectionError for an id the
   * setting no longer lists, storing nothing, and deletes what it stored when a Remove ran while it stored, so no
   * key outlives its connection.
   */
  async storeSecrets(id: string, values: Readonly<Record<string, string>>): Promise<void> {
    if (!this.entries.has(id)) throw new UnknownConnectionError(id);
    const entries = Object.entries(values);
    await this.storeEach(id, entries);
    if (this.entries.has(id)) return;
    this.logUndeleted(
      await this.deleteKeys(entries.filter(([, value]) => value !== "").map(([path]) => secretKey(id, path))),
    );
    throw new UnknownConnectionError(id);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changes.dispose();
  }

  /** Reads and validates the setting, logs each invalid item, and answers each usable id's comparable element. */
  private load(): Map<string, unknown> {
    const raw = this.deps.setting.read();
    const items = readProfiles(raw);
    const snapshot = new Map<string, unknown>();
    const entries = new Map<string, ProfileEntry>();
    items.forEach((item, index) => {
      if (item.kind === "valid") entries.set(item.entry.id, item.entry);
      else this.deps.log.warn(`Ignoring a libredb.connections entry: ${item.reason}`);
      const id = item.kind === "valid" ? item.entry.id : item.id;
      // An item has an id only once rule 3 passed, so the setting is an array and the element an object.
      if (id !== undefined) snapshot.set(id, comparable((raw as Record<string, unknown>[])[index]));
    });
    this.items = items;
    this.entries = entries;
    return snapshot;
  }

  /** 0 for an id first seen, else one more than before. */
  private advance(id: string): void {
    this.revisions.set(id, (this.revisions.get(id) ?? -1) + 1);
  }

  private secretChanged(key: string): void {
    // The event of a write this store is making is no change of the connection.
    if (this.ownKeys.delete(key)) return;
    const id = idOfSecretKey(key);
    if (id === undefined || !this.entries.has(id)) return;
    this.advance(id);
    this.changes.fire({ added: [], removed: [], changed: [id] });
  }

  private readArray(): unknown[] {
    const raw = this.deps.setting.read();
    if (!Array.isArray(raw)) throw new SettingWriteError(SETTING_NOT_AN_ARRAY);
    return raw;
  }

  private async write(value: readonly unknown[]): Promise<void> {
    try {
      await this.deps.setting.write(value);
    } catch (error) {
      throw new SettingWriteError(
        `LibreDB could not write libredb.connections in your user settings: ${messageOf(error)}`,
      );
    }
  }

  /** Stores each non-empty value in order; a failure deletes the keys this call stored and rejects SecretStoreError. */
  private async storeEach(id: string, values: readonly (readonly [string, string])[]): Promise<void> {
    const stored: string[] = [];
    for (const [path, value] of values) {
      if (value === "") continue;
      const key = secretKey(id, path);
      this.ownKeys.add(key);
      try {
        // oxlint-disable-next-line no-await-in-loop -- in order, each settled before the next, so a failure knows what it stored.
        await this.deps.secrets.store(key, value);
        stored.push(key);
      } catch (error) {
        // oxlint-disable-next-line no-await-in-loop -- runs once: the throw below ends the loop.
        this.logUndeleted(await this.deleteKeys(stored));
        throw new SecretStoreError(secretStoreFailed(messageOf(error)));
      } finally {
        this.ownKeys.delete(key);
      }
    }
  }

  private async keysOf(id: string): Promise<string[]> {
    return (await this.deps.secrets.keys()).filter((key) => idOfSecretKey(key) === id);
  }

  /** Deletes every key and answers the ones whose delete failed. */
  private async deleteKeys(keys: readonly string[]): Promise<string[]> {
    const results = await Promise.allSettled(keys.map((key) => this.deps.secrets.delete(key)));
    return keys.filter((_key, index) => results[index].status === "rejected");
  }

  private logUndeleted(keys: readonly string[]): void {
    for (const key of keys) {
      this.deps.log.warn(`Could not delete ${key} from VS Code's secret storage: it stays on this machine.`);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
