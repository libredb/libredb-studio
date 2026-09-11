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
 * the width of one row.
 */

import { useCallback, useEffect, useRef } from "react";
import { TREE_ROW_HEIGHT } from "./TreeRow";
import type { TreeRowAction } from "./row-actions";

export interface RowMenuProps {
  readonly actions: readonly TreeRowAction[];
  /** Viewport coordinates: the pointer, or the top left of the row for the keyboard path. */
  readonly x: number;
  readonly y: number;
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

export function RowMenu({ actions, x, y, label, onClose }: RowMenuProps) {
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
      style={{ top: y, left: x }}
      className="fixed z-50 min-w-48 rounded-md border border-border bg-popover p-1 shadow-md"
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
