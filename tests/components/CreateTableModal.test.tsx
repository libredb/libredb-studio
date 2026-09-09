import "../setup-dom";
import { mockToastError } from "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { CreateTableModal } from "@/components/CreateTableModal";
import type { DatabaseType } from "@/lib/types";

describe("CreateTableModal", () => {
  afterEach(() => {
    cleanup();
  });
  beforeEach(() => {
    mockToastError.mockClear();
  });

  test("renders dialog content when isOpen", () => {
    const { baseElement } = render(
      <CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
    const body = within(baseElement);
    expect(body.queryByText("Create New Table")).not.toBeNull();
    expect(body.queryByText("SQL Preview")).not.toBeNull();
    expect(body.queryByText("Add Column")).not.toBeNull();
    expect(body.queryByText("General Settings")).not.toBeNull();
    expect(body.queryByText("Column Definitions")).not.toBeNull();
  });

  test("shows default id column and SQL placeholder", () => {
    const { baseElement } = render(
      <CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
    expect(baseElement.textContent).toContain("-- Name your table to see SQL");
    expect(baseElement.textContent).toContain("Auto-Increment");
  });

  // ── 1. Add Column button adds new row ──────────────────────────────────────

  test("Add Column button adds a new column row", () => {
    const { baseElement } = render(
      <CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
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
    const { baseElement } = render(
      <CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
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
    const { baseElement } = render(
      <CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );

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

  // ── 4. Table name sanitization (lowercase + underscores) ───────────────────

  test("table name input sanitizes to lowercase and underscores", () => {
    const { baseElement } = render(
      <CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );

    const tableNameInput = baseElement.querySelector("#tableName") as HTMLInputElement;
    expect(tableNameInput).not.toBeNull();

    // Type mixed-case with special characters
    act(() => {
      fireEvent.change(tableNameInput, { target: { value: "My Table-Name!123" } });
    });

    // The onChange handler lowercases and replaces non-alphanumeric/underscore with _
    expect(tableNameInput.value).toBe("my_table_name_123");
  });

  // ── 5. SQL preview with column definitions ─────────────────────────────────

  test("SQL preview shows CREATE TABLE with column definitions", () => {
    const { baseElement } = render(
      <CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );

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
    const { baseElement } = render(
      <CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
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
    const { baseElement } = render(
      <CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
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
    const { baseElement } = render(
      <CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
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
    const { baseElement } = render(
      <CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={onTableCreated} />,
    );
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

  test("empty table name keeps the create button disabled and whitespace is sanitized", () => {
    const onTableCreated = mock(() => {});
    const { baseElement } = render(
      <CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={onTableCreated} />,
    );
    const body = within(baseElement);

    const createBtn = body.getByText("CREATE TABLE").closest("button") as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);

    // The name input sanitizes every character outside [a-z0-9_] to "_", so a
    // whitespace-only name is impossible through the UI: typing spaces yields
    // underscores and the name validation inside handleCreate stays defensive-only.
    const tableNameInput = baseElement.querySelector("#tableName") as HTMLInputElement;
    act(() => {
      fireEvent.change(tableNameInput, { target: { value: "   " } });
    });
    expect(tableNameInput.value).toBe("___");
    expect(createBtn.disabled).toBe(false);

    // A DOM click on the disabled empty-name state never reaches React, so
    // creation only proceeds with a sanitized non-empty name.
    expect(onTableCreated).not.toHaveBeenCalled();
  });

  // ── 10. Validate empty column names -> error toast ─────────────────────────

  test("handleCreate shows error toast when a column has empty name", () => {
    const onTableCreated = mock(() => {});
    const { baseElement } = render(
      <CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={onTableCreated} />,
    );
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
    const { baseElement } = render(<CreateTableModal isOpen onClose={onClose} onTableCreated={onTableCreated} />);
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
    const { baseElement } = render(<CreateTableModal isOpen onClose={onClose} onTableCreated={onTableCreated} />);
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
    const { baseElement } = render(
      <CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
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
    const { baseElement } = render(<CreateTableModal isOpen onClose={onClose} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    const cancelBtn = body.getByText("Cancel");
    act(() => {
      fireEvent.click(cancelBtn);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── 15. Column type selector changes SQL preview ───────────────────────────

  test("default column type VARCHAR(255) appears in SQL for new columns", () => {
    const { baseElement } = render(
      <CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
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
  function previewFor(dbType: DatabaseType | undefined): string {
    const { baseElement } = render(
      <CreateTableModal isOpen dbType={dbType} onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
    act(() => {
      fireEvent.change(baseElement.querySelector("#tableName") as HTMLInputElement, {
        target: { value: "widgets" },
      });
    });
    return (baseElement.querySelector("pre") as HTMLElement).textContent || "";
  }

  /**
   * The eight ids that publish `supportsCreateTable: true` and therefore reach this form,
   * with the default `id` column each one has to produce. Before #648 every row of this
   * table read `id SERIAL PRIMARY KEY`, which parses on two of the eight.
   */
  const AUTO_INCREMENT_BY_ENGINE: ReadonlyArray<[DatabaseType, string]> = [
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
      <CreateTableModal isOpen dbType="trino" onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
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
      <CreateTableModal isOpen dbType="postgres" onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
    expect(baseElement.querySelectorAll('button[role="checkbox"]').length).toBe(3);
  });

  /** Open the first column's type dropdown and return the type names it lists. */
  function typeOptionsFor(dbType: DatabaseType): string[] {
    const { baseElement } = render(
      <CreateTableModal isOpen dbType={dbType} onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
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
    for (const dbType of ["mysql", "duckdb", "trino"] as DatabaseType[]) {
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
    ] as Array<[DatabaseType, string]>) {
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
      <CreateTableModal isOpen dbType="sqlite" onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
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

  test("an unknown dbType keeps the PostgreSQL behaviour the form already had", () => {
    expect(previewFor(undefined)).toContain("id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY");
    expect(previewFor("cassandra" as DatabaseType)).toContain(
      "id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",
    );
  });

  test("switching engine under a chosen auto-increment column does not leak the sentinel", () => {
    // The modal stays mounted across a connection switch, so a column picked on
    // PostgreSQL can be rendered for Trino, which has no auto-increment clause to use.
    const { baseElement, rerender } = render(
      <CreateTableModal isOpen dbType="postgres" onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
    );
    act(() => {
      fireEvent.change(baseElement.querySelector("#tableName") as HTMLInputElement, {
        target: { value: "widgets" },
      });
    });
    rerender(<CreateTableModal isOpen dbType="trino" onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const sql = baseElement.querySelector("pre")?.textContent || "";
    expect(sql).toContain("id INTEGER NOT NULL");
    expect(sql).not.toContain("__auto_increment__");
  });

  // ── 17. The mount shape the app actually produces ──────────────────────────

  /**
   * `Studio.tsx` renders this modal unconditionally and passes
   * `dbType={conn.activeConnection?.type}`, so the first render is always `undefined` and
   * the engine arrives on a later one. Every test above mounts with the final `dbType`,
   * which is a shape the app never produces; these mount with none and then hand one over.
   */
  function mountThenConnect(dbType: DatabaseType) {
    const props = { isOpen: true as const, onClose: mock(() => {}), onTableCreated: mock(() => {}) };
    const view = render(<CreateTableModal {...props} />);
    view.rerender(<CreateTableModal {...props} dbType={dbType} />);
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
    const { baseElement, rerender } = render(<CreateTableModal {...props} />);
    rerender(<CreateTableModal {...props} dbType="trino" />);
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
    rerender(<CreateTableModal {...props} dbType="sqlite" />);
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
    const { baseElement, rerender } = render(<CreateTableModal {...props} dbType="postgres" />);
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

    rerender(<CreateTableModal {...props} dbType="sqlite" />);
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
      <CreateTableModal isOpen dbType="postgres" onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
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
    ] as Array<[DatabaseType, string]>) {
      const { baseElement } = render(
        <CreateTableModal isOpen dbType={dbType} onClose={mock(() => {})} onTableCreated={mock(() => {})} />,
      );
      act(() => {
        fireEvent.click(baseElement.querySelectorAll('button[role="checkbox"]')[0]);
      });
      expect(baseElement.querySelectorAll('[role="combobox"]')[0].textContent).toBe(expected);
      cleanup();
    }
  });
});
