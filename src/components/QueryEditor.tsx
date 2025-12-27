"use client";

import React, { useRef, useEffect, useState, useMemo, forwardRef, useImperativeHandle } from 'react';
import Editor, { useMonaco } from '@monaco-editor/react';
import { Zap, Sparkles, Send, X, Loader2, AlignLeft, Trash2, Copy, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'sql-formatter';

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
  language?: 'sql' | 'json';
  tables?: string[];
  databaseType?: string;
  schemaContext?: string;
}

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL',
  'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'UNION', 'ALL', 'EXISTS', 'DISTINCT',
  'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'NATURAL JOIN', 'ON', 'USING',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'TRUNCATE', 'CREATE', 'ALTER', 'DROP',
  'TABLE', 'VIEW', 'INDEX', 'SCHEMA', 'DATABASE', 'FUNCTION', 'TRIGGER', 'PROCEDURE',
  'AS', 'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'COALESCE', 'NULLIF',
  'WINDOW', 'OVER', 'PARTITION BY', 'ROWS', 'RANGE', 'PRECEDING', 'FOLLOWING', 'UNBOUNDED'
];

const SQL_FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'FIRST_VALUE', 'LAST_VALUE', 'LEAD', 'LAG',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'CONCAT', 'SUBSTR', 'LENGTH', 'LOWER', 'UPPER',
  'TRIM', 'LTRIM', 'RTRIM', 'REPLACE', 'ROUND', 'TRUNC', 'ABS', 'NOW', 'CURRENT_TIMESTAMP',
  'DATE_PART', 'DATE_TRUNC', 'EXTRACT', 'AGE', 'TO_CHAR', 'TO_DATE', 'TO_NUMBER', 'JSON_AGG', 'JSON_BUILD_OBJECT'
];

const SQL_SNIPPETS = [
  { label: 'SELECT', value: 'SELECT * FROM ${1:table_name} LIMIT 10;' },
  { label: 'INSERT', value: 'INSERT INTO ${1:table_name} (${2:columns})\nVALUES (${3:values});' },
  { label: 'UPDATE', value: 'UPDATE ${1:table_name}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};' },
  { label: 'DELETE', value: 'DELETE FROM ${1:table_name}\nWHERE ${2:condition};' },
  { label: 'JOIN', value: 'SELECT ${1:*}\nFROM ${2:table1} t1\nJOIN ${3:table2} t2 ON t1.${4:id} = t2.${5:t1_id};' },
  { label: 'WITH', value: 'WITH ${1:cte_name} AS (\n  SELECT ${2:*}\n  FROM ${3:table_name}\n)\nSELECT * FROM ${1:cte_name};' },
];

// Pre-computed completion items for static data (keywords, functions, snippets)
// These are created once and reused across all completion requests
interface PrecomputedItem {
  label: string;
  labelLower: string; // Pre-computed lowercase for faster matching
  kind: number; // Will be set when monaco is available
  insertText: string;
  insertTextRules?: number;
  detail: string;
}

const KEYWORD_ITEMS: PrecomputedItem[] = SQL_KEYWORDS.map(kw => ({
  label: kw,
  labelLower: kw.toLowerCase(),
  kind: 17, // CompletionItemKind.Keyword
  insertText: kw,
  detail: 'SQL Keyword'
}));

const FUNCTION_ITEMS: PrecomputedItem[] = SQL_FUNCTIONS.map(f => ({
  label: f,
  labelLower: f.toLowerCase(),
  kind: 1, // CompletionItemKind.Function
  insertText: f + '($1)',
  insertTextRules: 4, // InsertAsSnippet
  detail: 'SQL Function'
}));

const SNIPPET_ITEMS: PrecomputedItem[] = SQL_SNIPPETS.map(s => ({
  label: s.label,
  labelLower: s.label.toLowerCase(),
  kind: 27, // CompletionItemKind.Snippet
  insertText: s.value,
  insertTextRules: 4, // InsertAsSnippet
  detail: 'SQL Snippet'
}));

