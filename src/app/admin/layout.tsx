import { Suspense } from "react";
import AdminDashboard from "@/components/admin/AdminDashboard";
import { WorkspaceOwnerGate } from "@/components/auth/WorkspaceOwnerGate";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    // The boundary is no longer required by the shell itself (AdminDashboard moved
    // from useSearchParams to usePathname, which needs no Suspense). It stays as the
    // streaming boundary for the section pages rendered into {children}.
    // The gate: every admin section reads this browser's copy of the workspace, which must be the
    // signed-in account's first.
    <Suspense>
      <WorkspaceOwnerGate>
        <AdminDashboard>{children}</AdminDashboard>
      </WorkspaceOwnerGate>
    </Suspense>
  );
}
