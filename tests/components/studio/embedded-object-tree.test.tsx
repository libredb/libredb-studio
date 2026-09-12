import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupFramerMotionMock, setupMonacoMock } from "../../helpers/mock-monaco";

setupMonacoMock();
setupFramerMotionMock();

// The editor and the panel library are the two things this file does NOT exercise, and both
// are hostile to happy-dom: `react-resizable-panels` 4 reaches for a global `DOMRect`, and
// the Monaco loader's promise has no `cancel` for the unmount path. Everything between the
// published prop and the tree's own request is the real code, adapter and sidebar included,
// because mounting the tree directly with props the embedded shell never supplies is what
// let this ship (#789, B76).
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

import { StudioWorkspace } from "@/workspace/StudioWorkspace";
import type { WorkspaceObjectReader } from "@/workspace/types";
import type { ProviderCapabilities } from "@/lib/db/types";

const capabilities = {
  queryLanguage: "sql",
  containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
  objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
} as unknown as ProviderCapabilities;

const realFetch = globalThis.fetch;

/** Every request the workspace issues, by pathname, so a read that went to a route is visible. */
function installFetch(): string[] {
  const paths: string[] = [];
  globalThis.fetch = mock(async (url: string | URL) => {
    paths.push(new URL(String(url), "http://localhost:3000").pathname);
    return Response.json({ error: "no route here" }, { status: 404 });
  }) as never;
  return paths;
}

function renderWorkspace(reader: WorkspaceObjectReader) {
  return render(
    <StudioWorkspace
      connections={[{ id: "host-conn-1", name: "Adopter DB", type: "clickhouse", capabilities }]}
      onQueryExecute={async () => ({ rows: [], fields: [], rowCount: 0, executionTime: 1 })}
      onSchemaFetch={async () => []}
      onObjectsFetch={reader}
    />,
  );
}

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

/**
 * The embedded shell reads its objects through the HOST (#789, B76).
 *
 * This package ships no API routes: `package.json`'s `exports` map carries components and types
 * only, so `/api/db/objects/*` is a path on the HOST's origin, which need not serve it. Measured
 * before the fix, on this exact mount: the tree posted
 * `{"connection":{"id","name","type","createdAt","managed"}}` to `/api/db/objects/containers`, and
 * that connection object was refused by name by the real provider factory on every engine tried
 * ("ClickHouse requires a host or a connection string", "Host is required for PostgreSQL",
 * "Database file path is required for SQLite"), leaving an adopter with the tree's failure panel
 * on every connection.
 *
 * Driven through `StudioWorkspace` rather than through `ObjectTree`, deliberately: every test of
 * the tree supplied props the embedded shell never supplies, which is how the regression shipped.
 */
describe("the embedded workspace's object tree", () => {
  test("lists what the host answered, and asks no route for it", async () => {
    const paths = installFetch();
    const asked: unknown[][] = [];
    const reader: WorkspaceObjectReader = {
      listContainers: async (connectionId, parent) => {
        asked.push(["listContainers", connectionId, parent]);
        return [{ path: ["app"], level: 0, name: "app", isSessionDefault: true }];
      },
      countObjects: async (connectionId, container) => {
        asked.push(["countObjects", connectionId, container]);
        return { table: { count: 1 } };
      },
      listObjects: async (connectionId, container, kind) => {
        asked.push(["listObjects", connectionId, container, kind]);
        return [{ path: ["app", "orders"], name: "orders", kind: "table" }];
      },
    };

    renderWorkspace(reader);

    // First paint: the host's container list, then the counts of the one it marked as the
    // session default, which is what opened the folder below without anybody clicking it.
    await waitFor(() => expect(screen.getByText("Tables")).toBeTruthy());
    expect(asked).toEqual([
      ["listContainers", "host-conn-1", undefined],
      ["countObjects", "host-conn-1", ["app"]],
    ]);

    // The third read is the LAZY one, and it is the reason the seam is per read rather than one
    // flat catalog: nothing named an object until a reader opened the folder.
    await userEvent.click(screen.getByText("Tables"));
    await waitFor(() => expect(screen.getByText("orders")).toBeTruthy());
    expect(asked[2]).toEqual(["listObjects", "host-conn-1", ["app"], "table"]);

    // The control for this negative is everything above: three reads answered and three sets of
    // rows are on screen, so a read that had gone to a route would have been counted here.
    expect(paths.filter((path) => path.startsWith("/api/db/objects"))).toEqual([]);
  });

  test("refuses a host answer the tree cannot render, rather than unmounting on it", async () => {
    installFetch();
    const reader: WorkspaceObjectReader = {
      // A host is ordinary JavaScript, so its declared return type is not a runtime guarantee.
      // `[null]` passes `Array.isArray`, and dereferencing it throws INSIDE the render, which
      // takes the whole workspace down with it.
      listContainers: async () => [null] as never,
      countObjects: async () => ({}),
      listObjects: async () => [],
    };

    renderWorkspace(reader);

    await waitFor(() => expect(screen.getByTestId("tree-failure")).toBeTruthy());
    expect(screen.getByTestId("tree-failure").textContent).toContain(
      "The containers reading answered with a body this tree cannot render",
    );
  });

  test("shows the host's own sentence when its reading fails", async () => {
    installFetch();
    const reader: WorkspaceObjectReader = {
      listContainers: async () => {
        throw new Error("The tenant's warehouse is asleep");
      },
      countObjects: async () => ({}),
      listObjects: async () => [],
    };

    renderWorkspace(reader);

    await waitFor(() => expect(screen.getByTestId("tree-failure")).toBeTruthy());
    expect(screen.getByTestId("tree-failure").textContent).toContain("The tenant's warehouse is asleep");
  });
});
