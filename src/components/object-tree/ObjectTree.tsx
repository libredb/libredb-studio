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
 *
 * The filter box above the rows (U25) narrows them to the objects whose name matches, over what
 * the tree has already read. Typing reads nothing; what the filter cannot see is counted on its
 * status line and read only on a press. The rule for an unread subtree is in `filter.ts`.
 */

import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { CircleAlert, Database, LoaderCircle, SearchX } from "lucide-react";
import type { DatabaseObject, ProviderCapabilities, ProviderLabels } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import type { TreeRowModel } from "./flatten";
import { RowMenu, type RowMenuAnchor } from "./RowMenu";
import { rowActions, type TreeRowAction, type TreeRowActionHandlers } from "./row-actions";
import { TreeFilter } from "./TreeFilter";
import { TREE_ROW_HEIGHT, TreeRow } from "./TreeRow";
import { useTreeNodes, type ObjectSource } from "./use-tree-nodes";

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
  /**
   * Why the tree is deferred, when it is not the connection's own `skipObjectScan`: the page opened a connection
   * whose every request can resume billed compute by itself, and nothing is read until the person uses it
   * (`useConnectionManager`, CL-CORE-2). Only the sentence changes; `deferred` is what holds the reads.
   */
  readonly deferredForBilledCompute?: boolean;
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
  /**
   * Who answers this tree's reads (#789, B76). Absent means this application's own
   * `/api/db/objects/*`, which is what the standalone shell wants and what it passes: nothing.
   * The embedded workspace passes a source that calls back into its host, because the package
   * ships no routes for those paths to reach.
   */
  readonly source?: ObjectSource;
  /**
   * Whether the SOURCE can answer a describe read, which is what draws a twisty on a table.
   *
   * Meaningless without `source`, and that is why it is resolved against it below rather than
   * defaulted: the standalone shell passes neither (`src/components/Studio.tsx` names no
   * `objectSource`), and its own route always exists, so it gets columns by passing nothing. A
   * shell that supplied a source declares what that source can answer, and an omission withholds
   * the twisty instead of issuing a read the host cannot serve (B76).
   */
  readonly readsColumns?: boolean;
  /**
   * A counter the shell bumps when a statement it ran changed the catalog (#789).
   *
   * A TOKEN rather than a callback registration or an imperative handle, because the signal is
   * one-way and the tree is the only thing that acts on it: the shell holds a number, and a
   * value different from the one this tree last acted on is the whole message. Which reads that
   * costs, and why nothing is derived from the statement, is in `useTreeNodes`' `refresh`.
   */
  readonly refreshToken?: number;
}

/** What the deferred panel says under a connection held for billed compute; `docs/providers/databend.md` 4.4 quotes it. */
export const BILLED_COMPUTE_HOLD =
  "Studio opened this connection without reading it, because any request to it can resume compute that is billed while it runs. The editor is ready to use.";

