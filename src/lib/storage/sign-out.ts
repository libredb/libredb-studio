/**
 * What an explicit sign-out does to this browser's copy of the workspace.
 *
 * In server storage mode the browser copy belongs to the signed-in account, so signing out
 * pushes whatever is still waiting to be pushed while the session cookie is still valid, ends
 * the session, and only then clears the copy: a sign-out that does not happen leaves the
 * signed-in account's copy in place. In local mode the browser copy is the only one and stays.
 *
 * Every sign-out path goes through `releaseAccountWorkspace()` with its POST /api/auth/logout.
 * Only the Studio page mounts `useStorageSync`, which registers itself here while it is mounted;
 * the admin dashboard and the launch page have nothing pending and only clear.
 */

import { appFetch } from "@/lib/config/base-path";
import { resetAccountWorkspace } from "./local-storage";
import type { StorageConfigResponse } from "./types";

/** The mounted sync, as a sign-out sees it. */
export interface WorkspaceSync {
  /** Pushes every pending collection and holds later changes; rejects when one did not land. */
  flush(): Promise<void>;
  /** Pushes again: the sign-out did not happen and the session goes on. */
  resume(): void;
}

let mountedSync: WorkspaceSync | null = null;

/** Register the mounted sync. Returns the unregister function. */
export function registerWorkspaceSync(sync: WorkspaceSync): () => void {
  mountedSync = sync;
  return () => {
    if (mountedSync === sync) mountedSync = null;
  };
}

/**
 * Server mode: push what is pending, run `signOut`, and once it succeeded clear this browser's
 * copy, marked so nothing written to it afterwards is migrated into the next account. Local
 * mode: only `signOut`. Rejects, before `signOut` runs, when the storage mode cannot be read or a
 * pending push does not land, so the caller reports a failed sign-out instead of dropping unsaved
 * changes. A refused or failed `signOut` keeps the copy and resumes the sync.
 */
export async function releaseAccountWorkspace(signOut: () => Promise<Response>): Promise<Response> {
  const res = await appFetch("/api/storage/config");
  if (!res.ok) throw new Error(`Storage mode unavailable: HTTP ${res.status}`);
  const config = (await res.json()) as StorageConfigResponse;
  if (!config.serverMode) return signOut();

  const sync = mountedSync;
  if (sync) await sync.flush();
  let response: Response;
  try {
    response = await signOut();
  } catch (err) {
    sync?.resume();
    throw err;
  }
  if (!response.ok) {
    sync?.resume();
    return response;
  }
  resetAccountWorkspace(null);
  return response;
}
