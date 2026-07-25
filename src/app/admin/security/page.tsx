import { SecurityTab } from "@/components/admin/tabs/SecurityTab";

export default function AdminSecurityPage() {
  return (
    <div data-testid="admin-content-security" className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
      <SecurityTab />
    </div>
  );
}
