import "../setup-dom";
import { mockToastError } from "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { CreateTableModal } from "@/components/CreateTableModal";
import type { CreateTableSpec, ProviderCapabilities } from "@/lib/db/types";
import { POSTGRES_CREATE_TABLE } from "@/lib/db/providers/sql/postgres-create-table";
import { MYSQL_CREATE_TABLE } from "@/lib/db/providers/sql/mysql-create-table";
import { MSSQL_CREATE_TABLE } from "@/lib/db/providers/sql/mssql-create-table";
import { ORACLE_CREATE_TABLE } from "@/lib/db/providers/sql/oracle-create-table";
import { SQLITE_CREATE_TABLE } from "@/lib/db/providers/sql/sqlite-create-table";
import { DUCKDB_CREATE_TABLE } from "@/lib/db/providers/sql/duckdb/create-table";
import { TRINO_CREATE_TABLE } from "@/lib/db/providers/sql/trino/create-table";

/** The eight engines whose providers declare a `createTable` grammar, the only ones that reach this form. */
type Engine = "postgres" | "mysql" | "mssql" | "oracle" | "sqlite" | "libsql" | "duckdb" | "trino";

/**
 * The fields of each engine's capabilities that the form reads: its create-table grammar, how it
 * quotes, and the identifier limit PostgreSQL truncates at. The values are the providers' own
 * declarations, and the grammars are the very constants each provider returns.
 */
const CAPS = {
  postgres: { queryLanguage: "sql", defaultPort: 5432, maxIdentifierBytes: 63, createTable: POSTGRES_CREATE_TABLE },
  mysql: { queryLanguage: "sql", defaultPort: 3306, createTable: MYSQL_CREATE_TABLE },
  mssql: { queryLanguage: "sql", defaultPort: 1433, createTable: MSSQL_CREATE_TABLE },
  oracle: { queryLanguage: "sql", defaultPort: 1521, createTable: ORACLE_CREATE_TABLE },
  sqlite: { queryLanguage: "sql", defaultPort: null, createTable: SQLITE_CREATE_TABLE },
  libsql: { queryLanguage: "sql", defaultPort: 8080, createTable: SQLITE_CREATE_TABLE },
  duckdb: { queryLanguage: "sql", defaultPort: null, identifierQuoting: "double", createTable: DUCKDB_CREATE_TABLE },
  trino: { queryLanguage: "sql", defaultPort: 8080, identifierQuoting: "double", createTable: TRINO_CREATE_TABLE },
} as unknown as Record<Engine, ProviderCapabilities>;

/**
 * The modal as the app mounts it: with one engine's capabilities (PostgreSQL unless a test names
 * another), unless a test passes its own.
 */
function Modal({ engine = "postgres", ...props }: React.ComponentProps<typeof CreateTableModal> & { engine?: Engine }) {
  return <CreateTableModal capabilities={CAPS[engine]} {...props} />;
}

