// The theme kind on <html> (part 4 "The theming bridge"): the dark class drives LibreDB's tokens and dark: utilities,
// and data-libredb-contrast="high" lets vscode-bridge.css map the hairlines and the ring to the contrast borders.
import type { ThemeKind } from "../results-protocol";

/** class "dark" for dark and highContrast; data-libredb-contrast="high" for both high-contrast kinds; removes both otherwise. */
export function applyTheme(root: HTMLElement, theme: ThemeKind): void {
  root.classList.toggle("dark", theme === "dark" || theme === "highContrast");
  if (theme === "highContrast" || theme === "highContrastLight") root.dataset.libredbContrast = "high";
  else delete root.dataset.libredbContrast;
}
