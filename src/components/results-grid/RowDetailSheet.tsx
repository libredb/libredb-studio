"use client";

import React, { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import {
  Copy,
  FileJson,
  Check,
  Eye,
  Lock,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  type MaskingPattern,
  maskValueByPattern,
} from '@/lib/data-masking';
import { formatCellValue } from './utils';

export interface RowDetailSheetProps {
  row: Record<string, unknown>;
  fields: string[];
  isOpen: boolean;
  onClose: () => void;
  rowIndex: number;
  maskingActive?: boolean;
  sensitiveColumns?: Map<string, MaskingPattern>;
  allowReveal?: boolean;
}

export function RowDetailSheet({
  row,
  fields,
  isOpen,
  onClose,
  rowIndex,
  maskingActive,
  sensitiveColumns,
  allowReveal,
}: RowDetailSheetProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());

  // Auto-hide revealed fields after 10s
  const revealField = useCallback((field: string) => {
    setRevealedFields(prev => new Set(prev).add(field));
    setTimeout(() => {
      setRevealedFields(prev => {
        const next = new Set(prev);
        next.delete(field);
        return next;
      });
    }, 10000);
  }, []);

  const getDisplayValue = useCallback((field: string, value: unknown): { text: string; isMasked: boolean } => {
    const pattern = sensitiveColumns?.get(field);
    if (maskingActive && pattern && value != null && value !== undefined && !revealedFields.has(field)) {
      return { text: maskValueByPattern(value, pattern), isMasked: true };
    }
    return { text: typeof value === 'object' ? JSON.stringify(value) : String(value ?? 'NULL'), isMasked: false };
  }, [maskingActive, sensitiveColumns, revealedFields]);

  const copyValue = (field: string, value: unknown) => {
    const { text } = getDisplayValue(field, value);
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  const copyAllAsJson = () => {
    // If masking is active, copy masked version
    if (maskingActive && sensitiveColumns && sensitiveColumns.size > 0) {
      const maskedRow: Record<string, unknown> = {};
      for (const field of fields) {
        const { text } = getDisplayValue(field, row[field]);
        maskedRow[field] = text;
      }
      navigator.clipboard.writeText(JSON.stringify(maskedRow, null, 2));
    } else {
      navigator.clipboard.writeText(JSON.stringify(row, null, 2));
    }
    setCopiedField('__all__');
    setTimeout(() => setCopiedField(null), 1500);
  };

  return (
    <Sheet open={isOpen} onOpenChange={onClose}>
      <SheetContent side="bottom" className="h-[85vh] bg-[#0a0a0a] border-t border-white/10 rounded-t-3xl">
        <SheetHeader className="pb-4 border-b border-white/5">
          <div className="flex items-center justify-between">
            <SheetTitle className="text-zinc-100 flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <FileJson className="w-4 h-4 text-blue-400" />
              </div>
              Row #{rowIndex + 1}
            </SheetTitle>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs border-white/10 hover:bg-white/5"
              onClick={copyAllAsJson}
            >
              {copiedField === '__all__' ? (
                <><Check className="w-3 h-3 mr-1 text-emerald-400" /> Copied</>
              ) : (
                <><Copy className="w-3 h-3 mr-1" /> Copy JSON</>
              )}
            </Button>
          </div>
        </SheetHeader>

        <ScrollArea className="h-[calc(85vh-100px)] mt-4">
          <div className="space-y-1 pr-4">
            {fields.map(field => {
              const { text, isMasked } = getDisplayValue(field, row[field]);
              const isLongValue = text.length > 50;

              return (
                <div
                  key={field}
                  className="group p-3 rounded-lg hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-zinc-500 mb-1 font-mono flex items-center gap-1">
                        {field}
                        {isMasked && <Lock className="w-2.5 h-2.5 text-purple-400" />}
                      </p>
                      <p className={cn(
                        "font-mono text-xs break-all",
                        isMasked ? "text-zinc-500 italic" : formatCellValue(row[field]).className,
                        isLongValue && "text-xs"
                      )}>
                        {text}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isMasked && allowReveal && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => revealField(field)}
                          title="Reveal value (10s)"
                        >
                          <Eye className="w-3.5 h-3.5 text-purple-400" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => copyValue(field, row[field])}
                      >
                        {copiedField === field ? (
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5 text-zinc-500" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