describe("CreateTableModal", () => {
  afterEach(() => {
    cleanup();
  });
  beforeEach(() => {
    mockToastError.mockClear();
  });

  test("renders dialog content when isOpen", () => {
    const { baseElement } = render(<Modal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);
    expect(body.queryByText("Create New Table")).not.toBeNull();
    expect(body.queryByText("SQL Preview")).not.toBeNull();
    expect(body.queryByText("Add Column")).not.toBeNull();
    expect(body.queryByText("General Settings")).not.toBeNull();
    expect(body.queryByText("Column Definitions")).not.toBeNull();
  });

  test("shows default id column and SQL placeholder", () => {
    const { baseElement } = render(<Modal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    expect(baseElement.textContent).toContain("-- Name your table to see SQL");
    expect(baseElement.textContent).toContain("Auto-Increment");
  });

  // ── 1. Add Column button adds new row ──────────────────────────────────────

  test("Add Column button adds a new column row", () => {
    const { baseElement } = render(<Modal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    // Initially there is 1 column (the default "id" column)
    const initialInputs = baseElement.querySelectorAll('input[placeholder="column_name"]');
    expect(initialInputs.length).toBe(1);

    // Click "Add Column"
    const addBtn = body.getByText("Add Column");
    act(() => {
      fireEvent.click(addBtn);
    });

    // Now there should be 2 column rows
    const updatedInputs = baseElement.querySelectorAll('input[placeholder="column_name"]');
    expect(updatedInputs.length).toBe(2);
  });

  // ── 2. Remove column removes a row ─────────────────────────────────────────

  test("remove button removes a column row", () => {
    const { baseElement } = render(<Modal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    // Add a second column first
    act(() => {
      fireEvent.click(body.getByText("Add Column"));
    });
    expect(baseElement.querySelectorAll('input[placeholder="column_name"]').length).toBe(2);

    const removeButton = body.getByRole("button", { name: "Remove column 2" });

    // Click the last remove button (removes the newly added column)
    act(() => {
      fireEvent.click(removeButton);
    });

    expect(baseElement.querySelectorAll('input[placeholder="column_name"]').length).toBe(1);
  });

  // ── 3. Cannot remove last remaining column ─────────────────────────────────

  test("cannot remove the last remaining column", () => {
    const { baseElement } = render(<Modal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);

    // Only 1 column (id) exists
    expect(baseElement.querySelectorAll('input[placeholder="column_name"]').length).toBe(1);

    // Find trash/remove buttons
    const trashButtons = baseElement.querySelectorAll("button");
    const removeButtons = Array.from(trashButtons).filter((btn) => {
      const icon = btn.querySelector('[data-icon="Trash2"]') || btn.querySelector("svg");
      return icon !== null && btn.textContent === "";
    });

    // Click the only remove button
    if (removeButtons.length > 0) {
      act(() => {
        fireEvent.click(removeButtons[0]);
      });
    }

    // Still 1 column — guard prevents removal
    expect(baseElement.querySelectorAll('input[placeholder="column_name"]').length).toBe(1);
  });

  // ── 4. Names are kept as typed (#1435) ────────────────────────────────────

  /** Render for one engine, type a table name and the first column's name, return the preview and the page. */
  function typeNames(dbType: Engine, table: string, column: string, onTableCreated = mock((_sql: string) => {})) {
    const { baseElement } = render(
      <Modal isOpen engine={dbType} onClose={mock(() => {})} onTableCreated={onTableCreated} />,
    );
    act(() => {
      fireEvent.change(baseElement.querySelector("#tableName") as HTMLInputElement, { target: { value: table } });
      fireEvent.change(baseElement.querySelector('input[placeholder="column_name"]') as HTMLInputElement, {
        target: { value: column },
      });
    });
    return { baseElement, sql: (baseElement.querySelector("pre") as HTMLElement).textContent || "" };
  }

  test("table name input keeps case and special characters as typed", () => {
    const { baseElement } = render(<Modal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);

    const tableNameInput = baseElement.querySelector("#tableName") as HTMLInputElement;
    expect(tableNameInput).not.toBeNull();

    act(() => {
      fireEvent.change(tableNameInput, { target: { value: "My Table-Name!123" } });
    });

    // It used to be rewritten to `my_table_name_123`, a different identifier (#1435).
    expect(tableNameInput.value).toBe("My Table-Name!123");
  });

  for (const [dbType, table, column] of [
    ["postgres", '"Ürün Tablo"', '"başlık"'],
    ["mysql", "`Ürün Tablo`", "`başlık`"],
    ["mssql", "[Ürün Tablo]", "[başlık]"],
    ["oracle", '"Ürün Tablo"', '"başlık"'],
  ] as Array<[Engine, string, string]>) {
    test(`${dbType}: a name outside the bare ASCII subset is quoted exactly, in the preview and the submitted SQL`, () => {
      const onTableCreated = mock((_sql: string) => {});
      const { baseElement, sql } = typeNames(dbType, "Ürün Tablo", "başlık", onTableCreated);
      expect(sql).toContain(`CREATE TABLE ${table} (\n  ${column} `);
      act(() => {
        fireEvent.click(within(baseElement).getByText("CREATE TABLE"));
      });
      expect(onTableCreated).toHaveBeenCalledTimes(1);
      expect(onTableCreated.mock.calls[0][0]).toBe(sql);
    });
  }

  for (const [dbType, name, quoted] of [
    ["postgres", 'A"B', '"A""B"'],
    ["mysql", "A`B", "`A``B`"],
    ["mssql", "A]B", "[A]]B]"],
    ["sqlite", 'A"B', '"A""B"'],
    ["trino", 'A"B', '"A""B"'],
  ] as Array<[Engine, string, string]>) {
    test(`${dbType}: a quote character inside a typed name is escaped`, () => {
      const { sql } = typeNames(dbType, name, name);
      expect(sql).toContain(`CREATE TABLE ${quoted} (\n  ${quoted} `);
    });
  }

  test("a regular ASCII name is written bare, so the engine reads it as the editor would", () => {
    // Mixed case folds the way the same text typed in the editor folds, and a reserved word
    // reaches the engine bare and is refused there, as it would be from the editor.
    expect(typeNames("postgres", "MyTable", "Order_Id").sql).toContain("CREATE TABLE MyTable (\n  Order_Id ");
    cleanup();
    expect(typeNames("postgres", "select", "id").sql).toContain("CREATE TABLE select (");
  });

  test("a name past the engine's identifier limit is refused under its field, not shortened by the engine", () => {
    // 64 UTF-8 bytes in 32 characters: PostgreSQL would keep the first 63 and say so only in a NOTICE.
    const long = "ü".repeat(32);
    const onTableCreated = mock((_sql: string) => {});
    const { baseElement, sql } = typeNames("postgres", long, "id", onTableCreated);
    expect((baseElement.querySelector("#tableName") as HTMLInputElement).value).toBe(long);
    expect(baseElement.querySelector("#tableName-error")?.textContent).toBe("Table name must be at most 63 bytes");
    expect(baseElement.querySelector("#tableName")?.getAttribute("aria-invalid")).toBe("true");
    expect(sql).toBe("-- Correct the names to see SQL");
    act(() => {
      fireEvent.click(within(baseElement).getByText("CREATE TABLE"));
    });
    expect(mockToastError).toHaveBeenCalledWith("Table name must be at most 63 bytes");
    expect(onTableCreated).not.toHaveBeenCalled();
  });

  test("a column name past the limit is refused under that column", () => {
    const onTableCreated = mock((_sql: string) => {});
    const { baseElement } = typeNames("postgres", "orders", "ü".repeat(32), onTableCreated);
    expect(baseElement.querySelector("#columnName-error-0")?.textContent).toBe("Column name must be at most 63 bytes");
    expect(baseElement.querySelector("#tableName-error")).toBeNull();
    act(() => {
      fireEvent.click(within(baseElement).getByText("CREATE TABLE"));
    });
    expect(mockToastError).toHaveBeenCalledWith("Column name must be at most 63 bytes");
    expect(onTableCreated).not.toHaveBeenCalled();
  });

  test("a name at the limit, or on an engine that declares none, is accepted", () => {
    // 63 bytes exactly.
    expect(typeNames("postgres", `${"ü".repeat(31)}a`, "id").sql).toContain(`CREATE TABLE "${"ü".repeat(31)}a" (`);
    cleanup();
    // MySQL declares no client-side limit: what it refuses, it refuses with an error of its own.
    expect(typeNames("mysql", "ü".repeat(40), "id").sql).toContain(`CREATE TABLE \`${"ü".repeat(40)}\` (`);
  });

  // ── 5. SQL preview with column definitions ─────────────────────────────────

  test("SQL preview shows CREATE TABLE with column definitions", () => {
    const { baseElement } = render(<Modal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);

    // Set table name to trigger SQL generation
    const tableNameInput = baseElement.querySelector("#tableName") as HTMLInputElement;
    act(() => {
      fireEvent.change(tableNameInput, { target: { value: "users" } });
    });

    const text = baseElement.textContent || "";
    expect(text).toContain("CREATE TABLE users");
    expect(text).toContain("id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY");
  });

  // ── 6. NOT NULL in SQL for non-nullable columns ────────────────────────────

  test("NOT NULL appears in SQL for non-nullable non-PK column", () => {
    const { baseElement } = render(<Modal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    // Set table name
    const tableNameInput = baseElement.querySelector("#tableName") as HTMLInputElement;
    act(() => {
      fireEvent.change(tableNameInput, { target: { value: "orders" } });
    });

    // Add a new column
    act(() => {
      fireEvent.click(body.getByText("Add Column"));
    });

    // Set column name for the new column (second input)
    const colInputs = baseElement.querySelectorAll('input[placeholder="column_name"]');
    act(() => {
      fireEvent.change(colInputs[1], { target: { value: "status" } });
    });

    // New column defaults: isNullable=true, isPrimary=false
    // Find Nullable checkboxes (role="checkbox") — Radix Checkbox renders as button[role="checkbox"]
    const checkboxes = baseElement.querySelectorAll('button[role="checkbox"]');
    // Each column row has 3 checkboxes: PK, Null, Unq
    // Row 0: checkboxes[0]=PK, checkboxes[1]=Null, checkboxes[2]=Unq
    // Row 1: checkboxes[3]=PK, checkboxes[4]=Null, checkboxes[5]=Unq
    const nullCheckbox = checkboxes[4];

    // New column is nullable by default (checked)
    expect(nullCheckbox.getAttribute("data-state")).toBe("checked");

    // Uncheck nullable
    act(() => {
      fireEvent.click(nullCheckbox);
    });
    expect(nullCheckbox.getAttribute("data-state")).toBe("unchecked");

    // SQL should now contain NOT NULL for the status column
    const text = baseElement.textContent || "";
    expect(text).toContain("status VARCHAR(255) NOT NULL");
  });

  // ── 7. UNIQUE in SQL for unique columns ────────────────────────────────────

  test("UNIQUE appears in SQL for unique non-PK column", () => {
    const { baseElement } = render(<Modal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    // Set table name
    const tableNameInput = baseElement.querySelector("#tableName") as HTMLInputElement;
    act(() => {
      fireEvent.change(tableNameInput, { target: { value: "products" } });
    });

    // Add a new column
    act(() => {
      fireEvent.click(body.getByText("Add Column"));
    });

    // Set column name
    const colInputs = baseElement.querySelectorAll('input[placeholder="column_name"]');
    act(() => {
      fireEvent.change(colInputs[1], { target: { value: "sku" } });
    });

    // Find checkboxes for column row 1
    const checkboxes = baseElement.querySelectorAll('button[role="checkbox"]');
    // Row 1: PK=checkboxes[3], Null=checkboxes[4], Unq=checkboxes[5]
    const uniqueCheckbox = checkboxes[5];

    // Initially unchecked
    expect(uniqueCheckbox.getAttribute("data-state")).toBe("unchecked");

    // Check unique
    act(() => {
      fireEvent.click(uniqueCheckbox);
    });
    expect(uniqueCheckbox.getAttribute("data-state")).toBe("checked");

    // Also uncheck nullable so NOT NULL + UNIQUE both appear
    const nullCheckbox = checkboxes[4];
    act(() => {
      fireEvent.click(nullCheckbox);
    });

    const text = baseElement.textContent || "";
    expect(text).toContain("sku VARCHAR(255) NOT NULL UNIQUE");
  });

  // ── 8. DEFAULT value in SQL ────────────────────────────────────────────────

  test("DEFAULT value appears in SQL when set", () => {
    const { baseElement } = render(<Modal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    // Set table name
    const tableNameInput = baseElement.querySelector("#tableName") as HTMLInputElement;
    act(() => {
      fireEvent.change(tableNameInput, { target: { value: "logs" } });
    });

    // Add a new column
    act(() => {
      fireEvent.click(body.getByText("Add Column"));
    });

    // Set column name
    const colInputs = baseElement.querySelectorAll('input[placeholder="column_name"]');
    act(() => {
      fireEvent.change(colInputs[1], { target: { value: "level" } });
    });

    // The component doesn't have a visible default value input in the main column row,
    // but the generateSQL function uses col.defaultValue. Since there's no UI for it
    // in the current component (defaultValue is always '' in UI), we verify the SQL
    // generation logic works by checking that an empty default produces no DEFAULT clause.
    // Scoped to the column's own clause: PostgreSQL's identity spelling contains the word
    // DEFAULT ("GENERATED BY DEFAULT AS IDENTITY"), so a document-wide check no longer
    // says anything about this column.
    const text = baseElement.textContent || "";
    expect(text).toContain("level VARCHAR(255)");
    expect(text).not.toContain("level VARCHAR(255) DEFAULT");
  });

  // ── 9. Validate empty table name -> button disabled ─────────────────────────

  test("CREATE TABLE button is disabled when table name is empty", () => {
    const onTableCreated = mock(() => {});
    const { baseElement } = render(<Modal isOpen onClose={mock(() => {})} onTableCreated={onTableCreated} />);
    const body = within(baseElement);

    // Table name is empty by default
    const createBtn = body.getByText("CREATE TABLE").closest("button") as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);

    // Click should not invoke onTableCreated
    act(() => {
      fireEvent.click(createBtn);
    });
    expect(onTableCreated).not.toHaveBeenCalled();
  });

  // ── 9b. Validate empty table name -> error toast (guard inside handleCreate) ─

  test("a whitespace-only table name stays as typed and cannot be created", () => {
    const onTableCreated = mock(() => {});
    const { baseElement } = render(<Modal isOpen onClose={mock(() => {})} onTableCreated={onTableCreated} />);
    const body = within(baseElement);

    const createBtn = body.getByText("CREATE TABLE").closest("button") as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);

    const tableNameInput = baseElement.querySelector("#tableName") as HTMLInputElement;
    act(() => {
      fireEvent.change(tableNameInput, { target: { value: "   " } });
    });
    expect(tableNameInput.value).toBe("   ");
    expect(createBtn.disabled).toBe(true);
    expect(baseElement.querySelector("#tableName-error")?.textContent).toBe("Table name is required");
    expect(onTableCreated).not.toHaveBeenCalled();
  });

  // ── 10. Validate empty column names -> error toast ─────────────────────────

  test("handleCreate shows error toast when a column has empty name", () => {
    const onTableCreated = mock(() => {});
    const { baseElement } = render(<Modal isOpen onClose={mock(() => {})} onTableCreated={onTableCreated} />);
    const body = within(baseElement);

    // Set table name
    const tableNameInput = baseElement.querySelector("#tableName") as HTMLInputElement;
    act(() => {
      fireEvent.change(tableNameInput, { target: { value: "test_table" } });
    });

    // Add a second column but leave its name empty
    act(() => {
      fireEvent.click(body.getByText("Add Column"));
    });

    // The new column has name='' by default
    const createBtn = body.getByText("CREATE TABLE");
    act(() => {
      fireEvent.click(createBtn);
    });

    expect(mockToastError).toHaveBeenCalledWith("All columns must have a name");
    expect(onTableCreated).not.toHaveBeenCalled();
  });

  // ── 11. handleCreate calls onTableCreated + onClose on success ─────────────

  test("handleCreate calls onTableCreated and onClose on success", () => {
    const onTableCreated = mock(() => {});
    const onClose = mock(() => {});
    const { baseElement } = render(<Modal isOpen onClose={onClose} onTableCreated={onTableCreated} />);
    const body = within(baseElement);

    // Set table name
    const tableNameInput = baseElement.querySelector("#tableName") as HTMLInputElement;
    act(() => {
      fireEvent.change(tableNameInput, { target: { value: "customers" } });
    });

    // Default id column already has a name, so validation passes
    const createBtn = body.getByText("CREATE TABLE");
    act(() => {
      fireEvent.click(createBtn);
    });

    expect(onTableCreated).toHaveBeenCalledTimes(1);
    // Verify the SQL was passed
    const sqlArg = (onTableCreated as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(sqlArg).toContain("CREATE TABLE customers");
    expect(sqlArg).toContain("id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── 12. State resets after creation ────────────────────────────────────────

  test("state resets after successful creation", () => {
    const onTableCreated = mock(() => {});
    const onClose = mock(() => {});
    const { baseElement } = render(<Modal isOpen onClose={onClose} onTableCreated={onTableCreated} />);
    const body = within(baseElement);

    // Set table name and add a column
    const tableNameInput = baseElement.querySelector("#tableName") as HTMLInputElement;
    act(() => {
      fireEvent.change(tableNameInput, { target: { value: "temp_table" } });
    });
    act(() => {
      fireEvent.click(body.getByText("Add Column"));
    });

    // Fill second column name
    const colInputs = baseElement.querySelectorAll('input[placeholder="column_name"]');
    act(() => {
      fireEvent.change(colInputs[1], { target: { value: "name" } });
    });

    // We should have 2 columns now
    expect(baseElement.querySelectorAll('input[placeholder="column_name"]').length).toBe(2);

    // Create table
    act(() => {
      fireEvent.click(body.getByText("CREATE TABLE"));
    });

    // After creation, state resets: table name should be empty, columns back to default (1)
    expect(tableNameInput.value).toBe("");
    expect(baseElement.querySelectorAll('input[placeholder="column_name"]').length).toBe(1);

    // The remaining column should be the default "id"
    const resetColInput = baseElement.querySelector('input[placeholder="column_name"]') as HTMLInputElement;
    expect(resetColInput.value).toBe("id");
  });

  // ── 13. PK checkbox auto-unchecks Nullable ─────────────────────────────────

  test("checking PK auto-unchecks Nullable", () => {
    const { baseElement } = render(<Modal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    // Add a new column (default: isPrimary=false, isNullable=true)
    act(() => {
      fireEvent.click(body.getByText("Add Column"));
    });

    const checkboxes = baseElement.querySelectorAll('button[role="checkbox"]');
    // Row 1: PK=checkboxes[3], Null=checkboxes[4], Unq=checkboxes[5]
    const pkCheckbox = checkboxes[3];
    const nullCheckbox = checkboxes[4];

    // Initially: PK unchecked, Null checked
    expect(pkCheckbox.getAttribute("data-state")).toBe("unchecked");
    expect(nullCheckbox.getAttribute("data-state")).toBe("checked");

    // Check PK
    act(() => {
      fireEvent.click(pkCheckbox);
    });

    // PK should be checked, Null should be auto-unchecked
    expect(pkCheckbox.getAttribute("data-state")).toBe("checked");
    expect(nullCheckbox.getAttribute("data-state")).toBe("unchecked");
  });

  // ── 14. Cancel button calls onClose ────────────────────────────────────────

  test("Cancel button calls onClose", () => {
    const onClose = mock(() => {});
    const { baseElement } = render(<Modal isOpen onClose={onClose} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    const cancelBtn = body.getByText("Cancel");
    act(() => {
      fireEvent.click(cancelBtn);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── 15. Column type selector changes SQL preview ───────────────────────────

  test("default column type VARCHAR(255) appears in SQL for new columns", () => {
    const { baseElement } = render(<Modal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    // Set table name
    const tableNameInput = baseElement.querySelector("#tableName") as HTMLInputElement;
    act(() => {
      fireEvent.change(tableNameInput, { target: { value: "items" } });
    });

    // Add a new column (defaults to VARCHAR(255))
    act(() => {
      fireEvent.click(body.getByText("Add Column"));
    });

    // Name the new column
    const colInputs = baseElement.querySelectorAll('input[placeholder="column_name"]');
    act(() => {
      fireEvent.change(colInputs[1], { target: { value: "description" } });
    });

    // SQL preview should show the default type
    const text = baseElement.textContent || "";
    expect(text).toContain("description VARCHAR(255)");

    // Also verify the default id column uses the identity spelling
    expect(text).toContain("id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY");
  });

  // ── 16. One dialect per engine (#648) ──────────────────────────────────────

  /** Render for one engine, name the table, and return the SQL the preview shows. */
  function previewFor(dbType: Engine): string {
    const { baseElement } = render(
      <Modal isOpen engine={dbType} onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
    act(() => {
      fireEvent.change(baseElement.querySelector("#tableName") as HTMLInputElement, {
        target: { value: "widgets" },
      });
    });
    return (baseElement.querySelector("pre") as HTMLElement).textContent || "";
  }

  /**
   * The eight engines that declare a `createTable` grammar and therefore reach this form,
   * with the default `id` column each one has to produce. Before #648 every row of this
   * table read `id SERIAL PRIMARY KEY`, which parses on two of the eight.
   */
  const AUTO_INCREMENT_BY_ENGINE: ReadonlyArray<[Engine, string]> = [
    ["postgres", "id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY"],
    ["mysql", "id INT AUTO_INCREMENT PRIMARY KEY"],
    ["mssql", "id INT IDENTITY(1,1) PRIMARY KEY"],
    ["oracle", "id NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY"],
    // AUTOINCREMENT has to follow PRIMARY KEY and the type has to be exactly INTEGER;
    // both were measured on SQLite 3.53.4, where the other orderings are syntax errors.
    ["sqlite", "id INTEGER PRIMARY KEY AUTOINCREMENT"],
    ["libsql", "id INTEGER PRIMARY KEY AUTOINCREMENT"],
    ["duckdb", "id INTEGER PRIMARY KEY DEFAULT nextval('widgets_id_seq')"],
    // Trino's column grammar is a name, a type and an optional NOT NULL — no generated
    // value, and no PRIMARY KEY to attach one to.
    ["trino", "id INTEGER NOT NULL"],
  ];

  for (const [dbType, expected] of AUTO_INCREMENT_BY_ENGINE) {
    test(`${dbType}: default id column is that engine's auto-increment key`, () => {
      const sql = previewFor(dbType);
      expect(sql).toContain(`CREATE TABLE widgets (\n  ${expected}\n);`);
      expect(sql).not.toContain("SERIAL");
    });
  }

  test("duckdb creates the sequence its default reads, ahead of the table", () => {
    const sql = previewFor("duckdb");
    // Measured on DuckDB 1.5.5: `CREATE TABLE t (id INTEGER DEFAULT nextval('nope'))` is
    // "Catalog Error: Sequence with name nope does not exist!", so the order of these two
    // statements is the fix and not a formatting choice. IF NOT EXISTS because the
    // sequence outlives a DROP TABLE and a bare CREATE SEQUENCE would then fail.
    expect(sql.indexOf("CREATE SEQUENCE IF NOT EXISTS widgets_id_seq;")).toBe(0);
    expect(sql.indexOf("CREATE TABLE widgets")).toBeGreaterThan(0);
  });

  test("trino hides the options its grammar has no place for", () => {
    const { baseElement } = render(
      <Modal isOpen engine="trino" onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
    expect(baseElement.textContent).not.toContain("Auto-Increment");
    // PK and Unq go with it: Trino takes a name, a type and NOT NULL, so those two
    // checkboxes would compile to nothing the engine parses. Null stays.
    expect(baseElement.textContent).not.toContain("PK");
    expect(baseElement.textContent).not.toContain("Unq");
    expect(baseElement.textContent).toContain("Null");
  });

  test("every other engine keeps all three column checkboxes", () => {
    const { baseElement } = render(
      <Modal isOpen engine="postgres" onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
    expect(baseElement.querySelectorAll('button[role="checkbox"]').length).toBe(3);
  });

  /** Open the first column's type dropdown and return the type names it lists. */
  function typeOptionsFor(dbType: Engine): string[] {
    const { baseElement } = render(
      <Modal isOpen engine={dbType} onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
    act(() => {
      fireEvent.keyDown(baseElement.querySelectorAll('[role="combobox"]')[0], { key: "ArrowDown" });
    });
    return Array.from(baseElement.querySelectorAll('[role="option"]'))
      .map((o) => o.textContent || "")
      .filter((label) => label !== "Auto-Increment");
  }

  test("JSONB is offered only on the engine that has it", () => {
    // Measured on DuckDB 1.5.5: `CREATE TABLE t (a JSONB)` is "Catalog Error: Type with
    // name JSONB does not exist", while `JSON` is accepted.
    expect(typeOptionsFor("postgres")).toContain("JSONB");
    cleanup();
    for (const dbType of ["mysql", "duckdb", "trino"] as Engine[]) {
      const options = typeOptionsFor(dbType);
      expect(options).not.toContain("JSONB");
      expect(options).toContain("JSON");
      cleanup();
    }
    // The three with no JSON type of their own: SQL Server 2022 stores JSON in
    // NVARCHAR(MAX), Oracle before 21c in CLOB, and SQLite in TEXT.
    for (const [dbType, textType] of [
      ["mssql", "NVARCHAR(MAX)"],
      ["oracle", "CLOB"],
      ["sqlite", "TEXT"],
      ["libsql", "TEXT"],
    ] as Array<[Engine, string]>) {
      const options = typeOptionsFor(dbType);
      expect(options).not.toContain("JSONB");
      expect(options).toContain(textType);
      cleanup();
    }
  });

  test("the type list drops the spellings each engine does not have", () => {
    // TIMESTAMP on SQL Server is a deprecated synonym for ROWVERSION and holds no date,
    // so a form offering it for "a moment in time" is offering the wrong column.
    const mssql = typeOptionsFor("mssql");
    expect(mssql).toContain("DATETIME2");
    expect(mssql).not.toContain("TIMESTAMP");
    expect(mssql).toContain("BIT");
    expect(mssql).not.toContain("BOOLEAN");
    cleanup();
    const oracle = typeOptionsFor("oracle");
    expect(oracle).toContain("VARCHAR2(255)");
    expect(oracle).not.toContain("BIGINT");
    cleanup();
    // SQLite has type affinities rather than types: it accepts any word, which is why the
    // old list looked fine there and silently mis-filed every column.
    expect(typeOptionsFor("sqlite")).toEqual(["TEXT", "INTEGER", "REAL", "BLOB", "NUMERIC"]);
  });

  test("an added column starts on a type the engine has", () => {
    const { baseElement } = render(
      <Modal isOpen engine="sqlite" onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
    const body = within(baseElement);
    act(() => {
      fireEvent.change(baseElement.querySelector("#tableName") as HTMLInputElement, {
        target: { value: "notes" },
      });
      fireEvent.click(body.getByText("Add Column"));
    });
    const colInputs = baseElement.querySelectorAll('input[placeholder="column_name"]');
    act(() => {
      fireEvent.change(colInputs[1], { target: { value: "body" } });
    });
    // SQLite's list starts at TEXT; "VARCHAR(255)" is not one of its affinity spellings.
    expect(baseElement.querySelector("pre")?.textContent).toContain("body TEXT");
  });

  /** Capabilities that quote like PostgreSQL's and declare no create-table grammar, as Db2's and Cassandra's do. */
  const NO_CREATE_TABLE = { ...CAPS.postgres, createTable: undefined } as ProviderCapabilities;

  test("opening it for an engine that declares no createTable throws instead of writing another engine's DDL", () => {
    // Every entry point gates on the declaration; this is the refusal when one does not, so the
    // form never hands such an engine `CREATE TABLE ... GENERATED BY DEFAULT AS IDENTITY` in silence.
    const consoleError = console.error;
    console.error = () => {};
    try {
      expect(() =>
        render(
          <Modal isOpen capabilities={NO_CREATE_TABLE} onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
        ),
      ).toThrow("CreateTableModal: this connection declares no createTable");
    } finally {
      console.error = consoleError;
    }
  });

  test("closed, it stays mounted for an engine that declares no createTable and renders nothing", () => {
    // `StudioOverlays` mounts this modal for every connection, so the refusal is on OPEN only.
    const { baseElement } = render(
      <Modal isOpen={false} capabilities={NO_CREATE_TABLE} onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
    expect(baseElement.textContent).not.toContain("Create New Table");
  });

  test("a refetch that answers the same grammar in a new object keeps the draft", () => {
    // Capabilities arrive as JSON, so a refetch or a second connection to the same engine is a new
    // object holding an equal grammar; only a different grammar may throw the columns away.
    const props = { isOpen: true as const, onClose: mock(() => {}), onTableCreated: mock(() => {}) };
    const { baseElement, rerender } = render(<Modal {...props} />);
    act(() => {
      fireEvent.click(within(baseElement).getByText("Add Column"));
    });
    const refetched = JSON.parse(JSON.stringify(CAPS.postgres)) as ProviderCapabilities;
    expect(refetched.createTable).not.toBe(POSTGRES_CREATE_TABLE);
    rerender(<Modal {...props} capabilities={refetched} />);
    expect(baseElement.querySelectorAll('input[placeholder="column_name"]').length).toBe(2);
  });

  test("a different grammar on the same quoting resets the columns", () => {
    const props = { isOpen: true as const, onClose: mock(() => {}), onTableCreated: mock(() => {}) };
    const { baseElement, rerender } = render(<Modal {...props} />);
    act(() => {
      fireEvent.click(within(baseElement).getByText("Add Column"));
    });
    const other: CreateTableSpec = { ...POSTGRES_CREATE_TABLE, types: ["INTEGER", "TEXT"] };
    rerender(<Modal {...props} capabilities={{ ...CAPS.postgres, createTable: other }} />);
    expect(baseElement.querySelectorAll('input[placeholder="column_name"]').length).toBe(1);
  });

  test("switching engine under a chosen auto-increment column does not leak the sentinel", () => {
    // The modal stays mounted across a connection switch, so a column picked on
    // PostgreSQL can be rendered for Trino, which has no auto-increment clause to use.
    const { baseElement, rerender } = render(
      <Modal isOpen engine="postgres" onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
    act(() => {
      fireEvent.change(baseElement.querySelector("#tableName") as HTMLInputElement, {
        target: { value: "widgets" },
      });
    });
    rerender(<Modal isOpen engine="trino" onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const sql = baseElement.querySelector("pre")?.textContent || "";
    expect(sql).toContain("id INTEGER NOT NULL");
    expect(sql).not.toContain("__auto_increment__");
  });

  // ── 17. The mount shape the app actually produces ──────────────────────────

  /**
   * `StudioOverlays` renders this modal unconditionally with the active connection's
   * capabilities, so it stays mounted while the connection, and with it the grammar, changes
   * under it. Every test above mounts with the final grammar; these mount on PostgreSQL's
   * and then hand another one over.
   */
  function mountThenConnect(dbType: Engine) {
    const props = { isOpen: true as const, onClose: mock(() => {}), onTableCreated: mock(() => {}) };
    const view = render(<Modal {...props} />);
    view.rerender(<Modal {...props} engine={dbType} />);
    return view;
  }

  test("the engine's default column survives arriving after the first render", () => {
    const { baseElement } = mountThenConnect("trino");
    // Trino lists no Auto-Increment entry, so a column left on the sentinel renders a
    // dropdown with nothing selected — the trigger reads "" instead of a type name.
    expect(baseElement.querySelectorAll('[role="combobox"]')[0].textContent).toBe("INTEGER");
    act(() => {
      fireEvent.change(baseElement.querySelector("#tableName") as HTMLInputElement, {
        target: { value: "widgets" },
      });
    });
    expect(baseElement.querySelector("pre")?.textContent).toContain("id INTEGER NOT NULL");
  });

  test("a create on one engine does not fix the form's columns to it", () => {
    const props = { isOpen: true as const, onClose: mock(() => {}), onTableCreated: mock(() => {}) };
    const { baseElement, rerender } = render(<Modal {...props} />);
    rerender(<Modal {...props} engine="trino" />);
    act(() => {
      fireEvent.change(baseElement.querySelector("#tableName") as HTMLInputElement, {
        target: { value: "widgets" },
      });
    });
    act(() => {
      fireEvent.click(within(baseElement).getByText("CREATE TABLE"));
    });

    // Switching to SQLite has to bring SQLite's default key back. Carrying Trino's plain
    // `id INTEGER NOT NULL` over is the silently-broken key this PR set out to close,
    // arriving through the reset instead of through the dialect table.
    rerender(<Modal {...props} engine="sqlite" />);
    act(() => {
      fireEvent.change(baseElement.querySelector("#tableName") as HTMLInputElement, {
        target: { value: "notes" },
      });
    });
    expect(baseElement.querySelector("pre")?.textContent).toContain("id INTEGER PRIMARY KEY AUTOINCREMENT");
  });

  test("a type chosen on one engine does not survive into the next", () => {
    // JSONB is a PostgreSQL spelling; SQLite takes it silently on NUMERIC affinity.
    const props = { isOpen: true as const, onClose: mock(() => {}), onTableCreated: mock(() => {}) };
    const { baseElement, rerender } = render(<Modal {...props} engine="postgres" />);
    const body = within(baseElement);
    act(() => {
      fireEvent.change(baseElement.querySelector("#tableName") as HTMLInputElement, {
        target: { value: "widgets" },
      });
      fireEvent.click(body.getByText("Add Column"));
    });
    act(() => {
      fireEvent.change(baseElement.querySelectorAll('input[placeholder="column_name"]')[1], {
        target: { value: "payload" },
      });
    });
    act(() => {
      fireEvent.keyDown(baseElement.querySelectorAll('[role="combobox"]')[1], { key: "ArrowDown" });
    });
    act(() => {
      fireEvent.click(
        Array.from(baseElement.querySelectorAll('[role="option"]')).find((o) => o.textContent === "JSONB") as Element,
      );
    });
    expect(baseElement.querySelector("pre")?.textContent).toContain("payload JSONB");

    rerender(<Modal {...props} engine="sqlite" />);
    act(() => {
      fireEvent.change(baseElement.querySelector("#tableName") as HTMLInputElement, {
        target: { value: "notes" },
      });
    });
    const sql = baseElement.querySelector("pre")?.textContent || "";
    expect(sql).not.toContain("JSONB");
    expect(sql).toContain("id INTEGER PRIMARY KEY AUTOINCREMENT");
  });

  // ── 18. Unchecking PK on an auto-increment column ──────────────────────────

  test("unchecking PK takes the auto-increment column off the key", () => {
    const { baseElement } = render(
      <Modal isOpen engine="postgres" onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
    act(() => {
      fireEvent.change(baseElement.querySelector("#tableName") as HTMLInputElement, {
        target: { value: "widgets" },
      });
    });
    expect(baseElement.querySelector("pre")?.textContent).toContain(
      "id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",
    );

    // Row 0: PK=checkboxes[0], Null=checkboxes[1], Unq=checkboxes[2]
    act(() => {
      fireEvent.click(baseElement.querySelectorAll('button[role="checkbox"]')[0]);
    });

    // The clause spells PRIMARY KEY itself, so it cannot stay once the key is gone; the
    // dropdown stops listing Auto-Increment at the same click, and a trigger left on it
    // would read "".
    const sql = baseElement.querySelector("pre")?.textContent || "";
    expect(sql).not.toContain("PRIMARY KEY");
    expect(sql).toContain("id INTEGER NOT NULL UNIQUE");
    expect(baseElement.querySelectorAll('[role="combobox"]')[0].textContent).toBe("INTEGER");
  });

  test("the fallback type is a name the engine's own dropdown lists", () => {
    // MySQL and SQL Server list INT, not the INTEGER both also accept: a state value the
    // list does not carry leaves the Select trigger blank.
    for (const [dbType, expected] of [
      ["mysql", "INT"],
      ["mssql", "INT"],
      ["oracle", "INTEGER"],
      ["duckdb", "INTEGER"],
    ] as Array<[Engine, string]>) {
      const { baseElement } = render(
        <Modal isOpen engine={dbType} onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
      );
      act(() => {
        fireEvent.click(baseElement.querySelectorAll('button[role="checkbox"]')[0]);
      });
      expect(baseElement.querySelectorAll('[role="combobox"]')[0].textContent).toBe(expected);
      cleanup();
    }
  });

  // ── 17. The container the folder named (#1391) ─────────────────────────────

  /** Render in a container with the given capabilities, name the table, return the preview and the page. */
  function previewIn(
    dbType: Engine,
    container: readonly string[],
    capabilities: ProviderCapabilities | undefined,
    name = "ct_other",
  ): { sql: string; text: string } {
    const { baseElement } = render(
      <Modal
        isOpen
        engine={dbType}
        container={container}
        capabilities={capabilities}
        onClose={mock(() => {})}
        onTableCreated={mock(() => {})}
      />,
    );
    act(() => {
      fireEvent.change(baseElement.querySelector("#tableName") as HTMLInputElement, { target: { value: name } });
    });
    const result = {
      sql: (baseElement.querySelector("pre") as HTMLElement).textContent || "",
      text: baseElement.textContent || "",
    };
    cleanup();
    return result;
  }

  const MYSQL_CAPS = CAPS.mysql;
  const PG_CAPS = CAPS.postgres;

  test("a table asked for in a container is created in it, and the header says where (#1391)", () => {
    // Measured on MySQL 26.7.0: Create Table under `e2e_other` used to create `e2e.ct_other`.
    const { sql, text } = previewIn("mysql", ["e2e_other"], MYSQL_CAPS);
    expect(sql).toContain("CREATE TABLE e2e_other.ct_other (");
    expect(text).toContain("In e2e_other");
    expect(text).not.toContain("Define schema structure");
  });

  test("each segment is quoted in the connection's own dialect (#1391)", () => {
    expect(previewIn("mysql", ["e2e-other"], MYSQL_CAPS).sql).toContain("CREATE TABLE `e2e-other`.ct_other (");
    expect(previewIn("postgres", ["Sales"], PG_CAPS).sql).toContain('CREATE TABLE "Sales".ct_other (');
  });

  test("the typed name is written as the flat button writes it, inside the quoted container (#1391, #1435)", () => {
    // Oracle folds an unquoted name to upper case, so force-quoting the typed `orders` would create a
    // lowercase table that a later `SELECT * FROM orders` cannot find (ORA-00942).
    expect(previewIn("oracle", ["APP"], CAPS.oracle, "orders").sql).toContain("CREATE TABLE APP.orders (");
    // A mixed-case PostgreSQL schema keeps its case through quoting; the table name stays as typed.
    expect(previewIn("postgres", ["MySchema"], PG_CAPS, "orders").sql).toContain('CREATE TABLE "MySchema".orders (');
    // A name outside the bare subset is quoted exactly, in the container as on the flat button.
    expect(previewIn("oracle", ["APP"], CAPS.oracle, "Ürün").sql).toContain('CREATE TABLE APP."Ürün" (');
  });

  test("DuckDB's sequence is created beside the table it numbers (#1391)", () => {
    const { sql } = previewIn("duckdb", ["main"], CAPS.duckdb, "widgets");
    expect(sql).toContain("CREATE SEQUENCE IF NOT EXISTS main.widgets_id_seq;");
    expect(sql).toContain("DEFAULT nextval('main.widgets_id_seq')");
    expect(sql).toContain("CREATE TABLE main.widgets (");
  });

  test("a quote inside the sequence's name stays inside its string literal (#1391, #1435)", () => {
    expect(previewIn("duckdb", ["it's"], CAPS.duckdb, "widgets").sql).toContain(
      `DEFAULT nextval('"it''s".widgets_id_seq')`,
    );
    expect(previewIn("duckdb", [], CAPS.duckdb, "Kid's Table").sql).toContain(
      `CREATE SEQUENCE IF NOT EXISTS "Kid's Table_id_seq";`,
    );
    expect(previewIn("duckdb", [], CAPS.duckdb, "Kid's Table").sql).toContain(
      `DEFAULT nextval('"Kid''s Table_id_seq"')`,
    );
  });

  test("DuckDB runs the generated statements for a typed name with an apostrophe and non-ASCII letters (#1435)", async () => {
    const { sql } = typeNames("duckdb", "Ürün's Tablo", "başlık");
    const [createSequence, createTable, ...rest] = sql.split(";\n");
    expect(rest).toEqual([]);

    const { DuckDBInstance } = await import("@duckdb/node-api");
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      // The sequence first: the table's default reads it.
      await connection.run(createSequence);
      await connection.run(createTable);
      await connection.run(`INSERT INTO "Ürün's Tablo" DEFAULT VALUES`);
      const rows = await connection.runAndReadAll(`SELECT "başlık" AS value FROM "Ürün's Tablo"`);
      expect(rows.getRowObjectsJson()).toEqual([{ value: 1 }]);
    } finally {
      connection.disconnectSync();
      instance.closeSync();
    }
  });

  test("no container keeps the bare name (#1391)", () => {
    const bare = previewIn("mysql", [], MYSQL_CAPS);
    expect(bare.sql).toContain("CREATE TABLE ct_other (");
    expect(bare.text).toContain("Define schema structure");
  });

  test("opening it without the connection's capabilities throws: it cannot quote a name without them", () => {
    const consoleError = console.error;
    console.error = () => {};
    try {
      expect(() => previewIn("mysql", ["e2e_other"], undefined)).toThrow(
        "CreateTableModal: opened without the connection's capabilities",
      );
    } finally {
      console.error = consoleError;
    }
  });

  test("closed, it stays mounted without capabilities and renders nothing", () => {
    const { baseElement } = render(
      <Modal
        isOpen={false}
        engine="mysql"
        capabilities={undefined}
        onClose={mock(() => {})}
        onTableCreated={mock(() => {})}
      />,
    );
    expect(baseElement.textContent).not.toContain("Create New Table");
  });
});
