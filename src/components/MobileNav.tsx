"use client";

import React from 'react';
import { Database, Terminal, Table as TableIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MobileNavProps {
  activeTab: 'database' | 'schema' | 'editor';
  onTabChange: (tab: 'database' | 'schema' | 'editor') => void;
  hasResult?: boolean;
}

export function MobileNav({ activeTab, onTabChange }: MobileNavProps) {
  const tabs = [
    { id: 'database', label: 'DB', icon: Database },
    { id: 'schema', label: 'Schema', icon: TableIcon },
    { id: 'editor', label: 'SQL', icon: Terminal },
  ] as const;

  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 h-16 bg-[#0a0a0a]/90 backdrop-blur-xl border-t border-white/5 flex items-center justify-around px-4 z-50">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;

        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "flex flex-col items-center gap-1 transition-all duration-200 relative",
              isActive ? "text-blue-400" : "text-zinc-500"
            )}
          >
            <div className={cn(
              "p-2 rounded-xl transition-all",
              isActive ? "bg-blue-500/10 scale-110" : "hover:bg-white/5"
            )}>
              <Icon className="w-5 h-5" />
            </div>
            <span className="text-[10px] font-medium uppercase tracking-wider">{tab.label}</span>
            {isActive && (
              <div className="absolute -top-1 w-1 h-1 bg-blue-400 rounded-full" />
            )}
          </button>
        );
      })}
    </div>
  );
}
