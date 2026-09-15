"use client";

import { createContext, useContext } from "react";

/**
 * Imperative diagram actions consumed by node components. Passed through
 * context (not node data) so node data objects stay referentially stable.
 */
export interface DiagramActions {
  /** Keyed by the NODE ID, which is the object's `pathKey` and never its label (#789). */
  toggleExpand(nodeId: string): void;
}

export const DiagramActionsContext = createContext<DiagramActions>({
  toggleExpand: () => {},
});

export function useDiagramActions(): DiagramActions {
  return useContext(DiagramActionsContext);
}
