import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { mock } from "bun:test";

// cmdk is replaced by plain elements, as tests/components/CommandPalette.test.tsx replaces it. `@/lib/db-ui-config` is
// NOT mocked here (FND-1): the palette's icon lookup has to meet a type no provider has for real.
mock.module("cmdk", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  const Command = React.forwardRef(({ children, ...props }: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
    React.createElement("div", { ...props, ref, "data-testid": "command" }, children),
  );
  Command.displayName = "Command";

  const CommandInput = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
    React.createElement("input", { ...props, ref, "data-testid": "command-input" }),
  );
  CommandInput.displayName = "CommandInput";
  Command.Input = CommandInput;

  const CommandList = ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", { ...props, "data-testid": "command-list" }, children);
  CommandList.displayName = "CommandList";
  Command.List = CommandList;

  const CommandEmpty = ({ children }: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "command-empty" }, children);
  CommandEmpty.displayName = "CommandEmpty";
  Command.Empty = CommandEmpty;

  const CommandGroup = ({ children, heading, ...props }: Record<string, unknown>) =>
    React.createElement(
      "div",
      { ...props, "data-testid": `command-group-${heading}` },
      React.createElement("div", null, heading),
      children,
    );
  CommandGroup.displayName = "CommandGroup";
  Command.Group = CommandGroup;

  const CommandItem = ({ children, onSelect, ...props }: Record<string, unknown>) =>
    React.createElement(
      "div",
      { ...props, onClick: onSelect, role: "option", "data-testid": "command-item" },
      children,
    );
  CommandItem.displayName = "CommandItem";
  Command.Item = CommandItem;

  const CommandSeparator = () => null;
  CommandSeparator.displayName = "CommandSeparator";
  Command.Separator = CommandSeparator;

  return { Command };
});

// Mock storage

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { CommandPalette } from "@/components/CommandPalette";
import { ABSENT_TYPE_SENTENCE, MALFORMED_TYPE_SENTENCE, unknownTypeSentence } from "@/lib/db/type-id";
import type { DatabaseConnection } from "@/lib/types";
import { mockToastError } from "../helpers/mock-sonner";

const postgres: DatabaseConnection = {
  id: "pg-1",
  name: "Orders",
  type: "postgres",
  host: "localhost",
  port: 5432,
  createdAt: new Date("2026-11-20T10:00:00.000Z"),
};
const unknown = { ...postgres, id: "u-1", name: "Acme Store", type: "acmefoo" } as unknown as DatabaseConnection;

