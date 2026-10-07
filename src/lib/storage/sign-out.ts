/**
 * What an explicit sign-out does to this browser's copy of the workspace.
 *
 * In server storage mode the browser copy belongs to the signed-in account, so signing out
 * pushes whatever is still waiting to be pushed while the session cookie is still valid, ends
 * the session, and only then clears the copy. A push that did not land does not stop the sign-out:
 * when the session had already ended the copy is cleared, and otherwise the session ends and the
 * copy is kept for this account, whose owner key the next sign-in checks. A sign-out the server
 * refused while the session goes on leaves the copy in place. In local mode the browser copy is
 * the only one and stays.
 *
 * Every sign-out path goes through `releaseAccountWorkspace()` with its POST /api/auth/logout.
 * Only the Studio page mounts `useStorageSync`, which registers itself here while it is mounted;
 * the admin dashboard and the launch page have nothing pending and only clear.
 */

import { resetAccountWorkspace } from "./local-storage";
import { readServerMode, readSignedInUsername, SessionEndedError } from "./workspace-owner";

/** The mounted sync, as a sign-out sees it. */
export interface WorkspaceSync {
  /** Pushes every pending collection and holds later changes; rejects when one did not land. */
  flush(): Promise<void>;
  /** Pushes again: the sign-out did not happen and the session goes on. */
  resume(): void;
}

/** How a sign-out ended. */
export interface SignOutResult {
  /** The session is over: the sign-out succeeded, or no session was left after it. */
  signedOut: boolean;
  /** The successful POST /api/auth/logout answer, whose body may name the provider's sign-out address. */
  response: Response | null;
  /** Changes that could not be pushed stay in this browser's copy for the account that signed out. */
  changesKept: boolean;
}

let mountedSync: WorkspaceSync | null = null;

/** Register the mounted sync. Returns the unregister function. */
export function registerWorkspaceSync(sync: WorkspaceSync): () => void {
  mountedSync = sync;
  return () => {
    if (mountedSync === sync) mountedSync = null;
  };
}

/** Whether GET /api/auth/me says no session is left. Not knowing counts as a session that goes on. */
async function sessionHasEnded(): Promise<boolean> {
  try {
    await readSignedInUsername();
    return false;
  } catch (err) {
    return err instanceof SessionEndedError;
  }
}

/**
 * Runs `signOut`. A refused or failed one is still a sign-out when no session is left after it (the
 * server ended the session and the answer was an error or was lost); otherwise the sync resumes.
 */
async function endSession(
  signOut: () => Promise<Response>,
  sync: WorkspaceSync | null,
  changesKept: boolean,
): Promise<SignOutResult> {
  const response = await signOut().catch(() => null);
  if (response?.ok) return { signedOut: true, response, changesKept };
  if (await sessionHasEnded()) return { signedOut: true, response: null, changesKept };
  sync?.resume();
  return { signedOut: false, response: null, changesKept: false };
}

/**
 * Server mode: push what is pending, run `signOut`, and once the session is over clear this
 * browser's copy, marked so nothing written to it afterwards is migrated into the next account.
 * A pending push that did not land clears the copy without `signOut` when the session had already
 * ended, and otherwise keeps it (`changesKept`) while the session still ends. Local mode, or a
 * storage mode that cannot be read for a copy never bound to a server account: only `signOut`.
 * Rejects, before `signOut` runs, when the storage mode cannot be read for a copy bound to a server
 * account, so the caller reports a failed sign-out.
 */
export async function releaseAccountWorkspace(signOut: () => Promise<Response>): Promise<SignOutResult> {
  if (!(await readServerMode())) return endSession(signOut, null, false);

  const sync = mountedSync;
  let changesKept = false;
  if (sync) {
    try {
      await sync.flush();
    } catch {
      if (await sessionHasEnded()) {
        resetAccountWorkspace(null);
        return { signedOut: true, response: null, changesKept: false };
      }
      changesKept = true;
    }
  }
  const result = await endSession(signOut, sync, changesKept);
  if (result.signedOut && !changesKept) resetAccountWorkspace(null);
  return result;
}
