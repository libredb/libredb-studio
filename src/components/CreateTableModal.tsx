"use client";

import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Trash2, Table as TableIcon, Type, Settings2 } from "lucide-react";
import { toast } from "sonner";
import type { CreateTableSpec, ProviderCapabilities } from "@/lib/db/types";
import { objectPathLabel } from "@/lib/db/object-path";
import { quoteObjectPath, quoteTypedName } from "@/lib/query-generators";

interface ColumnDefinition {
  name: string;
  type: string;
  isPrimary: boolean;
  isNullable: boolean;
  isUnique: boolean;
  defaultValue: string;
}

interface CreateTableModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTableCreated: (sql: string) => void;
  /**
   * The container the table is created in: the path of the object-tree folder it was asked
   * for in. Without it the statement named the table alone and it landed in the session's
   * default container, measured on MySQL 26.7.0 as `e2e.ct_other` for a Create Table asked
   * for under `e2e_other` (#1391). Empty or absent keeps the bare name, which is what the
   * flat explorer's button and an engine with no container level ask for.
   */
  container?: readonly string[];
  /**
   * The connection's capabilities: the create-table grammar the form writes (`createTable`), and
   * the quoting every name is written in. Optional only because the modal stays mounted before
   * they load; opening it without them, or for a connection that declares no `createTable`, throws.
   */
  capabilities?: ProviderCapabilities;
}

/**
 * The `type` an auto-increment primary-key column carries in state, and deliberately not a
 * type name in any dialect.
 *
 * What the engines disagree about is not only the spelling but the SHAPE of the clause. For
 * example MySQL's `AUTO_INCREMENT` is a column attribute that precedes `PRIMARY KEY`; SQLite's
 * `AUTOINCREMENT` is a suffix that has to FOLLOW it, and only on a column typed exactly
 * `INTEGER`; DuckDB has no keyword at all and reaches for a sequence, which is a second
 * statement. None of them is a value the type dropdown could hold and hand to the shared
 * qualifier path below, which is why `CreateTableSpec.autoIncrement.clause` is stored whole.
 * So the column stores the user's INTENT and `generateSQL` resolves it against the
 * connection's spec.
 */
const AUTO_INCREMENT = "__auto_increment__";

/** No container, so the bare table name. One shared reference rather than a literal per render. */
const NO_CONTAINER: readonly string[] = [];

/** The first column the form starts with, which is an auto-increment key wherever there is one. */
function defaultColumns(spec: CreateTableSpec): ColumnDefinition[] {
  return [
    {
      name: "id",
      type: spec.autoIncrement ? AUTO_INCREMENT : spec.keyType,
      isPrimary: spec.columnConstraints,
      isNullable: false,
      isUnique: spec.columnConstraints,
      defaultValue: "",
    },
  ];
}

/**
 * The one name the form refuses beyond a blank: one the engine would SHORTEN in silence rather
 * than refuse (#1435). Every other name an engine cannot take is refused by the engine with an
 * error of its own, which reaches the user through the normal execute path.
 */
function lengthError(name: string, kind: "Table" | "Column", maxBytes: number | undefined): string {
  if (maxBytes === undefined || new TextEncoder().encode(name).length <= maxBytes) return "";
  return `${kind} name must be at most ${maxBytes} bytes`;
}

/**
 * The modal is mounted for every connection (`StudioOverlays`), so a connection whose
 * capabilities have not loaded, or that declares no `createTable`, renders nothing while
 * closed. OPENING it before the capabilities have loaded throws: every name is written in the
 * connection's own quoting, and there is none to write in. Opening it for a connection that
 * declares no `createTable` is a caller that skipped that gate, and throws for the same
 * reason: the form has no grammar to write for it.
 */
export function CreateTableModal(props: CreateTableModalProps) {
  const { capabilities } = props;
  if (capabilities === undefined) {
    if (props.isOpen) throw new Error("CreateTableModal: opened without the connection's capabilities");
    return null;
  }
  const spec = capabilities.createTable;
  if (spec === undefined) {
    if (props.isOpen) throw new Error("CreateTableModal: this connection declares no createTable");
    return null;
  }
  return <CreateTableForm {...props} capabilities={capabilities} spec={spec} />;
}

