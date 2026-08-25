"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "editor-line-numbers";

/*
  The editor's line-number preference, held as an external store rather than read
  into state by a mount effect: QueryEditor is in the first paint and is published
  from `src/exports`, so the value has to be SSR-stable and only become the stored
  one at hydration. `useSyncExternalStore` is what React provides for exactly that.

  localStorage's own `storage` event fires only in OTHER tabs, so the writer below is
  what notifies this one. Deliberately NOT subscribed to `storage`: picking up another
  tab's toggle would be new behaviour, not the behaviour this replaces.
*/
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): boolean {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === null ? true : stored === "true";
}

/** No localStorage on the server, and line numbers are on by default. */
function getServerSnapshot(): boolean {
  return true;
}

/** The editor's line-number preference, as the browser has it stored. */
export function useLineNumbersPreference(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Persist the user's toggle and tell every mounted editor. */
export function setLineNumbersPreference(next: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(next));
  for (const listener of listeners) listener();
}
