'use client';

import { useState, useCallback } from 'react';

interface ParsedTable {
  name: string;
  rowCount?: number;
  columns?: Array<{
    name: string;
    type: string;
    isPrimary?: boolean;
  }>;
}

interface AiChatDeps {
  /** Parsed schema tables for context */
  parsedSchema: ParsedTable[];
  /** Raw schema context JSON string (fallback) */
  schemaContext?: string;
  /** Database type for the AI prompt */
  databaseType?: string;
  /** Returns the current editor value */
  getEditorValue: () => string;
  /** Sets editor content and syncs value */
  setEditorValue: (value: string) => void;
  /** Notifies the parent of a value change */
  onChange?: (val: string) => void;
  /** Optional API adapter: when provided, bypasses the built-in /api/ai/chat fetch. */
  onAiChat?: (params: { prompt: string; schemaContext: string; history: { role: string; content: string }[] }) => Promise<string>;
}

export interface AiChatState {
  showAi: boolean;
  setShowAi: (show: boolean) => void;
  aiPrompt: string;
  setAiPrompt: (prompt: string) => void;
  isAiLoading: boolean;
  aiError: string | null;
  setAiError: (error: string | null) => void;
  aiConversationHistory: { role: 'user' | 'assistant'; content: string }[];
  setAiConversationHistory: React.Dispatch<React.SetStateAction<{ role: 'user' | 'assistant'; content: string }[]>>;
  handleAiSubmit: (e?: React.FormEvent) => Promise<void>;
}

/**
 * Manages the AI chat panel state and the streaming submit handler.
 *
 * All editor interactions are done through the callback deps to keep
 * this hook independent of the Monaco editor instance.
 */
export function useAiChat(deps: AiChatDeps): AiChatState {
  const { parsedSchema, schemaContext, databaseType, getEditorValue, setEditorValue, onChange, onAiChat } = deps;

  const [showAi, setShowAi] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiConversationHistory, setAiConversationHistory] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);

  const handleAiSubmit = useCallback(async (e?: React.FormEvent) => {
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
            if (!table.columns || table.columns.length === 0) {
              return `Table: ${table.name} (${table.rowCount || 0} rows)\nColumns: (none)`;
            }
            const cols = table.columns.slice(0, 10).map((c) => `${c.name} (${c.type}${c.isPrimary ? ', PK' : ''})`).join(', ');
            return `Table: ${table.name} (${table.rowCount || 0} rows)\nColumns: ${cols}${table.columns.length > 10 ? '...' : ''}`;
          }).join('\n\n');
        } catch {
          filteredSchemaContext = schemaContext.substring(0, 2000);
        }
      }

      const currentVal = getEditorValue();
      const shouldReplace = !currentVal || currentVal.startsWith('--');

      let fullAiResponse = '';
      if (!shouldReplace) {
        fullAiResponse = currentVal + '\n\n';
      }

      if (onAiChat) {
        // Platform adapter: use callback instead of fetch
        const result = await onAiChat({
          prompt: aiPrompt,
          schemaContext: filteredSchemaContext,
          history: aiConversationHistory,
        });
        fullAiResponse += result;
        setEditorValue(fullAiResponse);
        onChange?.(fullAiResponse);
      } else {
        // Default: existing fetch behavior
        const response = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: aiPrompt,
            databaseType,
            schemaContext: filteredSchemaContext,
            conversationHistory: aiConversationHistory.length > 0 ? aiConversationHistory : undefined,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'AI request failed');
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No reader available');

        // Buffered update using requestAnimationFrame to avoid excessive re-renders
        let rafId: number | null = null;
        const updateEditor = () => {
          setEditorValue(fullAiResponse);
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
        setEditorValue(fullAiResponse);
        onChange?.(fullAiResponse);
      }

      // Save conversation history for multi-turn
      setAiConversationHistory(prev => [
        ...prev,
        { role: 'user' as const, content: aiPrompt },
        { role: 'assistant' as const, content: fullAiResponse },
      ]);

      setAiPrompt('');
      setShowAi(false);
    } catch (error) {
      console.error('AI Error:', error);
      const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred while communicating with the AI.';
      setAiError(errorMessage);
    } finally {
      setIsAiLoading(false);
    }
  }, [aiPrompt, isAiLoading, schemaContext, parsedSchema, databaseType, aiConversationHistory, getEditorValue, setEditorValue, onChange, onAiChat]);

  return {
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
  };
}
