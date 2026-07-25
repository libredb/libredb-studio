import { OperationsTab } from "@/components/admin/tabs/OperationsTab";

export default function AdminOperationsPage() {
  return (
    <div data-testid="admin-content-operations" className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
      <OperationsTab />
    </div>
  );
}
