"use client";

import { type ReactNode, useEffect, useState } from "react";
import { ViewLoading } from "@/components/LazyView";
import { reportSessionEnded } from "@/lib/config/base-path";
import { logger } from "@/lib/logger";
import { WORKSPACE_OWNER_KEY } from "@/lib/storage/local-storage";
import {
  claimWorkspaceForSignedInAccount,
  readSignedInUsername,
  SessionEndedError,
} from "@/lib/storage/workspace-owner";

/**
 * Renders a page that reads this browser's copy of the workspace only once the copy is the
 * signed-in account's. In server storage mode the browser copy belongs to the signed-in account,
 * so a copy another account left behind is cleared before the page reads it, and signing in as
 * a different account starts from that account's server data on every such page, not only the
 * editor. The copy is shared by every tab of the browser profile: when another tab records a
 * different owner or clears it (a sign-out, a different account signing in), this page stops
 * rendering and reloads, so the check runs again for the account signed in now. A sign-in can
 * also land where nothing records an owner (an unknown address), so whenever the tab is shown
 * again it asks which account is signed in, and reloads the same way when that is no longer the
 * account it rendered for. A session that has ended, at the first check or when the tab is shown
 * again, shows no page and no message: the tab goes to sign in, as every page does when the server
 * reports an ended session. In local mode the page renders after the storage mode is known, with
 * the copy as it is.
 */
export function WorkspaceOwnerGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "ready" | "failed">("checking");

  useEffect(() => {
    let cancelled = false;
    let stopListening = () => {};
    claimWorkspaceForSignedInAccount().then(
      (owner) => {
        if (cancelled) return;
        setState("ready");
        if (owner === null) return;
        let left = false;
        /** Stops rendering the page, once; answers whether this call is the one that did. */
        const drop = () => {
          if (left || cancelled) return false;
          left = true;
          stopListening();
          setState("checking");
          return true;
        };
        const leave = () => {
          if (drop()) window.location.reload();
        };
        const onStorage = (event: StorageEvent) => {
          if (event.key !== null && event.key !== WORKSPACE_OWNER_KEY) return;
          if (localStorage.getItem(WORKSPACE_OWNER_KEY) === owner) return;
          leave();
        };
        const onShown = () => {
          if (document.visibilityState !== "visible") return;
          readSignedInUsername().then(
            (username) => {
              if (username !== owner) leave();
            },
            // Not knowing the account now says nothing about a switch: this page stays as it
            // is, and the next request a page sends meets the session check as usual. A session
            // that has ended is known: the page goes, and the tab goes to sign in.
            (err: unknown) => {
              if (err instanceof SessionEndedError) {
                if (drop()) reportSessionEnded();
                return;
              }
              logger.warn("Could not ask which account is signed in when the tab was shown again", {
                error: err instanceof Error ? err.message : String(err),
              });
            },
          );
        };
        window.addEventListener("storage", onStorage);
        document.addEventListener("visibilitychange", onShown);
        stopListening = () => {
          window.removeEventListener("storage", onStorage);
          document.removeEventListener("visibilitychange", onShown);
        };
      },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof SessionEndedError) {
          reportSessionEnded();
          return;
        }
        logger.warn("Could not match this browser's workspace to the signed-in account", {
          error: err instanceof Error ? err.message : String(err),
        });
        setState("failed");
      },
    );
    return () => {
      cancelled = true;
      stopListening();
    };
  }, []);

  if (state === "ready") return children;
  if (state === "failed") {
    return (
      <p role="alert" className="p-6 text-sm text-danger">
        Studio could not confirm the signed-in account, so this browser&apos;s workspace is not shown. Reload the page
        to try again.
      </p>
    );
  }
  return <ViewLoading label="Checking the signed-in account" className="h-screen" />;
}
