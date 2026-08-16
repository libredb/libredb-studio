"use client";

import React, { type Dispatch, type SetStateAction } from "react";
import type { QueryTab } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FileJson, Hash, Plus, X } from "lucide-react";

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
  // Roving tabindex (WAI-ARIA tabs pattern): arrows/Home/End move activation,
  // and focus follows the newly activated tab.
  const activateTabAt = (index: number, e: React.KeyboardEvent) => {
    const target = tabs[(index + tabs.length) % tabs.length];
    onSetActiveTabId(target.id);
    e.currentTarget
      .closest('[role="tablist"]')
      ?.querySelector<HTMLButtonElement>(`[role="tab"][data-tab-id="${target.id}"]`)
      ?.focus();
  };

  const handleTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === "ArrowRight") activateTabAt(index + 1, e);
    else if (e.key === "ArrowLeft") activateTabAt(index - 1, e);
    else if (e.key === "Home") activateTabAt(0, e);
    else if (e.key === "End") activateTabAt(tabs.length - 1, e);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="tablist"
      aria-label="Editor tabs"
      className="hidden md:flex h-10 bg-raised border-b border-hairline items-center px-2 gap-1 overflow-x-auto no-scrollbar"
    >
      {tabs.map((tab, index) => (
        // Non-semantic wrapper: role="tab" lives on the name button below so
        // the rename input and close button are siblings, not tab descendants
        // (a tab must not contain focusable controls, and the close button's
        // label would otherwise contaminate the tab's accessible name).
        <div
          key={tab.id}
          className={cn(
            "h-8 flex items-center px-3 gap-2 rounded-t-md transition-all cursor-pointer min-w-[120px] max-w-[200px] group relative border-t-2",
            activeTabId === tab.id
              ? "bg-overlay text-fg border-blue-500"
              : "text-fg-muted hover:bg-fill border-transparent",
          )}
        >
          {editingTabId === tab.id ? (
            <>
              {tab.type === "sql" ? (
                <Hash strokeWidth={1.5} className="w-3 h-3" />
              ) : (
                <FileJson strokeWidth={1.5} className="w-3 h-3" />
              )}
              <input
                autoFocus
                aria-label={`Rename ${tab.name}`}
                value={editingTabName}
                onChange={(e) => onSetEditingTabName(e.target.value)}
                onBlur={() => {
                  if (editingTabName.trim()) {
                    onSetTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, name: editingTabName.trim() } : t)));
                  }
                  onSetEditingTabId(null);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== "Escape") return;
                  if (e.key === "Enter" && editingTabName.trim()) {
                    onSetTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, name: editingTabName.trim() } : t)));
                  }
                  // The input unmounts with the state update; hand focus back to
                  // the restored tab button instead of the document body.
                  const tablist = e.currentTarget.closest('[role="tablist"]') as HTMLElement | null;
                  onSetEditingTabId(null);
                  setTimeout(() => {
                    tablist?.querySelector<HTMLButtonElement>(`[role="tab"][data-tab-id="${tab.id}"]`)?.focus();
                  }, 0);
                }}
                onClick={(e) => e.stopPropagation()}
                className="text-xs font-medium bg-transparent border-b border-blue-500 outline-none w-full text-fg"
              />
            </>
          ) : (
            <button
              type="button"
              role="tab"
              data-tab-id={tab.id}
              aria-selected={activeTabId === tab.id}
              tabIndex={activeTabId === tab.id ? 0 : -1}
              onClick={() => onSetActiveTabId(tab.id)}
              onKeyDown={(e) => handleTabKeyDown(e, index)}
              onDoubleClick={() => {
                onSetEditingTabId(tab.id);
                onSetEditingTabName(tab.name);
              }}
              className="flex items-center gap-2 flex-1 min-w-0 h-full text-left cursor-pointer"
            >
              {tab.type === "sql" ? (
                <Hash strokeWidth={1.5} className="w-3 h-3" />
              ) : (
                <FileJson strokeWidth={1.5} className="w-3 h-3" />
              )}
              <span className="text-xs truncate font-medium">{tab.name}</span>
            </button>
          )}
          {tabs.length > 1 && (
            <button
              type="button"
              aria-label={`Close ${tab.name}`}
              className="ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-fg-bright shrink-0 cursor-pointer"
              onClick={(e) => {
                // Closing removes this button from the DOM; without an explicit
                // handoff, keyboard focus falls back to the document body.
                const tablist = e.currentTarget.closest('[role="tablist"]') as HTMLElement | null;
                onCloseTab(tab.id, e);
                setTimeout(() => {
                  tablist?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
                }, 0);
              }}
            >
              <X strokeWidth={1.5} className="w-3 h-3" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        aria-label="New tab"
        className="text-fg-muted cursor-pointer hover:text-fg-bright mx-2"
        onClick={onAddTab}
      >
        <Plus strokeWidth={1.5} className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
