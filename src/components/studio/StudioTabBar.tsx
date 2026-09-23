"use client";

import React, { useEffect, type Dispatch, type SetStateAction } from "react";
import type { QueryTab } from "@/lib/types";
import { SHORTCUTS, matchesShortcut, shortcutLabel } from "@/lib/keyboard-shortcuts";
import { cn } from "@/lib/utils";
import { FileBraces, FileCode, Hash, Plus, X } from "lucide-react";

/**
 * Which icon a tab draws, in ONE place because the bar draws it in TWO (#789 Phase 2).
 *
 * The rename input and the tab button each render the icon beside the name, and the ladder
 * used to be written out at both sites. A third arm added to one of them and not the other is
 * a drift nothing would report, so the ladder is a function and the two sites call it.
 *
 * The SOURCE arm is first and it wins over the dialect. A Source tab holds no query, so its
 * `type` is the neutral `"sql"` on a SQL connection and whatever `resolveTabType` answered on
 * a document connection; without this arm a Source tab on MongoDB or Redis would take the
 * document icon and be indistinguishable from a query tab in the one place a reader picks a
 * tab from. Nothing errors if the arm is missing, which is exactly why it is tested.
 *
 * The last arm means "a query language that is not SQL", not "JSON": Redis and LibreDB commands
 * take it, and so does PromQL (#1085), decided rather than defaulted and pinned in
 * `tests/components/studio/StudioTabBar.test.tsx`.
 */
function tabIcon(tab: QueryTab): React.JSX.Element {
  // The ELEMENT rather than the component, so nothing here assigns a component to a local
  // inside a render: `react(static-components)` is an error in this repository's oxlint
  // configuration, and the three returns also keep the size and the stroke in one place.
  if (tab.source !== undefined) return <FileCode strokeWidth={1.5} className="w-3 h-3" />;
  if (tab.type === "sql") return <Hash strokeWidth={1.5} className="w-3 h-3" />;
  return <FileBraces strokeWidth={1.5} className="w-3 h-3" />;
}

/**
 * Whether this tab holds source text the reader has changed and not applied (#789 Phase 3).
 *
 * READ THROUGH `tab.source`, so an ordinary query tab has no field that could carry it and the
 * strip cannot mark one by accident. The pane writes `dirty` onto `SourceTabState` only when the
 * buffer's dirtiness FLIPS, so this costs one render per transition rather than one per keystroke.
 */
function hasUnsavedEdit(tab: QueryTab): boolean {
  return tab.source?.dirty === true;
}

/**
 * The tab's ACCESSIBLE NAME, which is its visible label plus the mark when there is one.
 *
 * WCAG 2.5.3, Label in Name: the accessible name has to CONTAIN the visible label. The dot beside
 * the icon is the only visible statement that a tab the reader is not looking at holds an unsaved
 * edit, and a dot is not text, so the same fact is put in the name. Replacing the name with
 * "unsaved edit" would satisfy nothing: a speech-input user could no longer say the tab's own name
 * to reach it, and a screen-reader user would not be told WHICH object the mark is about.
 *
 * `undefined` and not the bare name for a tab with no mark, so the accessible name keeps coming
 * from the visible text in the ordinary case. An `aria-label` that duplicates the visible label is
 * a second copy of the same string that can drift from it under a rename.
 */
function tabAccessibleName(tab: QueryTab): string | undefined {
  return hasUnsavedEdit(tab) ? `${tab.name} (unsaved edit)` : undefined;
}

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

  // The "+" button's keyboard twin (#745): register on `document` so it also
  // works while Monaco owns focus (Monaco uses a hidden textarea). Only the
  // tab rename input is excluded so the shortcut does not interrupt renaming.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, SHORTCUTS.newTab)) return;
      const target = event.target;
      if (target instanceof HTMLInputElement && target.getAttribute("aria-label")?.startsWith("Rename ")) return;
      event.preventDefault();
      onAddTab();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onAddTab]);

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
              ? "bg-overlay text-fg border-brand-tint"
              : "text-fg-muted hover:bg-fill border-transparent",
          )}
        >
          {editingTabId === tab.id ? (
            <>
              {tabIcon(tab)}
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
                className="text-xs font-medium bg-transparent border-b border-brand-tint outline-none w-full text-fg"
              />
            </>
          ) : (
            <button
              type="button"
              role="tab"
              data-tab-id={tab.id}
              aria-selected={activeTabId === tab.id}
              aria-label={tabAccessibleName(tab)}
              tabIndex={activeTabId === tab.id ? 0 : -1}
              onClick={() => onSetActiveTabId(tab.id)}
              onKeyDown={(e) => handleTabKeyDown(e, index)}
              onDoubleClick={() => {
                onSetEditingTabId(tab.id);
                onSetEditingTabName(tab.name);
              }}
              className="flex items-center gap-2 flex-1 min-w-0 h-full text-left cursor-pointer"
            >
              {tabIcon(tab)}
              {hasUnsavedEdit(tab) && (
                /*
                 * ARIA-HIDDEN, because the same fact is already in the tab's accessible name
                 * above. Left in the tree it would be announced as a second, wordless node
                 * inside the tab, and a decorative shape has nothing to say twice.
                 */
                <span
                  aria-hidden="true"
                  data-testid="tab-dirty-dot"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-tint"
                />
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
        title={`New Query Tab (${shortcutLabel(SHORTCUTS.newTab)})`}
        className="text-fg-muted cursor-pointer hover:text-fg-bright mx-2"
        onClick={onAddTab}
      >
        <Plus strokeWidth={1.5} className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
