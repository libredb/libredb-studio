"use client";

import { useState, useCallback } from "react";
import type { DatabaseConnection, QueryTab } from "@/lib/types";
import type { CellChange } from "@/components/ResultsGrid";
import { useToast } from "@/hooks/use-toast";
import { isBareIdentifier, quoteIdentifier } from "@/lib/sql/identifier";
import { positionalPlaceholder, quoteLiteral } from "@/lib/sql/values";

interface UseInlineEditingParams {
  activeConnection: DatabaseConnection | null;
  currentTab: QueryTab;
  /**
   * `useQueryExecution`'s `executeQuery`. `handleApplyChanges` awaits it between
   * rows and passes its execution options, so the signature carries both.
   */
  executeQuery: (
    sql: string,
    tabId?: string,
    isExplain?: boolean,
    options?: { skipSafety?: boolean; params?: unknown[] },
  ) => void | Promise<unknown>;
}

export function useInlineEditing({ activeConnection, currentTab, executeQuery }: UseInlineEditingParams) {
  const [editingEnabled, setEditingEnabled] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<CellChange[]>([]);
  const { toast } = useToast();

  const handleCellChange = useCallback((change: CellChange) => {
    setPendingChanges((prev) => {
      // Replace existing change for same cell, or add new
      const existing = prev.findIndex((c) => c.rowIndex === change.rowIndex && c.columnId === change.columnId);
      if (existing >= 0) {
        // If reverting to original value, remove the change
        if (String(change.originalValue ?? "") === change.newValue) {
          return prev.filter((_, i) => i !== existing);
        }
        const updated = [...prev];
        updated[existing] = change;
        return updated;
      }
      // Don't add if no actual change
      if (String(change.originalValue ?? "") === change.newValue) return prev;
      return [...prev, change];
    });
  }, []);

  const handleApplyChanges = useCallback(async () => {
    if (!activeConnection || !currentTab.result || pendingChanges.length === 0) return;

    // Detect primary key column
    const pkColumn = currentTab.result.fields.find((f) => f.toLowerCase() === "id" || f.toLowerCase().endsWith("_id"));

    if (!pkColumn) {
      toast({
        title: "Cannot Apply Changes",
        description: "No primary key column detected (id or *_id). Edit the SQL manually.",
        variant: "destructive",
      });
      return;
    }

    // Group changes by row
    const changesByRow = new Map<number, CellChange[]>();
    for (const change of pendingChanges) {
      const existing = changesByRow.get(change.rowIndex) || [];
      existing.push(change);
      changesByRow.set(change.rowIndex, existing);
    }

    // Detect table name from current tab or query
    const tableName =
      currentTab.name.replace(/^Query[:  ]*/, "") || currentTab.query.match(/FROM\s+(\S+)/i)?.[1] || "table_name";

    // The table name is a GUESS (a tab title, or the first word after FROM), so it
    // is validated rather than quoted: quoting would change its case semantics and
    // break a hand-typed lowercase name on Oracle, while interpolating an arbitrary
    // string would let a tab title carry statement text. A guess that is not a bare
    // identifier is not usable, so say so instead of building SQL from it.
    if (!isBareIdentifier(tableName)) {
      toast({
        title: "Cannot Apply Changes",
        description: `Could not read a table name from this tab ("${tableName}"). Edit the SQL manually.`,
        variant: "destructive",
      });
      return;
    }

    const dialect = activeConnection.type;
    const quote = (identifier: string) => quoteIdentifier(identifier, dialect);

    // Generate UPDATE statements
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    for (const [rowIndex, changes] of changesByRow) {
      const row = currentTab.result.rows[rowIndex];
      const pkValue = row[pkColumn];
      const params: unknown[] = [];
      // A value is arbitrary text — pasted, imported, or read back from the table —
      // so it is bound rather than written into the statement. Interpolating it and
      // doubling the quote is only enough where a backslash is data: MySQL reads
      // `\'` as an escaped quote, so a value could close its own literal and have
      // the rest read as SQL, and applying edits skips the dangerous-query dialog
      // that would otherwise show the user that statement (#290). Where the dialect
      // has no positional bind form, a dialect-aware quoted literal is the fallback.
      const emit = (value: string | number): string => {
        const placeholder = positionalPlaceholder(dialect, params.length + 1);
        if (placeholder !== null) {
          params.push(value);
          return placeholder;
        }
        return typeof value === "number" ? String(value) : quoteLiteral(value, dialect);
      };
      const setClauses = changes.map((c) => {
        const isNull = c.newValue === "" || c.newValue.toUpperCase() === "NULL";
        // Column names come from the result's own field list, so they are exactly
        // what the engine reports and can be quoted: that keeps a name holding a
        // space or a reserved word legal, and keeps one that spells SQL inert.
        // NULL stays a keyword: it is not a value, so it takes no parameter.
        return `${quote(c.columnId)} = ${isNull ? "NULL" : emit(c.newValue)}`;
      });
      // The key keeps the number/text split it always had — a number goes to the
      // driver as a number — but neither form is written into the statement now.
      const pkVal = emit(typeof pkValue === "number" ? pkValue : String(pkValue));
      // No trailing semicolon: it only ever served to join the statements, and each
      // one now goes to /api/db/query verbatim rather than through
      // `splitStatements`, which used to strip it. oracledb rejects a plain
      // statement that carries one (ORA-00933).
      statements.push({
        sql: `UPDATE ${tableName} SET ${setClauses.join(", ")} WHERE ${quote(pkColumn)} = ${pkVal}`,
        params,
      });
    }

    // One request per row (issue #269), sequentially and with the safety dialog
    // skipped. Each part matters:
    //  - per row, because a joined payload reaches the engine as ONE string whenever
    //    a transaction or sandbox run is active, and because a failure is only
    //    attributable to a row when the row is its own request. (On the default path
    //    `/api/db/multi-query` did split it, so this is about the other path and
    //    about error attribution, not about every engine rejecting the join.)
    //  - sequentially, because executeQuery mutates the active tab's result and
    //    isExecuting, so concurrent calls would race on that state (the tab ends up
    //    showing the last row's result);
    //  - skipSafety, because isDangerousQuery matches every `UPDATE ... SET` and the
    //    gate returns WITHOUT executing while remembering only the last query it was
    //    handed — so an unflagged loop would apply nothing but the row the user then
    //    confirms, silently dropping the rest. Apply is the confirmation here: these
    //    statements are generated rather than typed, each carries a WHERE on the
    //    detected key, and the pending changes were reviewed in the grid first.
    for (const statement of statements) {
      await executeQuery(statement.sql, undefined, false, {
        skipSafety: true,
        ...(statement.params.length > 0 && { params: statement.params }),
      });
    }
    setPendingChanges([]);
    setEditingEnabled(false);
    toast({
      // "submitted", not "executed": executeQuery reports a failing row itself and
      // returns, so the loop runs on and a partial application is possible now that
      // each row is its own request. Claiming all N ran would be the dishonest half.
      title: "Changes Applied",
      description: `${statements.length} UPDATE statement(s) submitted; check the results panel for each row.`,
    });
  }, [activeConnection, currentTab, pendingChanges, executeQuery, toast]);

  const handleDiscardChanges = useCallback(() => {
    setPendingChanges([]);
  }, []);

  return {
    editingEnabled,
    setEditingEnabled,
    pendingChanges,
    handleCellChange,
    handleApplyChanges,
    handleDiscardChanges,
  };
}
