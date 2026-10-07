/**
 * What an explicit sign-out does to this browser's copy of the workspace.
 *
 * In server storage mode the browser copy belongs to the signed-in account, so signing out
 * pushes whatever is still waiting to be pushed, while the session cookie is still valid, and
 * then clears the copy. In local mode the browser copy is the only one and stays.
 *
 * Every sign-out path calls `releaseAccountWorkspace()` before POST /api/auth/logout. Only the
 * Studio page mounts `useStorageSync`, which registers its pending push here while it is
 * mounted; the admin dashboard and the launch page have nothing pending and only clear.
 */

import { appFetch } from "@/lib/config/base-path";
import { clearAccountWorkspace } from "./local-storage";
import type { StorageConfigResponse } from "./types";

/** Pushes every pending collection; rejects when one of them did not reach the server. */
type PendingPush = () => Promise<void>;

let pendingPush: PendingPush | null = null;

/** Register the mounted sync's pending push. Returns the unregister function. */
export function registerPendingPush(push: PendingPush): () => void {
  pendingPush = push;
  return () => {
    if (pendingPush === push) pendingPush = null;
  };
}

/**
 * Server mode: push what is pending, then clear this browser's copy. Local mode: nothing.
 * Rejects, and clears nothing, when the storage mode cannot be read or a pending push does not
 * land, so the caller reports a failed sign-out instead of dropping unsaved changes.
 */
export async function releaseAccountWorkspace(): Promise<void> {
  const res = await appFetch("/api/storage/config");
  if (!res.ok) throw new Error(`Storage mode unavailable: HTTP ${res.status}`);
  const config = (await res.json()) as StorageConfigResponse;
  if (!config.serverMode) return;
  if (pendingPush) await pendingPush();
  clearAccountWorkspace();
}
