'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MonitoringDashboard } from '@/components/monitoring/MonitoringDashboard';
import { RefreshCw } from 'lucide-react';

export default function MonitoringPage() {
  const router = useRouter();
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    // Check authentication
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        if (data.authenticated) {
          setIsAuthenticated(true);
        } else {
          router.push('/login');
        }
      })
      .catch(() => {
        router.push('/login');
      });
  }, [router]);

  if (isAuthenticated === null) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <RefreshCw className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <MonitoringDashboard />;
}
