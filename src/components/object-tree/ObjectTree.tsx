"use client";

/**
 * The lazy, container-aware object tree (#789).
 *
 * Windowed by hand rather than by a library. `react-window` would be a new dependency, and
 * `@tanstack/react-virtual`, which this repo already has, cannot be exercised in a component test:
 * happy-dom measures every element as zero, which is why `tests/components/ResultsGrid.test.tsx`
 * has to replace that module with `mock.module`, and a mocked virtualiser would make every row
 * assertion here vacuous. A fixed row height and a slice is a few lines, is measured by its own
 * tests, and lets the window be clamped so the row holding focus is always mounted, which the
 * roving tabindex depends on. Either way the ARIA numbers come from `flattenTree` and never from
 * the window.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, PlugZap } from "lucide-react";
import type { DatabaseObject, ProviderCapabilities } from "@/lib/db/types";
import type { TreeRowModel } from "./flatten";
import { TREE_ROW_HEIGHT, TreeRow } from "./TreeRow";
import { useTreeNodes } from "./use-tree-nodes";

/** Rows kept mounted beyond each edge of the viewport, so a scroll does not flash empty. */
const OVERSCAN = 4;
/**
 * The height assumed until the scroll box has been measured.
 *
 * The measurement happens in the ref callback, so this is what the very first commit renders with.
 * One screenful is the ceiling any tree can need, and assuming too much only mounts rows that are
 * then dropped, while assuming too little would leave a gap under the last row.
 */
const UNMEASURED_VIEWPORT = 640;

export interface ObjectTreeProps {
  /** What the object routes resolve: a seed id today, per `resolveConnection`. */
  readonly connectionId: string;
  readonly capabilities: ProviderCapabilities;
  readonly onObjectClick?: (object: DatabaseObject) => void;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * The half-open row range to mount.
 *
 * `focusIndex` is -1 unless a key or a click put focus on a row, and when it is set the window is
 * SHIFTED to contain that row rather than widened. Shifting keeps the mounted count constant, and
 * containing it is what lets `End` focus the last row of forty thousand: focus cannot move to a
 * node that is not in the DOM.
 */
export function treeWindow(
  count: number,
  scrollTop: number,
  height: number,
  focusIndex: number,
): readonly [number, number] {
  const size = Math.min(count, Math.ceil(height / TREE_ROW_HEIGHT) + OVERSCAN * 2);
  const fromScroll = clamp(Math.floor(scrollTop / TREE_ROW_HEIGHT) - OVERSCAN, 0, count - size);
  const start = focusIndex < 0 ? fromScroll : clamp(fromScroll, focusIndex - size + 1, focusIndex);
  return [start, start + size];
}

/** The row below this one, when it is a child of it rather than the next sibling. */
function firstChildIndex(rows: readonly TreeRowModel[], index: number): number {
  return index + 1 < rows.length && rows[index + 1].depth > rows[index].depth ? index + 1 : -1;
}

function parentIndex(rows: readonly TreeRowModel[], index: number): number {
  for (let candidate = index - 1; candidate >= 0; candidate--) {
    if (rows[candidate].depth < rows[index].depth) return candidate;
  }
  return -1;
}

export function ObjectTree({ connectionId, capabilities, onObjectClick }: ObjectTreeProps) {
  const tree = useTreeNodes(connectionId, capabilities);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  // A fresh object per request rather than an id, so asking twice for the same row focuses it
  // twice: Right on an open row and Left on its child both land on a row that is already active.
  const [focusRequest, setFocusRequest] = useState<{ readonly id: string } | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);

  const rows = tree.rows;
  // Exactly one row is tabbable. Until the reader picks one it is the first, and a row that
  // disappeared under a collapse hands the tab stop back rather than taking it out of the page.
  const activeRowId = rows.find((row) => row.id === activeId)?.id ?? rows[0]?.id;

  // The window is clamped to the focused row, so by the time this runs the row is mounted even if
  // it was forty thousand rows away.
  useEffect(() => {
    if (focusRequest === null) return;
    const mounted = Array.from(treeRef.current?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []);
    // Matched by dataset rather than by a selector, because a container name may hold a quote and
    // there is no CSS.escape in every runtime this renders in.
    const element = mounted.find((candidate) => candidate.dataset.rowId === focusRequest.id);
    element?.focus();
    element?.scrollIntoView({ block: "nearest" });
  }, [focusRequest]);

  const focusRow = useCallback((id: string) => {
    setActiveId(id);
    setPinned(true);
    setFocusRequest({ id });
  }, []);

  const moveTo = useCallback((index: number) => focusRow(rows[clamp(index, 0, rows.length - 1)].id), [focusRow, rows]);

