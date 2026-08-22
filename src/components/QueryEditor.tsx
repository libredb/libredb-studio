"use client";

import React, { useRef, useEffect, useState, useMemo, forwardRef, useImperativeHandle } from "react";
import Editor, { useMonaco } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { Zap, Loader2, AlignLeft, Trash2, Copy, Play, Hash } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { format } from "sql-formatter";
import { registerSQLCompletionProvider } from "@/lib/editor/sql-completions";
import type { SchemaCompletionCache, SchemaColumnItem } from "@/lib/editor/sql-completions";
import { registerMongoDBCompletionProvider } from "@/lib/editor/mongodb-completions";
import { registerLibreDBLanguage } from "@/lib/editor/libredb-language";
import { registerRedisLanguage } from "@/lib/editor/redis-language";
import { configureMonacoLoader } from "@/lib/editor/monaco-loader";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import { logger } from "@/lib/logger";
import { writeToClipboard } from "@/components/copy-button";
import { toast } from "sonner";

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
  /** Optional callback for value changes. Only called on blur, execute, or explicit sync - NOT on every keystroke. */
  onChange?: (val: string) => void;
  /** Called when content changes in real-time. Use sparingly as it triggers on every keystroke. */
  onContentChange?: (val: string) => void;
  onExplain?: () => void;
  language?: "sql" | "json" | "libredb" | "redis";
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
  ({ value, onChange, onContentChange, onExplain, language = "sql", schemaContext, capabilities }, ref) => {
    const monaco = useMonaco();
    const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
    const [hasSelection, setHasSelection] = useState(false);

    // Both themes are defined in `beforeMount`; this only picks which is applied.
    // Monaco re-reads the `theme` prop on change, so the switch needs no remount.
    const editorTheme = useEffectiveTheme() === "light" ? "db-light" : "db-dark";

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

    // Line numbers toggle — default must be SSR-stable; localStorage is applied after mount.
    const [showLineNumbers, setShowLineNumbers] = useState(true);
    const [lineNumbersPreferenceReady, setLineNumbersPreferenceReady] = useState(false);

    useEffect(() => {
      const saved = localStorage.getItem("editor-line-numbers");
      if (saved !== null) {
        setShowLineNumbers(saved === "true");
      }
      setLineNumbersPreferenceReady(true);
    }, []);

    // Track last synced value to detect external changes
    const lastSyncedValueRef = useRef<string>(value);
    const isInternalChangeRef = useRef<boolean>(false);

    // Sync editor content when value prop changes externally (e.g., tab switch)
    useEffect(() => {
      if (editorRef.current && value !== lastSyncedValueRef.current) {
        const currentEditorValue = editorRef.current.getValue();
        // Only update if the new value is different from current editor content
        // This prevents unnecessary updates when we're the source of the change
        if (value !== currentEditorValue) {
          isInternalChangeRef.current = true;
          editorRef.current.setValue(value);
          lastSyncedValueRef.current = value;
          isInternalChangeRef.current = false;
        }
      }
    }, [value]);

    // Update editor options when line numbers toggle changes
    useEffect(() => {
      if (editorRef.current) {
        editorRef.current.updateOptions({ lineNumbers: showLineNumbers ? "on" : "off" });
      }
    }, [showLineNumbers]);

    // Persist line numbers preference to localStorage
    useEffect(() => {
      if (!lineNumbersPreferenceReady) return;
      localStorage.setItem("editor-line-numbers", String(showLineNumbers));
    }, [showLineNumbers, lineNumbersPreferenceReady]);

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
        lastSyncedValueRef.current = formatted;
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

      // 2. If no selection, try to find the current statement (between semicolons)
      if (language === "sql") {
        const position = editorRef.current.getPosition();
        if (position) {
          const fullText = model.getValue();
          const cursorOffset = model.getOffsetAt(position);

          // Find boundaries of the current statement
          let startOffset = fullText.lastIndexOf(";", cursorOffset - 1);
          let endOffset = fullText.indexOf(";", cursorOffset);

          if (startOffset === -1) startOffset = 0;
          else startOffset += 1; // skip the semicolon

          if (endOffset === -1) endOffset = fullText.length;

          const statement = fullText.substring(startOffset, endOffset).trim();
          if (statement.length > 0) {
            const startPos = model.getPositionAt(startOffset);
            const endPos = model.getPositionAt(endOffset);
            const range = new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
            return { query: statement, range };
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
          lastSyncedValueRef.current = newValue;
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
        lastSyncedValueRef.current = "";
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

      monacoInstance.editor.defineTheme("db-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [
          { token: "keyword", foreground: "569cd6", fontStyle: "bold" },
          { token: "function", foreground: "dcdcaa" },
          { token: "string", foreground: "ce9178" },
          { token: "number", foreground: "b5cea8" },
          { token: "comment", foreground: "6a9955" },
          { token: "operator", foreground: "d4d4d4" },
          { token: "identifier", foreground: "9cdcfe" },
        ],
        colors: {
          "editor.background": "#050505",
          "editor.foreground": "#d4d4d4",
          "editorCursor.foreground": "#569cd6",
          "editor.lineHighlightBackground": "#111111",
          "editorLineNumber.foreground": "#333333",
          "editorLineNumber.activeForeground": "#666666",
          "editor.selectionBackground": "#264f78",
          "editor.inactiveSelectionBackground": "#3a3d41",
          "editorIndentGuide.background": "#1a1a1a",
          "editorIndentGuide.activeBackground": "#333333",
        },
      });

      /*
       * Monaco paints its own canvas and knows nothing about the CSS token layer,
       * so the editor is the one surface that needs the palette written twice.
       * Same syntax hues either side — they are chosen for contrast against the
       * CODE, not against the chrome — with only the ground and the guides moved.
       * `editor.background` mirrors `--studio-canvas` in both themes so the pane
       * sits flush with the shell it lives in.
       */
      monacoInstance.editor.defineTheme("db-light", {
        base: "vs",
        inherit: true,
        rules: [
          { token: "keyword", foreground: "0000ff", fontStyle: "bold" },
          { token: "function", foreground: "795e26" },
          { token: "string", foreground: "a31515" },
          { token: "number", foreground: "098658" },
          { token: "comment", foreground: "008000" },
          { token: "operator", foreground: "3f3f46" },
          { token: "identifier", foreground: "001080" },
        ],
        colors: {
          "editor.background": "#f4f4f5",
          "editor.foreground": "#27272a",
          "editorCursor.foreground": "#0000ff",
          "editor.lineHighlightBackground": "#e4e4e7",
          "editorLineNumber.foreground": "#a1a1aa",
          "editorLineNumber.activeForeground": "#52525b",
          "editor.selectionBackground": "#add6ff",
          "editor.inactiveSelectionBackground": "#e5ebf1",
          "editorIndentGuide.background": "#e4e4e7",
          "editorIndentGuide.activeBackground": "#a1a1aa",
        },
      });
    };

    // SQL completion provider
    useEffect(() => {
      if (monaco && language === "sql") {
        const disposable = registerSQLCompletionProvider(monaco, schemaCompletionCache);
        return () => disposable.dispose();
      }
    }, [monaco, language, schemaCompletionCache]);

    // MongoDB JSON completion provider
    useEffect(() => {
      if (monaco && language === "json") {
        const disposable = registerMongoDBCompletionProvider(monaco, schemaCompletionCache);
        return () => disposable.dispose();
      }
    }, [monaco, language, schemaCompletionCache]);

    const handleEditorChange = (val: string | undefined) => {
      const newValue = val || "";
      // Only call onContentChange if provided (for real-time sync scenarios)
      // This avoids the performance hit of updating parent state on every keystroke
      onContentChange?.(newValue);
    };

    // Sync to parent on blur (when user leaves the editor)
    const handleEditorBlur = () => {
      if (editorRef.current) {
        const currentValue = editorRef.current.getValue();
        lastSyncedValueRef.current = currentValue;
        onChange?.(currentValue);
      }
    };

    const handleExecute = () => {
      // Sync current content to parent before executing
      if (editorRef.current) {
        const currentValue = editorRef.current.getValue();
        lastSyncedValueRef.current = currentValue;
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
              variant="ghost"
              size="sm"
              // `text-white` is the label ON a blue button, not the top of the
              // text ramp: it must stay white in the light theme too.
              className="h-7 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 hover:text-white gap-2 shadow-[0_0_10px_rgba(37,99,235,0.3)] animate-in fade-in zoom-in duration-200"
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
              title={language === "json" ? "Format JSON (Shift+Alt+F)" : "Format SQL (Shift+Alt+F)"}
            >
              <AlignLeft strokeWidth={1.5} className="w-3 h-3" /> Format
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
            className="h-7 text-xs font-medium text-fg-muted hover:text-red-400 gap-2"
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
            onClick={() => setShowLineNumbers(!showLineNumbers)}
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
                className="h-7 text-xs font-medium text-amber-500 hover:text-amber-400 gap-2"
                onClick={onExplain}
              >
                <Zap strokeWidth={1.5} className="w-3 h-3" /> Explain
              </Button>
            )}
            <kbd className="px-1.5 py-0.5 rounded bg-raised border border-hairline text-[0.5625rem] text-fg-subtle font-mono">
              ⌘+Enter
            </kbd>
          </div>
        </div>

        {/* min-h-0: the flex item must shrink below Monaco's rendered height, else the editor can never shrink (#94) */}
        <div className="flex-1 relative min-h-0">
          <Editor
            height="100%"
            language={language}
            theme={editorTheme}
            value={value}
            beforeMount={handleBeforeMount}
            onChange={handleEditorChange}
            loading={
              <div className="h-full w-full bg-canvas flex items-center justify-center">
                <Loader2 strokeWidth={1.5} className="w-6 h-6 animate-spin text-fg-subtle" />
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
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
                handleExecute();
              });

              // Add format shortcut
              editor.addCommand(monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => {
                handleFormat();
              });

              // Context Menu Actions
              editor.addAction({
                id: "run-query",
                label: "Run Query",
                keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
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
                keybindings: [monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.KeyF],
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
