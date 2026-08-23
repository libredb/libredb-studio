import React from "react";
import { TableSchema } from "@/lib/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import {
  Search,
  Table as TableIcon,
  Play,
  ChevronRight,
  Funnel,
  EllipsisVertical,
  Copy,
  Trash2,
  Code,
  ChartColumn,
  WandSparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { toast } from "sonner";
import { writeToClipboard } from "@/components/copy-button";
import { ColumnList } from "./ColumnList";

interface TableItemProps {
  table: TableSchema;
  isExpanded: boolean;
  onToggle: () => void;
  // `labels` is itself optional on ProviderMetadata, so the indexed access already
  // carries `undefined`; NonNullable keeps the `?` from restating it (#427).
  labels?: NonNullable<ProviderMetadata["labels"]>;
  capabilities?: ProviderMetadata["capabilities"];
  isAdmin: boolean;
  onTableClick?: (tableName: string) => void;
  onGenerateSelect?: (tableName: string) => void;
  onProfileTable?: (tableName: string) => void;
  onGenerateCode?: (tableName: string) => void;
  onGenerateTestData?: (tableName: string) => void;
  onOpenMaintenance?: (tab?: "global" | "tables" | "sessions", table?: string) => void;
}

type TableItemCallbacks = Pick<
  TableItemProps,
  "onTableClick" | "onGenerateSelect" | "onProfileTable" | "onGenerateCode" | "onGenerateTestData" | "onOpenMaintenance"
>;

/**
 * What one rendering of the menu needs. The two call sites differ only in which
 * primitives they pass (`DropdownMenu*` vs `ContextMenu*`), so everything else
 * travels as one object rather than as a positional list.
 */
interface MenuItemsContext {
  table: TableSchema;
  labels: TableItemProps["labels"];
  capabilities: TableItemProps["capabilities"];
  isAdmin: boolean;
  callbacks: TableItemCallbacks;
  copyToClipboard: (text: string, label: string) => void;
  Item: React.ComponentType<{ onClick?: () => void; children: React.ReactNode }>;
  Separator: React.ComponentType;
}

function renderMenuItems({
  table,
  labels,
  capabilities,
  isAdmin,
  callbacks,
  copyToClipboard,
  Item,
  Separator,
}: MenuItemsContext): React.ReactNode {
  // Rows that are derived groupings are not addressable objects: a Redis `user:*`
  // row is this server's summary of a key prefix, so profiling it and inserting
  // rows into it have no target and the provider answers 400 (#427). Gate on the
  // declared capability, never on connection.type. Absent capabilities read as
  // "ordinary objects", matching the flag's own docblock.
  const rowsAreAddressable = capabilities?.tablesAreDerivedGroupings !== true;

  return (
    <>
      <Item onClick={() => callbacks.onTableClick?.(table.name)}>
        <Play strokeWidth={1.5} className="w-3.5 h-3.5 mr-2 text-green-500" />
        {labels?.selectAction || "Select Top 50"}
      </Item>
      <Item onClick={() => callbacks.onGenerateSelect?.(table.name)}>
        <Funnel strokeWidth={1.5} className="w-3.5 h-3.5 mr-2 text-blue-500" />
        {labels?.generateAction || "Generate Query"}
      </Item>
      <Item onClick={() => copyToClipboard(table.name, `${labels?.entityName || "Table"} name`)}>
        <Copy strokeWidth={1.5} className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
        {"Copy Name"}
      </Item>
      {/* Generate Code stays visible everywhere — it names the row, it does not
          address it — so this separator is unconditional (#427). */}
      <Separator />
      {rowsAreAddressable && (
        <Item onClick={() => callbacks.onProfileTable?.(table.name)}>
          <ChartColumn strokeWidth={1.5} className="w-3.5 h-3.5 mr-2 text-cyan-500" />
          {"Profile Table"}
        </Item>
      )}
      <Item onClick={() => callbacks.onGenerateCode?.(table.name)}>
        <Code strokeWidth={1.5} className="w-3.5 h-3.5 mr-2 text-purple-500" />
        {"Generate Code"}
      </Item>
      {rowsAreAddressable && (
        <Item onClick={() => callbacks.onGenerateTestData?.(table.name)}>
          <WandSparkles strokeWidth={1.5} className="w-3.5 h-3.5 mr-2 text-amber-500" />
          {"Generate Test Data"}
        </Item>
      )}
      {/* A PER-ROW maintenance action needs an addressable row AND an engine with
          maintenance to run: both items call `onOpenMaintenance("tables", table.name)`,
          and for a derived grouping there is no such object to name — which is exactly
          the dead end #427 reported for Redis "Key Info".

          The second half of the condition is the same dead end reached the other way,
          measured in the browser on 2026-08-19 against Elasticsearch 9.1.4: an index IS
          addressable, so both items rendered on an engine that declares
          `supportsMaintenance: false`, and the page they open gates its Global
          Operations card on that same capability — so clicking "Merge Segments" landed
          on a page with no maintenance controls, no error and no explanation.

          Global maintenance is unaffected wherever an engine has any: it lives on the
          admin Operations page and still runs there. */}
      {isAdmin && rowsAreAddressable && capabilities?.supportsMaintenance !== false && (
        <>
          <Separator />
          <Item onClick={() => callbacks.onOpenMaintenance?.("tables", table.name)}>
            <Search strokeWidth={1.5} className="w-3.5 h-3.5 mr-2 text-amber-500" />
            {labels?.analyzeAction || "Analyze Table"}
          </Item>
          <Item onClick={() => callbacks.onOpenMaintenance?.("tables", table.name)}>
            <Trash2 strokeWidth={1.5} className="w-3.5 h-3.5 mr-2 text-blue-400" />
            {labels?.vacuumAction || "Vacuum Table"}
          </Item>
        </>
      )}
    </>
  );
}

