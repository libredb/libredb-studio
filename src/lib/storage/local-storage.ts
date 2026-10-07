/**
 * Pure localStorage CRUD operations.
 * All reads/writes go through these functions.
 * No event dispatching — that's the facade's responsibility.
 */

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
 * Returns true on success, false on failure (e.g. QuotaExceededError).
 */
export function writeJSON(collection: string, data: unknown): boolean {
  if (!isClient()) return false;
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
 * Returns true on success, false on failure (e.g. QuotaExceededError).
 */
export function writeString(collection: string, value: string): boolean {
  if (!isClient()) return false;
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
  if (!isClient()) return;
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
  if (!isClient()) return;
  localStorage.removeItem(workspaceTabsKey(connectionId));
}

/**
 * The signed-in username the browser copy belongs to. Written in server storage mode only, by
 * `useStorageSync`, which compares it with the signed-in account before it uses the copy.
 */
export const WORKSPACE_OWNER_KEY = `${KEY_PREFIX}workspace_owner`;

/** Set once this browser's copy has been handed to a server account (`useStorageSync`). */
export const SERVER_MIGRATED_KEY = `${KEY_PREFIX}server_migrated`;

/** Unsaved object-source edits (`components/object-source/source-drafts.ts`). */
export const SOURCE_DRAFTS_KEY = `${KEY_PREFIX}source_drafts_v1`;

/** The agent conversation this browser was last in (`components/agent/use-agent-run.ts`). */
export const AGENT_THREAD_KEY = `${KEY_PREFIX}agent_thread`;

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
