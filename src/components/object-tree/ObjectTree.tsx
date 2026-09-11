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
import { CircleAlert, Database, LoaderCircle, PlugZap } from "lucide-react";
import type { DatabaseObject, ProviderCapabilities, ProviderLabels } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import type { TreeRowModel } from "./flatten";
import { RowMenu } from "./RowMenu";
import { rowActions, type TreeRowAction, type TreeRowActionHandlers } from "./row-actions";
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
  /**
   * The connection to read, whole rather than by id: `buildConnectionPayload` sends a
   * managed seed as `seed:<id>` and anything else in full, which is how every other db
   * route is called and the only way a connection the server has never heard of can be
   * read at all.
   */
  readonly connection: DatabaseConnection;
  readonly capabilities: ProviderCapabilities;
  /**
   * Read nothing until asked (#765). The flag itself lives on the connection
   * (`skipObjectScan`) and the ANSWER is resolved by whoever owns that connection, so
   * that one reader's press releases both this tree and the flat schema read.
   */
  readonly deferred?: boolean;
  /** What the load action calls. Absent means no action is offered. */
  readonly onLoad?: () => void;
  readonly onObjectClick?: (object: DatabaseObject) => void;
  /**
   * What the row menu may offer (U22, #789). Absent, or absent field by field, means the
   * shell cannot do that thing and the item is not drawn: the embedded workspace mounts no
   * maintenance page and no create-table modal, and passes neither handler.
   */
  readonly actions?: TreeRowActionHandlers;
  /** The engine's own wording. Only the menu's maintenance items read it. */
  readonly labels?: ProviderLabels;
}

