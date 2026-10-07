/**
 * Whose browser copy this is, in server storage mode. The copy belongs to the signed-in account:
 * every page that reads it (the editor, the admin dashboard, monitoring), and every settings page a
 * sign-in can land on, first makes it the signed-in account's (`claimAccountWorkspace`), so a
 * different account starts from its own server data.
 */

import { appFetch } from "@/lib/config/base-path";
import { claimAccountWorkspace, SERVER_MIGRATED_KEY, WORKSPACE_OWNER_KEY } from "./local-storage";
import type { StorageConfigResponse } from "./types";

/** GET /api/auth/me answered 401: there is no session any more, so no account is signed in. */
export class SessionEndedError extends Error {
  constructor() {
    super("The session has ended");
    this.name = "SessionEndedError";
  }
}

/**
 * The signed-in account's username, from GET /api/auth/me. Throws when it cannot be read:
 * `SessionEndedError` when the session has ended, an ordinary error otherwise.
 */
export async function readSignedInUsername(): Promise<string> {
  const res = await appFetch("/api/auth/me");
  if (res.status === 401) throw new SessionEndedError();
  if (!res.ok) throw new Error(`Could not read the signed-in account: HTTP ${res.status}`);
  const body = (await res.json()) as { user?: { username?: unknown } };
  const username = body.user?.username;
  if (typeof username !== "string" || username === "") {
    throw new Error("Could not read the signed-in account: no username");
  }
  return username;
}

/**
 * Server mode: make the browser copy the signed-in account's before a page reads it. Local mode:
 * nothing. Throws in server mode when the signed-in account cannot be read: the copy must not be
 * used. A storage mode that cannot be read throws too when the copy carries an owner or the
 * migration flag, which only server mode writes, so such a copy is never shown unchecked; a copy
 * with neither counts as local mode, as `useStorageSync` counts it. Answers the account the copy
 * now belongs to, or null when no account was matched (local mode).
 */
export async function claimWorkspaceForSignedInAccount(): Promise<string | null> {
  let config: StorageConfigResponse;
  try {
    const res = await appFetch("/api/storage/config");
    if (!res.ok) throw new Error(`Storage mode unavailable: HTTP ${res.status}`);
    config = (await res.json()) as StorageConfigResponse;
  } catch (err) {
    if (isServerBoundCopy()) throw err;
    return null;
  }
  if (!config.serverMode) return null;
  const username = await readSignedInUsername();
  claimAccountWorkspace(username);
  return username;
}

function isServerBoundCopy(): boolean {
  return localStorage.getItem(WORKSPACE_OWNER_KEY) !== null || localStorage.getItem(SERVER_MIGRATED_KEY) !== null;
}
