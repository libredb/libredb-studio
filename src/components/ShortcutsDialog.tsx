"use client";

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useSyncExternalStore } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SHORTCUT_GROUPS } from "@/lib/shortcuts";

export interface ShortcutsDialogRef {
  open: () => void;
}

/**
 * Open state lives at module scope rather than in this component's own `useState` (#746
 * review): `Studio.tsx` mounts one instance unconditionally and `DataProfiler.tsx` mounts a
 * second whenever it's open, so in the standalone shell with the profiler open BOTH are
 * mounted at once. Two independent `useState`s would mean two independent dialogs — "?"
 * opening both, and one Escape closing only the topmost, leaving the other (and the profiler
 * underneath) still up. A shared store fixes the STATE half of that; `primaryInstanceKey`
 * below fixes the other half, which instance actually renders the `Dialog`.
 */
let sharedOpen = false;
const openListeners = new Set<() => void>();

function setSharedOpen(next: boolean): void {
  if (sharedOpen === next) return;
  sharedOpen = next;
  openListeners.forEach((listener) => listener());
}

function subscribeOpen(callback: () => void): () => void {
  openListeners.add(callback);
  return () => openListeners.delete(callback);
}

function getOpenSnapshot(): boolean {
  return sharedOpen;
}

function getServerOpenSnapshot(): boolean {
  return false;
}

/**
 * Whichever instance mounts first renders the `Dialog`; a later one sharing the tree (the
 * standalone shell's Studio-level instance is always first in practice, since `DataProfiler`
 * mounts only once the profiler opens) shares the same open flag but renders nothing, so
 * there is exactly one `Dialog` no matter how many instances are mounted at once. The
 * mutation lives inside `subscribePrimary`, which `useSyncExternalStore` calls from its own
 * effect — not inside an effect of this component's — so this never calls setState from
 * render or from an effect body of its own; `isPrimary` is a pure read of external state,
 * the same shape `useFavoriteConnections`/`useConnectionOrder` already use for this reason.
 */
let primaryInstanceKey: object | null = null;
const mountedInstances = new Map<object, () => void>();

function subscribePrimary(key: object, callback: () => void): () => void {
  mountedInstances.set(key, callback);
  if (primaryInstanceKey === null) primaryInstanceKey = key;
  return () => {
    mountedInstances.delete(key);
    if (primaryInstanceKey === key) {
      // Promote whichever instance is still mounted, if any, so it starts rendering the
      // Dialog. In practice this is Studio.tsx's own instance outliving DataProfiler's, not
      // the reverse, but nothing here assumes that ordering.
      const [nextKey] = mountedInstances.keys();
      primaryInstanceKey = nextKey ?? null;
    }
    // Nothing left to show it to - and in the embedded workspace, DataProfiler's is the
    // only instance there is, so this is what closes the dialog on the profiler's own
    // unmount rather than leaving a stale "open" flag for the next time it mounts.
    if (mountedInstances.size === 0) setSharedOpen(false);
    mountedInstances.forEach((listener) => listener());
  };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  if (target.isContentEditable) return true;
  // Monaco 0.56 focuses a `div.native-edit-context`, not a textarea or a contentEditable
  // element, so neither check above sees it - and `?` is the positional-parameter
  // placeholder in SQLite and MySQL, so missing this let the dialog eat the keystroke
  // mid-query. `.monaco-editor` is Monaco's own stable root class, not an internal we're
  // reaching past: checking "inside the editor at all" survives Monaco changing which
  // element it focuses next, where chasing that element by name would not.
  return target.closest(".monaco-editor") !== null;
}

/**
 * The single place that answers "what shortcuts exist" (#746). Self-contained, following
 * `CommandPalette`'s own Cmd/Ctrl+K effect: every instance owns its own "?" listener, so
 * mounting it in both `Studio.tsx` and `DataProfiler.tsx` — `DataProfiler` is itself mounted
 * by both the standalone shell and the embedded workspace — is what makes the dialog reachable
 * everywhere without either host threading open state through props. What's shared across
 * instances (module scope, above) is the open flag itself and which one actually renders.
 *
 * `CommandPalette`'s "Keyboard Shortcuts" entry reaches the standalone shell's instance
 * through the imperative handle below, the same seam `QueryEditorRef` already uses for the
 * editor. Its `open()` writes the shared flag, so it opens whichever instance is currently
 * rendering the dialog regardless of which one the ref happens to be attached to.
 */
export const ShortcutsDialog = forwardRef<ShortcutsDialogRef>(function ShortcutsDialog(_props, ref) {
  const instanceKey = useRef<object>({}).current;
  const subscribe = useCallback((callback: () => void) => subscribePrimary(instanceKey, callback), [instanceKey]);
  const getIsPrimary = useCallback(() => primaryInstanceKey === instanceKey, [instanceKey]);
  const rendersDialog = useSyncExternalStore(subscribe, getIsPrimary, () => false);

  const open = useSyncExternalStore(subscribeOpen, getOpenSnapshot, getServerOpenSnapshot);

  useImperativeHandle(ref, () => ({ open: () => setSharedOpen(true) }), []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "?" || isTypingTarget(e.target)) return;
      e.preventDefault();
      setSharedOpen(true);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (!rendersDialog) return null;

  return (
    <Dialog open={open} onOpenChange={setSharedOpen}>
      <DialogContent className="sm:max-w-md bg-surface border-hairline-strong">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 max-h-[60vh] overflow-y-auto">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.heading}>
              <h3 className="text-xs font-medium text-fg-muted mb-2">{group.heading}</h3>
              <div className="space-y-1.5">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={`${group.heading}:${shortcut.keys}:${shortcut.description}`}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="text-fg">{shortcut.description}</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-fill text-fg-secondary font-mono text-[0.7rem] shrink-0">
                      {shortcut.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
});
