import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";
import React from "react";
import { setupFramerMotionMock, setupRechartssMock } from "../../helpers/mock-monaco";
import { DEFAULT_THRESHOLDS } from "@/lib/monitoring-thresholds";
import type { DatabaseConnection } from "@/lib/types";

setupRechartssMock();
setupFramerMotionMock();

/*
 * The monitoring dashboard's connection picker and a connection whose type names no provider (FND-1). The real
 * `@/components/ui/select` is rendered here: a closed Radix select still renders its items, so a type that is not text
 * threw in render while the picker was closed, which `MonitoringDashboard.test.tsx` never saw because it replaces
 * `SelectContent` with nothing.
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
      lastUpdated: null,
      autoRefresh: false,
      refreshInterval: 10000,
      history: [],
      setAutoRefresh: () => {},
      setRefreshInterval: () => {},
      refresh: () => {},
      killSession: async () => true,
      runMaintenance: async () => true,
      previewMaintenance: async () => null,
    };
  },
}));

mock.module("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { role: "admin" }, isAdmin: true, handleLogout: async () => {} }),
}));

mock.module("@/lib/storage", () => ({
  storage: {
    getActiveConnectionId: () => savedActiveId,
    getThresholdConfig: () => DEFAULT_THRESHOLDS,
    getActiveCatalog: () => null,
    setActiveCatalog: () => {},
  },
}));

// The tabs draw a selected connection's data, which this file does not test.
for (const tab of [
  "OverviewTab",
  "PerformanceTab",
  "QueriesTab",
  "SessionsTab",
  "TablesTab",
  "StorageTab",
  "PoolTab",
] as const) {
  mock.module(`@/components/monitoring/tabs/${tab}`, () => ({ [tab]: () => null }));
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { ABSENT_TYPE_SENTENCE, MALFORMED_TYPE_SENTENCE, unknownTypeSentence } from "@/lib/db/type-id";
import { mockToastError } from "../../helpers/mock-sonner";

// Imported after the mocks, as `MonitoringDashboard.test.tsx` does.
const { MonitoringDashboard } = await import("@/components/monitoring/MonitoringDashboard");

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

function renderDashboard(connections: DatabaseConnection[], savedId: string | null = null) {
  listedConnections = connections;
  savedActiveId = savedId;
  const view = render(<MonitoringDashboard />);
  // The header's selects in document order: the refresh interval, then the connection.
  const connectionTrigger = () => view.getAllByRole("combobox")[1];
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

describe("the monitoring dashboard and a connection whose type names no provider (FND-1)", () => {
  test("never opens on it when it is listed first", () => {
    const { connectionTrigger } = renderDashboard([U, P]);

    expect(connectionTrigger().textContent).toContain("Orders");
    expect(handed(metadataConnections)).not.toContain("u");
    expect(handed(monitoredConnections)).not.toContain("u");
    expect(handed(monitoredConnections)).toContain("p");
  });

  test("never opens on it when it is the editor's saved active connection", () => {
    const { connectionTrigger } = renderDashboard([P, U], "u");

    expect(connectionTrigger().textContent).toContain("Orders");
    expect(handed(metadataConnections)).not.toContain("u");
  });

  test("lists it as Unavailable, with the reason, and renders a type that is not text", () => {
    const { openConnections, getByRole } = renderDashboard([U, N, M, P], "p");

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
    const { openConnections, getByRole, connectionTrigger } = renderDashboard([U, P]);

    openConnections();
    fireEvent.keyDown(getByRole("option", { name: /^Acme/ }), { key: "Enter" });

    expect(mockToastError).toHaveBeenCalledWith("Connection unavailable", {
      description: `Acme: ${unknownTypeSentence("acmefoo")}`,
    });
    expect(connectionTrigger().textContent).toContain("Orders");
    expect(handed(metadataConnections)).not.toContain("u");
  });

  test("with no available connection nothing is selected", () => {
    const { getByText, connectionTrigger } = renderDashboard([U, N]);

    expect(getByText("No Connection Selected")).toBeTruthy();
    expect(connectionTrigger().textContent).toBe("Select connection");
    expect(handed(metadataConnections).every((id) => id === null)).toBe(true);
    expect(handed(monitoredConnections).every((id) => id === null)).toBe(true);
  });

  test("a connection the reader chose stays chosen when a later list names no provider for its type", () => {
    const { openConnections, getByRole, connectionTrigger, rerender } = renderDashboard([P, P2]);
    openConnections();
    fireEvent.keyDown(getByRole("option", { name: /^Billing/ }), { key: "Enter" });
    expect(connectionTrigger().textContent).toContain("Billing");

    listedConnections = [P, { ...P2, type: "acmefoo" } as unknown as DatabaseConnection];
    rerender(<MonitoringDashboard />);

    const trigger = connectionTrigger();
    expect(trigger.textContent).toContain("Billing");
    expect(trigger.textContent).not.toContain("(acmefoo)");
    expect(within(trigger).getByTitle(unknownTypeSentence("acmefoo")).textContent).toContain("Unavailable");
  });
});
