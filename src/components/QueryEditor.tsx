"use client";

import React, { useRef, useEffect, useState, useMemo, forwardRef, useImperativeHandle, useCallback } from 'react';
import Editor, { useMonaco } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { Zap, Sparkles, Send, X, Loader2, AlignLeft, Trash2, Copy, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'sql-formatter';
import { registerSQLCompletionProvider } from '@/lib/editor/sql-completions';
import type { SchemaCompletionCache, SchemaColumnItem } from '@/lib/editor/sql-completions';
import { registerMongoDBCompletionProvider } from '@/lib/editor/mongodb-completions';
import { useAiChat } from '@/hooks/use-ai-chat';

export interface QueryEditorRef {
  getSelectedText: () => string;
  getEffectiveQuery: () => string;
  getValue: () => string;
  setValue: (value: string) => void;
  focus: () => void;
  format: () => void;
  toggleAi: () => void;
}

interface QueryEditorProps {
  /** Initial value for the editor. Changes to this prop will update the editor content. */
  value: string;
  /** Optional callback for value changes. Only called on blur, execute, or explicit sync - NOT on every keystroke. */
  onChange?: (val: string) => void;
  /** Called when content changes in real-time. Use sparingly as it triggers on every keystroke. */
  onContentChange?: (val: string) => void;
  onExplain?: () => void;
  language?: 'sql' | 'json';
  tables?: string[];
  databaseType?: string;
  schemaContext?: string;
  capabilities?: import('@/lib/db/types').ProviderCapabilities;
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
const EDITOR_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 13,
  fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
  lineNumbers: 'on' as const,
  roundedSelection: true,
  scrollBeyondLastLine: false,
  readOnly: false,
  automaticLayout: true,
  padding: { top: 12 },
  cursorSmoothCaretAnimation: 'on' as const,
  cursorBlinking: 'smooth' as const,
  smoothScrolling: true,
  contextmenu: true,
  renderLineHighlight: 'all' as const,
  bracketPairColorization: { enabled: true },
  guides: { indentation: true },
  scrollbar: {
    vertical: 'visible' as const,
    horizontal: 'visible' as const,
    verticalScrollbarSize: 8,
    horizontalScrollbarSize: 8,
  },
  fontLigatures: true,
  suggestOnTriggerCharacters: true,
  quickSuggestions: {
    other: true,
    comments: false,
    strings: true
  },
  parameterHints: {
    enabled: true
  }
} as const;

export const QueryEditor = forwardRef<QueryEditorRef, QueryEditorProps>(({
  value,
  onChange,
  onContentChange,
  onExplain,
  language = 'sql',
  tables = [],
  databaseType,
  schemaContext,
  capabilities
}, ref) => {
  const monaco = useMonaco();
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [hasSelection, setHasSelection] = useState(false);

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

  const parsedSchema = useMemo((): ParsedTable[] => {
    if (!schemaContext) return [];
    try {
      return JSON.parse(schemaContext);
    } catch (e) {
      console.error('Failed to parse schema context for editor:', e);
      return [];
    }
  }, [schemaContext]);

  // Pre-compute schema-based completion items for faster lookups
  const schemaCompletionCache = useMemo((): SchemaCompletionCache => {
    const tableItems: SchemaCompletionCache['tableItems'] = [];
    const columnMap = new Map<string, SchemaColumnItem[]>();
    const allColumns = new Map<string, SchemaColumnItem>();

    parsedSchema.forEach((table) => {
      const tableLower = table.name.toLowerCase();
      tableItems.push({
        label: table.name,
        labelLower: tableLower,
        rowCount: table.rowCount || 0,
        columnNames: table.columns?.map((c) => c.name).join(', ') || ''
      });

      const tableColumns: SchemaColumnItem[] = [];
      table.columns?.forEach((col) => {
        const colItem: SchemaColumnItem = {
          label: col.name,
          labelLower: col.name.toLowerCase(),
          type: col.type,
          isPrimary: col.isPrimary || false,
          tableName: table.name
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
      if (language === 'json') {
        // JSON formatting for MongoDB queries
        const parsed = JSON.parse(currentValue);
        formatted = JSON.stringify(parsed, null, 2);
      } else if (language === 'sql') {
        formatted = format(currentValue, {
          language: 'postgresql',
          keywordCase: 'upper',
          dataTypeCase: 'upper',
          indentStyle: 'tabularLeft',
          logicalOperatorNewline: 'before',
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
      console.error('Formatting failed:', e);
    }
  };

  const getSelectedText = () => {
    if (!editorRef.current) return '';
    const selection = editorRef.current.getSelection();
    const model = editorRef.current.getModel();
    if (!selection || !model) return '';
    return model.getValueInRange(selection);
  };

  const getEffectiveQuery = () => {
    const editorValue = editorRef.current?.getValue() || '';
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
    if (language === 'sql') {
      const position = editorRef.current.getPosition();
      if (position) {
        const fullText = model.getValue();
        const cursorOffset = model.getOffsetAt(position);

        // Find boundaries of the current statement
        let startOffset = fullText.lastIndexOf(';', cursorOffset - 1);
        let endOffset = fullText.indexOf(';', cursorOffset);

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
    const decorations = editorRef.current.deltaDecorations([], [
      {
        range: range,
        options: {
          isWholeLine: false,
          className: 'executed-query-highlight',
          inlineClassName: 'executed-query-inline-highlight'
        }
      }
    ]);
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

  // AI Chat hook (must be before useImperativeHandle that references showAi/setShowAi)
  const getEditorValue = useCallback(() => editorRef.current?.getValue() || '', []);
  const setEditorValueForAi = useCallback((val: string) => {
    if (editorRef.current) {
      editorRef.current.setValue(val);
      lastSyncedValueRef.current = val;
    }
  }, []);

  const {
    showAi,
    setShowAi,
    aiPrompt,
    setAiPrompt,
    isAiLoading,
    aiError,
    setAiError,
    aiConversationHistory,
    setAiConversationHistory,
    handleAiSubmit,
  } = useAiChat({
    parsedSchema,
    schemaContext,
    databaseType,
    getEditorValue,
    setEditorValue: setEditorValueForAi,
    onChange,
  });

  useImperativeHandle(ref, () => ({
    getSelectedText,
    getEffectiveQuery: () => getEffectiveQuery().query,
    getValue: () => editorRef.current?.getValue() || '',
    setValue: (newValue: string) => {
      if (editorRef.current) {
        editorRef.current.setValue(newValue);
        lastSyncedValueRef.current = newValue;
      }
    },
    focus: () => editorRef.current?.focus(),
    format: handleFormat,
    toggleAi: () => setShowAi(!showAi),
  }));

  const handleCopy = () => {
    const textToCopy = getSelectedText() || editorRef.current?.getValue() || '';
    navigator.clipboard.writeText(textToCopy);
  };

  const handleClear = () => {
    if (editorRef.current) {
      editorRef.current.setValue('');
      lastSyncedValueRef.current = '';
      onChange?.('');
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
    // Suppress Monaco's "Canceled" errors in console (with cleanup tracking)
    if (!originalConsoleErrorRef.current) {
      originalConsoleErrorRef.current = console.error;
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        const message = args[0]?.toString?.() || '';
        if (message.includes('Canceled') || message.includes('ERR Canceled')) {
          return; // Suppress Monaco cancellation errors
        }
        originalConsoleError.apply(console, args as Parameters<typeof console.error>);
      };
    }

    monacoInstance.editor.defineTheme('db-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'keyword', foreground: '569cd6', fontStyle: 'bold' },
        { token: 'function', foreground: 'dcdcaa' },
        { token: 'string', foreground: 'ce9178' },
        { token: 'number', foreground: 'b5cea8' },
        { token: 'comment', foreground: '6a9955' },
        { token: 'operator', foreground: 'd4d4d4' },
        { token: 'identifier', foreground: '9cdcfe' },
      ],
      colors: {
        'editor.background': '#050505',
        'editor.foreground': '#d4d4d4',
        'editorCursor.foreground': '#569cd6',
        'editor.lineHighlightBackground': '#111111',
        'editorLineNumber.foreground': '#333333',
        'editorLineNumber.activeForeground': '#666666',
        'editor.selectionBackground': '#264f78',
        'editor.inactiveSelectionBackground': '#3a3d41',
        'editorIndentGuide.background': '#1a1a1a',
        'editorIndentGuide.activeBackground': '#333333',
      }
    });
  };

  // SQL completion provider
  useEffect(() => {
    if (monaco && language === 'sql') {
      const disposable = registerSQLCompletionProvider(monaco, schemaCompletionCache);
      return () => disposable.dispose();
    }
  }, [monaco, language, schemaCompletionCache]);

  // MongoDB JSON completion provider
  useEffect(() => {
    if (monaco && language === 'json') {
      const disposable = registerMongoDBCompletionProvider(monaco, schemaCompletionCache);
      return () => disposable.dispose();
    }
  }, [monaco, language, schemaCompletionCache]);

  const handleEditorChange = (val: string | undefined) => {
    const newValue = val || '';
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
    const event = new CustomEvent('execute-query', { detail: { query } });
    window.dispatchEvent(event);
  };


  return (
    <div className="h-full w-full flex flex-col bg-[#050505] relative overflow-hidden group">
      {/* Dynamic Pro Toolbar - Hidden on mobile */}
      <div className="hidden md:flex items-center gap-1.5 px-3 py-1.5 bg-[#0a0a0a] border-b border-white/5 overflow-x-auto no-scrollbar scroll-smooth">
        <div className="flex items-center gap-1 mr-2 px-1.5 py-1 rounded bg-white/5 border border-white/5">
          <span className="text-[9px] font-black text-zinc-500 uppercase tracking-[0.2em]">Quick Actions</span>
        </div>

        {hasSelection && (
          <button
            onClick={handleExecute}
            className="px-2.5 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold transition-all border border-blue-400/30 active:scale-95 flex items-center gap-1.5 shadow-[0_0_15px_rgba(37,99,235,0.3)] animate-in fade-in zoom-in duration-200"
          >
            <Play className="w-3 h-3 fill-current" />
            RUN SELECTION
          </button>
        )}

        <button
          onClick={handleFormat}
          title={language === 'json' ? "Format JSON (Shift+Alt+F)" : "Format SQL (Shift+Alt+F)"}
          className="px-2.5 py-1.5 rounded bg-[#111] hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 text-[10px] font-mono transition-all border border-white/5 active:scale-95 flex items-center gap-1.5"
        >
          <AlignLeft className="w-3 h-3" />
          FORMAT
        </button>

        <button
          onClick={handleCopy}
          className="px-2.5 py-1.5 rounded bg-[#111] hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 text-[10px] font-mono transition-all border border-white/5 active:scale-95 flex items-center gap-1.5"
        >
          <Copy className="w-3 h-3" />
          {hasSelection ? 'COPY SELECTION' : 'COPY'}
        </button>

        <button
          onClick={handleClear}
          className="px-2.5 py-1.5 rounded bg-[#111] hover:bg-zinc-800 text-zinc-500 hover:text-red-400 text-[10px] font-mono transition-all border border-white/5 active:scale-95 flex items-center gap-1.5"
        >
          <Trash2 className="w-3 h-3" />
          CLEAR
        </button>

        <div className="w-px h-4 bg-white/5 mx-1" />

        <button
          onClick={() => setShowAi(!showAi)}
          className={cn(
            "px-2.5 py-1.5 rounded text-[10px] font-bold transition-all border active:scale-95 flex items-center gap-1.5",
            showAi
              ? "bg-blue-600 border-blue-500 text-white shadow-[0_0_10px_rgba(37,99,235,0.4)]"
              : "bg-zinc-900 border-white/5 text-zinc-400 hover:text-blue-400 hover:border-blue-500/30"
          )}
        >
          <Sparkles className={cn("w-3.5 h-3.5", showAi && "animate-pulse")} />
          AI ASSISTANT
        </button>

        <div className="flex-1" />

          <div className="flex items-center gap-1.5 opacity-50 hover:opacity-100 transition-opacity">
            {onExplain && capabilities?.supportsExplain && (
              <button
                onClick={onExplain}
                className="px-2.5 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800 text-amber-500 hover:text-amber-400 text-[10px] font-bold transition-all border border-amber-500/10 active:scale-95 flex items-center gap-1.5 mr-2"
              >
                <Zap className="w-3 h-3" />
                EXPLAIN
              </button>
            )}
            <kbd className="px-2 py-1 rounded bg-zinc-900 border border-white/5 text-[9px] text-zinc-500 font-mono">
              ⌘ + ENTER TO RUN
            </kbd>
          </div>
        </div>

      {/* Floating AI Input */}
      <AnimatePresence>
        {showAi && (
            <motion.div
              initial={{ opacity: 0, y: -10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              className="absolute top-2 md:top-12 left-1/2 -translate-x-1/2 w-full max-w-2xl z-50 px-2 md:px-4"
            >
              <form
                onSubmit={handleAiSubmit}
                className="bg-[#0f0f0f]/95 backdrop-blur-xl border border-blue-500/40 rounded-2xl shadow-[0_0_50px_rgba(37,99,235,0.25)] overflow-hidden flex flex-col p-1.5"
              >
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5 mb-1.5">
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded-md bg-blue-500/10">
                      <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                    </div>
                    <span className="text-[10px] font-black text-blue-400 uppercase tracking-[0.2em]">Expert DBA Mode</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {aiConversationHistory.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setAiConversationHistory([])}
                        className="text-[9px] text-zinc-500 hover:text-zinc-300 font-medium px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 transition-colors"
                        title="Clear conversation history"
                      >
                        {aiConversationHistory.length / 2} turns - Clear
                      </button>
                    )}
                    <span className="text-[9px] text-zinc-500 font-medium">Context: {tables.length} tables</span>
                    <div className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
                  </div>
                  </div>

                  <AnimatePresence>
                    {aiError && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="px-3 pb-2"
                      >
                        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5 flex items-start gap-2.5">
                          <div className="p-1 rounded bg-red-500/20 mt-0.5">
                            <X className="w-3 h-3 text-red-400" />
                          </div>
                          <div className="flex-1">
                            <p className="text-[11px] font-bold text-red-400 uppercase tracking-tight mb-0.5">AI Error</p>
                            <p className="text-[12px] text-red-300/90 leading-relaxed">{aiError}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setAiError(null)}
                            className="text-red-400/50 hover:text-red-400 transition-colors"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div className="flex items-center gap-2 px-3 pb-1.5">

                  <input
                    autoFocus
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="Describe the data you need in plain English... (e.g. 'Show me the revenue growth per month')"
                    className="bg-transparent border-none outline-none text-[13px] text-zinc-100 w-full h-12 placeholder:text-zinc-600 font-medium"
                  />
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setShowAi(false)}
                      className="p-2.5 rounded-xl hover:bg-white/5 text-zinc-500 transition-colors"
                    >
                      <X className="w-4.5 h-4.5" />
                    </button>
                    <button
                      type="submit"
                      disabled={isAiLoading || !aiPrompt.trim()}
                      className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600 px-5 py-2.5 rounded-xl text-white text-xs font-bold transition-all shadow-lg shadow-blue-600/30 flex items-center gap-2"
                    >
                      {isAiLoading ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Thinking...</span>
                        </>
                      ) : (
                        <>
                          <span>Generate</span>
                          <Send className="w-3.5 h-3.5" />
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </form>
            </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 relative">
        <Editor
          height="100%"
          language={language}
          theme="db-dark"
          value={value}
          beforeMount={handleBeforeMount}
          onChange={handleEditorChange}
          loading={<div className="h-full w-full bg-[#050505] flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-zinc-800" /></div>}
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
              id: 'run-query',
              label: 'Run Query',
              keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
              contextMenuGroupId: 'navigation',
              contextMenuOrder: 1,
              run: () => handleExecute()
            });

            if (onExplain) {
              editor.addAction({
                id: 'explain-query',
                label: 'Explain Plan',
                contextMenuGroupId: 'navigation',
                contextMenuOrder: 2,
                run: () => onExplain()
              });
            }

            editor.addAction({
              id: 'format-sql',
              label: 'Format SQL',
              keybindings: [monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.KeyF],
              contextMenuGroupId: 'modification',
              contextMenuOrder: 1,
              run: () => handleFormat()
            });
          }}
          options={EDITOR_OPTIONS}
        />

        {/* Connection Type Badge */}
        <div className="absolute top-3 right-6 pointer-events-none select-none z-10">
          <div className="flex items-center gap-2 px-3 py-1 rounded-md bg-zinc-900/90 border border-white/10 backdrop-blur-md shadow-2xl">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]" />
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">
              {language} Engine
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});

QueryEditor.displayName = 'QueryEditor';
