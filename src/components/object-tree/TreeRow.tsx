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

import {
  ChevronDown,
  ChevronRight,
  Database,
  EllipsisVertical,
  Folder,
  LoaderCircle,
  Table2,
  TriangleAlert,
} from "lucide-react";
import type { DatabaseObject } from "@/lib/db/types";
import type { TreeRowModel } from "./flatten";
import type { TreeReadFailure } from "./use-tree-nodes";

/** Fixed, because the window is a slice and a slice needs one arithmetic for every row. */
export const TREE_ROW_HEIGHT = 28;

/**
 * The trigger's slot, reserved on EVERY row by the row's own right padding: 20px for the
 * button and 8px of the gutter the row already had.
 *
 * Reserved rather than shared, which is the whole of the design. The flat explorer put the
 * ellipsis and the row count in ONE absolutely positioned box and swapped them on hover
 * (`git show main:src/components/schema-explorer/TableItem.tsx`), so reaching for the menu
 * hid the number the reader was reaching past. Pushing the count leftward on hover instead
 * is the same defect in another form: row content that moves under the pointer makes the
 * target harder to hit. A constant ~20px of row width buys a row where nothing moves and
 * nothing is hidden, and it is constant on rows that HAVE no trigger too, so a routine's
 * number lines up with a table's.
 */
const ROW_PADDING_RIGHT = "pr-7";

const ROW_ICONS = { container: Database, folder: Folder, object: Table2 } as const;

/**
 * The pieces of the row that carry its meaning, in render order, which is the order they
 * are read in.
 *
 * The row NAMES ITSELF BY REFERENCE through these (`aria-labelledby` below) rather than
 * from its contents, because its contents include the menu trigger: a control inside a
 * `treeitem` folds its own name into the row's, so `APP_ORDERS` announced as
 * `APP_ORDERS Actions for APP_ORDERS` on every arrow-key move (Task 34). Naming by
 * reference removes the button from the name and removes nothing else. The two convenient
 * alternatives are both worse: an `aria-label` built here would duplicate in JavaScript
 * what the JSX below renders, and the pair drifts the first time a field is added; and
 * shortening the button's own name to "More" would leave a reader who navigates BY BUTTON
 * with a column of controls that name nothing.
 *
 * Every slot is referenced UNCONDITIONALLY. A slot that did not render leaves a dangling
 * IDREF, which the name computation skips, so the list of conditions lives in exactly one
 * place - the JSX - instead of being restated here where the two could disagree.
 */
const ROW_NAME_PARTS = ["label", "status", "unavailable", "failure", "count", "badge"] as const;

/**
 * A DOM id for one name slot of one row.
 *
 * Derived from `row.id`, which `flatten.ts` guarantees is unique and injective over the
 * path segments (`pathKey`), never rebuilt from those segments here. `row.id` is not
 * usable as an IDREF as it stands: a quoted identifier may hold a space, and ASCII
 * whitespace is exactly what separates the tokens of `aria-labelledby`, so one id would
 * split into two that resolve to nothing and the row would go back to naming itself from
 * its contents - on the rows with an awkward name and nowhere else.
 *
 * The class escaped is therefore ASCII whitespace, plus the escape character itself so the
 * mapping is injective over any string rather than only over what `pathKey` happens to
 * emit. Every code in it is two hex digits wide, so the encoding is prefix-free; putting
 * the slot name first keeps the join unambiguous, since no slot name is a prefix of another.
 */