  const activate = useCallback(
    (row: TreeRowModel) => {
      focusRow(row.id);
      if (row.kind === "object") {
        const object = tree.objectFor(row);
        if (object !== undefined) onObjectClick?.(object);
        return;
      }
      // `expanded` is absent on a leaf, and a folder whose count the engine refused is a leaf.
      if (row.expanded !== undefined) tree.toggle(row.id);
    },
    [focusRow, onObjectClick, tree],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const index = Math.max(
        0,
        rows.findIndex((row) => row.id === activeRowId),
      );
      const row = rows[index];
      switch (event.key) {
        case "ArrowDown":
          moveTo(index + 1);
          break;
        case "ArrowUp":
          moveTo(index - 1);
          break;
        case "Home":
          moveTo(0);
          break;
        case "End":
          moveTo(rows.length - 1);
          break;
        case "ArrowRight":
          // Opens a closed row, then moves into it. A row that is open but holds nothing has no
          // child to move to, and a leaf has neither.
          if (row.expanded === false) activate(row);
          else if (firstChildIndex(rows, index) >= 0) moveTo(index + 1);
          break;
        case "ArrowLeft":
          if (row.expanded === true) activate(row);
          else if (parentIndex(rows, index) >= 0) moveTo(parentIndex(rows, index));
          break;
        case "Enter":
        case " ":
          activate(row);
          break;
        default:
          // Anything the pattern does not claim stays the browser's, type-ahead included.
          return;
      }
      event.preventDefault();
    },
    [activate, activeRowId, moveTo, rows],
  );

  const onClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const element = (event.target as HTMLElement).closest<HTMLElement>("[data-row-id]");
      const row = rows.find((candidate) => candidate.id === element?.dataset.rowId);
      if (row !== undefined) activate(row);
    },
    [activate, rows],
  );

  /**
   * Focus landed on the tree itself rather than on a row, which is what Tab does once the active
   * row has scrolled out of the window. Re-pinning brings that row back into the window, and the
   * focus effect then moves focus onto it.
   */
  const onContainerFocus = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget || activeRowId === undefined) return;
      focusRow(activeRowId);
    },
    [activeRowId, focusRow],
  );

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
    setViewportHeight(event.currentTarget.clientHeight);
    // The window follows the scroll again: the row holding focus is allowed to leave it.
    setPinned(false);
  }, []);

  const attach = useCallback((element: HTMLDivElement | null) => {
    treeRef.current = element;
    if (element !== null) setViewportHeight(element.clientHeight);
  }, []);

  if (tree.rootFailure !== undefined) {
    const failure = tree.rootFailure;
    return failure.unimplemented ? (
      <TreePanel testId="tree-unimplemented" icon={<PlugZap strokeWidth={1.5} className="w-6 h-6 text-brand" />}>
        <h3 className="text-foreground text-xs font-medium mb-1">This engine is not wired up yet</h3>
        <p className="text-xs text-muted-foreground leading-relaxed break-words">{failure.message}</p>
      </TreePanel>
    ) : (
      <TreePanel testId="tree-failure" icon={<CircleAlert strokeWidth={1.5} className="w-6 h-6 text-warning" />}>
        <h3 className="text-foreground text-xs font-medium mb-1">The object list could not be read</h3>
        <p className="text-xs text-muted-foreground leading-relaxed break-words">{failure.message}</p>
        <button
          type="button"
          data-testid="tree-retry"
          onClick={tree.loadContainers}
          className="mt-3 rounded-md bg-brand-solid hover:bg-brand-solid-hover text-white px-3 py-1.5 text-xs font-medium transition-colors"
        >
          Try again
        </button>
      </TreePanel>
    );
  }

  if (tree.rootLoading) {
    return (
      <div data-testid="tree-loading" className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <LoaderCircle strokeWidth={1.5} className="w-6 h-6 animate-spin text-brand/40" />
        <span className="mt-3 text-xs font-medium">Reading the catalog...</span>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <TreePanel testId="tree-empty" icon={<CircleAlert strokeWidth={1.5} className="w-6 h-6 text-muted-foreground" />}>
        <h3 className="text-foreground text-xs font-medium mb-1">Nothing to show</h3>
        <p className="text-xs text-muted-foreground leading-relaxed">
          The engine answered, and reported nothing at this level.
        </p>
      </TreePanel>
    );
  }

  const activeIndex = rows.findIndex((row) => row.id === activeRowId);
  const [start, end] = treeWindow(
    rows.length,
    scrollTop,
    viewportHeight > 0 ? viewportHeight : UNMEASURED_VIEWPORT,
    pinned ? activeIndex : -1,
  );
  // A window can leave the row holding the tab stop unmounted, and then NOTHING inside the tree is
  // tabbable: the arrow handler would sit on an element that cannot take focus, and a keyboard user
  // could not get in without reaching for the mouse. So the container holds the tab stop exactly
  // while the active row is out of the DOM, and hands it back on focus.
  const activeMounted = activeIndex >= start && activeIndex < end;

  return (
    <div
      ref={attach}
      role="tree"
      aria-label="Database objects"
      data-testid="object-tree"
      tabIndex={activeMounted ? -1 : 0}
      onFocus={onContainerFocus}
      onKeyDown={onKeyDown}
      onClick={onClick}
      onScroll={onScroll}
      className="relative h-full overflow-auto outline-none"
    >
      {/* Presentational, so the rows below stay owned by the tree in the accessibility tree. */}
      <div role="presentation" className="relative" style={{ height: rows.length * TREE_ROW_HEIGHT }}>
        {rows.slice(start, end).map((row, offset) => (
          <TreeRow
            key={row.id}
            row={row}
            object={tree.objectFor(row)}
            active={row.id === activeRowId}
            selected={row.id === activeId}
            busy={tree.isBusy(row)}
            failure={tree.failureFor(row)}
            top={(start + offset) * TREE_ROW_HEIGHT}
          />
        ))}
      </div>
    </div>
  );
}

function TreePanel({
  testId,
  icon,
  children,
}: {
  readonly testId: string;
  readonly icon: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div data-testid={testId} className="flex flex-col items-center justify-center py-12 px-6 text-center">
      <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4 border border-border">
        {icon}
      </div>
      {children}
    </div>
  );
}
