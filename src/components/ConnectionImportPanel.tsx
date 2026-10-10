"use client";

import { useState } from "react";
import { FileInput } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type {
  ConnectionImportDeclaration,
  ConnectionImporter,
  ConnectionImportResult,
  ImportedContext,
} from "@/lib/connection-import";

/** The test id of the action that opens the import; scripts/check-lib-closure.mjs looks for it in the built package. */
export const CONNECTION_IMPORT_ACTION_ID = "connection-import-open";

const LOAD_FAILED = "The import could not be loaded. Close it and open it again to retry.";
const READ_FAILED = "The import could not read the text, so nothing was filled.";
const NOTHING_FOUND = "No entry was found in the text.";

/**
 * An importer's result copied into plain lists, or undefined when it is not in the shape an importer is declared to
 * return: the panel draws it, so a malformed one is a failed read rather than a render that throws. Each entry is read
 * as data again by the form that fills from it.
 */
function readResult(out: unknown): ConnectionImportResult | undefined {
  if (typeof out !== "object" || out === null) return undefined;
  const { contexts, refusals } = out as Record<string, unknown>;
  if (!Array.isArray(contexts) || !Array.isArray(refusals)) return undefined;
  if (!refusals.every((refusal) => typeof refusal === "string")) return undefined;
  return { contexts: [...contexts], refusals: [...refusals] };
}

type Reader =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly importer: ConnectionImporter }
  | { readonly state: "failed" };

/**
 * The connection dialog's import, drawn for a type whose `DB_UI_CONFIG` entry declares `connectionImport`: an action
 * that opens a paste box, loads the declared parser the first time it opens, reads the pasted text in the browser, and
 * lists the entries found, one button each, to fill the form from. Nothing is sent, logged or stored. The pasted text
 * is dropped as soon as it is read, and the entries as soon as one fills the form or the import closes; an entry the
 * form refuses leaves them listed, so another can be chosen without pasting the text again.
 */
export function ConnectionImportPanel({
  declaration,
  onApply,
}: {
  readonly declaration: ConnectionImportDeclaration;
  /** Fills the form from one entry; false when the form refused it, which keeps the import open on its entries. */
  readonly onApply: (context: ImportedContext) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reader, setReader] = useState<Reader | null>(null);
  const [text, setText] = useState("");
  const [result, setResult] = useState<ConnectionImportResult | null>(null);
  const [readFailed, setReadFailed] = useState(false);

  const close = () => {
    setOpen(false);
    setText("");
    setResult(null);
    setReadFailed(false);
  };

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    // Loaded once; a load that failed is tried again on the next open.
    if (reader !== null && reader.state !== "failed") return;
    setReader({ state: "loading" });
    declaration.load().then(
      (importer) => setReader({ state: "ready", importer }),
      () => setReader({ state: "failed" }),
    );
  };

  const read = () => {
    if (reader?.state !== "ready") return;
    const pasted = text;
    setText("");
    try {
      const read = readResult(reader.importer(pasted));
      setResult(read ?? null);
      setReadFailed(read === undefined);
    } catch {
      // An importer is declared never to throw. One that does may quote the text, a credential included, in its
      // error, so the error is dropped unread and never logged.
      setResult(null);
      setReadFailed(true);
    }
  };

  const apply = (context: ImportedContext) => {
    if (onApply(context)) close();
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        data-testid={CONNECTION_IMPORT_ACTION_ID}
        aria-expanded={open}
        onClick={toggle}
        className="flex items-center gap-1.5 text-xs font-medium text-brand hover:text-brand-bright transition-colors px-2 py-1 rounded-md hover:bg-brand-tint/10"
      >
        <FileInput strokeWidth={1.5} className="w-3 h-3" />
        {declaration.label}
      </button>
      {open && (
        <div className="p-3 rounded-lg border border-brand-tint/20 bg-brand-tint/5 space-y-2">
          <Label htmlFor="connection-import-text" className="text-xs font-medium text-brand">
            Paste the text to import
          </Label>
          <textarea
            id="connection-import-text"
            data-testid="connection-import-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            className="w-full rounded-md bg-panel border border-hairline focus:border-brand-tint/50 text-xs font-mono p-2"
          />
          {reader?.state === "failed" && (
            <p role="alert" data-testid="connection-import-error" className="text-xs text-danger">
              {LOAD_FAILED}
            </p>
          )}
          {readFailed && (
            <p role="alert" data-testid="connection-import-error" className="text-xs text-danger">
              {READ_FAILED}
            </p>
          )}
          <Button
            size="sm"
            type="button"
            data-testid="connection-import-read"
            disabled={reader?.state !== "ready" || text.trim() === ""}
            onClick={read}
            className="bg-brand-solid hover:bg-brand-solid-hover text-white h-9 px-4 text-xs font-medium"
          >
            Read
          </Button>
          {result !== null && result.refusals.length > 0 && (
            <ul data-testid="connection-import-refusals" className="space-y-1 text-xs text-warning">
              {result.refusals.map((refusal, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- two refusals can read the same; the list is read-only and rebuilt whole on every read.
                <li key={index}>{refusal}</li>
              ))}
            </ul>
          )}
          {result !== null && result.contexts.length === 0 && result.refusals.length === 0 && (
            <p data-testid="connection-import-empty" className="text-xs text-fg-muted">
              {NOTHING_FOUND}
            </p>
          )}
          {result !== null && result.contexts.length > 0 && (
            <fieldset className="flex flex-col gap-1">
              <legend className="sr-only">Entries found</legend>
              {result.contexts.map((context, index) => (
                <button
                  // oxlint-disable-next-line react/no-array-index-key -- two entries can share a name; the list is read-only and rebuilt whole on every read.
                  key={index}
                  type="button"
                  data-testid="connection-import-context"
                  onClick={() => apply(context)}
                  className="text-left text-xs px-2 py-1.5 rounded-md border border-hairline bg-panel hover:bg-raised"
                >
                  Fill the form from {context.name}
                </button>
              ))}
            </fieldset>
          )}
        </div>
      )}
    </div>
  );
}