function rowNameId(part: (typeof ROW_NAME_PARTS)[number], rowId: string): string {
  const escaped = rowId.replace(
    /[ \t\n\f\r%]/g,
    (character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
  return `tree-name-${part}-${escaped}`;
}

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
  /** The row menu is open on THIS row, which the trigger reflects as `aria-expanded`. */
  readonly menuOpen?: boolean;
  /**
   * Open the row menu against the trigger, whose element is handed over so the menu can be
   * placed against its real rect rather than against a pointer that was never pressed.
   */
  readonly onOpenMenu: (row: TreeRowModel, trigger: HTMLElement) => void;
  /** Absolute offset inside the scroll spacer, in pixels. */
  readonly top: number;
}

export function TreeRow({
  row,
  object,
  active,
  selected,
  busy,
  failure,
  hasActions,
  menuOpen,
  onOpenMenu,
  top,
}: TreeRowProps) {
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
      aria-labelledby={ROW_NAME_PARTS.map((part) => rowNameId(part, row.id)).join(" ")}
      tabIndex={active ? 0 : -1}
      style={{ top, height: TREE_ROW_HEIGHT, paddingLeft: 8 + row.depth * 12 }}
      className={`group absolute inset-x-0 flex items-center gap-1.5 ${ROW_PADDING_RIGHT} text-xs cursor-pointer select-none outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand ${
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
      <span id={rowNameId("label", row.id)} data-testid="tree-row-label" className="truncate">
        {row.label}
      </span>
      {/*
        An ICON, because a status reaches this row only when the engine reported something
        worth acting on: the provider publishes `status` for `INVALID` and `DISABLED` and
        leaves it unset for the ordinary case, so a row that shows nothing is the normal
        row. The engine's OWN WORD is what is shown, never a sentence written here, and it
        is readable rather than only hoverable: the title attribute serves a pointer and
        the text serves a screen reader, which a tooltip alone does not.
      */}
      {object?.status !== undefined && (
        <span
          id={rowNameId("status", row.id)}
          data-testid="tree-row-status"
          title={object.status}
          className="shrink-0 text-warning"
        >
          <TriangleAlert aria-hidden="true" strokeWidth={1.5} className="w-3.5 h-3.5" />
          <span className="sr-only">{object.status}</span>
        </span>
      )}
      {busy && <LoaderCircle aria-hidden="true" className="w-3 h-3 shrink-0 animate-spin text-muted-foreground" />}
      {/* The engine's own sentence for a read it refused, in place of the number it could not give. */}
      {row.unavailable !== undefined && (
        <span
          id={rowNameId("unavailable", row.id)}
          data-testid="tree-row-unavailable"
          title={row.unavailable}
          className="ml-auto truncate pl-2 text-[10px] text-warning"
        >
          {row.unavailable}
        </span>
      )}
      {/* A read that failed, in the engine's own words. */}
      {failure !== undefined && (
        <span
          id={rowNameId("failure", row.id)}
          data-testid="tree-row-failure"
          title={failure.message}
          className="ml-auto truncate pl-2 text-[10px] text-destructive"
        >
          {failure.message}
        </span>
      )}
      {object?.rowCount !== undefined && (
        <span
          id={rowNameId("count", row.id)}
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
          id={rowNameId("badge", row.id)}
          data-testid="tree-row-badge"
          title={row.badgeTitle}
          className="ml-auto shrink-0 pl-2 text-[10px] text-muted-foreground tabular-nums"
        >
          {row.badge}
        </span>
      )}
      {/*
        The visible way in (Task 33). `hasActions` is the SAME answer the right click asks
        and the same one `aria-haspopup` above announces, so a row that offers nothing shows
        no trigger and the two entry points cannot drift apart. Every action is gated on
        `role === "relation"` today, which is why a routine, a trigger and a sequence have
        none; Phase 3's source editing gives routines actions, and this trigger then appears
        on them with no change here.
      */}
      {hasActions === true && (
        <button
          type="button"
          data-testid="tree-row-menu-trigger"
          // Named after its row rather than "More", because a screen reader reads a list of
          // these and "More" repeated forty times names nothing.
          aria-label={`Actions for ${row.label}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen === true}
          // The tree is one composite widget with a roving tabindex, so only the row that
          // holds the tab stop offers its trigger to Tab. Every mounted row offering one
          // would put thirty tab stops inside a widget the pattern gives one.
          tabIndex={active ? 0 : -1}
          onClick={(event) => {
            // The tree delegates click AND keydown at its root. Without stopping here a
            // press would also activate the row, opening the object in a tab behind the
            // menu it just opened, or collapsing the folder the menu belongs to.
            event.stopPropagation();
            onOpenMenu(row, event.currentTarget);
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className={`absolute right-1 flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-brand ${
            menuOpen === true
              ? "opacity-100"
              : // Shown on hover, on focus anywhere in the row, and always where there is no
                // hover to have: a touch reader cannot reveal anything by pointing at it.
                "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
          }`}
        >
          <EllipsisVertical aria-hidden="true" strokeWidth={1.5} className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
