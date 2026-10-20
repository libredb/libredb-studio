// The Results view's React tree (part 4 "What the person sees" and "The entry and the grid's props"): one small
// component per view kind, over the store's state. Every value from the database reaches the DOM as React text,
// never as markup.
import { Component, type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ResultsGrid } from "@/components/ResultsGrid";
import { RESULTS_LIMITS, type RunFailure } from "../results-protocol";
import { copyOrReport } from "./clipboard";
import { postToHost } from "./host-channel";
import { EXTENSION_MASKING_CONFIG } from "./masking";
import {
  backendStoppedSentence,
  CANCELLED_SENTENCE,
  CANCELLED_TITLE,
  DISPLAY_FAILED_TITLE,
  EMPTY_SENTENCE,
  noticesFor,
  RUN_FAILED_TITLE,
  RUNNING_SENTENCE,
} from "./notices";
import type { ResultsView } from "./results-reducer";
import type { ResultsStore } from "./results-store";

type View<K extends ResultsView["kind"]> = Extract<ResultsView, { kind: K }>;

/** The element ResultsGrid marks as its desktop grid, whose scroll the view keeps. */
const DESKTOP_GRID = "[data-desktop-grid]";
/** The scroll is saved this long after the last scroll event. */
const SCROLL_SAVE_DELAY_MS = 200;
/** What the person does in the view that ends a scroll restore still waiting for its rows. */
const PERSON_INPUT = ["pointerdown", "wheel", "keydown"] as const;

/** Shows DISPLAY_FAILED_TITLE with the error's message and posts reportError with it. */
export class GridErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  override state: { message: string | null } = { message: null };

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    postToHost({ v: 1, type: "reportError", message: message.slice(0, RESULTS_LIMITS.reportErrorChars) });
  }

  override render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <div role="alert" className="p-4 text-xs text-danger">
        <p className="font-medium">{DISPLAY_FAILED_TITLE}</p>
        <p className="mt-1 whitespace-pre-wrap break-words font-mono">{this.state.message}</p>
      </div>
    );
  }
}

function EmptyView() {
  return (
    <div className="flex min-h-full items-center justify-center p-4 text-center text-xs text-fg-tertiary">
      <p>{EMPTY_SENTENCE}</p>
    </div>
  );
}

function RunningView({ view }: { view: View<"running"> }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - view.startedAt) / 1000));
  return (
    <output className="flex min-h-full flex-col items-center justify-center p-4 text-center text-xs">
      <p className="font-medium text-fg-secondary">
        {RUNNING_SENTENCE} <span data-elapsed="">{seconds}</span>s
      </p>
      <p className="mt-1 max-w-xl truncate font-mono text-fg-tertiary">{view.statement.split("\n", 1)[0]}</p>
    </output>
  );
}

function FailureBody({ failure }: { failure: RunFailure }) {
  switch (failure.kind) {
    case "cancelled":
      return (
        <>
          <p className="font-medium">{CANCELLED_TITLE}</p>
          <p className="mt-1">{CANCELLED_SENTENCE}</p>
        </>
      );
    case "backendExited":
      return <p>{backendStoppedSentence(failure.exitCode, failure.signal)}</p>;
    case "error": {
      const { message, detail, fixStatement } = failure;
      return (
        <>
          <p className="font-medium">{RUN_FAILED_TITLE}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-left font-mono">{message}</p>
          {detail !== undefined && <p className="mt-1 whitespace-pre-wrap break-words text-left font-mono">{detail}</p>}
          {fixStatement !== undefined && (
            <p className="mt-2 flex items-center gap-2">
              <code className="whitespace-pre-wrap break-all font-mono text-fg">{fixStatement}</code>
              <button
                type="button"
                className="rounded border border-hairline px-2 py-0.5 text-fg-secondary hover:bg-fill"
                onClick={() => copyOrReport(fixStatement)}
              >
                Copy
              </button>
            </p>
          )}
        </>
      );
    }
  }
}

function FailedView({ view }: { view: View<"failed"> }) {
  return (
    <div
      role="alert"
      className="flex min-h-full flex-col items-center justify-center p-4 text-center text-xs text-danger"
    >
      <FailureBody failure={view.failure} />
    </div>
  );
}

interface RowsProps {
  view: View<"rows">;
  store: ResultsStore;
  maskingEnabled: boolean;
  onToggleMasking: () => void;
}