export const TableItem = React.memo(function TableItem({
  table,
  isExpanded,
  onToggle,
  labels,
  capabilities,
  isAdmin,
  onTableClick,
  onGenerateSelect,
  onProfileTable,
  onGenerateCode,
  onGenerateTestData,
  onOpenMaintenance,
}: TableItemProps) {
  const copyToClipboard = (text: string, label: string) => {
    // The toast waits for the write to report an outcome (B43). It used to fire in the
    // same statement that started it, which announced a copy that never happened over
    // plain HTTP off loopback — `navigator.clipboard` is undefined there, and several
    // distribution channels ship exactly that way.
    void writeToClipboard(text).then((copied) => {
      if (copied) toast.success(`${label} copied to clipboard`);
      else toast.error(`Could not copy ${label} — select the text and copy it yourself`);
    });
  };

  const callbacks = {
    onTableClick,
    onGenerateSelect,
    onProfileTable,
    onGenerateCode,
    onGenerateTestData,
    onOpenMaintenance,
  };

  return (
    <div className="group flex flex-col">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "flex items-center gap-1.5 px-2 rounded-md transition-all",
              isExpanded ? "bg-accent/50" : "hover:bg-accent/30",
            )}
          >
            <button
              type="button"
              aria-expanded={isExpanded}
              className="flex items-center gap-1.5 flex-1 min-w-0 py-1.5 cursor-pointer text-left"
              onClick={onToggle}
            >
              <motion.div animate={{ rotate: isExpanded ? 90 : 0 }} transition={{ duration: 0.2 }} className="shrink-0">
                <ChevronRight strokeWidth={1.5} className="w-3.5 h-3.5 text-muted-foreground" />
              </motion.div>

              <TableIcon
                className={cn(
                  "w-3.5 h-3.5 shrink-0 transition-colors",
                  isExpanded ? "text-blue-400" : "text-muted-foreground group-hover:text-foreground",
                )}
              />

              <span
                className={cn(
                  "truncate min-w-0 flex-1 text-xs font-medium transition-colors",
                  isExpanded ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
                )}
              >
                {table.name}
              </span>
            </button>

            <div className="shrink-0 relative w-8 h-6 flex items-center justify-center">
              {table.rowCount !== undefined && (
                <span className="absolute inset-0 flex items-center justify-center text-[0.625rem] font-mono text-muted-foreground/70 whitespace-nowrap opacity-100 group-hover:opacity-0 transition-opacity pointer-events-none">
                  {table.rowCount >= 1000 ? `${(table.rowCount / 1000).toFixed(1)}k` : table.rowCount}
                </span>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="absolute inset-0 w-full h-full opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-within:opacity-100 transition-opacity hover:bg-accent flex items-center justify-center"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <EllipsisVertical
                      strokeWidth={1.5}
                      className="w-3.5 h-3.5 text-muted-foreground group-hover:text-foreground"
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  {renderMenuItems({
                    table,
                    labels,
                    capabilities,
                    isAdmin,
                    callbacks,
                    copyToClipboard,
                    Item: DropdownMenuItem,
                    Separator: DropdownMenuSeparator,
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          {renderMenuItems({
            table,
            labels,
            capabilities,
            isAdmin,
            callbacks,
            copyToClipboard,
            Item: ContextMenuItem,
            Separator: ContextMenuSeparator,
          })}
        </ContextMenuContent>
      </ContextMenu>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <ColumnList columns={table.columns} indexes={table.indexes} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
