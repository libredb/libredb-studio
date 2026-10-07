/**
 * Pure localStorage CRUD operations.
 * All reads/writes go through these functions.
 * No event dispatching — that's the facade's responsibility.
 */

import { heldWorkspaceOwner, holdWorkspaceOwner } from "@/lib/config/base-path";
import { logger } from "@/lib/logger";
import { STORAGE_COLLECTIONS } from "./types";

const KEY_PREFIX = "libredb_";

/** Map collection names to localStorage keys */
const COLLECTION_KEYS: Record<string, string> = {
  connections: `${KEY_PREFIX}connections`,
  history: `${KEY_PREFIX}history`,
  saved_queries: `${KEY_PREFIX}saved_queries`,
  schema_snapshots: `${KEY_PREFIX}schema_snapshots`,
  saved_charts: `${KEY_PREFIX}saved_charts`,
  active_connection_id: `${KEY_PREFIX}active_connection_id`,
  audit_log: `${KEY_PREFIX}audit_log`,
  masking_config: `${KEY_PREFIX}masking_config`,
  threshold_config: `${KEY_PREFIX}threshold_config`,
};

function isClient(): boolean {
  return typeof window !== "undefined";
}

export function getKey(collection: string): string {
  return COLLECTION_KEYS[collection] || `${KEY_PREFIX}${collection}`;
}

/**
 * Read raw JSON from localStorage.
 * Returns null if not found or parse fails.
 */
export function readJSON<T>(collection: string): T | null {
  if (!isClient()) return null;
  try {
    const key = getKey(collection);
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    logger.warn("Failed to parse JSON from localStorage", { key: getKey(collection) });
    return null;
  }
}

/**
 * Read raw string from localStorage.
 */
export function readString(collection: string): string | null {
  if (!isClient()) return null;
  return localStorage.getItem(getKey(collection));
}

/**
 * Write JSON to localStorage.
 * Returns true on success, false on failure (e.g. QuotaExceededError, or a copy this tab no
 * longer holds: `holdsAccountWorkspace`).
 */
