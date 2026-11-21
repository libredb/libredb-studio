"use client";

import React, { useRef, useState } from "react";
import { storage } from "@/lib/storage";
import { SavedQuery } from "@/lib/types";
import { Bookmark, Search, Trash2, PenLine, Tag, Calendar, Download, Upload, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { format } from "date-fns";
import { downloadText } from "@/lib/export/download";
import { jsonText } from "@/lib/export/json";
import { parseSavedQueries } from "@/lib/saved-query-import";
import { unavailableSavedQueryNotice } from "@/lib/connection-availability";
import { typeIdRefusal } from "@/lib/db/type-id";
import { toast } from "sonner";

interface SavedQueriesProps {
  onSelectQuery: (query: string) => void;
  connectionType?: string;
  refreshTrigger?: number;
}

export function SavedQueries({ onSelectQuery, connectionType, refreshTrigger }: SavedQueriesProps) {
  const [queries, setQueries] = useState<SavedQuery[]>(() => storage.getSavedQueries());
  const [search, setSearch] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  // The last import's report of the entries it left out, drawn in this panel until dismissed or replaced by the next
  // import. A line here rather than a toast, so the npm StudioWorkspace, which mounts no toaster, shows it too.
  const [importRefusals, setImportRefusals] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // `refreshTrigger` is bumped by whoever writes a saved query. Adjusting state during
  // render is React's prescribed replacement for a setState-in-effect, and unlike a `key`
  // re-mount it leaves the search box the user is typing in alone.
  const [loadedTrigger, setLoadedTrigger] = useState(refreshTrigger);
  if (loadedTrigger !== refreshTrigger) {
    setLoadedTrigger(refreshTrigger);
    setQueries(storage.getSavedQueries());
  }

  const filteredQueries = queries.filter((q) => {
    const matchesSearch =
      q.name.toLowerCase().includes(search.toLowerCase()) || q.query.toLowerCase().includes(search.toLowerCase());
    const matchesType = !connectionType || q.connectionType === connectionType;
    return matchesSearch && matchesType;
  });

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("Are you sure you want to delete this saved query?")) {
      storage.deleteSavedQuery(id);
      setQueries(storage.getSavedQueries());
    }
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImportRefusals(null);
    setIsImporting(true);
    try {
      const { queries: incoming, refused } = parseSavedQueries(await file.text());
      const result = storage.importSavedQueries(incoming);
      setQueries(storage.getSavedQueries());
      const added =
        result.collisions.length > 0
          ? `Added ${result.imported}; skipped duplicate IDs: ${result.collisions.join(", ")}.`
          : `Added ${result.imported}.`;
      if (refused.length > 0) {
        // An entry whose type names no provider is left out by itself and named with its reason (FND-1).
        const notImported = refused
          .map((entry) => unavailableSavedQueryNotice(entry, entry.error.message).description)
          .join(" ");
        setImportRefusals(`${added} Not imported: ${notImported}`);
      } else if (result.collisions.length > 0) {
        toast("Import finished with ID conflicts", { description: added });
      } else {
        toast.success("Saved queries import finished", { description: added });
      }
    } catch {
      toast.error("Could not import saved queries. Check the JSON file and available browser storage.");
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-surface">
      <div className="p-4 border-b border-hairline flex flex-col gap-4">
        <h3 className="text-xs font-medium text-fg-tertiary flex items-center gap-2">
          <Bookmark strokeWidth={1.5} className="w-3.5 h-3.5" /> Saved Queries
        </h3>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-2"
            aria-label="Export all saved queries as JSON"
            disabled={queries.length === 0}
            onClick={() => downloadText(jsonText(queries, 2), "application/json", `saved_queries_${Date.now()}.json`)}
          >
            <Download className="w-3 h-3" /> Export all
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-2"
            disabled={isImporting}
            onClick={() => fileInput.current?.click()}
          >
            <Upload className="w-3 h-3" /> Import JSON
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            aria-label="Import saved queries JSON"
            className="hidden"
            disabled={isImporting}
            onChange={handleImport}
          />
        </div>

        {importRefusals !== null && (
          <output className="flex items-start gap-2 rounded border border-hairline bg-warning-tint/10 px-2 py-1.5 text-warning">
            <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span className="text-xs break-words min-w-0">{importRefusals}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 ml-auto text-xs text-warning hover:text-fg-bright"
              onClick={() => setImportRefusals(null)}
            >
              Dismiss
            </Button>
          </output>
        )}

        <div className="relative">
          <Search strokeWidth={1.5} className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-fg-muted" />
          <Input
            placeholder="Search saved queries..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 bg-fill border-hairline-strong text-xs focus:ring-brand-tint/20"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {filteredQueries.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center opacity-20 p-8 text-center">
            <Bookmark strokeWidth={1.5} className="w-12 h-12 mb-4" />
            <p className="text-xs italic">No saved queries found</p>
          </div>
        )}
        {filteredQueries.length > 0 && (
          <div className="grid grid-cols-1 gap-px bg-fill">
            {filteredQueries.map((q) => {
              // A saved query whose type names no provider (FND-1) is listed with the reason and offers no control
              // that would load it into the editor; it can still be deleted.
              const refusal = typeIdRefusal(q.connectionType);
              return (
                <div
                  key={q.id}
                  className={`relative bg-surface p-4 hover:bg-fill-subtle transition-colors group${refusal === null ? " cursor-pointer" : ""}`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h4 className="text-xs font-medium mb-1">
                        {refusal === null ? (
                          /* Stretched-link pattern: the button's ::after overlay makes the
                           whole card clickable while nested action buttons stay above it */
                          <button
                            type="button"
                            className="text-brand group-hover:text-brand-bright transition-colors cursor-pointer text-left after:absolute after:inset-0"
                            onClick={() => onSelectQuery(q.query)}
                          >
                            {q.name}
                          </button>
                        ) : (
                          <span className="text-fg-muted">{q.name}</span>
                        )}
                      </h4>
                      {q.description && <p className="text-xs text-fg-muted line-clamp-1">{q.description}</p>}
                    </div>
                    <div className="relative z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
                      {refusal === null && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${q.name}`}
                          className="h-6 w-6 text-fg-muted hover:text-fg-bright"
                          onClick={() => onSelectQuery(q.query)}
                        >
                          <PenLine strokeWidth={1.5} className="w-3 h-3" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${q.name}`}
                        className="h-6 w-6 text-fg-muted hover:text-danger"
                        onClick={(e) => handleDelete(q.id, e)}
                      >
                        <Trash2 strokeWidth={1.5} className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>

                  <div className="bg-canvas border border-hairline rounded-md p-2 mb-3">
                    <pre className="text-xs font-mono text-fg-tertiary line-clamp-3">{q.query}</pre>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {refusal === null ? (
                        <span className="px-1.5 py-0.5 rounded bg-brand-tint/10 border border-brand-tint/20 text-[0.625rem] font-medium text-brand">
                          {q.connectionType}
                        </span>
                      ) : (
                        <span
                          className="px-1.5 py-0.5 rounded bg-fill text-[0.625rem] font-medium text-fg-muted"
                          title={refusal.sentence}
                        >
                          Unavailable<span className="sr-only">: {refusal.sentence}</span>
                        </span>
                      )}
                      {q.tags?.map((tag) => (
                        <span key={tag} className="flex items-center gap-1 text-[0.625rem] text-fg-muted">
                          <Tag strokeWidth={1.5} className="w-2.5 h-2.5" /> {tag}
                        </span>
                      ))}
                    </div>
                    <span className="text-[0.625rem] text-fg-subtle flex items-center gap-1 font-mono">
                      <Calendar className="w-2.5 h-2.5" /> {format(q.updatedAt, "MMM d, yyyy")}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
