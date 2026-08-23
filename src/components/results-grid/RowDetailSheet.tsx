"use client";

import React, { useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Copy, FileBraces, Check, Eye, Lock, TriangleAlert } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { type MaskingPattern, maskValueByPattern } from "@/lib/data-masking";
import { writeToClipboard } from "@/components/copy-button";
import { classifyValue } from "./renderers/classify";
import { getRenderer } from "./renderers/registry";

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
  /**
   * Which copy just ran, and whether it actually happened (B43). A bare field name
   * could only say "copied", and the write it stood for might never have run: over
   * plain HTTP off loopback `navigator.clipboard` is undefined, and this product ships
   * that way on several distribution channels.
   */
  const [copyOutcome, setCopyOutcome] = useState<{ key: string; copied: boolean } | null>(null);
  const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());

  // Auto-hide revealed fields after 10s
  const revealField = useCallback((field: string) => {
    setRevealedFields((prev) => new Set(prev).add(field));
    setTimeout(() => {
      setRevealedFields((prev) => {
        const next = new Set(prev);
        next.delete(field);
        return next;
      });
    }, 10000);
  }, []);

  const getDisplayValue = useCallback(
    (
      field: string,
      value: unknown,
    ): { text: string; className: string; preserveWhitespace: boolean; isMasked: boolean } => {
      const pattern = sensitiveColumns?.get(field);
      // Masking short-circuits before renderer selection — renderers never see
      // sensitive values.
      if (maskingActive && pattern && value != null && value !== undefined && !revealedFields.has(field)) {
        return {
          text: maskValueByPattern(value, pattern),
          className: "text-fg-muted italic",
          preserveWhitespace: false,
          isMasked: true,
        };
      }
      const detail = getRenderer(classifyValue(value)).renderDetail(value);
      return { ...detail, isMasked: false };
    },
    [maskingActive, sensitiveColumns, revealedFields],
  );

  /** The outcome is reported only once the write has one, never alongside starting it. */
  const copyAndReport = (key: string, text: string) => {
    void writeToClipboard(text).then((copied) => {
      setCopyOutcome({ key, copied });
      setTimeout(() => setCopyOutcome(null), 1500);
    });
  };

  const copyValue = (field: string, value: unknown) => {
    const { text } = getDisplayValue(field, value);
    copyAndReport(field, text);
  };

  const copyAllAsJson = () => {
    // If masking is active, copy masked version
    if (maskingActive && sensitiveColumns && sensitiveColumns.size > 0) {
      const maskedRow: Record<string, unknown> = {};
      for (const field of fields) {
        const { text } = getDisplayValue(field, row[field]);
        maskedRow[field] = text;
      }
      copyAndReport("__all__", JSON.stringify(maskedRow, null, 2));
    } else {
      copyAndReport("__all__", JSON.stringify(row, null, 2));
    }
  };

  return (
    <Sheet open={isOpen} onOpenChange={onClose}>
      <SheetContent side="bottom" className="h-[85vh] bg-surface border-t border-hairline-strong rounded-t-3xl">
        <SheetHeader className="pb-4 border-b border-hairline">
          <div className="flex items-center justify-between">
            <SheetTitle className="text-fg flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <FileBraces strokeWidth={1.5} className="w-3.5 h-3.5 text-blue-400" />
              </div>
              Row #{rowIndex + 1}
            </SheetTitle>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs border-hairline-strong hover:bg-fill"
              onClick={copyAllAsJson}
            >
              {copyOutcome?.key === "__all__" && copyOutcome.copied && (
                <>
                  <Check strokeWidth={1.5} className="w-3 h-3 mr-1 text-emerald-400" /> Copied
                </>
              )}
              {copyOutcome?.key === "__all__" && !copyOutcome.copied && (
                <>
                  <TriangleAlert strokeWidth={1.5} className="w-3 h-3 mr-1 text-amber-400" /> Copy failed
                </>
              )}
              {copyOutcome?.key !== "__all__" && (
                <>
                  <Copy strokeWidth={1.5} className="w-3 h-3 mr-1" /> Copy JSON
                </>
              )}
            </Button>
          </div>
        </SheetHeader>

        <ScrollArea className="h-[calc(85vh-100px)] mt-4">
          <div className="space-y-1 pr-4">
            {fields.map((field) => {
              const { text, className, preserveWhitespace, isMasked } = getDisplayValue(field, row[field]);
              const isLongValue = text.length > 50;

              return (
                <div key={field} className="group p-3 rounded-lg hover:bg-fill transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-fg-muted mb-1 font-mono flex items-center gap-1">
                        {field}
                        {isMasked && <Lock strokeWidth={1.5} className="w-2.5 h-2.5 text-purple-400" />}
                      </p>
                      <p
                        className={cn(
                          "font-mono text-xs break-all",
                          className,
                          preserveWhitespace && "whitespace-pre-wrap",
                          isLongValue && "text-xs",
                        )}
                      >
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
                        {copyOutcome?.key === field && copyOutcome.copied && (
                          <Check strokeWidth={1.5} className="w-3.5 h-3.5 text-emerald-400" />
                        )}
                        {copyOutcome?.key === field && !copyOutcome.copied && (
                          <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5 text-amber-400" />
                        )}
                        {copyOutcome?.key !== field && <Copy strokeWidth={1.5} className="w-3.5 h-3.5 text-fg-muted" />}
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
