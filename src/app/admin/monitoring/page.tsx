import { MonitoringEmbed } from "@/components/admin/tabs/MonitoringEmbed";

export default function AdminMonitoringPage() {
  return (
    <div data-testid="admin-content-monitoring" className="h-[calc(100vh-120px)]">
      <MonitoringEmbed />
    </div>
  );
}
