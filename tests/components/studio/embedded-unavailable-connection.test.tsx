import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    QueryEditor: (props: { databaseType?: unknown }) => {
      editorTypes.push(props.databaseType);
      return React.createElement("div", { "data-testid": "query-editor" });
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
import { ABSENT_TYPE_SENTENCE, MALFORMED_TYPE_SENTENCE, unknownTypeSentence } from "@/lib/db/type-id";

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

function workspace(connections: WorkspaceConnection[], onSchemaFetch: (id: string) => Promise<[]>) {
  return (
    <StudioWorkspace
      connections={connections}
      onQueryExecute={async () => ({ rows: [], fields: [], rowCount: 0, executionTime: 1 })}
      onSchemaFetch={onSchemaFetch}
      onObjectsFetch={reader}
    />
  );
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

  test("a host list that gives the open connection such a type moves the editor to one a provider can open and says why", async () => {
    const asked: string[] = [];
    const onSchemaFetch = async (id: string): Promise<[]> => {
      asked.push(id);
      return [];
    };
    const { rerender } = render(workspace([P1, P2], onSchemaFetch));
    await waitFor(() => expect(asked).toEqual(["p1"]));

    const retyped = { ...P1, type: "acmefoo" } as unknown as WorkspaceConnection;
    rerender(workspace([retyped, P2], onSchemaFetch));

    await waitFor(() => expect(asked).toEqual(["p1", "p2"]));
    expect(editorTypes).not.toContain("acmefoo");
    expect(editorTypes.at(-1)).toBe("postgres");
    const line = screen.getByTestId("workspace-connection-refusal");
    expect(line.textContent).toContain(`DB One: ${ACME_SENTENCE}`);
    expect(markerTitle("DB One")).toBe(ACME_SENTENCE);
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
