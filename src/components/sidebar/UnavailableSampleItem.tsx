import React from "react";
import { UNAVAILABLE_CONNECTION_ICON } from "@/lib/db-ui-config";
import type { UnavailableSample } from "@/lib/seed/types";

/**
 * A built-in sample whose copy failed on the server (src/lib/seed/samples.ts): its name and the Unavailable marker
 * ConnectionItem draws, carrying the server's sentence as its title and as screen-reader text. It is not a connection,
 * so the row is not a control: nothing opens, edits, duplicates or deletes it.
 */
export function UnavailableSampleItem({ sample }: { sample: UnavailableSample }) {
  return (
    <div
      data-testid={`unavailable-sample-${sample.seedId}`}
      className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-muted-foreground"
    >
      <div className="p-1 rounded bg-muted">
        {React.createElement(UNAVAILABLE_CONNECTION_ICON, { className: "w-3 h-3" })}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate min-w-[4ch] block font-medium text-xs" title={sample.name}>
            {sample.name}
          </span>
          <span
            title={sample.sentence}
            className="text-[0.5rem] font-medium px-1.5 py-0.5 rounded-sm shrink-0 bg-fill text-fg-muted"
          >
            Unavailable
            <span className="sr-only">: {sample.sentence}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
