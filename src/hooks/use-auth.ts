"use client";

import { appFetch, currentAppPath } from "@/lib/config/base-path";
import { claimSignInRedirect, signInPath } from "@/lib/api/session-ended";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/hooks/use-toast";
import { logger } from "@/lib/logger";
import { releaseAccountWorkspace } from "@/lib/storage/sign-out";

/** What a sign-out says when changes that could not be pushed stay in this browser's copy. */
const CHANGES_KEPT =
  "Some changes could not be saved to server storage. This browser keeps them and saves them when this account signs in here again; a different account signing in here first discards them.";

interface AuthUser {
  role?: string;
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const res = await appFetch("/api/auth/me");
        if (res.ok) {
          const data = await res.json();
          setUser(data.user);
        } else if (res.status === 401) {
          setSessionEnded(true);
        }
      } catch (error) {
        logger.warn("Failed to fetch the signed-in user", {
          route: "use-auth",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    fetchUser();
  }, []);

  // The server ended this session (for example the account was disabled) and cleared the cookie.
  // The proxy cannot know that, so the tab goes to the login screen from here, and comes back after.
  useEffect(() => {
    if (sessionEnded && claimSignInRedirect()) router.push(signInPath(currentAppPath()));
  }, [sessionEnded, router]);

  const isAdmin = user?.role === "admin";

  const handleLogout = useCallback(async () => {
    try {
      // In server storage mode the browser copy belongs to the signed-in account: it is pushed
      // while the session cookie is still valid and cleared once the session ended, or kept for
      // this account when a push did not land. The session-ended path above clears nothing; the
      // owner check every page that reads the copy runs at the next sign-in covers a different
      // account.
      const { signedOut, response, changesKept } = await releaseAccountWorkspace(() =>
        appFetch("/api/auth/logout", { method: "POST" }),
      );
      if (!signedOut) throw new Error("Sign-out did not complete");
      const data: { redirectUrl?: string } = response ? await response.json() : {};
      toast({
        title: "Logged out",
        description: changesKept ? CHANGES_KEPT : "You have been successfully logged out.",
      });

      if (data.redirectUrl) {
        window.location.href = data.redirectUrl;
      } else {
        router.push("/login");
        router.refresh();
      }
    } catch {
      toast({ title: "Error", description: "Failed to logout.", variant: "destructive" });
    }
  }, [toast, router]);

  return { user, isAdmin, handleLogout };
}
