"use client";

import * as React from "react";
import { GripVerticalIcon } from "lucide-react";
import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "@/lib/utils";

/**
 * react-resizable-panels 4 renamed the primitives this file wraps -
 * `PanelGroup` -> `Group`, `PanelResizeHandle` -> `Separator` - and took over
 * the layout styling the wrapper used to supply: the group element is written
 * with `display:flex`, `flex-direction`, `width/height:100%` and `overflow`
 * that cannot be overridden, so the old `flex h-full w-full ...:flex-col` had
 * nothing left to do.
 */
function ResizablePanelGroup({ className, ...props }: React.ComponentProps<typeof ResizablePrimitive.Group>) {
  return <ResizablePrimitive.Group data-slot="resizable-panel-group" className={cn(className)} {...props} />;
}

function ResizablePanel({ ...props }: React.ComponentProps<typeof ResizablePrimitive.Panel>) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

/**
 * Orientation styling hangs off `aria-orientation`, which v4 writes on the
 * separator itself - v3's `data-panel-group-direction` is gone.
 *
 * Note the inversion, which is correct ARIA and an easy way to get this
 * backwards: a *horizontal* group is split by a *vertical* separator line. So
 * the default classes below draw the vertical line (horizontal group), and the
 * `aria-[orientation=horizontal]` variants draw the horizontal one (vertical
 * group) - exactly where `data-[panel-group-direction=vertical]` used to sit.
 */
function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Separator> & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "bg-border focus-visible:ring-ring relative flex w-px items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="bg-border z-10 flex h-4 w-3 items-center justify-center rounded-xs border">
          <GripVerticalIcon className="size-2.5" />
        </div>
      )}
    </ResizablePrimitive.Separator>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
