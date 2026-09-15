"use client";

import React, { useRef, useEffect, useState, useMemo, forwardRef, useImperativeHandle } from "react";
import { SHORTCUTS, shortcutLabel, monacoKeybinding } from "@/lib/keyboard-shortcuts";
import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { Zap, LoaderCircle, TextAlignStart, Trash2, Copy, Play, Hash } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { format } from "sql-formatter";
import { registerSQLCompletionProvider } from "@/lib/editor/sql-completions";
import type { SchemaCompletionCache, SchemaColumnItem } from "@/lib/editor/sql-completions";
import { registerMongoDBCompletionProvider } from "@/lib/editor/mongodb-completions";
import { registerLibreDBLanguage } from "@/lib/editor/libredb-language";
import { registerRedisLanguage } from "@/lib/editor/redis-language";
import { configureMonacoLoader } from "@/lib/editor/monaco-loader";
import { defineStudioThemes, STUDIO_THEME_DARK, STUDIO_THEME_LIGHT } from "@/lib/editor/monaco-theme";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import { useMonacoInstance } from "@/hooks/use-monaco-instance";
import { logger } from "@/lib/logger";
import { setLineNumbersPreference, useLineNumbersPreference } from "@/hooks/use-line-numbers-preference";
import { writeToClipboard } from "@/components/copy-button";
import { toast } from "sonner";
import { splitStatements } from "@/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import type { DatabaseType } from "@/lib/types";

// Serve Monaco from our own origin rather than @monaco-editor/react's jsdelivr default.
// Runs at module load so it is in place before the first <Editor> mounts.
configureMonacoLoader();

// Context key gating the "Explain Plan" context-menu action. Monaco evaluates an action's
// precondition when the menu opens, so the key — not the mounting render — decides whether
// the affordance is offered (see the explain-capability gate below).
const CAN_EXPLAIN_CONTEXT_KEY = "libredbCanExplain";

export interface QueryEditorRef {
  getSelectedText: () => string;
  getEffectiveQuery: () => string;
  getValue: () => string;
  setValue: (value: string) => void;
  focus: () => void;
  format: () => void;
}

interface QueryEditorProps {
  /** Initial value for the editor. Changes to this prop will update the editor content. */
  value: string;
  /**
   * Which document `value` belongs to, so that switching documents is an event and not a
   * string comparison. The tab id in both hosts.
   *
   * Without it the editor cannot see a switch to a tab whose text happens to equal the
   * string it was already holding, and a new tab therefore opens showing the previous
   * tab's text (#808): the parent mirrors typing one render behind, so at the moment a
   * new empty tab arrives `value` can still be the empty string it started as, and a
   * prop that never changed cannot announce anything.
   *
   * Optional: a host that renders a single document never switches, and omitting it
   * leaves the text-only reconciliation below in charge.
   */
  documentId?: string;
  /** Optional callback for value changes. Only called on blur, execute, or explicit sync - NOT on every keystroke. */
  onChange?: (val: string) => void;
  /** Called when content changes in real-time. Use sparingly as it triggers on every keystroke. */
  onContentChange?: (val: string) => void;
  onExplain?: () => void;
  language?: "sql" | "json" | "libredb" | "redis";
  /**
   * The connected engine, whose grammar decides where a statement ends.
   *
   * Optional, and a caller that omits it gets the compatibility reading - the same
   * stated default every reader in `src/lib/sql/` applies to a dialect-less call.
   */
  databaseType?: DatabaseType;
  schemaContext?: string;
  capabilities?: import("@/lib/db/types").ProviderCapabilities;
}

interface ParsedTable {
  name: string;
  rowCount?: number;
  columns?: Array<{
    name: string;
    type: string;
    isPrimary?: boolean;
  }>;
}

// Static editor options - defined outside component to prevent re-creation on every render
const getEditorOptions = (showLineNumbers: boolean) => ({
  minimap: { enabled: false },
  fontSize: 13,
  fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
  lineNumbers: showLineNumbers ? ("on" as const) : ("off" as const),
  roundedSelection: true,
  scrollBeyondLastLine: false,
  readOnly: false,
  automaticLayout: true,
  padding: { top: 12 },
  cursorSmoothCaretAnimation: "on" as const,
  cursorBlinking: "smooth" as const,
  smoothScrolling: true,
  contextmenu: true,
  renderLineHighlight: "all" as const,
  bracketPairColorization: { enabled: true },
  guides: { indentation: true },
  scrollbar: {
    vertical: "visible" as const,
    horizontal: "visible" as const,
    verticalScrollbarSize: 8,
    horizontalScrollbarSize: 8,
  },
  fontLigatures: true,
  suggestOnTriggerCharacters: true,
  quickSuggestions: {
    other: true,
    comments: false,
    strings: true,
  },
  parameterHints: {
    enabled: true,
  },
});

