"use client";

/**
 * The object tree's row menu (#789).
 *
 * Hand-rolled rather than `@/components/ui/context-menu`, for the reason `ObjectTree`
 * windows its own rows: every suite in this repo that renders a Radix menu replaces the
 * module with `mock.module` first, so a Radix menu here could only be tested against a
 * stub, and a menu is exactly the surface whose focus behaviour is the thing worth
 * asserting. It is also the surface a reader reaches a destructive-adjacent action
 * through, so "the tests proved the stub" is the wrong trade.
 *
 * Rendered as a SIBLING of the `role="tree"` element, never inside it. A `menu` inside a
 * `tree` is not a valid child in the accessibility tree, and keeping it outside is also
 * what stops the menu's own arrow keys reaching the tree's key handler: React events
 * follow the DOM, so a sibling's keydown never bubbles through the tree.
 *
 * `position: fixed` at the pointer, because the tree lives in a narrow scrolling sidebar:
 * a menu positioned inside that box would be clipped by its `overflow-auto` at roughly
 * the width of one row. Fixed means the viewport is the only thing that can clip it, and
 * `menuPlacement` below is what keeps it from doing so.
 */

import { useCallback, useEffect, useRef } from "react";
import { TREE_ROW_HEIGHT } from "./TreeRow";
import type { TreeRowAction } from "./row-actions";

/**
 * Where the menu was asked for, in viewport coordinates.
 *
 * Two edges rather than one point, because the two ways of asking have different shapes: a
 * pointer is a POINT, so `top` and `bottom` are the same number, while a key press is about
 * a ROW, and a menu that flips upward there belongs above the row rather than over it.
 */
export interface RowMenuAnchor {
  /** Where the menu's left edge prefers to be. */
  readonly x: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * What the BOX adds to the sum of its items: `p-1` top and bottom, plus the 1px border on
 * each side.
 *
 * The border counts. `getBoundingClientRect` includes it, `box-sizing: border-box` does not
 * subtract it from a box whose height is auto, so the rendered menu really is two pixels
 * taller than its padding and items, and leaving it out let the "room below" branch overhang
 * the viewport by exactly that much.
 */
const MENU_CHROME_Y = 10;
/** `max-w-64`. The widest this menu can be, which is why it can be assumed rather than measured. */
const MENU_MAX_WIDTH = 256;

/**
 * The menu's own `top`/`bottom`/`left`/`right`, chosen so no item can land outside the
 * viewport.
 *
 * This is the regression the flat explorer's Radix `ContextMenu` did not have: Radix
 * measures and flips, and a right click on the last table in the sidebar therefore always
 * produced a usable menu. A fixed element that overflows the viewport cannot be scrolled
 * to, so items below the fold are not merely awkward, they are unreachable.
 *
 * NOTHING is measured, and that is deliberate rather than a shortcut. The height is exact
 * arithmetic: every item is `TREE_ROW_HEIGHT` tall because this component sets that height
 * explicitly, so a label can overflow its button but can never grow one. The width is not
 * derivable, so it is BOUNDED instead, by `max-w-64` on the box and `MENU_MAX_WIDTH` here,
 * which makes the horizontal decision conservative: it may flip a menu that would have fit,
 * and it can never leave one hanging off the edge. The alternative, measuring after mount,
 * costs a state write inside a layout effect and a frame at the wrong position, and it
 * cannot be tested here at all: happy-dom measures every element as zero, which is the same
 * reason `ObjectTree` windows its rows by arithmetic instead of with a virtualiser.
 *
 * Three cases per axis, in order: the preferred side, the other side, and neither, where the
 * menu is pinned to the edge and scrolls inside `max-height`.
 */
export function menuPlacement(
  anchor: RowMenuAnchor,
  itemCount: number,
  viewport: { readonly width: number; readonly height: number },
): React.CSSProperties {
  const height = itemCount * TREE_ROW_HEIGHT + MENU_CHROME_Y;
  const vertical =
    anchor.bottom + height <= viewport.height
      ? { top: anchor.bottom }
      : anchor.top >= height
        ? { bottom: viewport.height - anchor.top }
        : { top: 0, maxHeight: viewport.height };
  const horizontal =
    anchor.x + MENU_MAX_WIDTH <= viewport.width
      ? { left: anchor.x }
      : anchor.x >= MENU_MAX_WIDTH
        ? { right: viewport.width - anchor.x }
        : { left: 0 };
  return { ...vertical, ...horizontal };
}

export interface RowMenuProps {
  readonly actions: readonly TreeRowAction[];
  readonly anchor: RowMenuAnchor;
  /** Names the menu after the row it belongs to, since it is not inside that row. */
  readonly label: string;
  /**
   * `restoreFocus` is true exactly when the reader is still where the menu left them:
   * Escape and running an item hand focus back to the row, while focus LEAVING the menu
   * must not drag it back from wherever it went.
   */
  readonly onClose: (restoreFocus: boolean) => void;
}

/** The items, in DOM order, read off the DOM rather than held as a second index. */
function itemsOf(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
}

export function RowMenu({ actions, anchor, label, onClose }: RowMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  // The first item takes focus on open, which is what makes the menu operable by the
  // keyboard that opened it and what gives Escape somewhere to return from.
  useEffect(() => {
    itemsOf(menuRef.current)[0]?.focus();
  }, []);

  const moveTo = useCallback((index: number) => {
    const items = itemsOf(menuRef.current);
    // Wraps, which is the menu pattern: a menu is a short closed list, unlike the tree.
    items[(index + items.length) % items.length]?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const items = itemsOf(menuRef.current);
      const index = items.indexOf(document.activeElement as HTMLElement);
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
          moveTo(items.length - 1);
          break;
        case "Escape":
          onClose(true);
          break;
        case "Tab":
          // Closed WITHOUT restoring focus, so Tab still moves on: swallowing it would
          // trap a keyboard reader in a menu they are trying to leave.
          onClose(false);
          return;
        default:
          // Enter and Space are the button's own, and everything else is the browser's.
          return;
      }
      event.preventDefault();
    },
    [moveTo, onClose],
  );

