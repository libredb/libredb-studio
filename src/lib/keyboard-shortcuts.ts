interface Shortcut {
  code: "Enter" | "KeyF" | "KeyX" | "KeyK" | "KeyB";
  primary: boolean;
  alt: boolean;
  shift: boolean;
  description: string;
}

// Shared by DOM handlers, Monaco bindings, UI hints and docs/FEATURES.md.
// Focus/rename guards and listener lifetimes remain with the owning component.
export const SHORTCUTS = {
  executeQuery: {
    code: "Enter",
    primary: true,
    alt: false,
    shift: false,
    description: "execute the query (editor focused)",
  },
  formatQuery: {
    code: "KeyF",
    primary: false,
    alt: true,
    shift: true,
    description: "format the query (editor focused)",
  },
  // Cmd/Ctrl+N and Cmd/Ctrl+T belong to the browser.
  newTab: {
    code: "KeyX",
    primary: true,
    alt: false,
    shift: true,
    description: "open a new query tab (except while renaming a tab)",
  },
  commandPalette: { code: "KeyK", primary: true, alt: false, shift: false, description: "toggle the command palette" },
  toggleSidebar: {
    code: "KeyB",
    primary: true,
    alt: false,
    shift: false,
    description: "toggle the sidebar (when a SidebarProvider is mounted)",
  },
} as const satisfies Record<string, Shortcut>;

export function matchesShortcut(
  event: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  shortcut: Shortcut,
): boolean {
  return (
    event.code === shortcut.code &&
    (event.ctrlKey || event.metaKey) === shortcut.primary &&
    event.altKey === shortcut.alt &&
    event.shiftKey === shortcut.shift
  );
}

export function shortcutLabel(shortcut: Shortcut): string {
  return [
    shortcut.primary && "Cmd/Ctrl",
    shortcut.alt && "Alt",
    shortcut.shift && "Shift",
    shortcut.code.replace(/^Key/, ""),
  ]
    .filter(Boolean)
    .join("+");
}

// Receive Monaco's constants from onMount: importing its runtime here would make
// document-level shortcuts load the editor and would break server-side imports.
export function monacoKeybinding(
  shortcut: Shortcut,
  monaco: {
    KeyMod: { CtrlCmd: number; Alt: number; Shift: number };
    KeyCode: Record<Shortcut["code"], number>;
  },
): number {
  return (
    monaco.KeyCode[shortcut.code] |
    (shortcut.primary ? monaco.KeyMod.CtrlCmd : 0) |
    (shortcut.alt ? monaco.KeyMod.Alt : 0) |
    (shortcut.shift ? monaco.KeyMod.Shift : 0)
  );
}
