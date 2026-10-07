"use client";

import React from "react";
import { LoaderCircle } from "lucide-react";
import { ChunkLoadError } from "@/lib/lazy";
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
  /** Where the notice sits, for a view with no place of its own in the layout (a dialog). */
  className?: string;
  /** Takes the failed view away, for a caller that can: the notice then offers Close. */
  onDismiss?: () => void;
  /**
   * What the boundary is showing, for a caller whose one boundary holds many things (the
   * results panel: every result, every mode, every tab). When any entry changes, by
   * `Object.is`, a failure is cleared and the new children are rendered; a view that
   * still fails throws again and is shown failing again.
   */
  resetKeys?: readonly unknown[];
}

interface ChunkBoundaryState {
  /** What the view threw, or null while it renders. */
  error: { thrown: unknown } | null;
  /** The keys the current state belongs to. */
  resetKeys: readonly unknown[] | undefined;
}

function sameKeys(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  return a.every((key, index) => Object.is(key, b[index]));
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * The boundary a failed view lands in.
 *
 * A class, because catching a render-time error is still the one thing hooks cannot
 * do. It tells two failures apart, by class and never by message (a production render
 * error can have none):
 *
 * - a `ChunkLoadError`, a view whose code never arrived. Reloading is the honest remedy
 *   rather than a local retry: the common cause is a page whose build no longer exists
 *   on the server, and no number of retries against the old chunk names will produce
 *   it; only re-fetching the document will.
 * - anything else, a view that threw while drawing what it was given. That is said as
 *   such, with the error's own message, and offers Try again; Reload would be a false
 *   diagnosis, and the next thing the boundary is given (`resetKeys`) clears it.
 */
export class ChunkBoundary extends React.Component<ChunkBoundaryProps, ChunkBoundaryState> {
  state: ChunkBoundaryState = { error: null, resetKeys: this.props.resetKeys };

  static getDerivedStateFromError(thrown: unknown): Partial<ChunkBoundaryState> {
    return { error: { thrown } };
  }

  static getDerivedStateFromProps(
    props: ChunkBoundaryProps,
    state: ChunkBoundaryState,
  ): Partial<ChunkBoundaryState> | null {
    if (sameKeys(props.resetKeys, state.resetKeys)) return null;
    return { error: null, resetKeys: props.resetKeys };
  }

  componentDidCatch(thrown: unknown) {
    logger.warn(thrown instanceof ChunkLoadError ? "A split view could not be loaded" : "A view failed to render", {
      route: "ChunkBoundary",
      view: this.props.label,
      error: messageOf(thrown),
    });
  }

  private readonly retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const isChunk = error.thrown instanceof ChunkLoadError;
    const message = messageOf(error.thrown);
    return (
      <div
        data-testid={isChunk ? "chunk-error" : "render-error"}
        className={cn(
          "h-full w-full flex flex-col items-center justify-center gap-3 bg-sunken px-6 text-center",
          this.props.className,
        )}
      >
        {isChunk ? (
          <>
            <p className="text-xs font-medium text-fg-secondary">{this.props.label} could not be loaded.</p>
            <p className="text-xs text-fg-muted max-w-sm">
              This view is fetched when it is first opened, and the request did not complete. If the server was upgraded
              while this page was open, reloading picks up the new one.
            </p>
          </>
        ) : (
          <>
            <p className="text-xs font-medium text-fg-secondary">{this.props.label} could not be displayed.</p>
            {message !== "" && (
              <p
                data-testid="render-error-message"
                className="text-xs font-mono text-fg-muted max-w-xl break-words whitespace-pre-wrap"
              >
                {message}
              </p>
            )}
          </>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={isChunk ? () => window.location.reload() : this.retry}
            className="h-7 px-3 rounded border border-hairline-strong text-xs font-medium text-fg-secondary hover:text-fg-bright"
          >
            {isChunk ? "Reload" : "Try again"}
          </button>
          {this.props.onDismiss && (
            <button
              type="button"
              onClick={this.props.onDismiss}
              className="h-7 px-3 rounded text-xs font-medium text-fg-muted hover:text-fg-bright"
            >
              Close
            </button>
          )}
        </div>
      </div>
    );
  }
}
