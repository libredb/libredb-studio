"use client";

import type { ReactNode } from "react";

/**
 * The strip a windowed tree draws over its rows: the ancestor chain of the first visible row.
 *
 * Presentational on purpose. The arithmetic is in `sticky-rows.ts`, which is pure and holds no DOM
 * knowledge, and the two surfaces that use this - the object tree and the Keys panel - differ only
 * in how one row is drawn. Both would otherwise carry a copy of the sticky box, the ellipsis and the
 * empty case.
 *
 * THE BOX IS STICKY AND ZERO HEIGHT, so the strip covers rows without moving them. In flow it would
 * push the tree down a row per pinned ancestor and reflow on every pin; absolute inside a scrolling
 * box it would scroll away with the content it describes. A zero-height sticky box sits in flow at
 * the scroll box's top edge and stays there while its absolutely positioned child draws the rows
 * without taking space.
 *
 * IT IS DECORATIVE. `aria-hidden`, and every control inside it holds `tabIndex={-1}`, because the
 * ancestors it names are still rows of the tree: a reader who needs them reaches them with the arrow
 * keys the tree pattern already gives, and announcing them here would say every row twice.
 */
export type StickyStripSlot<T> =
  | { readonly kind: "gap"; readonly slot: number }
  | { readonly kind: "row"; readonly slot: number; readonly item: T };

export interface StickyStripProps<T> {
  /** The test id for the strip, one per surface so two of them on one page stay tellable apart. */
  readonly testId: string;
  readonly rowHeight: number;
  /** The slots, in drawing order. An empty list renders nothing at all, which is the start state. */
  readonly entries: readonly StickyStripSlot<T>[];
  /** How one row is drawn. The frame supplies the slot's own absolute offset through `slot`. */
  readonly renderRow: (item: T, slot: number) => ReactNode;
}

export function StickyStrip<T>({ testId, rowHeight, entries, renderRow }: StickyStripProps<T>) {
  if (entries.length === 0) return null;
  return (
    <div data-testid={testId} aria-hidden="true" className="sticky top-0 z-10 h-0">
      <div
        className="absolute inset-x-0 top-0 border-b border-border/60 bg-background/95 backdrop-blur-sm"
        style={{ height: entries.length * rowHeight }}
      >
        {entries.map((entry, slot) =>
          entry.kind === "gap" ? (
            <div
              key="gap"
              data-testid={`${testId}-gap`}
              className="absolute inset-x-0 flex items-center pl-2 font-mono text-[10px] text-muted-foreground"
              style={{ top: slot * rowHeight, height: rowHeight }}
            >
              &hellip;
            </div>
          ) : (
            renderRow(entry.item, slot)
          ),
        )}
      </div>
    </div>
  );
}
