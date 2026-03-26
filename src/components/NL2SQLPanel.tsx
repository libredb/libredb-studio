"use client";

import { useState, useRef, useEffect, type FormEvent } from 'react';
import { Send, Loader2, Sparkles, X, Play, MessageSquare, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  query?: string; // Extracted SQL/JSON query from assistant response
}

interface NL2SQLPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onExecuteQuery: (query: string) => void;
  onLoadQuery: (query: string) => void;
  schemaContext: string;
  databaseType?: string;
  queryLanguage?: string;
  /** Optional API adapter: when provided, bypasses the built-in /api/ai/nl2sql fetch. */
  onNL2SQL?: (params: { prompt: string; schemaContext: string; conversationHistory?: { role: string; content: string }[] }) => Promise<string>;
}

function extractCodeBlock(text: string): string | null {
  // Match ```sql ... ``` or ```json ... ``` or plain ``` ... ```
  const match = text.match(/```(?:sql|json|mongodb)?\s*\n?([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

export function NL2SQLPanel({
  isOpen,
  onClose,
  onExecuteQuery,
  onLoadQuery,
  schemaContext,
  databaseType,
  queryLanguage,
  onNL2SQL,
}: NL2SQLPanelProps) {
  const [question, setQuestion] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const handleSubmit = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!question.trim() || isLoading) return;

    const userMsg: ConversationMessage = { role: 'user', content: question.trim() };
    setMessages(prev => [...prev, userMsg]);
    setQuestion('');
    setIsLoading(true);
    setError(null);

    try {
      // Build filtered schema context (top 100 tables)
      let filteredSchema = '';
      if (schemaContext) {
        try {
          const tables = JSON.parse(schemaContext);
          const sorted = [...tables]
            .sort((a: { rowCount?: number }, b: { rowCount?: number }) => (b.rowCount || 0) - (a.rowCount || 0))
            .slice(0, 100);
          filteredSchema = sorted.map((t: { name: string; rowCount?: number; columns?: { name: string; type: string; isPrimary?: boolean }[] }) => {
            const cols = t.columns?.slice(0, 10).map(c => `${c.name} (${c.type}${c.isPrimary ? ', PK' : ''})`).join(', ') || '';
            return `Table: ${t.name} (${t.rowCount || 0} rows)\nColumns: ${cols}`;
          }).join('\n\n');
        } catch {
          filteredSchema = schemaContext.substring(0, 3000);
        }
      }

      // Build conversation history (exclude current question)
      const history = messages.map(m => ({ role: m.role, content: m.content }));

      let fullResponse = '';

      if (onNL2SQL) {
        // Platform adapter: use callback instead of fetch
        fullResponse = await onNL2SQL({
          prompt: question.trim(),
          schemaContext: filteredSchema,
          conversationHistory: history,
        });
      } else {
        // Default: existing fetch behavior
        const response = await fetch('/api/ai/nl2sql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: question.trim(),
            schemaContext: filteredSchema,
            databaseType,
            queryLanguage,
            conversationHistory: history,
          }),
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error || 'Request failed');
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No reader');

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullResponse += new TextDecoder().decode(value);
        }
      }

      const extractedQuery = extractCodeBlock(fullResponse);
      const assistantMsg: ConversationMessage = {
        role: 'assistant',
        content: fullResponse,
        query: extractedQuery || undefined,
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const clearConversation = () => {
    setMessages([]);
    setError(null);
  };

  if (!isOpen) return null;

  return (
    <div className="h-full flex flex-col bg-[#080808]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-[#0a0a0a]">
        <div className="flex items-center gap-2">
          <div className="p-1 rounded bg-violet-500/10">
            <MessageSquare className="w-3.5 h-3.5 text-violet-400" />
          </div>
          <span className="text-[10px] font-bold text-violet-400 uppercase tracking-widest">
            Natural Language Query
          </span>
          {messages.length > 0 && (
            <span className="text-[9px] text-zinc-500 font-mono">
              {messages.filter(m => m.role === 'user').length} questions
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              onClick={clearConversation}
              className="p-1.5 rounded hover:bg-white/5 text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Clear conversation"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-white/5 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full opacity-40">
            <Sparkles className="w-8 h-8 mb-3" />
            <p className="text-sm font-medium">Ask a question in plain English</p>
            <p className="text-[10px] text-zinc-500 mt-1">
              e.g. &quot;Show me the top 10 employees by salary&quot;
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={cn("flex gap-2", msg.role === 'user' ? "justify-end" : "justify-start")}>
            <div className={cn(
              "max-w-[85%] rounded-lg px-3 py-2 text-xs",
              msg.role === 'user'
                ? "bg-violet-600/20 border border-violet-500/20 text-zinc-200"
                : "bg-[#111] border border-white/5 text-zinc-300"
            )}>
              {msg.role === 'user' ? (
                <p>{msg.content}</p>
              ) : (
                <div>
                  {/* Show extracted query with action buttons */}
                  {msg.query && (
                    <div className="mb-2">
                      <pre className="bg-[#050505] rounded p-2 text-[11px] font-mono text-blue-300 overflow-x-auto whitespace-pre-wrap border border-white/5">
                        {msg.query}
                      </pre>
                      <div className="flex gap-1.5 mt-1.5">
                        <button
                          onClick={() => onExecuteQuery(msg.query!)}
                          className="flex items-center gap-1 px-2 py-1 rounded bg-blue-600/20 border border-blue-500/20 text-blue-400 text-[10px] font-bold hover:bg-blue-600/30 transition-colors"
                        >
                          <Play className="w-3 h-3 fill-current" /> Run
                        </button>
                        <button
                          onClick={() => onLoadQuery(msg.query!)}
                          className="flex items-center gap-1 px-2 py-1 rounded bg-white/5 border border-white/5 text-zinc-400 text-[10px] font-bold hover:bg-white/10 transition-colors"
                        >
                          Load to Editor
                        </button>
                      </div>
                    </div>
                  )}
                  {/* Show explanation text (non-code parts) */}
                  {msg.content.replace(/```[\s\S]*?```/g, '').trim() && (
                    <p className="text-zinc-400 text-[11px] leading-relaxed whitespace-pre-wrap">
                      {msg.content.replace(/```[\s\S]*?```/g, '').trim()}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex gap-2 justify-start">
            <div className="bg-[#111] border border-white/5 rounded-lg px-3 py-2 flex items-center gap-2 text-zinc-500 text-xs">
              <Loader2 className="w-3 h-3 animate-spin" />
              Generating query...
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="border-t border-white/5 p-3 bg-[#0a0a0a]">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask in plain English... (e.g. 'How many employees were hired in 1986?')"
            className="flex-1 bg-[#111] border border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-violet-500/30"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !question.trim()}
            className="bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-3 py-2 rounded-lg text-white text-xs font-bold transition-colors flex items-center gap-1.5"
          >
            {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
          </button>
        </div>
      </form>
    </div>
  );
}
