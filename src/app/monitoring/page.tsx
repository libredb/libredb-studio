"use client";

import { WorkspaceOwnerGate } from "@/components/auth/WorkspaceOwnerGate";
import { MonitoringDashboard } from "@/components/monitoring/MonitoringDashboard";

export default function MonitoringPage() {
  // Middleware handles authentication, no need for client-side check
  return (
    <WorkspaceOwnerGate>
      <MonitoringDashboard />
    </WorkspaceOwnerGate>
  );
}
