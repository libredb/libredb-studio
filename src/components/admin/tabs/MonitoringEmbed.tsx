'use client';

import { MonitoringDashboard } from '@/components/monitoring/MonitoringDashboard';

export function MonitoringEmbed() {
  return (
    <div className="h-full">
      <MonitoringDashboard isEmbedded />
    </div>
  );
}
