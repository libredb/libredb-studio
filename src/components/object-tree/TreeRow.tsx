"use client";

/**
 * One row of the object tree (#789).
 *
 * Every ARIA number is taken VERBATIM from `TreeRowModel` and none is computed here. The W3C tree
 * pattern requires `aria-setsize` and `aria-posinset` exactly when the full node set is not in the
 * DOM, which is what a window does, so deriving either one from what is mounted would be wrong in
 * precisely the case they exist for. `aria-expanded` is rendered only where the model carries it:
 * a leaf must not claim to be closed, and a folder whose count the engine refused is a leaf.
 */

import { ChevronDown, ChevronRight, Database, Folder, LoaderCircle, Table2 } from "lucide-react";
import type { DatabaseObject } from "@/lib/db/types";
import type { TreeRowModel } from "./flatten";
import type { TreeReadFailure } from "./use-tree-nodes";

/** Fixed, because the window is a slice and a slice needs one arithmetic for every row. */
export const TREE_ROW_HEIGHT = 28;

const ROW_ICONS = { container: Database, folder: Folder, object: Table2 } as const;

export interface TreeRowProps {
  readonly row: TreeRowModel;
  /** The object an object row was built from, for `status` and `rowCount`, which the model omits. */
  readonly object?: DatabaseObject;
  /** This row holds the tree's single tab stop. */
  readonly active: boolean;
  /**
   * The reader has picked this row.
   *
   * Distinct from `active`: before anything is picked the first row holds the tab stop so the tree
   * is reachable by keyboard, and saying that row is SELECTED would announce a choice nobody made.
   */
  readonly selected: boolean;
  readonly busy: boolean;
  /** This row's own read failed, as opposed to the engine refusing to count it. */
  readonly failure?: TreeReadFailure;
  /**
   * A row menu is offered here, which `aria-haspopup` announces. Computed from the
   * provider's declaration by `ObjectTree`, so a row with nothing to offer says nothing
   * rather than promising a menu that opens empty.
   */
  readonly hasActions?: boolean;
  /** Absolute offset inside the scroll spacer, in pixels. */
  readonly top: number;
}

export function TreeRow({ row, object, active, selected, busy, failure, hasActions, top }: TreeRowProps) {
  const Icon = ROW_ICONS[row.kind];
  return (
    <div
      role="treeitem"
      data-row-id={row.id}
      aria-level={row.depth + 1}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      aria-expanded={row.expanded}
      aria-selected={selected}
      aria-busy={busy ? true : undefined}
      aria-haspopup={hasActions === true ? "menu" : undefined}
      tabIndex={active ? 0 : -1}
      style={{ top, height: TREE_ROW_HEIGHT, paddingLeft: 8 + row.depth * 12 }}
      className={`absolute inset-x-0 flex items-center gap-1.5 pr-2 text-xs cursor-pointer select-none outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand ${
        selected ? "bg-muted" : "hover:bg-muted/60"
      }`}
    >
      <span aria-hidden="true" className="w-3.5 shrink-0 text-muted-foreground">
        {row.expanded === undefined ? null : row.expanded ? (
          <ChevronDown strokeWidth={1.5} className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight strokeWidth={1.5} className="w-3.5 h-3.5" />
        )}
      </span>
      <Icon aria-hidden="true" strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
      <span data-testid="tree-row-label" className="truncate">
        {row.label}
      </span>
      {object?.status !== undefined && (
        <span
          data-testid="tree-row-status"
          className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground"
        >
          {object.status}
        </span>
      )}
      {busy && <LoaderCircle aria-hidden="true" className="w-3 h-3 shrink-0 animate-spin text-muted-foreground" />}
      {/* The engine's own sentence for a read it refused, in place of the number it could not give. */}
      {row.unavailable !== undefined && (
        <span
          data-testid="tree-row-unavailable"
          title={row.unavailable}
          className="ml-auto truncate pl-2 text-[10px] text-warning"
        >
          {row.unavailable}
        </span>
      )}
      {/*
        A read that failed, in the engine's own words. The 501 that says the provider has not been
        migrated yet is NOT drawn as a failure: it is not red, because nothing is wrong with the
        database or the request. That distinction is the same one the root panel makes, and it
        reaches a single row whenever a provider implements one object method and not the next,
        which is the state each of the fifteen remaining provider tasks passes through.
      */}
      {failure !== undefined && (
        <span
          data-testid={failure.unimplemented ? "tree-row-unimplemented" : "tree-row-failure"}
          title={failure.message}
          className={`ml-auto truncate pl-2 text-[10px] ${
            failure.unimplemented ? "text-muted-foreground" : "text-destructive"
          }`}
        >
          {failure.message}
        </span>
      )}
      {object?.rowCount !== undefined && (
        <span
          data-testid="tree-row-count"
          title="Rows, as the engine reported them, which is an estimate on most engines"
          className="ml-auto shrink-0 pl-2 text-[10px] text-muted-foreground tabular-nums"
        >
          {object.rowCount.toLocaleString("en-US")}
        </span>
      )}
      {/*
        The folder's count. A trailing `+` is `flatten.ts` saying the number is a FLOOR because
        the provider counted what a bounded read saw, and `badgeTitle` is that provider's own
        sentence for what bounded it. The title is absent on an exact count, so hovering one
        number and not the other is itself the signal (#789).
      */}
      {row.badge !== undefined && (
        <span
          data-testid="tree-row-badge"
          title={row.badgeTitle}
          className="ml-auto shrink-0 pl-2 text-[10px] text-muted-foreground tabular-nums"
        >
          {row.badge}
        </span>
      )}
    </div>
  );
}
