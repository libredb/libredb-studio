'use client';

import React, { type Dispatch, type SetStateAction } from 'react';
import type { QueryTab } from '@/lib/types';
import { cn } from '@/lib/utils';
import { FileJson, Hash, Plus, X } from 'lucide-react';

interface StudioTabBarProps {
  tabs: QueryTab[];
  activeTabId: string;
  editingTabId: string | null;
  editingTabName: string;
  onSetActiveTabId: (id: string) => void;
  onSetEditingTabId: (id: string | null) => void;
  onSetEditingTabName: (name: string) => void;
  onSetTabs: Dispatch<SetStateAction<QueryTab[]>>;
  onCloseTab: (id: string, e: React.MouseEvent) => void;
  onAddTab: () => void;
}

export function StudioTabBar({
  tabs,
  activeTabId,
  editingTabId,
  editingTabName,
  onSetActiveTabId,
  onSetEditingTabId,
  onSetEditingTabName,
  onSetTabs,
  onCloseTab,
  onAddTab,
}: StudioTabBarProps) {
  return (
    <div className="hidden md:flex h-10 bg-[#0d0d0d] border-b border-white/5 items-center px-2 gap-1 overflow-x-auto no-scrollbar">
      {tabs.map(tab => (
        <div
          key={tab.id}
          onClick={() => onSetActiveTabId(tab.id)}
          onDoubleClick={() => {
            onSetEditingTabId(tab.id);
            onSetEditingTabName(tab.name);
          }}
          className={cn(
            "h-8 flex items-center px-3 gap-2 rounded-t-md transition-all cursor-pointer min-w-[120px] max-w-[200px] group relative border-t-2",
            activeTabId === tab.id ? "bg-[#141414] text-zinc-100 border-blue-500" : "text-zinc-500 hover:bg-white/5 border-transparent"
          )}
        >
          {tab.type === 'sql' ? <Hash className="w-3 h-3" /> : <FileJson className="w-3 h-3" />}
          {editingTabId === tab.id ? (
            <input
              autoFocus
              value={editingTabName}
              onChange={(e) => onSetEditingTabName(e.target.value)}
              onBlur={() => {
                if (editingTabName.trim()) {
                  onSetTabs(prev => prev.map(t => t.id === tab.id ? { ...t, name: editingTabName.trim() } : t));
                }
                onSetEditingTabId(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (editingTabName.trim()) {
                    onSetTabs(prev => prev.map(t => t.id === tab.id ? { ...t, name: editingTabName.trim() } : t));
                  }
                  onSetEditingTabId(null);
                } else if (e.key === 'Escape') {
                  onSetEditingTabId(null);
                }
              }}
              onClick={(e) => e.stopPropagation()}
              className="text-xs font-medium bg-transparent border-b border-blue-500 outline-none w-full text-zinc-100"
            />
          ) : (
            <span className="text-xs truncate font-medium">{tab.name}</span>
          )}
          {tabs.length > 1 && <X className="w-3 h-3 ml-auto opacity-0 group-hover:opacity-100 hover:text-white shrink-0" onClick={(e) => onCloseTab(tab.id, e)} />}
        </div>
      ))}
      <Plus className="w-4 h-4 text-zinc-500 cursor-pointer hover:text-white mx-2" onClick={onAddTab} />
    </div>
  );
}
