'use client';

import React from 'react';
import type { DatabaseConnection } from '@/lib/types';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Database, Gauge, LogOut, Settings, User } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';

interface StudioDesktopHeaderProps {
  activeConnection: DatabaseConnection | null;
  connectionPulse: 'healthy' | 'degraded' | 'error' | null;
  user: { role?: string } | null;
  isAdmin: boolean;
  onLogout: () => void;
}

export function StudioDesktopHeader({
  activeConnection,
  connectionPulse,
  user,
  isAdmin,
  onLogout,
}: StudioDesktopHeaderProps) {
  const router = useRouter();

  return (
    <header className="hidden md:flex h-14 border-b border-white/5 items-center justify-between px-4 bg-[#0a0a0a]/80 backdrop-blur-xl sticky top-0 z-30">
      <div className="flex items-center gap-3">
        <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20">
          <Database className="w-4 h-4 text-blue-400" />
        </div>
        <div>
          <h1 className="text-xs font-medium text-zinc-200 truncate max-w-[120px]">
            {activeConnection ? activeConnection.name : 'Quick Access'}
          </h1>
          {activeConnection && (
            <p className="text-xs text-zinc-500 font-mono uppercase leading-none mt-0.5">
              {activeConnection.type}
              {activeConnection.environment && activeConnection.environment !== 'other' && (
                <span
                  className="ml-1 font-medium"
                  style={{ color: activeConnection.color || '#22c55e' }}
                >
                  • {activeConnection.environment}
                </span>
              )}
              {!activeConnection.environment && (
                <span> • <span className="text-emerald-500/80">Online</span></span>
              )}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {connectionPulse && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/5 mr-2" title={`Connection: ${connectionPulse}`}>
            <div className={cn(
              "w-2 h-2 rounded-full",
              connectionPulse === 'healthy' && "bg-emerald-500 animate-pulse",
              connectionPulse === 'degraded' && "bg-amber-500",
              connectionPulse === 'error' && "bg-red-500",
            )} />
            <span className="text-xs font-medium text-zinc-500">
              {connectionPulse === 'healthy' ? 'Online' : connectionPulse === 'degraded' ? 'Slow' : 'Error'}
            </span>
          </div>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-3 text-xs font-medium gap-2 text-zinc-500 hover:text-purple-400 hover:bg-purple-500/10"
          onClick={() => router.push('/monitoring')}
        >
          <Gauge className="w-3 h-3" /> Monitoring
        </Button>

        {user && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 gap-2 hover:bg-white/5 px-2">
                <User className="w-3.5 h-3.5 text-blue-400" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 bg-[#0d0d0d] border-white/10 text-zinc-300">
              {isAdmin && (
                <DropdownMenuItem onClick={() => router.push('/admin')} className="cursor-pointer">
                  <Settings className="w-4 h-4 mr-2" /> Admin Dashboard
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => router.push('/monitoring')} className="cursor-pointer">
                <Gauge className="w-4 h-4 mr-2" /> Monitoring
              </DropdownMenuItem>
              <div className="border-t border-white/5 my-1" />
              <DropdownMenuItem onClick={onLogout} className="text-red-400 cursor-pointer">
                <LogOut className="w-4 h-4 mr-2" /> Logout
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Settings className="w-4 h-4 text-zinc-400 cursor-pointer hover:text-white transition-colors mx-2" />
        <span className="text-xs text-zinc-500 font-mono">
          v{process.env.NEXT_PUBLIC_APP_VERSION}
        </span>
      </div>
    </header>
  );
}
