"use client";

import { useEffect, useState } from "react";
import { OverviewTab } from "@/components/admin/tabs/OverviewTab";

interface User {
  username: string;
  role: string;
}

export default function AdminOverviewPage() {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
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
