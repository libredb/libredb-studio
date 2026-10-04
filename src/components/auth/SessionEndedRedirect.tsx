"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { claimSignInRedirect, signInPath } from "@/lib/api/session-ended";
import { currentAppPath, onSessionEnded } from "@/lib/config/base-path";

/**
 * Sends the tab to the sign-in screen when any API call reports that the session has ended
 * (#1420), with the page it was on as the return path. Mounted once, in the standalone app's root
 * layout, so every page has it; the published components never mount it, so an embedding
 * application keeps handling a 401 itself. Already on the sign-in screen, there is nowhere to go,
 * and a second refusal right after a redirect stays on the page (claimSignInRedirect).
 */
export function SessionEndedRedirect() {
  const router = useRouter();
  useEffect(
    () =>
      onSessionEnded(() => {
        const here = currentAppPath();
        if (here.split("?")[0] === "/login" || !claimSignInRedirect()) return;
        router.push(signInPath(here));
      }),
    [router],
  );
  return null;
}
