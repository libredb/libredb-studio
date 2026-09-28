"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A function with one identity for the component's life that always runs the latest `fn`.
 *
 * For a handler a memoized child receives (X5): the hooks that own tab state hand back a
 * new function whenever the tabs change, which is every keystroke, and passing that down
 * as it is re-renders the child each time. Not for a function called during render, which
 * would see the previous render's `fn`.
 *
 * The ref is written in a LAYOUT effect on purpose. A child's passive effect runs before
 * its parent's, and the agent rail calls the shell's hand-over handlers from one, so a
 * passive effect here would hand it the previous render's handler.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
