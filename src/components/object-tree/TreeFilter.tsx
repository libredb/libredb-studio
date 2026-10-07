"use client";

/**
 * The object tree's filter box and its status line (U25).
 *
 * Presentational: the query belongs to `ObjectTree` and the counts to `useTreeNodes`. The status
 * line is the one place the filter admits what it cannot see, which is the decision `filter.ts`
 * records: an unread subtree is reported, and read only when the reader presses for it.
 *
 * Ctrl+F and Cmd+F are left to the browser. The sidebar is one panel of a page whose editor and
 * results grid are also searchable, and taking the page's find key for one panel would surprise
 * more readers than it helps.
 */
import { LoaderCircle, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { SEARCH_READ_BATCH, type TreeSearch } from "./use-tree-nodes";

export interface TreeFilterProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  /** Present exactly while a query is active. */
  readonly search?: TreeSearch;
  /** ArrowDown from the box: focus the first visible row. */
  readonly onEnterTree: () => void;
}

export function TreeFilter({ query, onQueryChange, search, onEnterTree }: TreeFilterProps) {
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      event.stopPropagation();
      onQueryChange("");
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onEnterTree();
    }
  };

  return (
    <div data-testid="tree-filter" className="shrink-0 px-2 pt-2 pb-1">
      <div className="relative">
        <Search
          aria-hidden="true"
          strokeWidth={1.5}
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label="Filter objects"
          placeholder="Filter loaded objects"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          data-testid="tree-filter-input"
          // The browser's own clear control is hidden: the X below is the one clear button, with a name.
          className="h-7 pl-7 pr-7 text-xs md:text-xs [&::-webkit-search-cancel-button]:appearance-none"
        />
        {query !== "" && (
          <button
            type="button"
            aria-label="Clear filter"
            title="Clear filter"
            data-testid="tree-filter-clear"
            onClick={() => onQueryChange("")}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X aria-hidden="true" strokeWidth={1.5} className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {search !== undefined && <FilterStatus search={search} />}
    </div>
  );
}

function FilterStatus({ search }: { readonly search: TreeSearch }) {
  return (
    <div
      data-testid="tree-filter-status"
      className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground"
    >
      {/* `output` is an implicit polite live region, so the count is announced as it changes (D5). */}
      <output data-testid="tree-filter-matches">
        {search.matches.toLocaleString("en-US")} {search.matches === 1 ? "match" : "matches"}
      </output>
      {search.reading > 0 && (
        <span data-testid="tree-filter-reading" className="inline-flex items-center gap-1">
          <LoaderCircle aria-hidden="true" strokeWidth={1.5} className="h-3 w-3 animate-spin" />
          Reading {search.reading.toLocaleString("en-US")}...
        </span>
      )}
      {search.unread > 0 && (
        <>
          <span
            data-testid="tree-filter-unread"
            title="Folders and listings the filter cannot see into until they are read"
          >
            {search.unread.toLocaleString("en-US")} not read yet
          </span>
          <button
            type="button"
            data-testid="tree-filter-read"
            disabled={search.reading > 0}
            onClick={search.readUnread}
            className="text-brand hover:underline disabled:opacity-50 disabled:no-underline"
          >
            {search.unread > SEARCH_READ_BATCH ? `Read ${SEARCH_READ_BATCH} more` : "Read and search"}
          </button>
        </>
      )}
      {search.failed > 0 && (
        <span data-testid="tree-filter-failed" className="text-warning">
          {search.failed.toLocaleString("en-US")} could not be read
        </span>
      )}
    </div>
  );
}
