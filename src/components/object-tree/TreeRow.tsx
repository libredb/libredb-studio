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

import { formatRowCount, formatRowCountTitle } from "@/lib/db/utils/pool-manager";
import {
  ChevronDown,
  ChevronRight,
  Database,
  EllipsisVertical,
  Folder,
  Key,
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

/**
 * `ROW_ICONS` deliberately gains no `column` entry: `ROW_ICONS[row.kind]` is then a compile error
 * until the fourth row kind is answered, which is the only automatic guard on this side, and it is
 * answered by a narrowing below rather than by a fallback.
 */
const ROW_ICONS = { container: Database, folder: Folder, object: Table2 } as const;

/**
 * The non-primary column's mark, carried over from the flat explorer VERBATIM: a 4px dot in a
 * 14px slot (`schema-explorer/ColumnList.tsx:12-16`). Hoisted for the reason it was hoisted
 * there, and a dot rather than a kind icon because the KEY is the only thing a reader scans a
 * column list for. A 14px `Columns3` on every ordinary column would put a glyph of the same
 * weight and size beside the key on every row, which is the one thing that mark exists not to be.
 */
const COLUMN_DOT = (
  <span aria-hidden="true" className="flex w-3.5 h-3.5 shrink-0 items-center justify-center">
    <span className="w-1 h-1 rounded-full bg-muted-foreground/50" />
  </span>
);

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
 *
 * `primary` and `type` are a column row's two extra facts, placed in RENDER ORDER like every
 * other slot, which is what this array claims to be. They are referenced on every row for the
 * reason the six already here are: an unrendered slot is a dangling IDREF the name computation
 * skips, so the conditions stay in the JSX and are not restated here where the two could
 * disagree. No name is a prefix of another, which is what keeps the join unambiguous.
 */
const ROW_NAME_PARTS = ["label", "primary", "type", "status", "unavailable", "failure", "count", "badge"] as const;

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

/**
 * The twisty's glyph: a spinner while its own read is in flight, a chevron either way, and
 * nothing at all on a leaf.
 *
 * Extracted rather than written inline twice, and the reason is measurable rather than a taste:
 * inline it was two nested ternaries and it carried `TreeRow`'s cognitive complexity to 26
 * against a threshold of 15 (SonarCloud S3358 and S3776 on PR #1069). One function with three
 * guarded returns says the same thing in the order a reader asks it.
 *
 * `busy` is only ever passed by the BUTTON, which is the only place a describe can be in flight,
 * and the button renders only where `expanded` is defined, so the `undefined` arm below is
 * reached from the SPAN alone. That is a leaf: a column row, or a folder whose count the engine
 * refused. Both arms are driven by the suite rather than argued here.
 */
function TwistyGlyph({ busy, expanded }: { readonly busy?: boolean; readonly expanded?: boolean }) {
  if (busy === true) return <LoaderCircle aria-hidden="true" className="w-3.5 h-3.5 animate-spin" />;
  if (expanded === undefined) return null;
  return expanded ? (
    <ChevronDown strokeWidth={1.5} className="w-3.5 h-3.5" />
  ) : (
    <ChevronRight strokeWidth={1.5} className="w-3.5 h-3.5" />
  );
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
  /**
   * Open or close this row, which only an OBJECT row's twisty calls.
   *
   * OPTIONAL, permanently. The one mount that renders this row supplies it, and an optional prop
   * is what lets the row be rendered in isolation by a test that does not exercise a toggle.
   */
  readonly onToggle?: (row: TreeRowModel) => void;
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
  onToggle,
  top,
}: TreeRowProps) {
  // `null` only for a column row, and computed as a narrowing so a fifth row kind is still a
  // compile error on the lookup rather than an undefined component at runtime.
  const Icon = row.kind === "column" ? null : ROW_ICONS[row.kind];
  const isPrimaryColumn = row.column?.isPrimary === true;
  const showsTwisty = row.kind === "object" && row.expanded !== undefined && onToggle !== undefined;
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
      className={`group absolute inset-x-0 flex items-center gap-1.5 ${ROW_PADDING_RIGHT} text-xs ${
        // A column row activates into nothing, and a pointer cursor over a row that does nothing
        // reads as broken. That is also the cursor the flat explorer's column list set.
        row.kind === "column" ? "cursor-default" : "cursor-pointer"
      } select-none outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand ${
        selected ? "bg-muted" : "hover:bg-muted/60"
      }`}
    >
      {/*
        A HIT TARGET, and only where the row's own activation does not already toggle it. A
        container and a folder toggle on activation, so the whole row is their twisty and a
        nested button would be a second control for a gesture the row already has. An object row
        activates into a data tab, so without this its columns would be unreachable by pointer:
        the tree delegates one click at its root and there is no other target inside the row.

        `-m-1.5 p-1.5` GROWS THE TARGET WITHOUT MOVING ANYTHING. Flex measures the margin box, so
        the negative margin cancels the padding and the row's layout is identical to the 14px
        span this replaces, while the pressable box reaches 6px past the glyph on every side:
        26 by 26 around a 14 by 14 chevron, which clears the 24 by 24 of WCAG 2.5.8 on both axes.

        MEASURED rather than reasoned, because the arithmetic that stood here was wrong. In
        Chromium, against the compiled stylesheet, by `getBoundingClientRect` and by a half-pixel
        `elementFromPoint` scan asking which pixels actually land on the button, at row indents
        of 8, 20, 32, 44 and 56px: 26 by 26 at every depth, hittable across the whole of it. The
        kind icon does NOT take its own 14px back, which is what the earlier note here claimed
        and what made this look 20 wide: it is the next flex item and its left edge sits exactly
        on the button's border-box right edge at every depth, so nothing paints over the 6px
        right pad.

        THE SPINNER LIVES HERE while the describe is in flight, rather than mid-row after the
        label. The gesture and the reader's eye are both on this glyph, the wait is up to five
        seconds on a Couchbase `INFER`, and a chevron that flipped down onto nothing with the
        only feedback 100px away reads as a dead control.

        `tabIndex={-1}` always, unlike the menu trigger: ArrowRight and ArrowLeft are what the
        W3C tree pattern gives a keyboard for this, so a third tab stop on the active row would
        be noise rather than access. A pointer press still focuses it in most browsers, and
        `toggleRow` calls `focusRow`, whose effect focuses the row element by `data-row-id` with
        a fresh request object every time, so focus lands back on the treeitem and the arrow keys
        keep working. That repair is asserted, not assumed. No `aria-expanded` here either; the
        treeitem carries the state the pattern asks for and the label says which way this press
        goes, so it is announced once.
      */}
      {row.kind === "object" && row.expanded !== undefined && onToggle !== undefined ? (
        <button
          type="button"
          data-testid="tree-row-twisty"
          aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.label}`}
          tabIndex={-1}
          onClick={(event) => {
            // The tree delegates click at its root; without this the press would also activate
            // the row and open the data tab behind the columns it just opened.
            event.stopPropagation();
            onToggle(row);
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className="-m-1.5 flex w-3.5 h-3.5 box-content shrink-0 items-center justify-center rounded-sm p-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-brand"
        >
          <TwistyGlyph busy={busy} expanded={row.expanded} />
        </button>
      ) : (
        <span aria-hidden="true" className="w-3.5 shrink-0 text-muted-foreground">
          <TwistyGlyph expanded={row.expanded} />
        </span>
      )}
      {Icon === null ? (
        isPrimaryColumn ? (
          // The flat explorer's mark, in its own colour. `aria-hidden` like every icon in this
          // row, with the fact reaching the accessible name through the text twin below: the
          // same shape the status icon uses.
          <Key aria-hidden="true" strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0 text-hue-yellow/70" />
        ) : (
          COLUMN_DOT
        )
      ) : (
        <Icon aria-hidden="true" strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
      )}
      <span id={rowNameId("label", row.id)} data-testid="tree-row-label" className="truncate">
        {row.label}
      </span>
      {isPrimaryColumn && (
        <span id={rowNameId("primary", row.id)} data-testid="tree-row-primary" className="sr-only">
          Primary key
        </span>
      )}
      {/*
        The declared type, right-aligned and TRUNCATED AT THE FIRST PAREN, which is what
        `ColumnList` drew until 0.16.0: `VARCHAR(255)` reads `VARCHAR` and the whole declared
        type is one hover away, so the parameters never push the column name out. `type` and
        never `baseType`: that field's own docblock says `type` is "what a person wants to SEE"
        and what the object browser renders, and `baseType` is what a reader DECIDING prefers.

        TWO TEXTS, and that is the whole reason this is not one span. The row names itself by
        reference (`aria-labelledby` above), so `title` never reaches the accessible name: it is
        the last-resort name source and is dropped the moment a name exists. Without the
        `sr-only` twin a screen reader would hear "NUMERIC" for `NUMERIC(10,2)` and a keyboard
        reader could not reach the precision at all. Same shape as the status slot below.

        NOT `shrink-0`, unlike the count and the badge. Under pressure the type gives way with
        the label rather than taking the label's last pixels: at the 15% minimum sidebar width
        and a depth-4 column the content box is about 92px, and a `shrink-0` type capped at 40%
        leaves the name about nine of them. A truncated `TIMEST...` next to a readable name is
        the right trade, and the full type is in the title and in the name either way.

        NO `/70`. `--muted-foreground` is #737373 on #ffffff (4.7:1) and #a1a1aa on #09090b
        (7.7:1); composited at 70% those become 2.7:1 and 4.2:1, both under the 4.5:1 that text
        below 18.66px needs. The old list's `/60` had the same defect and is not carried over.

        The empty-type guard is not defensive padding: `cassandra/objects.ts` maps a UDT field
        whose position has no entry in `field_types` to `type: types[index] ?? ""`, and an empty
        span with an empty tooltip in the right-hand slot reads as a rendering bug.
      */}
      {row.column !== undefined && row.column.type !== "" && (
        <span
          id={rowNameId("type", row.id)}
          data-testid="tree-row-column-type"
          title={row.column.type}
          className="ml-auto min-w-0 pl-2 max-w-[40%] truncate font-mono text-[10px] uppercase text-muted-foreground"
        >
          <span aria-hidden="true">{row.column.type.split("(")[0]}</span>
          <span className="sr-only">{row.column.type}</span>
        </span>
      )}
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
      {/* Not on a row whose twisty is already spinning: one read, one spinner. */}
      {busy && !showsTwisty && (
        <LoaderCircle aria-hidden="true" className="w-3 h-3 shrink-0 animate-spin text-muted-foreground" />
      )}
      {/*
        ONE SENTENCE IN THIS SLOT, and where two are true the FAILURE takes it.

        `unavailable` is a read that ANSWERED, off a stored answer: the engine's own refusal to
        count on a folder, and on an open object the walk's sentence for a describe that landed
        carrying nothing. `failure` is a read that did not answer at all. A row can hold both, and
        before this gate it drew both, in this one slot, with `ROW_NAME_PARTS` above naming each
        span so the pair also ran together into the accessible name. Measured on an object row
        with a stored `columns: []` and a refused re-read:
        `ordersNo columns reportedconnection reset`, two reports of one read with nothing between
        them, competing for the same `ml-auto truncate` space.

        The FAILURE takes it because a read that failed outranks a read that answered: the
        answer's sentence describes a picture the tree no longer knows to be current, and the
        failure is the reason it does not. On an object row that is also the NEWER fact, and
        provably so: `run` clears a row's failure whenever an answer lands, so a stored detail
        beside a stored failure means the failure came second, and `refresh` keeps an open row's
        detail on purpose so the row does not blink empty while the re-read is in flight. On a
        folder the two are about DIFFERENT reads, a refused count and a failed listing, so only
        the ranking decides it, and the count refusal is the smaller loss: a folder whose listing
        failed is showing nothing at all, which is a bigger fact than a missing badge.

        Nothing is hidden by standing the answer's sentence down on an object row: that clash is
        reachable only when the stored answer was EMPTY, so there are no column rows under this
        one either way. And this is the rule the count one block below already follows, one step
        further on: the slot carries one report, and the rest stand down.
      */}
      {row.unavailable !== undefined && failure === undefined && (
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
      {/*
        The row count stands down for a sentence. `unavailable` and `failure` both take the free
        space with `ml-auto truncate` and this number takes what is left with `shrink-0`, which on
        a folder never happens: a folder carries no `object`. An object row is the first row kind
        where the two meet, and a 429 or "No columns reported" cut to four characters beside an
        estimate nobody asked about is worse than the estimate being absent for one render.
      */}
      {object?.rowCount !== undefined && row.unavailable === undefined && failure === undefined && (
        <span
          id={rowNameId("count", row.id)}
          data-testid="tree-row-count"
          title={formatRowCountTitle(object.rowCount)}
          aria-label={object.rowCount.toLocaleString("en-US")}
          className="ml-auto shrink-0 pl-2 text-[10px] text-muted-foreground tabular-nums"
        >
          {formatRowCount(object.rowCount)}
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
        no trigger and the two entry points cannot drift apart. Most actions are gated on
        `role === "relation"`, and View Source is the one that is not: #789 gates it on the
        kind's own `hasSource` declaration, so a routine, a trigger and a sequence now show
        this trigger wherever their engine declares a definition text for them, with no
        change here. A kind that declares neither still shows nothing.
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