/** An open menu: which row it belongs to, and where the reader asked for it. */
interface OpenMenu {
  readonly rowId: string;
  readonly anchor: RowMenuAnchor;
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
  deferredForBilledCompute,
  onLoad,
  onObjectClick,
  actions,
  labels,
  source,
  readsColumns,
  refreshToken = 0,
}: ObjectTreeProps) {
  const columnsReadable = source === undefined || readsColumns === true;
  // Held per connection, so a switch starts unfiltered without an effect to reset it (D7).
  const [filter, setFilter] = useState<{ readonly connectionId: string; readonly text: string }>({
    connectionId: connection.id,
    text: "",
  });
  const query = filter.connectionId === connection.id ? filter.text : "";
  const setQuery = useCallback((text: string) => setFilter({ connectionId: connection.id, text }), [connection.id]);
  // The walk over ten thousand read objects runs on the deferred value, so the box never waits on it.
  const filterQuery = useDeferredValue(query);
  const tree = useTreeNodes(connection, capabilities, deferred, source, columnsReadable, filterQuery);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [pinned, setPinned] = useState(false);
  // Keyed by the query, so a new query starts at the top without an effect to reset it.
  const [scroll, setScroll] = useState<{ readonly query: string; readonly top: number }>({ query: "", top: 0 });
  const scrollTop = scroll.query === filterQuery ? scroll.top : 0;
  const [viewportHeight, setViewportHeight] = useState(0);
  // A fresh object per request rather than an id, so asking twice for the same row focuses it
  // twice: Right on an open row and Left on its child both land on a row that is already active.
  const [focusRequest, setFocusRequest] = useState<{ readonly id: string } | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);

  /**
   * The token this tree has already acted on.
   *
   * Compared rather than depended on alone, because `refresh` is rebuilt whenever the rows
   * change and an effect keyed on it would re-read the whole tree on every expansion.
   */
  const actedOn = useRef(refreshToken);
  const refresh = tree.refresh;
  useEffect(() => {
    if (refreshToken === actedOn.current) return;
    actedOn.current = refreshToken;
    refresh();
  }, [refresh, refreshToken]);

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

  /** ArrowDown from the filter box: into the tree, on its first row. */
  const enterTree = useCallback(() => {
    if (rows.length > 0) focusRow(rows[0].id);
  }, [focusRow, rows]);

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

  /**
   * Is there anything to open on this row?
   *
   * ONE predicate, read by every entry point: the right click, the ContextMenu key and
   * Shift+F10 through `openMenu`, and the row's visible trigger and `aria-haspopup` through
   * `TreeRow`. Two predicates could drift, and the drift has a direction that matters - a
   * visible control that opens an empty menu is worse than the undiscoverable menu it
   * replaced.
   */
  const hasRowMenu = useCallback((row: TreeRowModel): boolean => actionsFor(row).length > 0, [actionsFor]);

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
    (row: TreeRowModel, anchor: RowMenuAnchor): boolean => {
      if (!hasRowMenu(row)) return false;
      selectRow(row.id);
      setMenu({ rowId: row.id, anchor });
      return true;
    },
    [hasRowMenu, selectRow],
  );

  /**
   * The keyboard has no pointer, so the menu opens against the row's own BOX rather than a
   * point: a menu that has to flip upward then sits above the row instead of over it.
   */
  const openMenuOnRow = useCallback(
    (row: TreeRowModel): void => {
      const mounted = Array.from(treeRef.current?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []);
      const element = mounted.find((candidate) => candidate.dataset.rowId === row.id);
      const box = element?.getBoundingClientRect();
      openMenu(row, { x: box?.left ?? 0, top: box?.top ?? 0, bottom: box?.bottom ?? 0 });
    },
    [openMenu],
  );

  /**
   * The trigger's anchor is its own box rather than a point, for the reason the keyboard
   * path uses the row's: a menu that has to flip sits beside the button instead of over it,
   * which is what the last row of a scrolled sidebar needs.
   */
  const openMenuOnTrigger = useCallback(
    (row: TreeRowModel, element: HTMLElement): void => {
      const box = element.getBoundingClientRect();
      openMenu(row, { x: box.left, top: box.top, bottom: box.bottom });
    },
    [openMenu],
  );

  /**
   * Open or close a row, which is now a gesture of its own rather than a synonym for activation.
   *
   * The arrow keys used to call `activate`, which was the same thing for a container and a folder
   * and became wrong the moment an object row grew a twisty: `activate` returns before the toggle
   * on an object row, so ArrowRight on a closed table would have opened a query tab instead of
   * its columns and ArrowLeft on an open one would have opened a second. Identical to the old
   * path for every other kind, `focusRow` included, and `focusRow` is also what pulls DOM focus
   * back out of the twisty button after a pointer press.
   */
  const toggleRow = useCallback(
    (row: TreeRowModel) => {
      focusRow(row.id);
      tree.toggle(row.id);
    },
    [focusRow, tree],
  );

  const activate = useCallback(
    (row: TreeRowModel) => {
      focusRow(row.id);
      // A COLUMN row selects and does nothing else, which is what the flat list's column did
      // (`cursor-default`, no handler). The three alternatives all cost a new handler across the
      // published embedded seam for a gesture nobody asked for: inserting the name at the cursor
      // needs an editor the embedded shell does not mount, a clipboard write is invisible in the
      // EMBEDDED shell, which mounts no `<Toaster />` and records why at `StudioWorkspace.tsx`
      // (the standalone one does mount it, in `app/layout.tsx`, so this is a two-shell constraint
      // and not a missing surface), and generating a SELECT from one click is a heavier side
      // effect than any other row's activation. Stated as an arm rather than left to the
      // `expanded !== undefined` fall-through below, so giving a column children later cannot
      // make this silently wrong.
      if (row.kind === "column") return;
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
          // child to move to, and a leaf has neither. `toggleRow` rather than `activate`, which
          // on an object row opens a data tab and never its columns.
          if (row.expanded === false) toggleRow(row);
          else if (firstChildIndex(rows, index) >= 0) moveTo(index + 1);
          break;
        case "ArrowLeft":
          if (row.expanded === true) toggleRow(row);
          else if (parentIndex(rows, index) >= 0) moveTo(parentIndex(rows, index));
          break;
        case "Enter":
        case " ":
          // A held key auto-repeats, and every repeat is another keydown: without this one long
          // press opened a data tab per repeat. The repeat still falls through to
          // `preventDefault`, so a held Space does not scroll the sidebar either.
          if (!event.repeat) activate(row);
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
    [activate, activeRowId, moveTo, openMenuOnRow, rows, toggleRow],
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
      // A pointer is a point, so both edges of the anchor are where it was pressed.
      const anchor = { x: event.clientX, top: event.clientY, bottom: event.clientY };
      if (row !== undefined && openMenu(row, anchor)) event.preventDefault();
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

  const onScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      setScroll({ query: filterQuery, top: event.currentTarget.scrollTop });
      setViewportHeight(event.currentTarget.clientHeight);
      // The window follows the scroll again: the row holding focus is allowed to leave it.
      setPinned(false);
    },
    [filterQuery],
  );

  /**
   * A NEW scroll box, which `key={filterQuery}` makes on every query, starts at the top. So the
   * stored offset is taken from the box rather than kept: clearing a query returns to the query
   * `""`, whose offset from before the first keystroke is still on record, and the window would
   * draw rows thousands of pixels below what the fresh box shows, a blank pane. A row pinned deep
   * in the old list is released for the same reason.
   */
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      treeRef.current = element;
      if (element === null) return;
      setViewportHeight(element.clientHeight);
      setScroll({ query: filterQuery, top: element.scrollTop });
      setPinned(false);
    },
    [filterQuery],
  );

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
          {deferredForBilledCompute === true
            ? BILLED_COMPUTE_HOLD
            : "This connection opens without reading its catalog. The editor is ready to use."}
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
    return (
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

  // An empty FILTERED view is not an empty catalog: it falls through to the render below, which
  // keeps the box and its status line above the no-match panel.
  if (rows.length === 0 && tree.search === undefined) {
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
      <div className="flex h-full flex-col">
        <TreeFilter query={query} onQueryChange={setQuery} search={tree.search} onEnterTree={enterTree} />
        {rows.length === 0 ? (
          <TreePanel
            testId="tree-no-match"
            icon={<SearchX strokeWidth={1.5} className="w-6 h-6 text-muted-foreground" />}
          >
            <h3 className="text-foreground text-xs font-medium mb-1 break-words">
              No loaded object matches &quot;{filterQuery.trim()}&quot;
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Only folders that have been read are searched.
            </p>
          </TreePanel>
        ) : (
          <div
            key={filterQuery}
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
            className="relative min-h-0 flex-1 overflow-auto outline-none"
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
                  hasActions={hasRowMenu(row)}
                  menuOpen={menu?.rowId === row.id}
                  onOpenMenu={openMenuOnTrigger}
                  onToggle={toggleRow}
                  top={(start + offset) * TREE_ROW_HEIGHT}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      {/* Outside the tree element: a menu is not a valid child of one, and a sibling's keys
          never bubble to the tree's own handler. */}
      {menu !== null && menuRow !== undefined && (
        <RowMenu
          actions={actionsFor(menuRow)}
          anchor={menu.anchor}
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
