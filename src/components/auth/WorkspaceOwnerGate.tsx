"use client";

import { type ReactNode, useEffect, useState } from "react";
import { logger } from "@/lib/logger";
import { claimWorkspaceForSignedInAccount } from "@/lib/storage/workspace-owner";

/**
 * Renders a page that reads this browser's copy of the workspace only once the copy is the
 * signed-in account's. In server storage mode the browser copy belongs to the signed-in account,
 * so a copy another account left behind is cleared before the page reads it, and signing in as
 * a different account starts from that account's server data on every such page, not only the
 * editor. In local mode the page renders after the storage mode is known, with the copy as it is.
 */
export function WorkspaceOwnerGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "ready" | "failed">("checking");

  useEffect(() => {
    let cancelled = false;
    claimWorkspaceForSignedInAccount().then(
      () => {
        if (!cancelled) setState("ready");
      },
      (err: unknown) => {
        logger.warn("Could not match this browser's workspace to the signed-in account", {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!cancelled) setState("failed");
      },
    );
    return () => {
      cancelled = true;
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
  return null;
}
