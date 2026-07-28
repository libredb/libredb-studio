import { Suspense } from "react";
import AdminDashboard from "@/components/admin/AdminDashboard";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    // The boundary is no longer required by the shell itself (AdminDashboard moved
    // from useSearchParams to usePathname, which needs no Suspense). It stays as the
    // streaming boundary for the section pages rendered into {children}.
    <Suspense>
      <AdminDashboard>{children}</AdminDashboard>
    </Suspense>
  );
}
