"use client";

import { appFetch } from "@/lib/config/base-path";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/hooks/use-toast";
import { logger } from "@/lib/logger";

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
  // The proxy cannot know that, so the tab goes to the login screen from here.
  useEffect(() => {
    if (sessionEnded) router.push("/login");
  }, [sessionEnded, router]);

  const isAdmin = user?.role === "admin";

  const handleLogout = useCallback(async () => {
    try {
      const res = await appFetch("/api/auth/logout", { method: "POST" });
      const data = await res.json();
      toast({ title: "Logged out", description: "You have been successfully logged out." });

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
