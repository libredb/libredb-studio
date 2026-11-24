import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { setupFramerMotionMock, setupMonacoMock } from "../../helpers/mock-monaco";

setupMonacoMock();
setupFramerMotionMock();

/**
 * Every `databaseType` the workspace hands its editor, in order. The editor is the first reader of the active
 * connection's type, so a value here that is not a type id is the defect this file pins: everything downstream of the
 * editor (its grammar, the statement refusal, paging, export, the schema diff) reads the same value.
 */
const editorTypes: unknown[] = [];

// The editor and the panel library are replaced exactly as `embedded-object-tree.test.tsx` replaces them: Monaco and
// `react-resizable-panels` are hostile to happy-dom. Everything between the published prop and the editor's prop is
// the real code, adapter, sidebar and bottom panel included.
mock.module("@/components/QueryEditor", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    // A button that types a destructive statement, so a run can raise the safety confirmation.
    QueryEditor: (props: { databaseType?: unknown; onContentChange?: (value: string) => void }) => {
      editorTypes.push(props.databaseType);
      return React.createElement(
        "button",
        { "data-testid": "query-editor", onClick: () => props.onContentChange?.("DROP TABLE users") },
        "editor",
      );
    },
  };
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

import { StudioWorkspace, type WorkspaceConnection, type WorkspaceObjectReader } from "@/exports/workspace";
import type { SavedQueryInput, WorkspaceQueryResult } from "@/workspace/types";
import { ABSENT_TYPE_SENTENCE, MALFORMED_TYPE_SENTENCE, unknownTypeSentence } from "@/lib/db/type-id";
import { CONFIRMED_ELSEWHERE_SENTENCE } from "@/workspace/hooks/use-query-adapter";

const ACME_SENTENCE = unknownTypeSentence("acmefoo");

// Host connections as a host application may build them: the casts are the point, a host is ordinary JavaScript.
const U = { id: "u", name: "Acme", type: "acmefoo" } as unknown as WorkspaceConnection;
const N = { id: "n", name: "Untyped" } as unknown as WorkspaceConnection;
const M = { id: "m", name: "Malformed", type: { id: "postgres" } } as unknown as WorkspaceConnection;
const P1: WorkspaceConnection = { id: "p1", name: "DB One", type: "postgres" };
const P2: WorkspaceConnection = { id: "p2", name: "DB Two", type: "postgres" };

/** A host that answers every object read with nothing. */
const reader: WorkspaceObjectReader = {
  listContainers: async () => [],
  countObjects: async () => ({}),
  listObjects: async () => [],
};

interface HostCallbacks {
  onQueryExecute?: (id: string, sql: string) => Promise<WorkspaceQueryResult>;
  onSaveQuery?: (query: SavedQueryInput) => Promise<void>;
}

function workspace(
  connections: WorkspaceConnection[],
  onSchemaFetch: (id: string) => Promise<[]>,
  {
    onQueryExecute = async () => ({ rows: [], fields: [], rowCount: 0, executionTime: 1 }),
    onSaveQuery,
  }: HostCallbacks = {},
) {
  return (
    <StudioWorkspace
      connections={connections}
      onQueryExecute={onQueryExecute}
      onSchemaFetch={onSchemaFetch}
      onObjectsFetch={reader}
      onSaveQuery={onSaveQuery}
    />
  );
}

const noSchema = async (): Promise<[]> => [];

