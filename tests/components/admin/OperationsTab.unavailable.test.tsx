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

mock.module("@/hooks/use-all-connections", () => ({
  useAllConnections: () => ({ connections: listedConnections, loading: false }),
}));

mock.module("@/hooks/use-provider-metadata", () => ({
  useProviderMetadata: (connection: DatabaseConnection | null) => {
    metadataConnections.push(connection);
    return { metadata: connection === null ? null : { capabilities: {}, labels: {} }, isLoading: false, error: null };
  },
}));

mock.module("@/hooks/use-monitoring-data", () => ({
  useMonitoringData: (connection: DatabaseConnection | null) => {
    monitoredConnections.push(connection);
    return {
      data: null,
      loading: false,
      error: null,
      refresh: () => {},
      killSession: async () => true,
      runMaintenanceOutcome: async () => ({ success: true }),
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

  test("never opens on it when it is the editor's saved active connection", () => {
    const { connectionTrigger } = renderTab([P, U], "u");

    expect(connectionTrigger().textContent).toContain("Orders");
    expect(handed(metadataConnections)).not.toContain("u");
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
    const { getByText, queryByText, connectionTrigger } = renderTab([U, N]);

    expect(getByText("No Connection Selected")).toBeTruthy();
    expect(getByText("Select a database connection to run operations on.")).toBeTruthy();
    expect(connectionTrigger().textContent).toBe("Select connection");
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
});
