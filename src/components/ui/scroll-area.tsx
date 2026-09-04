"use client";

import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

import { cn } from "@/lib/utils";

function ScrollArea({ className, children, ...props }: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn("relative", className)} {...props}>
      {/* `[&>div]:block!` takes Radix's own content wrapper out of table layout.
          Radix renders that wrapper with an inline `display: table; min-width: 100%`,
          and a table box GROWS to its content's minimum width no matter what: `width`
          is a floor for a table, not a cap, so it cannot be pinned — only `display`
          can. Past the viewport, its `overflow-x: hidden` then slices off the excess.
          Measured in a browser on 2026-09-04 against a Cloudberry connection whose
          object browser lists `pg_ext_aux.pg_pax_fastsequence`: the wrapper rendered
          327px inside a 299px viewport, so every row shifted right and lost its last
          28px — a table's `2.0k` row count read `2.0`, and the Explorer's count badge
          was sliced mid-glyph. `truncate` on the table name cannot prevent it, because
          truncation needs a definite container width and a table box has none until
          its content has already set one.

          Safe to do because nothing here scrolls sideways: `ScrollBar` below is only
          ever rendered vertical (no call site passes `orientation="horizontal"`), so
          horizontal overflow inside this component is always clipping, never scrolling.
          The `!` is required: `display` is one of the properties Radix sets inline. */}
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1 [&>div]:block!"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none",
        orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="bg-border relative flex-1 rounded-full"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