export const QueryEditor = forwardRef<QueryEditorRef, QueryEditorProps>(({
  value,
  onChange,
  onContentChange,
  onExplain,
  language = 'sql',
  tables = [],
  databaseType,
  schemaContext
}, ref) => {
  const monaco = useMonaco();
  const editorRef = useRef<any>(null);
  const [hasSelection, setHasSelection] = useState(false);

  // Track last synced value to detect external changes
  const lastSyncedValueRef = useRef<string>(value);
  const isInternalChangeRef = useRef<boolean>(false);

  // AI States
  const [showAi, setShowAi] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

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

  const parsedSchema = useMemo(() => {
    if (!schemaContext) return [];
    try {
      return JSON.parse(schemaContext);
    } catch (e) {
      console.error('Failed to parse schema context for editor:', e);
      return [];
    }
  }, [schemaContext]);

  // Pre-compute schema-based completion items for faster lookups
  const schemaCompletionCache = useMemo(() => {
    interface TableItem {
      label: string;
      labelLower: string;
      rowCount: number;
      columnNames: string;
    }
    interface ColumnItem {
      label: string;
      labelLower: string;
      type: string;
      isPrimary: boolean;
      tableName: string;
    }

    const tableItems: TableItem[] = [];
    const columnMap = new Map<string, ColumnItem[]>(); // tableName -> columns
    const allColumns = new Map<string, ColumnItem>(); // columnName -> first occurrence

    parsedSchema.forEach((table: any) => {
      const tableLower = table.name.toLowerCase();
      tableItems.push({
        label: table.name,
        labelLower: tableLower,
        rowCount: table.rowCount || 0,
        columnNames: table.columns?.map((c: any) => c.name).join(', ') || ''
      });

      const tableColumns: ColumnItem[] = [];
      table.columns?.forEach((col: any) => {
        const colItem: ColumnItem = {
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
    if (language !== 'sql' || !editorRef.current) return;
    const currentValue = editorRef.current.getValue();
    if (!currentValue) return;

    try {
      const formatted = format(currentValue, {
        language: 'postgresql',
        keywordCase: 'upper',
        dataTypeCase: 'upper',
        indentStyle: 'tabularLeft',
        logicalOperatorNewline: 'before',
        expressionWidth: 100,
        tabWidth: 2,
        linesBetweenQueries: 2,
      });
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
    return editorRef.current.getModel().getValueInRange(selection);
  };

  const getEffectiveQuery = () => {
    const editorValue = editorRef.current?.getValue() || '';
    if (!editorRef.current) return { query: editorValue, range: null };

    const model = editorRef.current.getModel();

    // 1. Check for explicit selection
    const selection = editorRef.current.getSelection();
    const selectedText = model.getValueInRange(selection);
    
    if (selectedText && selectedText.trim().length > 0) {
      return { query: selectedText, range: selection };
    }

    // 2. If no selection, try to find the current statement (between semicolons)
    if (language === 'sql') {
      const position = editorRef.current.getPosition();
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
        const range = new monaco!.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
        return { query: statement, range };
      }
    }

    return { query: editorValue, range: null };
  };

  // Track active highlight timeout to prevent race conditions
  const highlightTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const activeDecorationsRef = useRef<string[]>([]);

  const flashHighlight = (range: any) => {
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
    format: handleFormat
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
  
  const handleAiSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!aiPrompt.trim() || isAiLoading) return;

    setIsAiLoading(true);
    setAiError(null);
    try {
      let filteredSchemaContext = '';
      if (schemaContext) {
        try {
          const topTables = [...parsedSchema]
            .sort((a, b) => (b.rowCount || 0) - (a.rowCount || 0))
            .slice(0, 100);
          
          filteredSchemaContext = topTables.map(table => {
            const cols = table.columns.slice(0, 10).map((c: any) => `${c.name} (${c.type}${c.isPrimary ? ', PK' : ''})`).join(', ');
            return `Table: ${table.name} (${table.rowCount || 0} rows)\nColumns: ${cols}${table.columns.length > 10 ? '...' : ''}`;
          }).join('\n\n');
        } catch (err) {
          filteredSchemaContext = schemaContext.substring(0, 2000);
        }
      }

      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          prompt: aiPrompt, 
          databaseType, 
          schemaContext: filteredSchemaContext 
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'AI request failed');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No reader available');

      const currentVal = editorRef.current?.getValue() || '';
      const shouldReplace = !currentVal || currentVal.startsWith('--');

      let fullAiResponse = '';
      if (!shouldReplace) {
        fullAiResponse = currentVal + '\n\n';
      }

      // Buffered update using requestAnimationFrame to avoid excessive re-renders
      let rafId: number | null = null;
      const updateEditor = () => {
        if (editorRef.current) {
          editorRef.current.setValue(fullAiResponse);
        }
        rafId = null;
      };

      while (true) {
        const { done, value: chunkValue } = await reader.read();
        if (done) break;
        const chunk = new TextDecoder().decode(chunkValue);
        fullAiResponse += chunk;

        // Schedule update on next animation frame if not already scheduled
        if (!rafId) {
          rafId = requestAnimationFrame(updateEditor);
        }
      }

      // Ensure final content is set and cancel any pending RAF
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      if (editorRef.current) {
        editorRef.current.setValue(fullAiResponse);
        lastSyncedValueRef.current = fullAiResponse;
        onChange?.(fullAiResponse);
      }

      setAiPrompt('');
      setShowAi(false);
    } catch (error: any) {
      console.error('AI Error:', error);
      setAiError(error.message || 'An unexpected error occurred while communicating with the AI.');
    } finally {
      setIsAiLoading(false);
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

  const handleBeforeMount = (monaco: any) => {
    // Suppress Monaco's "Canceled" errors in console (with cleanup tracking)
    if (!originalConsoleErrorRef.current) {
      originalConsoleErrorRef.current = console.error;
      const originalConsoleError = console.error;
      console.error = (...args: any[]) => {
        const message = args[0]?.toString?.() || '';
        if (message.includes('Canceled') || message.includes('ERR Canceled')) {
          return; // Suppress Monaco cancellation errors
        }
        originalConsoleError.apply(console, args);
      };
    }

    monaco.editor.defineTheme('db-dark', {
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

  useEffect(() => {
    if (monaco && language === 'sql') {
      const completionProvider = monaco.languages.registerCompletionItemProvider('sql', {
        triggerCharacters: ['.', ' '],
        provideCompletionItems: (model: any, position: any) => {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };

          const line = model.getLineContent(position.lineNumber);
          const lastChar = line[position.column - 2];
          const prefix = word.word.toLowerCase();

          const suggestions: any[] = [];

          // Dot-triggered: Show columns for specific table
          if (lastChar === '.') {
            const matches = line.substring(0, position.column - 1).match(/(\w+)\.$/);
            if (matches) {
              const tableName = matches[1].toLowerCase();
              const columns = schemaCompletionCache.columnMap.get(tableName);
              if (columns) {
                // Only create suggestion objects for matching columns
                columns.forEach(col => {
                  suggestions.push({
                    label: col.label,
                    kind: monaco.languages.CompletionItemKind.Field,
                    insertText: col.label,
                    range,
                    detail: `${col.type}${col.isPrimary ? ' (PK)' : ''}`,
                    documentation: `Column of ${col.tableName}`
                  });
                });
              }
            }
            return { suggestions };
          }

          // General completion with lazy filtering
          // Only add items that match the current prefix (or all if prefix is empty/very short)
          const shouldFilter = prefix.length >= 2;

          // Keywords - filter by prefix
          KEYWORD_ITEMS.forEach(item => {
            if (!shouldFilter || item.labelLower.startsWith(prefix)) {
              suggestions.push({
                label: item.label,
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: item.insertText,
                range,
                detail: item.detail
              });
            }
          });

          // Functions - filter by prefix
          FUNCTION_ITEMS.forEach(item => {
            if (!shouldFilter || item.labelLower.startsWith(prefix)) {
              suggestions.push({
                label: item.label,
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: item.insertText,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                range,
                detail: item.detail
              });
            }
          });

          // Tables - filter by prefix
          schemaCompletionCache.tableItems.forEach(table => {
            if (!shouldFilter || table.labelLower.startsWith(prefix)) {
              suggestions.push({
                label: table.label,
                kind: monaco.languages.CompletionItemKind.Class,
                insertText: table.label,
                range,
                detail: `Table (${table.rowCount} rows)`,
                documentation: table.columnNames
              });
            }
          });

          // All unique columns - filter by prefix
          schemaCompletionCache.allColumns.forEach((col, colName) => {
            if (!shouldFilter || col.labelLower.startsWith(prefix)) {
              suggestions.push({
                label: colName,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: colName,
                range,
                detail: `Column (${col.type})`
              });
            }
          });

          // Snippets - filter by prefix
          SNIPPET_ITEMS.forEach(item => {
            if (!shouldFilter || item.labelLower.startsWith(prefix)) {
              suggestions.push({
                label: item.label,
                kind: monaco.languages.CompletionItemKind.Snippet,
                insertText: item.insertText,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                range,
                detail: item.detail
              });
            }
          });

          return { suggestions };
        },
      });

      return () => completionProvider.dispose();
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
          title="Format SQL (Shift+Alt+F)"
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
            {language === 'sql' && onExplain && (
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
              className="absolute top-12 left-1/2 -translate-x-1/2 w-full max-w-2xl z-50 px-4"
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
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] text-zinc-500 font-medium">Context: {tables.length} tables active</span>
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
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
            lineNumbers: 'on',
            roundedSelection: true,
            scrollBeyondLastLine: false,
            readOnly: false,
            automaticLayout: true,
            padding: { top: 12 },
            cursorSmoothCaretAnimation: 'on',
            cursorBlinking: 'smooth',
            smoothScrolling: true,
            contextmenu: true,
            renderLineHighlight: 'all',
            bracketPairColorization: { enabled: true },
            guides: { indentation: true },
            scrollbar: {
              vertical: 'visible',
              horizontal: 'visible',
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
          }}
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
