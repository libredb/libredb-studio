import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";
import React from "react";
import type { DatabaseConnection } from "@/lib/types";

/*
 * The admin Operations tab's connection picker and a connection whose type names no provider (FND-1), with the real
 * `@/components/ui/select`: a closed Radix select still renders its items, so a type that is not text threw in render
 * while the picker was closed. `use-all-connections` is mocked here with the list each case sets, so the cases of this
 * slice stay apart from `OperationsTab.test.tsx`, which reads its list through the real hook.
 */

let listedConnections: DatabaseConnection[] = [];
let savedActiveId: string | null = null;
const metadataConnections: (DatabaseConnection | null)[] = [];
const monitoredConnections: (DatabaseConnection | null)[] = [];
// What the provider declares and what the monitoring read answers; a case that opens a confirmation sets both.
let declaredCapabilities: Record<string, unknown> = {};
let monitoredData: Record<string, unknown> | null = null;
const killedPids: (number | string)[] = [];
const maintenanceRuns: unknown[][] = [];

mock.module("@/hooks/use-all-connections", () => ({
  useAllConnections: () => ({ connections: listedConnections, loading: false }),
}));

mock.module("@/hooks/use-provider-metadata", () => ({
  useProviderMetadata: (connection: DatabaseConnection | null) => {
    metadataConnections.push(connection);
    return {
      metadata: connection === null ? null : { capabilities: declaredCapabilities, labels: {} },
      isLoading: false,
      error: null,
    };
  },
}));

mock.module("@/hooks/use-monitoring-data", () => ({
  useMonitoringData: (connection: DatabaseConnection | null) => {
    monitoredConnections.push(connection);
    return {
      data: connection === null ? null : monitoredData,
      loading: false,
      error: null,
      refresh: () => {},
      killSession: async (pid: number | string) => {
        killedPids.push(pid);
        return true;
      },
      runMaintenanceOutcome: async (...args: unknown[]) => {
        maintenanceRuns.push(args);
        return { success: true };
      },
      maintenanceReport: null,
      previewMaintenance: async () => null,
    };
  },
}));

mock.module("@/lib/storage", () => ({
  storage: {
    getActiveConnectionId: () => savedActiveId,
    getActiveCatalog: () => null,
    setActiveCatalog: () => {},
  },
}));

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { ABSENT_TYPE_SENTENCE, MALFORMED_TYPE_SENTENCE, unknownTypeSentence } from "@/lib/db/type-id";
import { mockToastError } from "../../helpers/mock-sonner";

const { OperationsTab } = await import("@/components/admin/tabs/OperationsTab");

const P: DatabaseConnection = {
  id: "p",
  name: "Orders",
  type: "postgres",
  host: "localhost",
  port: 5432,
  createdAt: new Date("2026-11-21T10:00:00.000Z"),
};
const P2: DatabaseConnection = { ...P, id: "p2", name: "Billing" };
const U = { ...P, id: "u", name: "Acme", type: "acmefoo" } as unknown as DatabaseConnection;
const N = { ...P, id: "n", name: "Untyped", type: undefined } as unknown as DatabaseConnection;
const M = { ...P, id: "m", name: "Malformed", type: { id: "postgres" } } as unknown as DatabaseConnection;

function renderTab(connections: DatabaseConnection[], savedId: string | null = null) {
  listedConnections = connections;
  savedActiveId = savedId;
  const view = render(<OperationsTab />);
  // The connection select is the tab's first; the database select draws nothing on a connection that lists none.
  const connectionTrigger = () => view.getAllByRole("combobox")[0];
  const openConnections = () => fireEvent.keyDown(connectionTrigger(), { key: "ArrowDown" });
  return { ...view, connectionTrigger, openConnections };
}

const handed = (calls: (DatabaseConnection | null)[]) => calls.map((connection) => connection?.id ?? null);

