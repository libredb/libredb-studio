import { AuditTab } from "@/components/admin/tabs/AuditTab";

export default function AdminAuditPage() {
  return (
    <div data-testid="admin-content-audit" className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
      <AuditTab />
    </div>
  );
}