export const QueryEditor = forwardRef<QueryEditorRef, QueryEditorProps>(
  (
    {
      value,
      documentId,
      onChange,
      onContentChange,
      onExplain,
      language = "sql",
      databaseType,
      schemaContext,
      capabilities,
    },
    ref,
  ) => {
    const monaco = useMonacoInstance();
    const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
    const [hasSelection, setHasSelection] = useState(false);

    // Both themes are defined in `beforeMount`, from `@/lib/editor/monaco-theme`; this only picks
    // which is applied.
    // Monaco re-reads the `theme` prop on change, so the switch needs no remount.
    const editorTheme = useEffectiveTheme() === "light" ? STUDIO_THEME_LIGHT : STUDIO_THEME_DARK;

    // Explain capability gate, shared by the toolbar button and the context-menu action.
    const canExplain = Boolean(onExplain) && Boolean(capabilities?.supportsExplain);
    // The context-menu action is registered once, in onMount, so it must not close over the
    // mounting render: `onExplain` is undefined until /api/db/provider-meta resolves, and it
    // changes again on every connection switch. Both the handler and the visibility key are
    // therefore read at invocation time (#200).
    const explainHandlerRef = useRef<(() => void) | undefined>(canExplain ? onExplain : undefined);
    const canExplainKeyRef = useRef<Monaco.editor.IContextKey<boolean> | null>(null);

    useEffect(() => {
      explainHandlerRef.current = canExplain ? onExplain : undefined;
      // Null until the editor mounts; onMount seeds the key from the ref instead.
      canExplainKeyRef.current?.set(canExplain);
    }, [canExplain, onExplain]);

    // Line numbers toggle. The store keeps the default SSR-stable and applies the stored
    // value at hydration, so there is no local default left that could overwrite it.
    const showLineNumbers = useLineNumbersPreference();

    /*
      Every text this editor has handed up through `onContentChange` and has not yet seen
      come back down as `value`, oldest first, plus the document they belong to.

      The parent mirrors the buffer: it writes each change into the tab's query and feeds
      that straight back in as `value`, one render behind. An incoming `value` is
      therefore one of two completely different things, and only one of them may touch
      the model:

        - OUR OWN text, arriving late. Writing it back rewrites the buffer with an older
          string and moves the caret, which is the "typing scrambles, cursor jumps to
          line 1" bug (#808).
        - Somebody ELSE's text: another tab, a query loaded from history or the saved
          list, a generated statement. That has to land.

      An outstanding text is ours by construction, so this tells them apart by identity.
      Asking instead whether the buffer has moved since the last sync can only infer it,
      and an external write that arrives while the user is typing looks exactly like a
      late echo under that reading.

      Two equal strings need no tie-break: if an external write happens to carry text this
      editor just sent up, applying it or skipping it leaves the same buffer.
    */
    const echoesRef = useRef<{ documentId?: string; values: string[] }>({ documentId, values: [] });

    // The ONE path that pushes an external value change into the model, now that
    // <Editor> is uncontrolled (defaultValue) and the library's own controlled-value
    // effect stays at its early return.
    useEffect(() => {
      const editor = editorRef.current;
      if (!editor) return;

      const echoes = echoesRef.current;

      // A different document is in front of the user now: its text is authoritative
      // whatever the buffer holds, and nothing the editor sent up belongs to it.
      if (documentId !== echoes.documentId) {
        echoesRef.current = { documentId, values: [] };
        if (value !== editor.getValue()) editor.setValue(value);
        return;
      }

      const echoIndex = echoes.values.indexOf(value);
      if (echoIndex !== -1) {
        // Ours, arriving late. Drop it and everything older with it: the parent moves
        // through our texts in order, so a render carrying one of those cannot follow.
        echoes.values.splice(0, echoIndex + 1);
        return;
      }

      // Nobody here wrote this, so it came from outside: a query loaded from history or
      // the saved list, a generated statement. It replaces the buffer, which makes every
      // outstanding echo a description of text that no longer exists.
      echoes.values = [];
      editor.setValue(value);
    }, [value, documentId]);

    // Update editor options when line numbers toggle changes
    useEffect(() => {
      if (editorRef.current) {
        editorRef.current.updateOptions({ lineNumbers: showLineNumbers ? "on" : "off" });
      }
    }, [showLineNumbers]);

    const parsedSchema = useMemo((): ParsedTable[] => {
      if (!schemaContext) return [];
      try {
        return JSON.parse(schemaContext);
      } catch (e) {
        logger.warn("Failed to parse the schema context; the editor completes without it", {
          route: "QueryEditor",
          error: e instanceof Error ? e.message : String(e),
        });
        return [];
      }
    }, [schemaContext]);

    // Pre-compute schema-based completion items for faster lookups
    const schemaCompletionCache = useMemo((): SchemaCompletionCache => {
      const tableItems: SchemaCompletionCache["tableItems"] = [];
      const columnMap = new Map<string, SchemaColumnItem[]>();
      const allColumns = new Map<string, SchemaColumnItem>();

      parsedSchema.forEach((table) => {
        const tableLower = table.name.toLowerCase();
        tableItems.push({
          label: table.name,
          labelLower: tableLower,
          rowCount: table.rowCount || 0,
          columnNames: table.columns?.map((c) => c.name).join(", ") || "",
        });

        const tableColumns: SchemaColumnItem[] = [];
        table.columns?.forEach((col) => {
          const colItem: SchemaColumnItem = {
            label: col.name,
            labelLower: col.name.toLowerCase(),
            type: col.type,
            isPrimary: col.isPrimary || false,
            tableName: table.name,
          };
          tableColumns.push(colItem);

          // Only store first occurrence for global column suggestions
          if (!allColumns.has(col.name)) {
            allColumns.set(col.name, colItem);
          }
        });
        columnMap.set(tableLower, tableColumns);
      });

      return { tableItems, columnMap, allColumns };
    }, [parsedSchema]);

    const handleFormat = () => {
      if (!editorRef.current) return;
      const currentValue = editorRef.current.getValue();
      if (!currentValue) return;

      try {
        let formatted: string;
        if (language === "json") {
          // JSON formatting for MongoDB queries
          const parsed = JSON.parse(currentValue);
          formatted = JSON.stringify(parsed, null, 2);
        } else if (language === "sql") {
          formatted = format(currentValue, {
            language: "postgresql",
            keywordCase: "upper",
            dataTypeCase: "upper",
            indentStyle: "tabularLeft",
            logicalOperatorNewline: "before",
            expressionWidth: 100,
            tabWidth: 2,
            linesBetweenQueries: 2,
          });
        } else {
          return;
        }
        editorRef.current.setValue(formatted);
        onChange?.(formatted);
      } catch (e) {
        logger.warn("Statement formatting failed; the editor text is left as written", {
          route: "QueryEditor",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    };

    const getSelectedText = () => {
      if (!editorRef.current) return "";
      const selection = editorRef.current.getSelection();
      const model = editorRef.current.getModel();
      if (!selection || !model) return "";
      return model.getValueInRange(selection);
    };

    const getEffectiveQuery = () => {
      const editorValue = editorRef.current?.getValue() || "";
      if (!editorRef.current || !monaco) return { query: editorValue, range: null };

      const model = editorRef.current.getModel();
      if (!model) return { query: editorValue, range: null };

      // 1. Check for explicit selection
      const selection = editorRef.current.getSelection();
      if (selection) {
        const selectedText = model.getValueInRange(selection);
        if (selectedText && selectedText.trim().length > 0) {
          return { query: selectedText, range: selection };
        }
      }

      // 2. No selection: run the statement the cursor is in.
      //
      // Read through the shared splitter, under the connection's dialect. This used to be
      // `lastIndexOf(";")` over the raw text - no spans, no dialect, not even a
      // string-literal check - which made it the THIRD reader of "where does a statement
      // end" and the only one whose answer is what gets SENT. Measured in Chrome on
      // 2026-08-25 against postgres 18: a buffer PostgreSQL reads as one statement was
      // cut at a `;` inside a nested comment, so what reached the engine was a line
      // comment plus the SELECT, and the grid read 0 rows where psql answers 2. A `;`
      // inside a literal (`SELECT 'a;b'`) cut the same way.
      if (language === "sql") {
        const position = editorRef.current.getPosition();
        if (position) {
          const fullText = model.getValue();
          const cursorOffset = model.getOffsetAt(position);
          const statements = splitStatements(fullText, resolveSqlGrammar(databaseType));
          // The statement the cursor is inside or immediately after, which is what "run
          // this one" means with the caret resting at a statement's end. Whitespace
          // between two statements belongs to neither, so the last one that starts at or
          // before the cursor wins - and with the caret before the first statement, that
          // first one does.
          const current =
            [...statements].reverse().find((statement) => statement.start <= cursorOffset) ?? statements[0];

          if (current) {
            const startPos = model.getPositionAt(current.start);
            const endPos = model.getPositionAt(current.end);
            const range = new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
            return { query: current.sql, range };
          }
        }
      }

      return { query: editorValue, range: null };
    };

    // Track active highlight timeout to prevent race conditions
    const highlightTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const activeDecorationsRef = useRef<string[]>([]);

    const flashHighlight = (range: Monaco.Range | null) => {
      if (!editorRef.current || !monaco || !range) return;

      // Clear any existing highlight first
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
        highlightTimeoutRef.current = null;
      }
      if (activeDecorationsRef.current.length > 0 && editorRef.current) {
        editorRef.current.deltaDecorations(activeDecorationsRef.current, []);
        activeDecorationsRef.current = [];
      }

      // Create new decoration
      const decorations = editorRef.current.deltaDecorations(
        [],
        [
          {
            range: range,
            options: {
              isWholeLine: false,
              className: "executed-query-highlight",
              inlineClassName: "executed-query-inline-highlight",
            },
          },
        ],
      );
      activeDecorationsRef.current = decorations;

      // Schedule removal with ref tracking for safe cleanup
      highlightTimeoutRef.current = setTimeout(() => {
        if (editorRef.current && activeDecorationsRef.current.length > 0) {
          editorRef.current.deltaDecorations(activeDecorationsRef.current, []);
          activeDecorationsRef.current = [];
        }
        highlightTimeoutRef.current = null;
      }, 1000);
    };

    // Cleanup highlight timeout on unmount
    useEffect(() => {
      return () => {
        if (highlightTimeoutRef.current) {
          clearTimeout(highlightTimeoutRef.current);
        }
      };
    }, []);

    useImperativeHandle(ref, () => ({
      getSelectedText,
      getEffectiveQuery: () => getEffectiveQuery().query,
      getValue: () => editorRef.current?.getValue() || "",
      setValue: (newValue: string) => {
        if (editorRef.current) {
          editorRef.current.setValue(newValue);
        }
      },
      focus: () => editorRef.current?.focus(),
      format: handleFormat,
    }));

    const handleCopy = () => {
      // `writeToClipboard` rather than `navigator.clipboard` directly (B43): that API is
      // absent over plain HTTP off loopback, which several distribution channels are.
      // This button carries no label of its own to flip, so a failure has to be said out
      // loud or it is not said at all. It cannot be a `CopyButton`: the text lives in the
      // editor ref, so there is no `text` prop that would still be current at click time.
      const textToCopy = getSelectedText() || editorRef.current?.getValue() || "";
      void writeToClipboard(textToCopy).then((copied) => {
        if (!copied) toast.error("Could not copy the query — select the text and copy it yourself");
      });
    };

    const handleClear = () => {
      if (editorRef.current) {
        editorRef.current.setValue("");
        onChange?.("");
      }
    };

    // Store original console.error for cleanup
    const originalConsoleErrorRef = useRef<typeof console.error | null>(null);

    // Cleanup console.error override on unmount
    useEffect(() => {
      return () => {
        if (originalConsoleErrorRef.current) {
          console.error = originalConsoleErrorRef.current;
          originalConsoleErrorRef.current = null;
        }
      };
    }, []);

    const handleBeforeMount = (monacoInstance: typeof Monaco) => {
      // Register the LibreDB and Redis command languages (both idempotent) so
      // their tabs highlight correctly instead of being treated as JSON (#427).
      registerLibreDBLanguage(monacoInstance);
      registerRedisLanguage(monacoInstance);

      // Suppress Monaco's "Canceled" errors in console (with cleanup tracking)
      if (!originalConsoleErrorRef.current) {
        originalConsoleErrorRef.current = console.error;
        const originalConsoleError = console.error;
        console.error = (...args: unknown[]) => {
          const message = args[0]?.toString?.() || "";
          if (message.includes("Canceled") || message.includes("ERR Canceled")) {
            return; // Suppress Monaco cancellation errors
          }
          originalConsoleError.apply(console, args as Parameters<typeof console.error>);
        };
      }

      // Both themes come from one owner so this mount and the read-only source viewer
      // paint identically (#789).
      defineStudioThemes(monacoInstance);
    };

    // SQL completion provider
    useEffect(() => {
      if (monaco && language === "sql") {
        const disposable = registerSQLCompletionProvider(monaco, schemaCompletionCache, databaseType);
        return () => disposable.dispose();
      }
    }, [monaco, language, schemaCompletionCache, databaseType]);

    // MongoDB JSON completion provider
    useEffect(() => {
      if (monaco && language === "json") {
        const disposable = registerMongoDBCompletionProvider(monaco, schemaCompletionCache);
        return () => disposable.dispose();
      }
    }, [monaco, language, schemaCompletionCache]);

    // Every model change reaches here: a keystroke, and equally the writes Format, Clear
    // and the imperative setValue make, since Monaco reports those through the same
    // change event. All of them are this editor's own text, so all of them are recorded
    // before they go up, and none of them may come back down into the buffer.
    const handleEditorChange = (val: string | undefined) => {
      const newValue = val || "";
      if (onContentChange) {
        echoesRef.current.values.push(newValue);
        onContentChange(newValue);
      }
    };

    // Sync to parent on blur (when user leaves the editor)
    const handleEditorBlur = () => {
      if (editorRef.current) {
        const currentValue = editorRef.current.getValue();
        onChange?.(currentValue);
      }
    };

    const handleExecute = () => {
      // Sync current content to parent before executing
      if (editorRef.current) {
        const currentValue = editorRef.current.getValue();
        onChange?.(currentValue);
      }

      const { query, range } = getEffectiveQuery();
      flashHighlight(range);
      const event = new CustomEvent("execute-query", { detail: { query } });
      window.dispatchEvent(event);
    };

    return (
      <div className="h-full w-full flex flex-col bg-canvas relative overflow-hidden group">
        {/* Dynamic Pro Toolbar - Hidden on mobile */}
        <div className="hidden md:flex items-center gap-1 px-4 py-1.5 bg-surface border-b border-hairline overflow-x-auto no-scrollbar scroll-smooth">
          {hasSelection && (
            <Button
              variant="default"
              size="sm"
              // `text-white` is the label ON a blue button, not the top of the
              // text ramp: it must stay white in the light theme too.
              className="h-7 text-xs font-medium text-white bg-brand-solid hover:bg-brand-solid-hover hover:text-white gap-2 shadow-[0_0_10px_rgba(37,99,235,0.3)] animate-in fade-in zoom-in duration-200"
              onClick={handleExecute}
            >
              <Play strokeWidth={1.5} className="w-3 h-3 fill-current" /> Run Sel
            </Button>
          )}

          {(language === "sql" || language === "json") && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs font-medium text-fg-muted hover:text-fg-bright gap-2"
              onClick={handleFormat}
              title={`Format ${language === "json" ? "JSON" : "SQL"} (${shortcutLabel(SHORTCUTS.formatQuery)})`}
            >
              <TextAlignStart strokeWidth={1.5} className="w-3 h-3" /> Format
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs font-medium text-fg-muted hover:text-fg-bright gap-2"
            onClick={handleCopy}
          >
            <Copy strokeWidth={1.5} className="w-3 h-3" /> {hasSelection ? "Copy Sel" : "Copy"}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs font-medium text-fg-muted hover:text-danger gap-2"
            onClick={handleClear}
          >
            <Trash2 strokeWidth={1.5} className="w-3 h-3" /> Clear
          </Button>

          <div className="h-4 w-px bg-fill" />

          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 text-xs font-medium gap-2",
              showLineNumbers ? "text-fg-secondary" : "text-fg-muted hover:text-fg-bright",
            )}
            onClick={() => setLineNumbersPreference(!showLineNumbers)}
            title={showLineNumbers ? "Hide line numbers" : "Show line numbers"}
          >
            <Hash strokeWidth={1.5} className="w-3 h-3" /> Lines
          </Button>

          <div className="flex-1" />

          <div className="flex items-center gap-2 opacity-50 hover:opacity-100 transition-opacity">
            {canExplain && (
              <Button
                variant="ghost"
                size="sm"
                // The base absorbed this button's old hover value when the -500 text
                // drift collapsed amber-500 onto the token, so the hover has to step
                // up to keep any feedback of its own (#402).
                className="h-7 text-xs font-medium text-warning hover:text-warning-bright gap-2"
                onClick={onExplain}
              >
                <Zap strokeWidth={1.5} className="w-3 h-3" /> Explain
              </Button>
            )}
            <kbd className="px-1.5 py-0.5 rounded bg-raised border border-hairline text-[0.5625rem] text-fg-subtle font-mono">
              {shortcutLabel(SHORTCUTS.executeQuery)}
            </kbd>
          </div>
        </div>

        {/* min-h-0: the flex item must shrink below Monaco's rendered height, else the editor can never shrink (#94) */}
        <div className="flex-1 relative min-h-0">
          <Editor
            height="100%"
            language={language}
            theme={editorTheme}
            // `defaultValue`, not `value`: this editor owns its buffer, and the model is
            // never driven by a prop. `@monaco-editor/react`'s controlled-`value` effect
            // runs an `executeEdits` over the FULL model range whenever the prop differs
            // from the buffer, and the prop is the parent's mirror of our own text, one
            // render behind. A keystroke landing inside that window therefore made the
            // library rewrite the whole buffer with older text and snap the caret to
            // (1,1): the "typing scrambles / cursor jumps" bug (#808), easiest to hit
            // where a render is slow. Passing `defaultValue` leaves that effect at its
            // `t === void 0` early return, which makes the effect above the single place
            // an outside change can reach the model.
            defaultValue={value}
            beforeMount={handleBeforeMount}
            onChange={handleEditorChange}
            loading={
              <div className="h-full w-full bg-canvas flex items-center justify-center">
                <LoaderCircle strokeWidth={1.5} className="w-6 h-6 animate-spin text-fg-subtle" />
              </div>
            }
            onMount={(editor, monaco) => {
              editorRef.current = editor;

              // Sync to parent when editor loses focus
              editor.onDidBlurEditorText(() => {
                handleEditorBlur();
              });

              editor.onDidChangeCursorSelection(() => {
                const selection = editor.getSelection();
                setHasSelection(selection ? !selection.isEmpty() : false);
              });

              // Add custom keyboard shortcut
              editor.addCommand(monacoKeybinding(SHORTCUTS.executeQuery, monaco), () => {
                handleExecute();
              });

              // Add format shortcut
              editor.addCommand(monacoKeybinding(SHORTCUTS.formatQuery, monaco), () => {
                handleFormat();
              });

              // Context Menu Actions
              editor.addAction({
                id: "run-query",
                label: "Run Query",
                keybindings: [monacoKeybinding(SHORTCUTS.executeQuery, monaco)],
                contextMenuGroupId: "navigation",
                contextMenuOrder: 1,
                run: () => handleExecute(),
              });

              canExplainKeyRef.current = editor.createContextKey<boolean>(
                CAN_EXPLAIN_CONTEXT_KEY,
                Boolean(explainHandlerRef.current),
              );
              editor.addAction({
                id: "explain-query",
                label: "Explain Plan",
                precondition: CAN_EXPLAIN_CONTEXT_KEY,
                contextMenuGroupId: "navigation",
                contextMenuOrder: 2,
                run: () => explainHandlerRef.current?.(),
              });

              editor.addAction({
                id: "format-sql",
                label: "Format SQL",
                keybindings: [monacoKeybinding(SHORTCUTS.formatQuery, monaco)],
                contextMenuGroupId: "modification",
                contextMenuOrder: 1,
                run: () => handleFormat(),
              });
            }}
            options={getEditorOptions(showLineNumbers)}
          />
        </div>
      </div>
    );
  },
);

QueryEditor.displayName = "QueryEditor";
