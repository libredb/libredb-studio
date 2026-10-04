"use client";

import { appFetch } from "@/lib/config/base-path";
import { useEffect, useState } from "react";
import { PlatformDiscoveryCard } from "@/components/admin/PlatformDiscoveryCard";
import { OverviewTab, type AdminUser } from "@/components/admin/tabs/OverviewTab";

export default function AdminOverviewPage() {
  const [user, setUser] = useState<AdminUser | null>(null);

  useEffect(() => {
    appFetch("/api/auth/me")
      .then((res) => res.json())
      .then((data) => {
        if (data.authenticated && data.user) {
          setUser(data.user);
        }
      })
      .catch((error) => {
        console.error("Failed to fetch user:", error);
      });
  }, []);

  // The discovery card sits above OverviewTab, not inside it, so it shows on both of OverviewTab's
  // branches: the empty state it returns early when there is no connection at all, and the full overview.
  return (
    <div data-testid="admin-content-overview" className="mx-auto max-w-7xl px-4 sm:px-6 py-6 space-y-6">
      <PlatformDiscoveryCard />
      <OverviewTab user={user} />
    </div>
  );
}
