"use client";

import { useState } from "react";
import type { QueryTab } from "@/lib/types";

/**
 * What the tab strip draws of a tab, and nothing else (X5).
 *
 * The strip used to be handed the whole `QueryTab`, whose identity changes on every keystroke
 * because the editor writes the query into the tab. Nothing the strip draws reads the query,
 * so both shells hand it this summary instead.
 */
export interface StudioTabSummary {
  id: string;
  name: string;
  type: QueryTab["type"];
  isSource: boolean;
  dirty: boolean;
}

function summarize(tab: QueryTab): StudioTabSummary {
  return {
    id: tab.id,
    name: tab.name,
    type: tab.type,
    isSource: tab.source !== undefined,
    dirty: tab.source?.dirty === true,
  };
}

function sameSummaries(a: readonly StudioTabSummary[], b: readonly StudioTabSummary[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (summary, index) =>
        summary.id === b[index].id &&
        summary.name === b[index].name &&
        summary.type === b[index].type &&
        summary.isSource === b[index].isSource &&
        summary.dirty === b[index].dirty,
    )
  );
}

/**
 * The tabs as the strip draws them, as the SAME array for as long as none of those fields
 * changed, so a keystroke that only rewrites a query lets the memoized strip bail out.
 *
 * The array from the previous render is kept in state and replaced during render when the
 * summaries differ, which is React's supported way to derive from a previous render; a ref
 * written during render is not.
 */
export function useTabSummaries(tabs: readonly QueryTab[]): readonly StudioTabSummary[] {
  const next = tabs.map(summarize);
  const [kept, setKept] = useState(next);
  if (sameSummaries(kept, next)) return kept;
  setKept(next);
  return next;
}
