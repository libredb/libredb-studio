"use client";

import { useSyncExternalStore } from "react";

export type EffectiveTheme = "dark" | "light";

/**
 * The theme actually in force, for the surfaces that cannot read CSS tokens —
 * Monaco, chart libraries, the ER diagram — because they paint their own canvas
 * from a JS palette.
 *
 * Deliberately reads the `dark` class off the document rather than calling
 * `useTheme()`. That class is where next-themes writes studio's own choice AND
 * where a host app writes its own, so one source answers both deployments and an
 * embedded studio needs no provider to follow along. It is observed rather than
 * read once because either owner can change it at any time.
 */
function subscribe(onStoreChange: () => void) {
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function getSnapshot(): EffectiveTheme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Dark is studio's default, so assuming it server-side is the smaller flash. */
function getServerSnapshot(): EffectiveTheme {
  return "dark";
}

export function useEffectiveTheme(): EffectiveTheme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