  /**
   * Focus left the menu: a click outside, or a Tab that has already moved on. Closing on
   * BLUR rather than on a document listener keeps this to one handler, and the containment
   * check is what keeps moving between items from closing it - the pointer press that
   * focuses the next item fires this blur first.
   */
  const onBlur = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      onClose(false);
    },
    [onClose],
  );

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      data-testid="tree-row-menu"
      // Programmatically focusable and never in the tab order: the menu handles the arrow
      // keys for its items, so the element carrying that handler has to be able to hold
      // focus itself, which is what `jsx-a11y/interactive-supports-focus` insists on.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      // Read at render rather than held in state: this component only ever mounts from a
      // reader's gesture, so there is no server render to guard against, and a resize while
      // a menu is open closes it through focus long before it could matter.
      style={menuPlacement(anchor, actions.length, { width: window.innerWidth, height: window.innerHeight })}
      // `overflow-y-auto` is not decoration: the third vertical case pins the box to an edge
      // under a `max-height`, and a capped box that cannot scroll hides the items it clipped
      // with no way to reach them, which is the defect this placement exists to prevent.
      className="fixed z-50 min-w-48 max-w-64 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md"
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          data-action-id={action.id}
          // Not tabbable: the menu moves focus itself, and Tab closes it.
          tabIndex={-1}
          onClick={() => {
            action.run();
            onClose(true);
          }}
          className="flex w-full items-center gap-2 rounded-sm px-2 text-left text-xs outline-none hover:bg-muted focus-visible:bg-muted"
          style={{ height: TREE_ROW_HEIGHT }}
        >
          <action.icon aria-hidden="true" strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          {action.label}
        </button>
      ))}
    </div>
  );
}
