"use client";

import { useMemo, useRef } from "react";

/**
 * Focus handlers for an `AlertDialogContent` that opens from app state rather than from an
 * `AlertDialogTrigger`. Spread the result onto the content: `<AlertDialogContent {...returnFocus}>`.
 *
 * Radix hands focus back only to a trigger, so without one Cancel or Escape leaves focus on
 * `document.body`, and a keyboard user has to Tab from the top of the page (#1198).
 *
 * `onOpenAutoFocus` runs before Radix moves focus into the dialog, so the element it keeps is
 * the one the user was on. It does not call `preventDefault()`, so Radix still focuses Cancel.
 * `onCloseAutoFocus` does call it: otherwise Radix runs its own handler and focuses the trigger
 * that is not there.
 */
export function useReturnFocus(): {
  onOpenAutoFocus: () => void;
  onCloseAutoFocus: (event: Event) => void;
} {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  return useMemo(
    () => ({
      onOpenAutoFocus: () => {
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      },
      onCloseAutoFocus: (event: Event) => {
        event.preventDefault();
        returnFocusRef.current?.focus();
      },
    }),
    [],
  );
}
