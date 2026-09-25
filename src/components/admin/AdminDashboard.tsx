"use client";

import { appFetch } from "@/lib/config/base-path";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { LogOut, ArrowLeft, LayoutDashboard, Wrench, Activity, Shield, FileText, Users } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ADMIN_SECTIONS, adminSectionFromPathname, adminSectionPath, type AdminSection } from "@/lib/admin-sections";

const SECTION_NAV: Record<AdminSection, { label: string; icon: typeof LayoutDashboard }> = {
  overview: { label: "Overview", icon: LayoutDashboard },
  operations: { label: "Operations", icon: Wrench },
  monitoring: { label: "Monitoring", icon: Activity },
  security: { label: "Security", icon: Shield },
  accounts: { label: "Accounts", icon: Users },
  audit: { label: "Audit", icon: FileText },
};

interface AdminDashboardProps {
  children: ReactNode;
}

export default function AdminDashboard({ children }: AdminDashboardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const activeSection = adminSectionFromPathname(pathname);

  const handleLogout = async () => {
    const res = await appFetch("/api/auth/logout", { method: "POST" });
    const data = await res.json();
    toast.success("Logged out successfully");

    // In OIDC mode the route answers with the provider's end_session URL. The local cookie is gone
    // either way, but the provider session only ends if the browser visits that URL, so dropping it
    // here left an admin signed in at the IdP while the app looked signed out. Same handling as
    // src/hooks/use-auth.ts, which is the other caller of this route.
    if (data.redirectUrl) {
      window.location.href = data.redirectUrl;
    } else {
      router.push("/login");
      router.refresh();
    }
  };

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <header className="border-b border-hairline bg-surface">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="space-y-0.5">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-fg">Admin Dashboard</h1>
            <p className="text-xs text-fg-muted">Manage your application and infrastructure.</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="border-hairline-strong text-fg-tertiary hover:text-fg"
              onClick={() => router.push("/")}
            >
              <ArrowLeft className="mr-2 h-3.5 w-3.5" />
              <span className="hidden sm:inline">Editor</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-danger-tint/20 text-danger hover:bg-danger-tint/10 hover:text-danger-bright"
              onClick={handleLogout}
            >
              <LogOut className="mr-2 h-3.5 w-3.5" />
              <span className="hidden sm:inline">Logout</span>
            </Button>
          </div>
        </div>
      </header>

      <div className="border-b border-hairline bg-surface">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <nav
            aria-label="Admin sections"
            className="h-11 flex items-center gap-0 w-full justify-start overflow-x-auto"
          >
            {ADMIN_SECTIONS.map((section) => {
              const { label, icon: Icon } = SECTION_NAV[section];
              const isActive = activeSection === section;
              return (
                <Link
                  key={section}
                  href={adminSectionPath(section)}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    // whitespace-nowrap keeps the longest labels on one line inside the
                    // h-11 row; the nav's overflow-x-auto then scrolls instead of wrapping.
                    "flex flex-1 items-center justify-center gap-2 px-3 sm:px-4 h-11 border-b-2 text-xs sm:text-sm whitespace-nowrap transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/60",
                    isActive ? "border-brand text-brand" : "border-transparent text-fg-muted hover:text-fg-secondary",
                  )}
                >
                  <Icon className="h-4 w-4" strokeWidth={1.5} />
                  <span className="hidden sm:inline">{label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      </div>

      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}