/** An open menu: which row it belongs to, and where the reader asked for it. */
interface OpenMenu {
  readonly rowId: string;
  readonly x: number;
  readonly y: number;
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

export function ObjectTree({
  connection,
  capabilities,
  deferred,
  onLoad,
  onObjectClick,
  actions,
  labels,
}: ObjectTreeProps) {
  const tree = useTreeNodes(connection, capabilities, deferred);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
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

  /**
   * This row is the reader's, so it holds the tab stop and the window is pinned to it. It
   * does NOT take focus: the menu opens on a selected row and takes focus itself, and a
   * focus request here would pull focus back out of the menu the moment it mounted. Child
   * effects run before parent effects, so that race is not hypothetical - it closed the
   * menu on the frame it opened.
   */
  const selectRow = useCallback((id: string) => {
    setActiveId(id);
    setPinned(true);
  }, []);

  const focusRow = useCallback(
    (id: string) => {
      selectRow(id);
      setFocusRequest({ id });
    },
    [selectRow],
  );

  const moveTo = useCallback((index: number) => focusRow(rows[clamp(index, 0, rows.length - 1)].id), [focusRow, rows]);

  /**
   * What this row may be asked to do, from the DECLARATION. Built per row rather than
   * cached, because the answer depends on the cached object and on which handlers the
   * shell passed, and a stale menu is worse than a rebuilt array of four items.
   */
  const actionsFor = useCallback(
    (row: TreeRowModel): readonly TreeRowAction[] =>
      actions === undefined
        ? []
        : rowActions({ row, object: tree.objectFor(row), capabilities, labels, handlers: actions }),
    [actions, capabilities, labels, tree],
  );

  const closeMenu = useCallback(
    (restoreFocus: boolean) => {
      // Read from the closure rather than from a `setMenu` updater: an updater must stay
      // pure, and this one would be writing the focus request from inside it.
      if (menu !== null && restoreFocus) setFocusRequest({ id: menu.rowId });
      setMenu(null);
    },
    [menu],
  );

  /** A row with nothing to offer opens nothing, so the gesture is left to the browser. */
  const openMenu = useCallback(
    (row: TreeRowModel, x: number, y: number): boolean => {
      if (actionsFor(row).length === 0) return false;
      selectRow(row.id);
      setMenu({ rowId: row.id, x, y });
      return true;
    },
    [actionsFor, selectRow],
  );

  /** The keyboard has no pointer, so the menu opens against the row's own box. */
  const openMenuOnRow = useCallback(
    (row: TreeRowModel): void => {
      const mounted = Array.from(treeRef.current?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []);
      const element = mounted.find((candidate) => candidate.dataset.rowId === row.id);
      const box = element?.getBoundingClientRect();
      openMenu(row, box?.left ?? 0, box?.bottom ?? 0);
    },
    [openMenu],
  );

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
        // The two ways a keyboard asks for a context menu. Neither is part of the W3C tree
        // pattern, which says nothing about row actions; both are what the platform already
        // means by "the menu for the thing that has focus", and a menu that only a pointer
        // can open is the defect Task 6's review caught on the tree itself.
        case "ContextMenu":
          openMenuOnRow(row);
          break;
        case "F10":
          // Plain F10 is the browser's own (the menu bar on Windows); only Shift+F10 is this.
          if (!event.shiftKey) return;
          openMenuOnRow(row);
          break;
        default:
          // Anything the pattern does not claim stays the browser's, type-ahead included.
          return;
      }
      event.preventDefault();
    },
    [activate, activeRowId, moveTo, openMenuOnRow, rows],
  );

  /** The row a pointer event landed in, by the dataset rather than by a CSS selector. */
  const rowOf = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): TreeRowModel | undefined => {
      const element = (event.target as HTMLElement).closest<HTMLElement>("[data-row-id]");
      return rows.find((candidate) => candidate.id === element?.dataset.rowId);
    },
    [rows],
  );

  const onClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const row = rowOf(event);
      if (row !== undefined) activate(row);
    },
    [activate, rowOf],
  );

  const onContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const row = rowOf(event);
      // The browser's own menu stands where this one has nothing to offer, rather than the
      // page swallowing the gesture and showing nothing.
      if (row !== undefined && openMenu(row, event.clientX, event.clientY)) event.preventDefault();
    },
    [openMenu, rowOf],
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

  /*
    The escape hatch (#765). Checked before every other state, because the states below
    all describe a read: this one is the absence of one, and the reader is the only thing
    that can end it. The editor and query execution are untouched, which is the point -
    the reporter wanted to run a statement against an owner holding tens of thousands of
    objects without waiting for any of them.
  */
  if (deferred === true) {
    return (
      <TreePanel testId="tree-deferred" icon={<Database strokeWidth={1.5} className="w-6 h-6 text-brand" />}>
        <h3 className="text-foreground text-xs font-medium mb-1">{connection.name}</h3>
        <p className="text-xs text-muted-foreground leading-relaxed">
          This connection opens without reading its catalog. The editor is ready to use.
        </p>
        {onLoad !== undefined && (
          <button
            type="button"
            data-testid="tree-load"
            onClick={onLoad}
            className="mt-3 rounded-md bg-brand-solid hover:bg-brand-solid-hover text-white px-3 py-1.5 text-xs font-medium transition-colors"
          >
            Load objects
          </button>
        )}
      </TreePanel>
    );
  }

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
  // A menu whose row is gone - collapsed away, or dropped by a re-read - is closed by
  // DERIVING it from the rows rather than by an effect watching them.
  const menuRow = menu === null ? undefined : rows.find((row) => row.id === menu.rowId);

  return (
    <>
      <div
        ref={attach}
        role="tree"
        aria-label="Database objects"
        data-testid="object-tree"
        tabIndex={activeMounted ? -1 : 0}
        onFocus={onContainerFocus}
        onKeyDown={onKeyDown}
        onClick={onClick}
        onContextMenu={onContextMenu}
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
              hasActions={actionsFor(row).length > 0}
              top={(start + offset) * TREE_ROW_HEIGHT}
            />
          ))}
        </div>
      </div>
      {/* Outside the tree element: a menu is not a valid child of one, and a sibling's keys
          never bubble to the tree's own handler. */}
      {menu !== null && menuRow !== undefined && (
        <RowMenu
          actions={actionsFor(menuRow)}
          x={menu.x}
          y={menu.y}
          label={`Actions for ${menuRow.label}`}
          onClose={closeMenu}
        />
      )}
    </>
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
