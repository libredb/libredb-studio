import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupFramerMotionMock } from "../../helpers/mock-monaco";

setupFramerMotionMock();

/*
 * A host mounting `StudioWorkspace` and returning a 768-dimension vector column (vector-family spec 3.10, R51 U13).
 *
 * Everything between the host's result and the clipboard is the real code: the adapter, the tab manager, the
 * bottom panel, the grid, the renderers and `writeToClipboard`. Doubled are only what happy-dom cannot run or what
 * this file does not exercise, as in `embedded-source.test.tsx`: Monaco and the query editor, the resizable panels,
 * the row virtualizer (which measures layout happy-dom does not do, so the double hands every row out) and the
 * Radix context menu (whose portal and pointer handling happy-dom does not drive; the double opens on the same
 * `contextmenu` event the grid listens for).
 */
mock.module("@monaco-editor/react", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    default: () => React.createElement("div", { "data-testid": "monaco" }),
    DiffEditor: () => React.createElement("div", { "data-testid": "monaco-diff" }),
    loader: { init: () => Promise.resolve(), config: () => {}, __getMonacoInstance: () => null },
  };
});

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

mock.module("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({ index, start: index * 36, size: 36, key: index })),
    getTotalSize: () => options.count * 36,
    measureElement: () => {},
    measure: () => {},
  }),
}));

mock.module("@/components/ui/context-menu", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  const MenuContext = React.createContext(null);
  return {
    ContextMenu: ({ children }: { children: unknown }) => {
      const [open, setOpen] = React.useState(false);
      return React.createElement(
        MenuContext.Provider,
        { value: { open, setOpen } },
        React.createElement("div", { "data-testid": "result-context-menu" }, children),
      );
    },
    ContextMenuContent: ({ children }: { children: unknown }) => {
      const menu = React.useContext(MenuContext) as { open: boolean } | null;
      return menu?.open ? React.createElement("div", { "data-testid": "context-menu-content" }, children) : null;
    },
    ContextMenuItem: ({ children, onClick }: { children: unknown; onClick?: () => void }) =>
      React.createElement("button", { type: "button", role: "menuitem", onClick }, children),
    ContextMenuSeparator: () => null,
    ContextMenuTrigger: ({ children }: { children: unknown }) => {
      const menu = React.useContext(MenuContext) as { setOpen: (open: boolean) => void } | null;
      return React.createElement(
        "div",
        {
          "data-testid": "context-menu-trigger",
          onContextMenu: (event: { preventDefault: () => void }) => {
            event.preventDefault();
            menu?.setOpen(true);
          },
        },
        children,
      );
    },
  };
});

import { StudioWorkspace } from "@/workspace/StudioWorkspace";
import type { WorkspaceObjectReader, WorkspaceQueryResult } from "@/workspace/types";
import type { ProviderCapabilities } from "@/lib/db/types";

const DIMENSION = 768;
/** 768 elements cycling -1, -0.75, ..., 1: each exact in float32, and -1, 0 and 1 integral. */
const EMBEDDING = Array.from({ length: DIMENSION }, (_, index) => ((index % 9) - 4) / 4);
const DISPLAY = "[-1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, …] 768 dims";
const COPY = `[${EMBEDDING.map((value) => (Number.isInteger(value) ? value.toFixed(1) : String(value))).join(",")}]`;
const PAYLOAD = new Uint8Array(100).fill(0xab);
const PAYLOAD_PREVIEW = `\\x${"ab".repeat(32)}... (100 B)`;
const PAYLOAD_COPY = `\\x${"ab".repeat(100)}`;

/** A relation-only host, so a click on its one table runs a statement through `onQueryExecute`. */
const capabilities = {
  queryLanguage: "sql",
  containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
  objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
} as unknown as ProviderCapabilities;

const reader: WorkspaceObjectReader = {
  listContainers: async () => [{ path: ["app"], level: 0, name: "app", isSessionDefault: true }],
  countObjects: async () => ({ table: { count: 1 } }),
  listObjects: async () => [{ path: ["app", "embeddings"], name: "embeddings", kind: "table" }],
};

const realFetch = globalThis.fetch;
const writeText = mock(async (text: string) => {
  void text;
});
let executed: string[] = [];

function hostAnswer(vectorColumns?: WorkspaceQueryResult["vectorColumns"]): WorkspaceQueryResult {
  return {
    rows: [{ id: 1, embedding: EMBEDDING, payload: PAYLOAD }],
    fields: ["id", "embedding", "payload"],
    rowCount: 1,
    executionTime: 1,
    ...(vectorColumns === undefined ? {} : { vectorColumns }),
  };
}

function mountHost(answer: WorkspaceQueryResult) {
  executed = [];
  return render(
    <StudioWorkspace
      connections={[{ id: "host-conn-1", name: "Vector host", type: "postgres", capabilities }]}
      onQueryExecute={async (_connectionId, query) => {
        executed.push(query);
        return answer;
      }}
      onSchemaFetch={async () => []}
      onObjectsFetch={reader}
    />,
  );
}

/** Opens the host's Tables folder and activates its one table, which runs it; answers the desktop grid. */
async function runTheTable(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("treeitem", { name: /Tables/ }));
  await userEvent.click(await screen.findByRole("treeitem", { name: /embeddings/ }));
  await waitFor(() => expect(executed).toHaveLength(1));
  return waitFor(() => {
    const grid = document.querySelector<HTMLElement>("[data-desktop-grid]");
    if (grid === null) throw new Error("no desktop grid yet");
    return grid;
  });
}

async function copyCell(grid: HTMLElement, text: string): Promise<void> {
  const cell = await within(grid).findByText(text);
  fireEvent.contextMenu(cell);
  const menu = cell.closest<HTMLElement>('[data-testid="result-context-menu"]');
  if (menu === null) throw new Error(`no copy menu around ${text.slice(0, 40)}`);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy Cell" }));
}

beforeEach(() => {
  localStorage.clear();
  writeText.mockClear();
  Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText }, configurable: true });
  // The shell has no routes of its own; any request it made would be a defect, answered here with a refusal.
  globalThis.fetch = mock(async () => Response.json({ error: "no route here" }, { status: 404 })) as never;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("a host mounting StudioWorkspace", () => {
  test("a 768-dimension vector column the host declares renders as a vector cell and copies whole", async () => {
    mountHost(hostAnswer({ embedding: { kind: "dense", dtype: "float32", dimension: DIMENSION } }));
    const grid = await runTheTable();
    await copyCell(grid, DISPLAY);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(COPY));
  });

  test("a binary value the host returns copies every byte, not its preview", async () => {
    mountHost(hostAnswer());
    const grid = await runTheTable();
    await copyCell(grid, PAYLOAD_PREVIEW);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PAYLOAD_COPY));
  });

  test("a host that declares no vector column gets the JSON cell it got before", async () => {
    mountHost(hostAnswer());
    const grid = await runTheTable();
    const json = JSON.stringify(EMBEDDING);
    await copyCell(grid, json);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(json));
  });
});
