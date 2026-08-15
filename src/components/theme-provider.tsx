"use client";

import { ThemeProvider as NextThemesProvider, type ThemeProviderProps } from "next-themes";

/**
 * Theme wiring for STANDALONE studio only.
 *
 * The embedded package deliberately does not mount this. Platform owns the
 * `dark` class on its own document, and `dark:`-free studio components read the
 * theme through the tokens in `styles/theme.css`, so embedded studio follows the
 * host's theme with no provider, no toggle and no coordination. Mounting a second
 * provider inside platform would fight the host for the same class attribute.
 *
 * `defaultTheme="dark"` keeps the pre-token appearance for anyone who never
 * touches the toggle — dark is what LibreDB Studio has always been.
 *
 * `enableSystem={false}` because the toggle offers two states, not three. It is
 * not merely cosmetic: with system disabled, next-themes stops RESOLVING a stored
 * `"system"` against the OS and writes it to the document as a literal class, so
 * a value left over from a three-state build would put `class="system"` on <html>
 * — matching neither palette. Hence the storage key below.
 *
 * `storageKey` is deliberately not next-themes' default `"theme"`. The set of
 * values this control can write changed when "system" was dropped, so the old key
 * may hold a value that is no longer meaningful here; reading a fresh key is a
 * clean slate that needs no migration step and cannot half-apply.
 */
export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      storageKey="libredb-theme"
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
