"use client";

import React, { useState, useEffect } from 'react';
import { storage } from '@/lib/storage';
import { SavedQuery } from '@/lib/types';
import { 
  Bookmark, Search, Trash2, Edit3, 
  Tag, Calendar
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { format } from 'date-fns';

interface SavedQueriesProps {
  onSelectQuery: (query: string) => void;
  connectionType?: string;
  refreshTrigger?: number;
}

export function SavedQueries({ onSelectQuery, connectionType, refreshTrigger }: SavedQueriesProps) {
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    setQueries(storage.getSavedQueries());
  }, [refreshTrigger]);

  const filteredQueries = queries.filter(q => {
    const matchesSearch = q.name.toLowerCase().includes(search.toLowerCase()) || 
                         q.query.toLowerCase().includes(search.toLowerCase());
    const matchesType = !connectionType || q.connectionType === connectionType;
    return matchesSearch && matchesType;
  });

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Are you sure you want to delete this saved query?')) {
      storage.deleteSavedQuery(id);
      setQueries(storage.getSavedQueries());
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#0a0a0a]">
      <div className="p-4 border-b border-white/5 flex flex-col gap-4">
        <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-widest flex items-center gap-2">
          <Bookmark className="w-4 h-4" /> Saved Queries
        </h3>
        
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
          <Input 
            placeholder="Search saved queries..." 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 bg-white/5 border-white/10 text-xs focus:ring-blue-500/20"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {filteredQueries.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center opacity-20 p-8 text-center">
            <Bookmark className="w-12 h-12 mb-4" />
            <p className="text-sm italic">No saved queries found</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-px bg-white/5">
            {filteredQueries.map((q) => (
              <div 
                key={q.id}
                className="bg-[#0a0a0a] p-4 hover:bg-white/[0.02] transition-colors group cursor-pointer"
                onClick={() => onSelectQuery(q.query)}
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h4 className="text-xs font-bold text-blue-400 mb-1 group-hover:text-blue-300 transition-colors">
                      {q.name}
                    </h4>
                    {q.description && (
                      <p className="text-[10px] text-zinc-500 line-clamp-1">{q.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-zinc-500 hover:text-white">
                      <Edit3 className="w-3 h-3" />
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-6 w-6 text-zinc-500 hover:text-red-400"
                      onClick={(e) => handleDelete(q.id, e)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>

                <div className="bg-[#050505] border border-white/5 rounded-md p-2 mb-3">
                  <pre className="text-[10px] font-mono text-zinc-400 line-clamp-3">
                    {q.query}
                  </pre>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-[9px] font-bold text-blue-400 uppercase tracking-tighter">
                      {q.connectionType}
                    </span>
                    {q.tags?.map(tag => (
                      <span key={tag} className="flex items-center gap-1 text-[9px] text-zinc-500">
                        <Tag className="w-2.5 h-2.5" /> {tag}
                      </span>
                    ))}
                  </div>
                  <span className="text-[9px] text-zinc-600 flex items-center gap-1 font-mono">
                    <Calendar className="w-2.5 h-2.5" /> {format(q.updatedAt, 'MMM d, yyyy')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