/**
 * Mounted once per run (keyed by runId), so a new run never inherits an old scroll. The saved scroll is read once, at
 * mount; a replay brings the first page in runSucceeded and each later one in pageAppended, so a position inside a
 * later page is reachable only once that page arrives. The restore is therefore retried as rows arrive, until the grid
 * reaches the saved position or the person acts in the view.
 */
function RowsView({ view, store, maskingEnabled, onToggleMasking }: RowsProps) {
  const container = useRef<HTMLDivElement>(null);
  const { runId } = view;
  const [saved] = useState(() => store.viewState().scroll);
  const restoring = useRef(true);

  // After every render while restoring: each page the replay appends arrives as a render with more rows.
  useEffect(() => {
    const grid = container.current?.querySelector<HTMLElement>(DESKTOP_GRID);
    if (!restoring.current || !saved || saved.runId !== runId || !grid) return;
    grid.scrollTop = saved.top;
    grid.scrollLeft = saved.left;
    if (Math.abs(grid.scrollTop - saved.top) < 1 && Math.abs(grid.scrollLeft - saved.left) < 1) {
      restoring.current = false;
    }
  });

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const stop = () => {
      restoring.current = false;
    };
    for (const type of PERSON_INPUT) root.addEventListener(type, stop, true);
    return () => {
      for (const type of PERSON_INPUT) root.removeEventListener(type, stop, true);
    };
  }, []);

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // scroll does not bubble, so the listener captures it on the way down and keeps only the desktop grid's.
    const onScroll = (event: Event) => {
      const grid = event.target;
      if (!(grid instanceof HTMLElement) || !grid.matches(DESKTOP_GRID)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        store.setViewState({
          v: 1,
          maskingEnabled: store.viewState().maskingEnabled,
          scroll: { runId, top: grid.scrollTop, left: grid.scrollLeft },
        });
      }, SCROLL_SAVE_DELAY_MS);
    };
    root.addEventListener("scroll", onScroll, true);
    return () => {
      root.removeEventListener("scroll", onScroll, true);
      clearTimeout(timer);
    };
  }, [store, runId]);

  return (
    <div ref={container} className="flex h-full flex-col">
      {noticesFor(view).map((notice) => (
        <div
          // The notices' texts differ from one another, so each text is its own key.
          key={notice.text}
          role="note"
          className={`border-b border-hairline px-3 py-1.5 text-xs ${notice.title ? "text-danger" : "text-fg-secondary"}`}
        >
          {notice.title !== undefined && <p className="font-medium">{notice.title}</p>}
          <p className="whitespace-pre-wrap break-words">{notice.text}</p>
        </div>
      ))}
      {/* The grid takes the height the notices leave, so its own scroll, not the page's, moves its rows. */}
      <div className="min-h-0 flex-1">
        <GridErrorBoundary>
          <ResultsGrid
            result={view.result}
            onLoadMore={() => store.post({ v: 1, type: "loadMore", runId })}
            isLoadingMore={view.loadingMore}
            supportsResultPagination={view.grid.supportsResultPagination}
            resultQuery={view.statement}
            databaseType={view.grid.databaseType}
            maskingConfig={EXTENSION_MASKING_CONFIG}
            maskingEnabled={maskingEnabled}
            onToggleMasking={onToggleMasking}
            maskingExemptColumns={view.grid.maskingExemptColumns}
          />
        </GridErrorBoundary>
      </div>
    </div>
  );
}

export function ResultsApp({ store }: { store: ResultsStore }): React.JSX.Element {
  const { view } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [maskingEnabled, setMaskingEnabled] = useState(() => store.viewState().maskingEnabled);

  const toggleMasking = useCallback(() => {
    const next = !maskingEnabled;
    setMaskingEnabled(next);
    store.setViewState({ v: 1, maskingEnabled: next, scroll: store.viewState().scroll });
  }, [store, maskingEnabled]);

  switch (view.kind) {
    case "empty":
      return <EmptyView />;
    case "running":
      return <RunningView key={view.runId} view={view} />;
    case "failed":
      return <FailedView view={view} />;
    case "rows":
      return (
        <RowsView
          key={view.runId}
          view={view}
          store={store}
          maskingEnabled={maskingEnabled}
          onToggleMasking={toggleMasking}
        />
      );
  }
}