/** Below the mobile breakpoint, through `window.matchMedia` as `StudioWorkspace.test.tsx` drives it. */
const originalMatchMedia = window.matchMedia;
function setViewportMobile(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

/** The sidebar row of the connection named `name`. */
function row(name: string): HTMLElement {
  const label = screen.getByText(name, { selector: "span[title]" });
  const element = label.closest('[role="button"]');
  if (!(element instanceof HTMLElement)) throw new Error(`no row for ${name}`);
  return element;
}

/** The title of the Unavailable marker on the row of the connection named `name`. */
function markerTitle(name: string): string | null {
  return within(row(name)).getByText("Unavailable").getAttribute("title");
}

afterEach(() => {
  cleanup();
  editorTypes.length = 0;
  window.matchMedia = originalMatchMedia;
});

describe("the embedded workspace and a host connection whose type names no provider (FND-1)", () => {
  test("lists a host connection whose type names no provider as Unavailable and opens the first one a provider can open", async () => {
    const asked: string[] = [];
    render(
      workspace([U, P1], async (id) => {
        asked.push(id);
        return [];
      }),
    );

    await waitFor(() => expect(asked).toEqual(["p1"]));
    expect(markerTitle("Acme")).toBe(ACME_SENTENCE);
    expect(editorTypes).not.toContain("acmefoo");
    expect(editorTypes.at(-1)).toBe("postgres");
  });

  test("a pick of it is refused on a line of the workspace's own, and the editor keeps its connection", async () => {
    const asked: string[] = [];
    render(
      workspace([P1, U], async (id) => {
        asked.push(id);
        return [];
      }),
    );
    await waitFor(() => expect(asked).toEqual(["p1"]));

    fireEvent.click(row("Acme"));

    const line = await screen.findByTestId("workspace-connection-refusal");
    expect(line.textContent).toContain("Connection unavailable");
    expect(line.textContent).toContain(`Acme: ${ACME_SENTENCE}`);
    expect(editorTypes).not.toContain("acmefoo");
    expect(editorTypes.at(-1)).toBe("postgres");
    expect(asked).not.toContain("u");

    fireEvent.click(within(line).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("workspace-connection-refusal")).toBeNull();
    expect(editorTypes.at(-1)).toBe("postgres");
  });

  test("a host list that gives the open connection such a type closes it without opening another, and says why", async () => {
    const asked: string[] = [];
    const onSchemaFetch = async (id: string): Promise<[]> => {
      asked.push(id);
      return [];
    };
    const { rerender } = render(workspace([P1, P2], onSchemaFetch));
    await waitFor(() => expect(asked).toEqual(["p1"]));

    const retyped = { ...P1, type: "acmefoo" } as unknown as WorkspaceConnection;
    rerender(workspace([retyped, P2], onSchemaFetch));

    const line = await screen.findByTestId("workspace-connection-refusal");
    expect(line.textContent).toContain(`DB One: ${ACME_SENTENCE}`);
    expect(markerTitle("DB One")).toBe(ACME_SENTENCE);
    expect(asked).toEqual(["p1"]);
    expect(editorTypes).not.toContain("acmefoo");
    expect(editorTypes.at(-1)).toBeUndefined();
    expect((screen.getByRole("button", { name: /RUN/ }) as HTMLButtonElement).disabled).toBe(true);

    // The host gives the type back: the same connection opens again and the line goes with what it said.
    rerender(workspace([P1, P2], onSchemaFetch));
    await waitFor(() => expect(asked).toEqual(["p1", "p1"]));
    expect(editorTypes.at(-1)).toBe("postgres");
    expect(screen.queryByTestId("workspace-connection-refusal")).toBeNull();
  });

  test("below the mobile breakpoint a host list with nothing to open says why on the line", async () => {
    setViewportMobile(true);
    render(workspace([U], noSchema));

    const line = await screen.findByTestId("workspace-connection-refusal");
    expect(line.textContent).toContain(`Acme: ${ACME_SENTENCE}`);
    expect((screen.getByRole("button", { name: /RUN/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("offers no Save while no connection is open", async () => {
    render(workspace([U], noSchema, { onSaveQuery: async () => {} }));

    await screen.findByTestId("workspace-connection-refusal");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  test("a Save dialog left open while the host retypes the connection saves under the type it was opened for", async () => {
    const saved: SavedQueryInput[] = [];
    const onSaveQuery = async (query: SavedQueryInput) => {
      saved.push(query);
    };
    const { rerender } = render(workspace([P1], noSchema, { onSaveQuery }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    fireEvent.change(await screen.findByPlaceholderText("e.g. Monthly Active Users"), { target: { value: "Q1" } });

    rerender(workspace([{ ...P1, type: "acmefoo" } as unknown as WorkspaceConnection], noSchema, { onSaveQuery }));
    await screen.findByTestId("workspace-connection-refusal");
    fireEvent.click(screen.getByRole("button", { name: "Save Query" }));

    await waitFor(() => expect(saved.map((query) => [query.name, query.connectionType])).toEqual([["Q1", "postgres"]]));
  });

  test("in a host build, a Save dialog left open while the host retypes the connection saves the text it was opened on", async () => {
    // A host bundle runs with workspace persistence on (`useTabManager` turns it off only under NODE_ENV "test"), so the
    // retype that closes the connection loads another workspace's tabs under the open dialog. Restored below.
    const env = process.env as Record<string, string | undefined>;
    const nodeEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      const saved: SavedQueryInput[] = [];
      const onSaveQuery = async (query: SavedQueryInput) => {
        saved.push(query);
      };
      const { rerender } = render(workspace([P1], noSchema, { onSaveQuery }));
      fireEvent.click(await screen.findByTestId("query-editor"));
      fireEvent.click(await screen.findByRole("button", { name: "Save" }));
      fireEvent.change(await screen.findByPlaceholderText("e.g. Monthly Active Users"), { target: { value: "Q1" } });
      expect(within(screen.getByRole("dialog")).getByText("DROP TABLE users")).toBeTruthy();

      rerender(workspace([{ ...P1, type: "acmefoo" } as unknown as WorkspaceConnection], noSchema, { onSaveQuery }));
      await screen.findByTestId("workspace-connection-refusal");
      expect(within(screen.getByRole("dialog")).getByText("DROP TABLE users")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Save Query" }));

      await waitFor(() =>
        expect(saved.map((query) => [query.name, query.query, query.connectionType])).toEqual([
          ["Q1", "DROP TABLE users", "postgres"],
        ]),
      );
    } finally {
      env.NODE_ENV = nodeEnv;
      localStorage.clear();
    }
  });

  async function confirmThenRerender(next: WorkspaceConnection[]) {
    const executed: [string, string][] = [];
    const onQueryExecute = async (id: string, sql: string) => {
      executed.push([id, sql]);
      return { rows: [], fields: [], rowCount: 0, executionTime: 1 };
    };
    const { rerender } = render(workspace([P1, P2], noSchema, { onQueryExecute }));
    fireEvent.click(screen.getByTestId("query-editor"));
    fireEvent.click(screen.getByRole("button", { name: /RUN/ }));
    const proceed = await screen.findByRole("button", { name: /Proceed/ });
    await waitFor(() => expect((proceed as HTMLButtonElement).disabled).toBe(false));

    rerender(workspace(next, noSchema, { onQueryExecute }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Proceed/ }));
    });
    return executed;
  }

  test("Proceed runs nothing once the host has retyped the connection the statement was confirmed for", async () => {
    const executed = await confirmThenRerender([{ ...P1, type: "acmefoo" } as unknown as WorkspaceConnection, P2]);

    expect(executed).toEqual([]);
    expect(await screen.findByText(CONFIRMED_ELSEWHERE_SENTENCE)).toBeTruthy();
  });

  test("Proceed runs nothing on the connection the shell falls back to once the host has dropped the confirmed one", async () => {
    const executed = await confirmThenRerender([P2]);

    expect(executed).toEqual([]);
    expect(await screen.findByText(CONFIRMED_ELSEWHERE_SENTENCE)).toBeTruthy();
  });

  test("a host connection with no type, or a type that is not text, is listed with its reason and never handed to the editor", async () => {
    const asked: string[] = [];
    render(
      workspace([N, M, P1], async (id) => {
        asked.push(id);
        return [];
      }),
    );

    await waitFor(() => expect(asked).toEqual(["p1"]));
    expect(markerTitle("Untyped")).toBe(ABSENT_TYPE_SENTENCE);
    expect(markerTitle("Malformed")).toBe(MALFORMED_TYPE_SENTENCE);
    expect(editorTypes.length).toBeGreaterThan(0);
    expect(editorTypes.every((type) => type === "postgres")).toBe(true);
  });
});
