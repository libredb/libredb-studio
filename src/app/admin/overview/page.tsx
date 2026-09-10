"use client";

import { appFetch } from "@/lib/config/base-path";
import { useEffect, useState } from "react";
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

  return (
    <div data-testid="admin-content-overview" className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
      <OverviewTab user={user} />
    </div>
  );
}
