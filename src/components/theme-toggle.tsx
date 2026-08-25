"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";

/**
 * False through the server render AND the hydration render, true after — the
 * SSR-safe form of "am I on the client yet". Preferred over `useState` +
 * `useEffect(() => setMounted(true))`, which asks React for a second render pass
 * it does not need.
 */
const subscribe = () => () => {};
const useHydrated = () =>
  useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

const NEXT_LABEL = {
  dark: "Switch to light theme",
  light: "Switch to dark theme",
} as const;

/**
 * Two-state theme control: dark ↔ light.
 *
 * Deliberately no "follow the system" state. One click turns it on, one click
 * turns it back, and the icon always names where the click goes — a third state
 * costs an extra click to return and shows an icon (a monitor) that reads as a
 * device rather than a theme. The trade is real and accepted: a viewer whose OS
 * is in night mode still starts on studio's own default rather than theirs.
 *
 * `showLabel` repeats that same destination as visible text inside the button, for
 * placements where an icon alone is not a control anyone finds — the mobile
 * overflow menu, where this is a settings row rather than one glyph among several
 * (#401). The text lives INSIDE the button on purpose: a caller that put its own
 * caption beside the toggle would leave that caption behind in the embedded case
 * below, labelling a control that is not there.
 *
 * Renders NOTHING when no `ThemeProvider` is mounted above it. That is the
 * embedded case: the host app owns the theme, `useTheme()` falls back to
 * next-themes' default context — whose `themes` array is empty — and a toggle
 * that cannot change anything is worse than no toggle at all.
 */
export function ThemeToggle({ className, showLabel = false }: { className?: string; showLabel?: boolean }) {
  const { theme, setTheme, themes } = useTheme();
  const hydrated = useHydrated();

  if (themes.length === 0) return null;

  // Total by construction: anything that is not "light" — unset, or a value an
  // earlier build wrote — is dark, which is also the provider's default.
  const current = theme === "light" ? "light" : "dark";
  const next = current === "dark" ? "light" : "dark";
  // The DESTINATION, like the label beside it. A sun in a dark header is an
  // offer; a moon in a dark header is a status readout on a control whose only
  // job is to change something. The two must not disagree — the icon is what a
  // sighted user reads and the label is what a screen reader announces, and a
  // toggle that shows a moon while announcing "switch to light theme" describes
  // two different buttons.
  const Icon = next === "dark" ? Moon : Sun;

  /*
   * EVERYTHING that depends on the resolved theme has to wait for hydration, not
   * just the icon. The server cannot know which theme is stored, so it would name
   * a destination the client immediately corrects — and React reports an
   * unmatched `aria-label`/`title` as a hydration error just as loudly as it
   * would a wrong icon. Before hydration the control therefore says what it IS,
   * which is true in every state and identical on both sides.
   */
  const label = hydrated ? NEXT_LABEL[current] : "Toggle theme";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setTheme(next)}
      className={cn(
        "flex items-center gap-2 p-1 rounded text-fg-tertiary hover:text-fg-bright hover:bg-fill transition-colors",
        className,
      )}
    >
      {/* The button keeps its size while empty, so the header does not shift. */}
      {hydrated ? <Icon strokeWidth={1.5} className="w-3.5 h-3.5" /> : <span className="block w-3.5 h-3.5" />}
      {showLabel && <span>{label}</span>}
    </button>
  );
}
