import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupFramerMotionMock, setupMonacoMock } from "../../helpers/mock-monaco";

setupMonacoMock();
setupFramerMotionMock();

// The editor and the panel library are replaced for the reasons `embedded-object-tree.test.tsx` gives; everything
// between the host's declaration and the statement the host is asked to run is the real code: the adapter, the
// sidebar, the tab manager and the generators.
mock.module("@/components/QueryEditor", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return { QueryEditor: () => React.createElement("div", { "data-testid": "query-editor" }) };
});

mock.module("@/components/ui/resizable", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    ResizablePanelGroup: ({ children }: Record<string, unknown>) => React.createElement("div", null, children),
    ResizablePanel: ({ children }: Record<string, unknown>) => React.createElement("div", null, children),
    ResizableHandle: () => React.createElement("div", null),
  };
});

const { StudioWorkspace } = await import("@/exports/workspace");
import type { ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";

/** A host's SQL declaration that names `defaultPort` and no identifier quoting of its own. */
function declaring(defaultPort: number | null): ProviderCapabilities {
  return {
    queryLanguage: "sql",
    supportsExplain: false,
    supportsExternalQueryLimiting: true,
    supportsInlineRowEdit: false,
    supportsMaintenance: false,
    maintenanceOperations: [],
    supportsConnectionString: false,
    schemaRefreshPattern: "",
    defaultPort,
    containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
    objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
  };
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

/** Mounts the published workspace on one host connection, clicks the `Order Items` table, and answers what ran. */
async function clickOrderItems(type: DatabaseType, defaultPort: number | null): Promise<string[]> {
  // The embedded shell reads through the host; a request to a route would be a defect, and it answers 404 here.
  globalThis.fetch = mock(async () => Response.json({ error: "no route here" }, { status: 404 })) as never;
  const ran: string[] = [];
  render(
    <StudioWorkspace
      connections={[{ id: "host-conn-1", name: "Adopter DB", type, capabilities: declaring(defaultPort) }]}
      onQueryExecute={async (_connectionId: string, query: string) => {
        ran.push(query);
        return { rows: [], fields: [], rowCount: 0, executionTime: 1 };
      }}
      onSchemaFetch={async () => []}
      onObjectsFetch={{
        listContainers: async () => [{ path: ["app"], level: 0, name: "app", isSessionDefault: true }],
        countObjects: async () => ({ table: { count: 1 } }),
        listObjects: async () => [{ path: ["app", "Order Items"], name: "Order Items", kind: "table" }],
      }}
    />,
  );
  await waitFor(() => expect(screen.getByText("Tables")).toBeTruthy());
  await userEvent.click(screen.getByText("Tables"));
  await waitFor(() => expect(screen.getByText("Order Items")).toBeTruthy());
  fireEvent.click(screen.getByText("Order Items"));
  await waitFor(() => expect(ran.length).toBeGreaterThan(0), { timeout: 3000 });
  return ran;
}

/**
 * A tree click writes the SQL forms of the connection's TYPE, never of the port its host's declaration names (FND-1).
 * Measured before the change through this same mount: a MySQL connection declared with 3307 or `null` ran
 * `app."Order Items"`, which MySQL reads as a string literal, and a PostgreSQL one declared with 3306 or 1433 ran
 * backticks or brackets.
 */
describe("the embedded workspace writes the SQL forms of the connection's type", () => {
  test.each([3307, null])("a MySQL connection whose host declares %p runs MySQL's quoting", async (port) => {
    expect(await clickOrderItems("mysql", port)).toEqual(["SELECT * FROM app.`Order Items`;"]);
  });

  test.each([3306, 1433])("a PostgreSQL connection whose host declares %p runs PostgreSQL's", async (port) => {
    expect(await clickOrderItems("postgres", port)).toEqual(['SELECT * FROM app."Order Items";']);
  });

  test("a declaration on the engine's own port runs as before", async () => {
    expect(await clickOrderItems("mysql", 3306)).toEqual(["SELECT * FROM app.`Order Items`;"]);
  });
});