function CreateTableForm({
  isOpen,
  onClose,
  onTableCreated,
  container = NO_CONTAINER,
  capabilities,
  spec,
}: CreateTableModalProps & { capabilities: ProviderCapabilities; spec: CreateTableSpec }) {
  const [tableName, setTableName] = useState("");
  const [columns, setColumns] = useState<ColumnDefinition[]>(() => defaultColumns(spec));
  const tableNameError = tableName.trim()
    ? lengthError(tableName, "Table", capabilities.maxIdentifierBytes)
    : "Table name is required";
  const columnNameErrors = columns.map((col) => lengthError(col.name, "Column", capabilities.maxIdentifierBytes));

  // Columns hold grammar text, a type name and the auto-increment sentinel, so they are
  // re-derived when the grammar changes rather than carried across it. The modal stays mounted
  // across connections (`StudioOverlays`), so without this the initial state is whatever spec
  // the FIRST open saw: a column on a sentinel the next engine has no clause for renders an
  // empty type dropdown, and the reset in `handleCreate` freezes one engine's default into the
  // next connection. Keyed on the spec's JSON rather than its identity: capabilities arrive as
  // JSON, so a refetch, or a second connection to the same engine, hands over an equal spec in
  // a new object, and that keeps the draft. A connection with no spec renders no form at all.
  const specKey = JSON.stringify(spec);
  const [renderedFor, setRenderedFor] = useState(specKey);
  if (renderedFor !== specKey) {
    setRenderedFor(specKey);
    setColumns(defaultColumns(spec));
  }

  const addColumn = () => {
    setColumns([
      ...columns,
      {
        name: "",
        // The engine's own first type, so an added column starts on a name it has:
        // "VARCHAR(255)" is not one on SQLite's list.
        type: spec.types[0],
        isPrimary: false,
        isNullable: true,
        isUnique: false,
        defaultValue: "",
      },
    ]);
  };

  const removeColumn = (index: number) => {
    if (columns.length === 1) return;
    setColumns(columns.filter((_, i) => i !== index));
  };

  const updateColumn = (index: number, updates: Partial<ColumnDefinition>) => {
    setColumns(columns.map((col, i) => (i === index ? { ...col, ...updates } : col)));
  };

  // Every typed name, the table's and each column's, is written the way the SQL editor reads
  // the same text: bare where it is a regular ASCII identifier, quoted exactly otherwise.
  const typedName = (name: string) => quoteTypedName(name, capabilities);
  // Qualified only when a folder click supplied a container; the flat button creates the table
  // in the session's default one.
  //
  // The container is a catalog name read back from the engine, so it is quoted to stay exact.
  // The table name is what the user typed, and it is NOT force-quoted: a regular name stays
  // bare, exactly as the flat button writes it. Quoting it would make the two buttons create
  // different objects on an engine that folds case: on Oracle, `APP."orders"` is a lowercase
  // table a later `SELECT * FROM orders` does not find.
  const qualified = container.length > 0;
  const nameInContainer = (name: string) =>
    qualified ? `${quoteObjectPath(container, capabilities)}.${typedName(name)}` : typedName(name);

  const generateSQL = () => {
    if (tableNameError || columnNameErrors.some(Boolean)) return "";

    // Statements the CREATE TABLE depends on: a sequence, when the spec says the key defaults
    // from one (DuckDB's, `docs/providers/duckdb.md`). `executeQuery` routes a
    // multi-statement buffer to `/api/db/multi-query`, which splits on the dialect's own
    // grammar and runs the fragments in order.
    const prelude: string[] = [];

    const colDefs = columns.map((col) => {
      // An auto-increment key is a whole column clause rather than a type, because each
      // engine puts PRIMARY KEY in a different place inside it. It cannot go through the
      // qualifier path below: appending " PRIMARY KEY" to SQLite's clause would give
      // `INTEGER PRIMARY KEY AUTOINCREMENT PRIMARY KEY`.
      // `col.isPrimary` gates it because the clause SPELLS `PRIMARY KEY` itself: without
      // that read, unchecking PK on this column left the key in the SQL while the form
      // said it was gone, and the two disagreed with no way back.
      if (col.type === AUTO_INCREMENT && col.isPrimary && spec.autoIncrement) {
        let clause = `${typedName(col.name)} ${spec.autoIncrement.clause}`;
        if (spec.autoIncrement.sequence) {
          // For an engine whose spec sets `autoIncrement.sequence` (DuckDB, `docs/providers/duckdb.md`).
          // `IF NOT EXISTS` because a DuckDB sequence OUTLIVES the table that defaults
          // from it: measured on 1.5.5, `DROP TABLE widgets` leaves `widgets_id_seq`
          // behind (`nextval` on it still answers), and a plain `CREATE SEQUENCE` then
          // fails with `Sequence with name "widgets_id_seq" already exists!`. Without the
          // guard, creating a table, dropping it and creating it again through this form
          // fails the second time. The surviving sequence resumes its count, which costs
          // a few ids and nothing else.
          // In the table's own container, so the two land side by side. The name goes into
          // a string literal below, so a quote in it is doubled there. Measured on DuckDB
          // 1.5.5: a typed name holding a double quote makes `nextval` resolve a different
          // sequence name, and the CREATE TABLE fails with DuckDB's own Catalog Error.
          const sequenceName = nameInContainer(`${tableName}_${col.name}_seq`);
          prelude.push(`CREATE SEQUENCE IF NOT EXISTS ${sequenceName};`);
          clause += ` DEFAULT nextval('${sequenceName.replaceAll("'", "''")}')`;
        }
        return `  ${clause}`;
      }

      // A column still on the sentinel here is one the key was taken off, or one whose
      // engine has no auto-increment clause. Either way emit the plain integer type rather
      // than the sentinel text.
      const type = col.type === AUTO_INCREMENT ? spec.keyType : col.type;
      // `isPrimary` also gates NOT NULL and UNIQUE below, so an engine without constraints
      // has to read it as false here rather than merely skip the PRIMARY KEY line -
      // otherwise a key column silently loses its NOT NULL as well.
      const isPrimary = col.isPrimary && spec.columnConstraints;
      let def = `${typedName(col.name)} ${type}`;
      if (isPrimary) def += " PRIMARY KEY";
      if (!col.isNullable && !isPrimary) def += " NOT NULL";
      if (col.isUnique && !isPrimary && spec.columnConstraints) def += " UNIQUE";
      if (col.defaultValue) def += ` DEFAULT ${col.defaultValue}`;
      return `  ${def}`;
    });

    const create = `CREATE TABLE ${nameInContainer(tableName)} (\n${colDefs.join(",\n")}\n);`;
    return prelude.length ? `${prelude.join("\n")}\n${create}` : create;
  };

  const handleCreate = async () => {
    // A blank table name never gets here (the button disables on it), and the check is kept
    // for imperative callers. A blank column and an over-long name do reach it.
    const columnError = columns.some((c) => !c.name.trim()) ? "All columns must have a name" : "";
    const validationError = tableNameError || columnError || columnNameErrors.find(Boolean);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    const sql = generateSQL();
    onTableCreated(sql);
    onClose();
    setTableName("");
    setColumns(defaultColumns(spec));
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl bg-surface border-hairline-strong text-fg p-0 overflow-hidden flex flex-col max-h-[90vh]">
        <DialogHeader className="px-6 py-4 border-b border-hairline bg-panel">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-brand-tint/10 border border-brand-tint/20">
              <TableIcon strokeWidth={1.5} className="w-5 h-5 text-brand" />
            </div>
            <div>
              <DialogTitle className="text-xs font-medium">Create New Table</DialogTitle>
              <p className="text-xs text-fg-muted mt-1 font-medium">
                {qualified ? `In ${objectPathLabel(container)}` : "Define schema structure"}
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
          {/* Table Name Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Settings2 strokeWidth={1.5} className="w-3.5 h-3.5 text-brand/50" />
              <Label className="text-xs font-medium text-fg-muted">General Settings</Label>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tableName" className="text-xs font-medium text-fg-tertiary">
                Table Name
              </Label>
              <Input
                id="tableName"
                placeholder="e.g. customers, orders, analytics_logs"
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
                aria-invalid={Boolean(tableName && tableNameError)}
                aria-describedby={tableName && tableNameError ? "tableName-error" : undefined}
                className="bg-raised border-hairline focus-visible:ring-brand-tint/50"
              />
              {tableName && tableNameError && (
                <p id="tableName-error" role="alert" className="text-xs text-danger">
                  {tableNameError}
                </p>
              )}
            </div>
          </div>

          {/* Columns Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Type strokeWidth={1.5} className="w-3.5 h-3.5 text-success/50" />
                <Label className="text-xs font-medium text-fg-muted">Column Definitions</Label>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={addColumn}
                className="h-7 text-xs font-medium gap-2 hover:bg-success-tint/10 hover:text-success"
              >
                <Plus strokeWidth={1.5} className="w-3 h-3" /> Add Column
              </Button>
            </div>

            <div className="space-y-3">
              {columns.map((col, index) => (
                <div
                  key={index}
                  className="flex items-end gap-3 p-3 rounded-lg bg-panel border border-hairline group hover:border-hairline-strong transition-colors"
                >
                  <div className="flex-1 space-y-2">
                    <Label className="text-xs text-fg-muted font-medium">Column Name</Label>
                    <Input
                      value={col.name}
                      onChange={(e) => updateColumn(index, { name: e.target.value })}
                      aria-invalid={Boolean(columnNameErrors[index])}
                      aria-describedby={columnNameErrors[index] ? `columnName-error-${index}` : undefined}
                      placeholder="column_name"
                      className="h-8 text-xs bg-surface border-hairline"
                    />
                    {columnNameErrors[index] && (
                      <p id={`columnName-error-${index}`} role="alert" className="text-xs text-danger">
                        {columnNameErrors[index]}
                      </p>
                    )}
                  </div>

                  <div className="w-40 space-y-2">
                    <Label className="text-xs text-fg-muted font-medium">Type</Label>
                    <Select value={col.type} onValueChange={(val) => updateColumn(index, { type: val })}>
                      <SelectTrigger className="h-8 text-xs bg-surface border-hairline">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-surface border-hairline-strong">
                        {spec.types.map((t) => (
                          <SelectItem key={t} value={t} className="text-xs">
                            {t}
                          </SelectItem>
                        ))}
                        {col.isPrimary && spec.autoIncrement && (
                          <SelectItem value={AUTO_INCREMENT} className="text-xs text-hue-yellow">
                            Auto-Increment
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center gap-4 pb-2 px-2">
                    {spec.columnConstraints && (
                      <div className="flex flex-col items-center gap-1.5" title="Primary Key">
                        <Label className="text-[0.5rem] text-fg-subtle uppercase font-black">PK</Label>
                        <Checkbox
                          checked={col.isPrimary}
                          onCheckedChange={(checked) =>
                            updateColumn(index, {
                              isPrimary: !!checked,
                              isNullable: checked ? false : col.isNullable,
                              // Auto-Increment is only offered ON a primary key, so taking
                              // the key off has to take the column off that entry too —
                              // the dropdown stops listing it at the same click, and a
                              // trigger left on it renders empty.
                              type: !checked && col.type === AUTO_INCREMENT ? spec.keyType : col.type,
                            })
                          }
                          className="border-edge data-[state=checked]:bg-hue-yellow-tint data-[state=checked]:border-hue-yellow-tint"
                        />
                      </div>
                    )}
                    <div className="flex flex-col items-center gap-1.5" title="Nullable">
                      <Label className="text-[0.5rem] text-fg-subtle uppercase font-black">Null</Label>
                      <Checkbox
                        checked={col.isNullable}
                        onCheckedChange={(checked) => updateColumn(index, { isNullable: !!checked })}
                        className="border-edge data-[state=checked]:bg-hue-blue-tint data-[state=checked]:border-hue-blue-tint"
                      />
                    </div>
                    {spec.columnConstraints && (
                      <div className="flex flex-col items-center gap-1.5" title="Unique">
                        <Label className="text-[0.5rem] text-fg-subtle uppercase font-black">Unq</Label>
                        <Checkbox
                          checked={col.isUnique}
                          onCheckedChange={(checked) => updateColumn(index, { isUnique: !!checked })}
                          className="border-edge data-[state=checked]:bg-hue-purple-tint data-[state=checked]:border-hue-purple-tint"
                        />
                      </div>
                    )}
                  </div>

                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-fg-subtle hover:text-danger hover:bg-danger-tint/10 mb-0.5"
                    onClick={() => removeColumn(index)}
                    aria-label={`Remove column ${index + 1}`}
                  >
                    <Trash2 strokeWidth={1.5} className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {/*
            A terminal, not a panel: the ground is a hard `bg-black` in both themes,
            so the tokens inside it have to resolve their DARK values or the light
            palette paints dark-on-black. Scoped the way the login hero scopes its
            own pinned-dark column (#402).
          */}
          <div className="dark p-4 rounded-lg bg-black border border-hairline font-mono">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-brand-tint" />
                <span className="text-xs font-medium text-fg-muted">SQL Preview</span>
              </div>
              <span className="text-[0.625rem] text-fg-faint">Auto-generated</span>
            </div>
            <pre className="text-xs text-brand/80 whitespace-pre-wrap leading-relaxed">
              {generateSQL() ||
                (tableName.trim() ? "-- Correct the names to see SQL" : "-- Name your table to see SQL")}
            </pre>
          </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t border-hairline bg-panel">
          <Button variant="ghost" onClick={onClose} className="text-xs text-fg-tertiary hover:text-fg-bright">
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!tableName.trim()}
            className="bg-brand-solid hover:bg-brand-solid-hover text-white text-xs font-medium gap-2 px-6"
          >
            <Plus strokeWidth={1.5} className="w-3 h-3" />
            CREATE TABLE
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
