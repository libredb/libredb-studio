'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  LogOut,
  ArrowLeft,
  LayoutDashboard,
  Wrench,
  Activity,
  Shield,
  FileText,
} from 'lucide-react';
import { toast } from 'sonner';

import { OverviewTab } from './tabs/OverviewTab';
import { OperationsTab } from './tabs/OperationsTab';
import { MonitoringEmbed } from './tabs/MonitoringEmbed';
import { SecurityTab } from './tabs/SecurityTab';
import { AuditTab } from './tabs/AuditTab';

interface User {
  username: string;
  role: string;
}

export default function AdminDashboard() {
  const [user, setUser] = useState<User | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const defaultTab = searchParams.get('tab') || 'overview';

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        if (data.authenticated && data.user) {
          setUser(data.user);
        }
      })
      .catch((error) => {
        console.error('Failed to fetch user:', error);
      });
  }, []);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    toast.success('Logged out successfully');
    router.push('/login');
    router.refresh();
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col">
      {/* Header */}
      <header className="border-b border-white/5 bg-zinc-950">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="space-y-0.5">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-zinc-100">
              Admin Dashboard
            </h1>
            <p className="text-xs text-zinc-500">
              Manage your application and infrastructure.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="border-white/10 text-zinc-400 hover:text-zinc-100"
              onClick={() => router.push('/')}
            >
              <ArrowLeft className="mr-2 h-3.5 w-3.5" />
              <span className="hidden sm:inline">Editor</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-red-500/20 text-red-400 hover:bg-red-500/10 hover:text-red-300"
              onClick={handleLogout}
            >
              <LogOut className="mr-2 h-3.5 w-3.5" />
              <span className="hidden sm:inline">Logout</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <Tabs defaultValue={defaultTab} className="flex-1 flex flex-col">
        <div className="border-b border-white/5 bg-zinc-950">
          <div className="mx-auto max-w-7xl px-4 sm:px-6">
            <TabsList className="h-11 bg-transparent rounded-none p-0 gap-0 w-full justify-start overflow-x-auto">
              <TabsTrigger
                value="overview"
                className="flex-shrink-0 gap-2 px-3 sm:px-4 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent data-[state=active]:text-blue-400 text-zinc-500 text-xs sm:text-sm"
              >
                <LayoutDashboard className="h-4 w-4" />
                <span className="hidden sm:inline">Overview</span>
              </TabsTrigger>
              <TabsTrigger
                value="operations"
                className="flex-shrink-0 gap-2 px-3 sm:px-4 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent data-[state=active]:text-blue-400 text-zinc-500 text-xs sm:text-sm"
              >
                <Wrench className="h-4 w-4" />
                <span className="hidden sm:inline">Operations</span>
              </TabsTrigger>
              <TabsTrigger
                value="monitoring"
                className="flex-shrink-0 gap-2 px-3 sm:px-4 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent data-[state=active]:text-blue-400 text-zinc-500 text-xs sm:text-sm"
              >
                <Activity className="h-4 w-4" />
                <span className="hidden sm:inline">Monitoring</span>
              </TabsTrigger>
              <TabsTrigger
                value="security"
                className="flex-shrink-0 gap-2 px-3 sm:px-4 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent data-[state=active]:text-blue-400 text-zinc-500 text-xs sm:text-sm"
              >
                <Shield className="h-4 w-4" />
                <span className="hidden sm:inline">Security</span>
              </TabsTrigger>
              <TabsTrigger
                value="audit"
                className="flex-shrink-0 gap-2 px-3 sm:px-4 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent data-[state=active]:text-blue-400 text-zinc-500 text-xs sm:text-sm"
              >
                <FileText className="h-4 w-4" />
                <span className="hidden sm:inline">Audit</span>
              </TabsTrigger>
            </TabsList>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          <TabsContent value="overview" className="m-0 p-0">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
              <OverviewTab user={user} />
            </div>
          </TabsContent>
          <TabsContent value="operations" className="m-0 p-0">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
              <OperationsTab />
            </div>
          </TabsContent>
          <TabsContent value="monitoring" className="m-0 p-0 h-[calc(100vh-120px)]">
            <MonitoringEmbed />
          </TabsContent>
          <TabsContent value="security" className="m-0 p-0">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
              <SecurityTab />
            </div>
          </TabsContent>
          <TabsContent value="audit" className="m-0 p-0">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
              <AuditTab />
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
