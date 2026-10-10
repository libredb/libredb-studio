"use client";

import { Database } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface CatalogSelectProps {
  /** The databases to choose from; the select renders nothing when there are none (#1530). */
  catalogs: readonly string[];
  value: string | undefined;
  onChange: (catalog: string) => void;
  disabled?: boolean;
  /** Why the select is disabled, shown on hover. */
  disabledReason?: string;
  className?: string;
}

/**
 * The database a server-level connection reads (#1530): one select, shared by the query toolbar,
 * the sidebar and the monitoring pages, so the same choice looks the same everywhere.
 */
export function CatalogSelect({ catalogs, value, onChange, disabled, disabledReason, className }: CatalogSelectProps) {
  if (catalogs.length === 0) return null;
  return (
    <Select value={value ?? ""} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        aria-label="Database"
        title={disabled ? disabledReason : "Database"}
        className={cn("h-7 text-xs gap-1.5", className)}
      >
        <Database strokeWidth={1.5} className="h-3 w-3 flex-shrink-0" />
        <SelectValue placeholder="Database" />
      </SelectTrigger>
      <SelectContent>
        {catalogs.map((catalog) => (
          <SelectItem key={catalog} value={catalog} className="text-xs">
            {catalog}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
