"use client";

import React from "react";
import { LoaderCircle } from "lucide-react";
import { logger } from "@/lib/logger";
import { cn } from "@/lib/utils";

/**
 * What a code-split view shows while its chunk is on the wire, and what it shows when
 * the chunk never arrives.
 *
 * Both belong together because they are the two halves of one decision: the views
 * behind `React.lazy` are no longer in the bundle that has already loaded, so their
 * arrival is a request that can be slow (say so) or fail (say that too). Leaving
 * either unsaid is how a click on Charts becomes a spinner that never stops, or —
 * with no fallback at all — a click that does nothing.
 *
 * `LoaderCircle`, not `Loader2`, and the same everywhere: on lucide-react 1.x the
 * old spellings are legacy-rename aliases that ship no `@deprecated` tag, so nothing
 * warns while one is alive and the first signal is a build breaking on the release
 * that drops it. Every icon import in this repo uses its canonical v1 name.
 */
export function ViewLoading({ label, className }: { label: string; className?: string }) {
  return (
    // `output` rather than a div with role="status": it carries the live region
    // natively, which is what jsx-a11y's prefer-tag-over-role asks for.
    <output
      data-testid="view-loading"
      aria-label={label}
      className={cn("h-full w-full flex items-center justify-center bg-sunken", className)}
    >
      <LoaderCircle strokeWidth={1.5} className="w-5 h-5 animate-spin text-fg-muted" />
    </output>
  );
}

interface ChunkBoundaryProps {
  /** What failed, named the way the user knows it — "Charts", "the diagram". */
  label: string;
  children: React.ReactNode;
}

/**
 * The boundary a failed chunk lands in.
 *
 * A class, because catching a render-time error is still the one thing hooks cannot
 * do. Reloading is the honest remedy rather than a local retry: the common cause is a
 * page whose build no longer exists on the server, and no number of retries against
 * the old chunk names will produce it — only re-fetching the document will.
 */
export class ChunkBoundary extends React.Component<ChunkBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    logger.warn("A split view could not be loaded", {
      route: "ChunkBoundary",
      view: this.props.label,
      error: error.message,
    });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        data-testid="chunk-error"
        className="h-full w-full flex flex-col items-center justify-center gap-3 bg-sunken px-6 text-center"
      >
        <p className="text-xs font-medium text-fg-secondary">{this.props.label} could not be loaded.</p>
        <p className="text-xs text-fg-muted max-w-sm">
          This view is fetched when it is first opened, and the request did not complete. If the server was upgraded
          while this page was open, reloading picks up the new one.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="h-7 px-3 rounded border border-hairline-strong text-xs font-medium text-fg-secondary hover:text-fg-bright"
        >
          Reload
        </button>
      </div>
    );
  }
}
