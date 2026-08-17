"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/hooks/use-toast";
import { logger } from "@/lib/logger";

interface AuthUser {
  role?: string;
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const { toast } = useToast();
  const router = useRouter();

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const res = await fetch("/api/auth/me");
        if (res.ok) {
          const data = await res.json();
          setUser(data.user);
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

  const isAdmin = user?.role === "admin";

  const handleLogout = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
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
