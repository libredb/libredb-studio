"use client";

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

/**
 * Selection highlight lives OUTSIDE React Flow node/edge objects on purpose:
 * selecting a table must not rebuild the nodes/edges arrays (that re-renders
 * every memoized card on large schemas). Nodes and edges subscribe to this
 * store with primitive snapshots, so only elements whose highlight state
 * actually flips re-render.
 */
export interface HighlightStore {
  select(table: string | null, neighbors?: Set<string>): void;
  getSelected(): string | null;
  hasSelection(): boolean;
  isHighlighted(table: string): boolean;
  subscribe(listener: () => void): () => void;
}

export function createHighlightStore(): HighlightStore {
  let selected: string | null = null;
  let highlighted = new Set<string>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  return {
    select(table, neighbors = new Set()) {
      const nextHighlighted = table ? new Set([table, ...neighbors]) : new Set<string>();
      const unchanged =
        table === selected &&
        nextHighlighted.size === highlighted.size &&
        [...nextHighlighted].every((id) => highlighted.has(id));
      if (unchanged) return;
      selected = table;
      highlighted = nextHighlighted;
      notify();
    },
    getSelected: () => selected,
    hasSelection: () => selected !== null,
    isHighlighted: (table) => highlighted.has(table),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const HighlightStoreContext = createContext<HighlightStore | null>(null);

export const HighlightStoreProvider = HighlightStoreContext.Provider;

function useHighlightStore(): HighlightStore {
  const store = useContext(HighlightStoreContext);
  if (!store) {
    throw new Error("useHighlightStore must be used inside a HighlightStoreProvider");
  }
  return store;
}

/** True when this table is the selection or one of its FK neighbors. */
export function useTableHighlighted(table: string): boolean {
  const store = useHighlightStore();
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  return useSyncExternalStore(
    subscribe,
    () => store.isHighlighted(table),
    () => false,
  );
}

export type EdgeHighlightState = "highlighted" | "dimmed" | "none";

/** Edges connected to the selected table light up; the rest fade out. */
export function useEdgeHighlight(source: string, target: string): EdgeHighlightState {
  const store = useHighlightStore();
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  return useSyncExternalStore(
    subscribe,
    () => {
      const selected = store.getSelected();
      if (!selected) return "none";
      return selected === source || selected === target ? "highlighted" : "dimmed";
    },
    () => "none" as const,
  );
}