beforeEach(() => {
  metadataConnections.length = 0;
  monitoredConnections.length = 0;
  killedPids.length = 0;
  maintenanceRuns.length = 0;
  declaredCapabilities = {};
  monitoredData = null;
  mockToastError.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("the Operations tab and a connection whose type names no provider (FND-1)", () => {
  test("never opens on it when it is listed first", () => {
    const { connectionTrigger } = renderTab([U, P]);

    expect(connectionTrigger().textContent).toContain("Orders");
    expect(handed(metadataConnections)).not.toContain("u");
    expect(handed(monitoredConnections)).not.toContain("u");
    expect(handed(monitoredConnections)).toContain("p");
  });

  test("never opens on it when it is the editor's saved active connection, and says so once", () => {
    const { connectionTrigger, rerender } = renderTab([P, U], "u");

    expect(connectionTrigger().textContent).toContain("Orders");
    expect(handed(metadataConnections)).not.toContain("u");
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith("Connection unavailable", {
      description: `Acme: ${unknownTypeSentence("acmefoo")}`,
      id: "saved-connection-unavailable",
    });

    listedConnections = [P, U, P2];
    rerender(<OperationsTab />);
    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  test("says nothing about a saved active connection that is available or not listed", () => {
    renderTab([P, U], "p");
    cleanup();
    renderTab([P, U], "gone");

    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("lists it as Unavailable, with the reason, and renders a type that is not text", () => {
    const { openConnections, getByRole } = renderTab([U, N, M, P], "p");

    openConnections();

    for (const [option, sentence] of [
      ["Acme", unknownTypeSentence("acmefoo")],
      ["Untyped", ABSENT_TYPE_SENTENCE],
      ["Malformed", MALFORMED_TYPE_SENTENCE],
    ] as const) {
      const marker = within(getByRole("option", { name: new RegExp(`^${option}`) })).getByTitle(sentence);
      expect(marker.textContent).toBe(`Unavailable: ${sentence}`);
    }
    expect(getByRole("option", { name: /^Orders/ }).textContent).toContain("(postgres)");
  });

  test("a pick of it is refused by name and the selection stays", () => {
    const { openConnections, getByRole, connectionTrigger } = renderTab([U, P]);

    openConnections();
    fireEvent.keyDown(getByRole("option", { name: /^Acme/ }), { key: "Enter" });

    expect(mockToastError).toHaveBeenCalledWith("Connection unavailable", {
      description: `Acme: ${unknownTypeSentence("acmefoo")}`,
    });
    expect(connectionTrigger().textContent).toContain("Orders");
    expect(handed(metadataConnections)).not.toContain("u");
  });

  test("with no available connection nothing is selected and no section is drawn", () => {
    const { getByText, queryByText, queryAllByRole, connectionTrigger } = renderTab([U, N]);

    expect(getByText("No Connection Selected")).toBeTruthy();
    expect(getByText("No listed connection can be opened in this Studio.")).toBeTruthy();
    expect(connectionTrigger().textContent).toBe("Select connection");
    // Refresh and the database select act on a selected connection, so they are not drawn without one.
    expect(queryByText("Refresh")).toBeNull();
    expect(queryAllByRole("combobox")).toHaveLength(1);
    expect(queryByText(/^Tables/)).toBeNull();
    expect(queryByText(/^Sessions/)).toBeNull();
    expect(handed(metadataConnections).every((id) => id === null)).toBe(true);
    expect(handed(monitoredConnections).every((id) => id === null)).toBe(true);
  });

  test("a connection the reader chose stays chosen when a later list names no provider for its type", () => {
    const { openConnections, getByRole, connectionTrigger, rerender } = renderTab([P, P2]);
    openConnections();
    fireEvent.keyDown(getByRole("option", { name: /^Billing/ }), { key: "Enter" });
    expect(connectionTrigger().textContent).toContain("Billing");

    listedConnections = [P, { ...P2, type: "acmefoo" } as unknown as DatabaseConnection];
    rerender(<OperationsTab />);

    const trigger = connectionTrigger();
    expect(trigger.textContent).toContain("Billing");
    expect(trigger.textContent).not.toContain("(acmefoo)");
    expect(within(trigger).getByTitle(unknownTypeSentence("acmefoo")).textContent).toContain("Unavailable");
  });

  test("the connection it opened on stays shown when a later list names no provider for its type", () => {
    const { connectionTrigger, rerender, getByText, queryByText } = renderTab([P2, P], "p");
    expect(connectionTrigger().textContent).toContain("Orders");

    listedConnections = [P2, { ...P, type: "acmefoo" } as unknown as DatabaseConnection];
    rerender(<OperationsTab />);

    const trigger = connectionTrigger();
    expect(trigger.textContent).toContain("Orders");
    expect(within(trigger).getByTitle(unknownTypeSentence("acmefoo")).textContent).toContain("Unavailable");
    expect(handed(monitoredConnections)).not.toContain("p2");
    expect(handed(metadataConnections)).not.toContain("p2");
    // The refusal is drawn in place of the sections, so nothing read before it is shown as current.
    expect(getByText("Connection Unavailable")).toBeTruthy();
    expect(getByText(unknownTypeSentence("acmefoo"))).toBeTruthy();
    expect(queryByText(/^Sessions/)).toBeNull();
    expect(queryByText("Refresh")).toBeNull();
  });

  test("the first connection it opened on, with no saved one, stays shown when a later list names no provider for it", () => {
    const { connectionTrigger, rerender } = renderTab([P, P2]);
    expect(connectionTrigger().textContent).toContain("Orders");

    listedConnections = [{ ...P, type: "acmefoo" } as unknown as DatabaseConnection, P2];
    rerender(<OperationsTab />);

    expect(connectionTrigger().textContent).toContain("Orders");
    expect(handed(monitoredConnections)).not.toContain("p2");
  });

  test("a picked connection that leaves the list falls to an available one, never to an unavailable one", () => {
    const { openConnections, getByRole, connectionTrigger, rerender } = renderTab([P, P2]);
    openConnections();
    fireEvent.keyDown(getByRole("option", { name: /^Billing/ }), { key: "Enter" });
    expect(connectionTrigger().textContent).toContain("Billing");

    listedConnections = [U, P];
    rerender(<OperationsTab />);

    expect(connectionTrigger().textContent).toContain("Orders");
    expect(handed(monitoredConnections)).not.toContain("u");
    expect(handed(metadataConnections)).not.toContain("u");
  });

  test("a picked connection that leaves the list falls to the saved active connection while it is available", () => {
    const S: DatabaseConnection = { ...P, id: "s", name: "Sales" };
    const { openConnections, getByRole, connectionTrigger, rerender } = renderTab([P, S, P2], "s");
    expect(connectionTrigger().textContent).toContain("Sales");
    openConnections();
    fireEvent.keyDown(getByRole("option", { name: /^Billing/ }), { key: "Enter" });
    expect(connectionTrigger().textContent).toContain("Billing");

    listedConnections = [U, P, S];
    rerender(<OperationsTab />);

    expect(connectionTrigger().textContent).toContain("Sales");
  });

  test("the trigger draws the Unavailable marker at every width, and the type of an available one only from sm up", () => {
    const { connectionTrigger, rerender } = renderTab([P, P2], "p");
    expect(within(connectionTrigger()).getByText("(postgres)").className).toContain("hidden");

    listedConnections = [{ ...P, type: "acmefoo" } as unknown as DatabaseConnection, P2];
    rerender(<OperationsTab />);

    expect(within(connectionTrigger()).getByTitle(unknownTypeSentence("acmefoo")).className).not.toContain("hidden");
  });
  // The refusal is drawn in place of the sections, and the confirmations with them: a confirmation still open when
  // the operator picks another connection would ask about, and send to, the connection just picked.
  const SESSION = {
    pid: 4242,
    user: "app",
    database: "orders",
    state: "active",
    query: "SELECT 1",
    duration: "1s",
    durationMs: 1000,
  };
  const MAINTAINED = { supportsMaintenance: true, maintenanceOperations: ["kill", "reindex"] };

  test("a Terminate confirmation open when the shown connection is re-listed unavailable is closed, not reopened over the next pick", () => {
    declaredCapabilities = MAINTAINED;
    monitoredData = { activeSessions: [SESSION], tables: [] };
    const { getByRole, queryByText, openConnections, connectionTrigger, rerender } = renderTab([P, P2], "p");
    fireEvent.click(getByRole("button", { name: "Terminate session 4242" }));
    expect(queryByText("Terminate Session?")).not.toBeNull();

    listedConnections = [{ ...P, type: "acmefoo" } as unknown as DatabaseConnection, P2];
    rerender(<OperationsTab />);
    expect(queryByText("Connection Unavailable")).not.toBeNull();
    openConnections();
    fireEvent.keyDown(getByRole("option", { name: /^Billing/ }), { key: "Enter" });

    expect(queryByText("Terminate Session?")).toBeNull();
    expect(connectionTrigger().textContent).toContain("Billing");
    expect(killedPids).toEqual([]);
  });

  test("a whole-database confirmation open when the shown connection is re-listed unavailable is closed, not reopened over the next pick", () => {
    declaredCapabilities = MAINTAINED;
    monitoredData = { activeSessions: [], tables: [] };
    const { getByRole, queryByRole, openConnections, connectionTrigger, rerender } = renderTab([P, P2], "p");
    fireEvent.click(getByRole("button", { name: "Run Reindex" }));
    expect(queryByRole("alertdialog")).not.toBeNull();

    listedConnections = [{ ...P, type: "acmefoo" } as unknown as DatabaseConnection, P2];
    rerender(<OperationsTab />);
    openConnections();
    fireEvent.keyDown(getByRole("option", { name: /^Billing/ }), { key: "Enter" });

    expect(queryByRole("alertdialog")).toBeNull();
    expect(connectionTrigger().textContent).toContain("Billing");
    expect(maintenanceRuns).toEqual([]);
  });
});
