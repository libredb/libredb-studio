import { AccountsTab } from "@/components/admin/tabs/AccountsTab";

export default function AdminAccountsPage() {
  return (
    <div data-testid="admin-content-accounts" className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
      <AccountsTab />
    </div>
  );
}