export function writeJSON(collection: string, data: unknown): boolean {
  if (!isClient() || !holdsAccountWorkspace()) return false;
  try {
    localStorage.setItem(getKey(collection), JSON.stringify(data));
    return true;
  } catch (error) {
    logger.warn("Failed to write to localStorage", {
      key: getKey(collection),
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Write raw string to localStorage.
 * Returns true on success, false on failure (e.g. QuotaExceededError, or a copy this tab no
 * longer holds: `holdsAccountWorkspace`).
 */
export function writeString(collection: string, value: string): boolean {
  if (!isClient() || !holdsAccountWorkspace()) return false;
  try {
    localStorage.setItem(getKey(collection), value);
    return true;
  } catch (error) {
    logger.warn("Failed to write to localStorage", {
      key: getKey(collection),
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Remove a key from localStorage.
 */
export function remove(collection: string): void {
  if (!isClient() || !holdsAccountWorkspace()) return;
  localStorage.removeItem(getKey(collection));
}

/**
 * The key one connection's editor tabs live under (the SQL text included). Not a collection:
 * the tab manager reads and writes it straight, per connection, and it is never synced to the
 * server. The one place the spelling lives, so `use-tab-manager` and the deletion that has to
 * clear it cannot drift apart (#1448).
 */
const WORKSPACE_TABS_KEY_PREFIX = `${KEY_PREFIX}workspace_tabs_v1`;

export function workspaceTabsKey(connectionId: string): string {
  return `${WORKSPACE_TABS_KEY_PREFIX}:${connectionId}`;
}

/** Drop a connection's saved editor tabs; the connection they belonged to is gone. */
export function removeWorkspaceTabs(connectionId: string): void {
  if (!isClient() || !holdsAccountWorkspace()) return;
  localStorage.removeItem(workspaceTabsKey(connectionId));
}

/**
 * The signed-in username the browser copy belongs to. Written in server storage mode only, by
 * `claimAccountWorkspace` and `resetAccountWorkspace` (from `WorkspaceOwnerGate`, `useStorageSync`
 * and the sign-out), which compare it with the signed-in account before the copy is used.
 */
export const WORKSPACE_OWNER_KEY = `${KEY_PREFIX}workspace_owner`;

/**
 * Set once this browser's copy has been handed to a server account: by `useStorageSync` after
 * the migration, and by `resetAccountWorkspace` when the copy is cleared.
 */
export const SERVER_MIGRATED_KEY = `${KEY_PREFIX}server_migrated`;

/** Unsaved object-source edits (`components/object-source/source-drafts.ts`). */
export const SOURCE_DRAFTS_KEY = `${KEY_PREFIX}source_drafts_v1`;

/** The agent conversation this browser was last in (`components/agent/use-agent-run.ts`). */
export const AGENT_THREAD_KEY = `${KEY_PREFIX}agent_thread`;

/**
 * Whether this tab may write the browser copy. Before a claim, and so always in local mode, it
 * may. In server storage mode it may only while the copy still belongs to the account this tab
 * claimed it for: once another tab of the browser profile has cleared it or recorded a different
 * owner, this tab writes nothing more and reloads (`WorkspaceOwnerGate`). `storage` is the store
 * the owner key is read from, for a writer that is handed its store.
 */
export function holdsAccountWorkspace(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  const claimed = heldWorkspaceOwner();
  return claimed === null || storage.getItem(WORKSPACE_OWNER_KEY) === claimed;
}

/**
 * Every key that holds the signed-in account's browser copy: the synced collections, the
 * unsynced drafts and hints, and the two keys that say whose copy it is. Per-browser
 * preferences (theme, line numbers, the star prompt counters) are not on it.
 */
const ACCOUNT_KEYS: readonly string[] = [
  ...STORAGE_COLLECTIONS.map(getKey),
  SOURCE_DRAFTS_KEY,
  AGENT_THREAD_KEY,
  SERVER_MIGRATED_KEY,
  WORKSPACE_OWNER_KEY,
];

/**
 * Remove the signed-in account's browser copy, editor tabs included, and nothing else. In
 * server storage mode the browser copy belongs to the signed-in account: signing out clears
 * it, and signing in as a different account starts from that account's server data.
 */
export function clearAccountWorkspace(): void {
  if (!isClient()) return;
  for (const key of ACCOUNT_KEYS) localStorage.removeItem(key);
  // Collected first: removing while walking by index would skip the key after each removal.
  const tabKeys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(`${WORKSPACE_TABS_KEY_PREFIX}:`)) tabKeys.push(key);
  }
  for (const key of tabKeys) localStorage.removeItem(key);
}

/**
 * Clear the browser copy and mark it as handed to a server account, so `claimAccountWorkspace`
 * never takes what is written to it afterwards for local-mode data. `owner` is the account the
 * emptied copy now belongs to, or null after a sign-out.
 */
export function resetAccountWorkspace(owner: string | null): void {
  if (!isClient()) return;
  clearAccountWorkspace();
  localStorage.setItem(SERVER_MIGRATED_KEY, new Date().toISOString());
  if (owner !== null) localStorage.setItem(WORKSPACE_OWNER_KEY, owner);
}

/**
 * Server storage mode: keep the browser copy only for the account it belongs to, before anything
 * reads it, and hold that account for the requests this tab sends (`holdWorkspaceOwner`). The
 * same owner keeps it. A copy with no owner that was never handed to a server
 * account is local-mode data: it now belongs to the signed-in account and is kept for
 * `useStorageSync` to migrate into that account alone (docs/STORAGE.md). Anything else is
 * cleared, and the signed-in account starts from its own server data.
 */
export function claimAccountWorkspace(username: string): void {
  if (!isClient()) return;
  // Every request this tab sends from now on names the account it claimed the copy for.
  holdWorkspaceOwner(username);
  const owner = localStorage.getItem(WORKSPACE_OWNER_KEY);
  if (owner === username) return;
  if (owner === null && localStorage.getItem(SERVER_MIGRATED_KEY) === null) {
    localStorage.setItem(WORKSPACE_OWNER_KEY, username);
    return;
  }
  resetAccountWorkspace(username);
}
