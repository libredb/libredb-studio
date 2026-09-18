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
   * rows and passes its execution options, so the signature carries both. The
   * resolved boolean is whether the statement actually applied (#882) — a caller
   * that only fires it and forgets, as this hook used to, is unaffected either way.
   */
  executeQuery: (
    sql: string,
    tabId?: string,
    isExplain?: boolean,
    options?: { skipSafety?: boolean; params?: unknown[] },
  ) => Promise<boolean>;
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

    // Detect the table name from the QUERY that produced these rows, never from the
    // tab title (#881). A tab is free text: it survives when the query is replaced,
    // it is not tied to the query in any way, and a user editing a result has no
    // reason to expect it to select the write target. #924 fixed this only for a
    // tab still carrying its default "Query N" name — a tab RENAMED to another
    // real table's name (the issue's own repro) still won there, silently
    // rewriting `UPDATE <tab name> ...` for a query that read a different table.
    // Reading the query alone, unconditionally, covers both: #924's case, because
    // a default-named tab never disagreed with its query anyway, and #881's.
    const fromMatch = currentTab.query.match(/FROM\s+(\S+)/i)?.[1];

    // A JOIN means the rows can carry columns from more than one table, so which
    // one an edited column belongs to cannot be read off the FROM clause alone —
    // the same "cannot be determined" case the suggested fix in #881 names for
    // computed columns and subqueries. Refusing here is the identifier check
    // below applied one step earlier: say so instead of guessing.
    const hasJoin = /\bJOIN\b/i.test(currentTab.query);

    // The table name is a GUESS (the first word after FROM), so it is validated
    // rather than quoted: quoting would change its case semantics and break a
    // hand-typed lowercase name on Oracle, while interpolating an arbitrary string
    // would let it carry statement text. A guess that is not a bare identifier is
    // not usable, so say so instead of building SQL from it.
    if (fromMatch === undefined || hasJoin || !isBareIdentifier(fromMatch)) {
      toast({
        title: "Cannot Apply Changes",
        description: hasJoin
          ? "This query joins more than one table, so which table an edited column belongs to cannot be determined. Edit the SQL manually."
          : `Could not read a table name from this tab's query${fromMatch ? ` ("${fromMatch}")` : ""}. Edit the SQL manually.`,
        variant: "destructive",
      });
      return;
    }
    const tableName = fromMatch;

    const dialect = activeConnection.type;
    const quote = (identifier: string) => quoteIdentifier(identifier, dialect);

    // Generate UPDATE statements
    const statements: Array<{ sql: string; params: unknown[]; rowIndex: number }> = [];
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
        rowIndex,
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
    // `executeQuery` reports its own success (#882 - it used to be a void call, so
    // nothing here ever branched on whether a row actually applied). Read per row,
    // so a row that failed can be told apart from one that did not.
    const failedRowIndexes = new Set<number>();
    for (const statement of statements) {
      const applied = await executeQuery(statement.sql, undefined, false, {
        skipSafety: true,
        ...(statement.params.length > 0 && { params: statement.params }),
      });
      if (!applied) failedRowIndexes.add(statement.rowIndex);
    }

    const succeededCount = statements.length - failedRowIndexes.size;

    // The UPDATE's own result — no rows, or a rowcount, depending on the driver —
    // would otherwise replace the SELECT result the grid is showing (#883): the
    // user's edit succeeds and the grid reads "no data", Export included. Re-run
    // the tab's own query, the way a manual re-run would, so the applied edits are
    // visible in real, current rows rather than in the write's own empty answer.
    // Skipped when nothing applied: there is nothing new to show, and re-running
    // would cost a round trip only to redraw the same rows this tab already has.
    if (succeededCount > 0) {
      await executeQuery(currentTab.query, currentTab.id, false);
    }

    // Only a row that FAILED keeps its pending change — one that applied is done,
    // and one that never got a request could not have (there are none of those
    // here, every pending row got a statement). A row's own failure already raised
    // its own toast (executeQuery's error path), so what follows is the aggregate
    // outcome, not a repeat of that.
    const stillPending = pendingChanges.filter((c) => failedRowIndexes.has(c.rowIndex));
    setPendingChanges(stillPending);
    // EDIT mode stays on exactly while there is something left to retry or discard
    // — turning it off regardless of outcome, the old behaviour, discarded a
    // rejected edit with nothing to show for it but the toast (#882).
    setEditingEnabled(stillPending.length > 0);

    if (failedRowIndexes.size === 0) {
      toast({
        title: "Changes Applied",
        description: `${statements.length} UPDATE statement(s) applied.`,
      });
    } else if (succeededCount === 0) {
      toast({
        title: "Changes Not Applied",
        description: `${failedRowIndexes.size} row(s) failed; see the results panel for each row's error. Nothing was reset — retry or discard.`,
        variant: "destructive",
      });
    } else {
      toast({
        title: "Some Changes Applied",
        description: `${succeededCount} of ${statements.length} row(s) applied; ${failedRowIndexes.size} failed and are still pending.`,
        variant: "destructive",
      });
    }
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
