"use client";

import React from "react";
import { Bot, Database, Terminal, Table as TableIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface MobileNavProps {
  activeTab: "database" | "schema" | "editor";
  onTabChange: (tab: "database" | "schema" | "editor") => void;
  hasResult?: boolean;
  /**
   * Opens the agent rail as a sheet (#329 T10a). Absent unless the server says the
   * agent runtime is enabled — an absent handler means there is no agent surface at
   * all, rather than a control that does nothing. Deliberately not a tab: the sheet
   * opens over whatever tab the user is on, so it never becomes `activeTab`.
   */
  onOpenAgent?: () => void;
}

export function MobileNav({ activeTab, onTabChange, onOpenAgent }: MobileNavProps) {
  const tabs = [
    { id: "database", label: "DB", icon: Database },
    { id: "schema", label: "Schema", icon: TableIcon },
    { id: "editor", label: "SQL", icon: Terminal },
  ] as const;

  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 h-16 bg-surface/90 backdrop-blur-xl border-t border-hairline flex items-center justify-around px-4 z-50">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;

        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "flex flex-col items-center gap-1 transition-all duration-200 relative",
              isActive ? "text-blue-400" : "text-fg-muted",
            )}
          >
            <div
              className={cn("p-2 rounded-xl transition-all", isActive ? "bg-blue-500/10 scale-110" : "hover:bg-fill")}
            >
              {/* strokeWidth per the platform-integration rule; the row's new agent
                  icon would otherwise render visibly thinner than its siblings. */}
              <Icon strokeWidth={1.5} className="w-5 h-5" />
            </div>
            {/* `font-mediumr` was a typo Tailwind emitted nothing for; the agent
                label added below would otherwise render at a different weight. */}
            <span className="text-xs font-medium">{tab.label}</span>
            {isActive && <div className="absolute -top-1 w-1 h-1 bg-blue-400 rounded-full" />}
          </button>
        );
      })}

      {onOpenAgent !== undefined && (
        <button
          data-testid="mobile-nav-agent"
          onClick={onOpenAgent}
          className="flex flex-col items-center gap-1 transition-all duration-200 relative text-fg-muted"
        >
          <div className="p-2 rounded-xl transition-all hover:bg-fill">
            <Bot strokeWidth={1.5} className="w-5 h-5" />
          </div>
          <span className="text-xs font-medium">Agent</span>
        </button>
      )}
    </div>
  );
}