function renderPalette(
  onSelectConnection = mock<(conn: DatabaseConnection) => void>(() => {}),
  onLoadSavedQuery = mock<(query: string) => void>(() => {}),
) {
  const noop = () => {};
  const view = render(
    <CommandPalette
      connections={[postgres, unknown]}
      activeConnection={postgres}
      schema={[]}
      onSelectConnection={onSelectConnection}
      onTableClick={noop}
      onExecuteQuery={noop}
      onLoadSavedQuery={onLoadSavedQuery}
      onLoadHistoryQuery={noop}
      onNavigateHealth={noop}
      onNavigateMonitoring={noop}
      onShowDiagram={noop}
      onFormatQuery={noop}
      onSaveQuery={noop}
      onShowShortcuts={noop}
      onLogout={noop}
    />,
  );
  fireEvent.keyDown(document, { key: "k", code: "KeyK", metaKey: true });
  return { ...view, onSelectConnection, onLoadSavedQuery };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("the command palette and a connection whose type names no provider (FND-1)", () => {
  test("lists it as Unavailable, with the reason, beside the active one", () => {
    const { getByTestId } = renderPalette();
    const group = within(getByTestId("command-group-Connections"));

    expect(group.getByText("Orders")).toBeTruthy();
    expect(group.getByText("Active")).toBeTruthy();
    expect(group.getByText("Acme Store")).toBeTruthy();
    expect(group.getByTitle(unknownTypeSentence("acmefoo")).textContent).toBe("Unavailable");
  });

  test("selecting it hands it to onSelectConnection, which decides", async () => {
    const { getByText, onSelectConnection } = renderPalette();

    fireEvent.click(getByText("Acme Store"));

    await waitFor(() => expect(onSelectConnection).toHaveBeenCalledWith(unknown));
  });
});

describe("the command palette and a saved query whose type names no provider (FND-1)", () => {
  const savedQuery = (id: string, name: unknown, query: string, connectionType: unknown) => ({
    id,
    name,
    query,
    connectionType,
    createdAt: "2026-11-21T10:00:00.000Z",
    updatedAt: "2026-11-21T10:00:00.000Z",
  });
  const acme = savedQuery("acme", "Acme query", "FIND acme", "acmefoo");
  const pg = savedQuery("pg", "Orders report", "SELECT 1", "postgres");

  function storeSavedQueries(records: readonly Record<string, unknown>[]) {
    localStorage.setItem("libredb_saved_queries", JSON.stringify(records));
  }

  beforeEach(() => {
    mockToastError.mockClear();
  });

  test("lists a saved query whose type names no provider as Unavailable, with the reason", () => {
    storeSavedQueries([acme, pg]);
    const { getByTestId } = renderPalette();
    const group = within(getByTestId("command-group-Saved Queries"));

    expect(group.getByText("Acme query")).toBeTruthy();
    expect(group.getByTitle(unknownTypeSentence("acmefoo")).textContent).toBe("Unavailable");
    expect(group.queryByText("FIND acme")).toBeNull();
    expect(group.getByText("SELECT 1")).toBeTruthy();
  });

  test("a pick of it is refused by name and loads nothing", async () => {
    storeSavedQueries([acme, pg]);
    const { getByText, onLoadSavedQuery } = renderPalette();

    fireEvent.click(getByText("Acme query"));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Saved query unavailable", {
        description: `Acme query: ${unknownTypeSentence("acmefoo")}`,
      }),
    );
    expect(onLoadSavedQuery).not.toHaveBeenCalled();
  });

  test("a saved query with no type, a type that is not text, or no name is refused in its own words", async () => {
    const untyped = savedQuery("untyped", "Untyped query", "FIND untyped", undefined);
    const malformed = savedQuery("malformed", "Malformed query", "FIND malformed", { id: "postgres" });
    const nameless = savedQuery("nameless", "", "FIND nameless", "acmefoo");
    const unnamed = savedQuery("unnamed", undefined, "FIND unnamed", "acmefoo");
    storeSavedQueries([untyped, malformed, nameless, unnamed]);
    const { getByTestId, onLoadSavedQuery } = renderPalette();
    const savedGroup = () => within(getByTestId("command-group-Saved Queries"));

    expect(savedGroup().getByTitle(ABSENT_TYPE_SENTENCE).textContent).toBe("Unavailable");
    expect(savedGroup().getByTitle(MALFORMED_TYPE_SENTENCE).textContent).toBe("Unavailable");
    // A pick closes the palette, so it is opened again before each one.
    for (let index = 0; index < 4; index++) {
      if (index > 0) fireEvent.keyDown(document, { key: "k", code: "KeyK", metaKey: true });
      fireEvent.click(savedGroup().getAllByRole("option")[index]);
      await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(index + 1));
    }

    expect(mockToastError.mock.calls).toEqual([
      ["Saved query unavailable", { description: `Untyped query: ${ABSENT_TYPE_SENTENCE}` }],
      ["Saved query unavailable", { description: `Malformed query: ${MALFORMED_TYPE_SENTENCE}` }],
      ["Saved query unavailable", { description: `This saved query: ${unknownTypeSentence("acmefoo")}` }],
      ["Saved query unavailable", { description: `This saved query: ${unknownTypeSentence("acmefoo")}` }],
    ]);
    expect(onLoadSavedQuery).not.toHaveBeenCalled();
  });

  test("a saved query of a type id still loads", async () => {
    storeSavedQueries([acme, pg]);
    const { getByText, onLoadSavedQuery } = renderPalette();

    fireEvent.click(getByText("Orders report"));

    await waitFor(() => expect(onLoadSavedQuery).toHaveBeenCalledWith("SELECT 1"));
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
