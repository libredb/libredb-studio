import "../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionGlobalConfig } from "framer-motion";

import { ConnectionModal } from "@/components/ConnectionModal";
import { CONNECTION_IMPORT_ACTION_ID } from "@/components/ConnectionImportPanel";
import { ConnectionModal as PackagedConnectionModal } from "@/exports/components";
import type { ConnectionImporter, ImportedContext } from "@/lib/connection-import";
import type { DatabaseConnection } from "@/lib/types";
import { declareConnectionImport } from "../helpers/synthetic-connection-import";

/**
 * The connection dialog offers an import exactly where the selected type's entry declares one, through the real
 * dialog, the real form hook and the real `DB_UI_CONFIG`, with nothing mocked: the declaration is put on the
 * PostgreSQL entry for each test and taken off after it. The same component is the one the package exports.
 */

// The dialog's banners animate in; happy-dom cancels an animation still running when the test ends, which surfaces
// as an unhandled AbortError, so animations finish at once here.
MotionGlobalConfig.skipAnimations = true;

const restores: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const restore of restores.splice(0)) restore();
});

const STAGING: ImportedContext = {
  name: "staging",
  fields: { host: "db.example", port: "6543", password: "import-token" },
  ssl: { mode: "verify-full", caCert: "CA PEM" },
  notices: [],
};

function declareOnPostgres(contexts: readonly ImportedContext[] = [STAGING]) {
  const importer = mock<ConnectionImporter>(() => ({ contexts, refusals: [] }));
  const load = mock(async () => importer);
  restores.push(declareConnectionImport("postgres", { label: "Import a test file", load }));
  return { importer, load };
}

function value(id: string): string {
  return (document.getElementById(id) as HTMLInputElement).value;
}

describe("ConnectionModal: a declared connection import", () => {
  test("no action where the selected type declares none", () => {
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
    expect(screen.queryByTestId(CONNECTION_IMPORT_ACTION_ID)).toBeNull();
  });

  test("the declared label is offered for a new connection, and nothing is loaded until it opens", () => {
    const { load } = declareOnPostgres();
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
    expect(screen.getByTestId(CONNECTION_IMPORT_ACTION_ID).textContent).toBe("Import a test file");
    expect(load).not.toHaveBeenCalled();
  });

  test("an entry chosen from the import fills the dialog's fields and SSL panel", async () => {
    declareOnPostgres();
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId(CONNECTION_IMPORT_ACTION_ID));
    });
    fireEvent.change(screen.getByTestId("connection-import-text"), { target: { value: "pasted text" } });
    fireEvent.click(screen.getByTestId("connection-import-read"));
    fireEvent.click(screen.getByTestId("connection-import-context"));
    expect([value("name"), value("host"), value("port"), value("password")]).toEqual([
      "staging",
      "db.example",
      "6543",
      "import-token",
    ]);
    expect(screen.getByTestId("connection-test-result").textContent).toContain("Filled from staging.");
    expect(screen.getByTestId("ssl-mode-hint")).toBeTruthy();
  });

  test("switching to a type that declares none takes the action away", () => {
    declareOnPostgres();
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
    expect(screen.getByTestId(CONNECTION_IMPORT_ACTION_ID)).toBeTruthy();
    fireEvent.click(screen.getByText("MySQL"));
    expect(screen.queryByTestId(CONNECTION_IMPORT_ACTION_ID)).toBeNull();
  });

  test("switching between two declaring types drops the first type's entries and parser", async () => {
    const postgres = declareOnPostgres();
    const mysqlImporter = mock<ConnectionImporter>(() => ({ contexts: [], refusals: [] }));
    const mysqlLoad = mock(async () => mysqlImporter);
    restores.push(declareConnectionImport("mysql", { label: "Import a MySQL file", load: mysqlLoad }));
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId(CONNECTION_IMPORT_ACTION_ID));
    });
    fireEvent.change(screen.getByTestId("connection-import-text"), { target: { value: "postgres text" } });
    fireEvent.click(screen.getByTestId("connection-import-read"));
    expect(screen.getAllByTestId("connection-import-context")).toHaveLength(1);
    fireEvent.click(screen.getByText("MySQL"));
    expect(screen.queryByTestId("connection-import-context")).toBeNull();
    expect(screen.getByTestId(CONNECTION_IMPORT_ACTION_ID).textContent).toBe("Import a MySQL file");
    await act(async () => {
      fireEvent.click(screen.getByTestId(CONNECTION_IMPORT_ACTION_ID));
    });
    fireEvent.change(screen.getByTestId("connection-import-text"), { target: { value: "mysql text" } });
    fireEvent.click(screen.getByTestId("connection-import-read"));
    expect(mysqlLoad).toHaveBeenCalledTimes(1);
    expect(mysqlImporter.mock.calls).toEqual([["mysql text"]]);
    expect(postgres.importer.mock.calls).toEqual([["postgres text"]]);
  });

  test("no action while a connection is edited", () => {
    declareOnPostgres();
    const editing: DatabaseConnection = {
      id: "c1",
      name: "saved",
      type: "postgres",
      host: "saved.example",
      port: 5432,
      createdAt: new Date(0),
    };
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} editConnection={editing} />);
    expect(screen.queryByTestId(CONNECTION_IMPORT_ACTION_ID)).toBeNull();
  });

  test("the package's exported ConnectionModal is this dialog and offers the same action", () => {
    declareOnPostgres();
    expect(PackagedConnectionModal).toBe(ConnectionModal);
    render(<PackagedConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
    expect(screen.getByTestId(CONNECTION_IMPORT_ACTION_ID).textContent).toBe("Import a test file");
  });
});
