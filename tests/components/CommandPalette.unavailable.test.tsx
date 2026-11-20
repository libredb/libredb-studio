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

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { CommandPalette } from "@/components/CommandPalette";
import { unknownTypeSentence } from "@/lib/db/type-id";
import type { DatabaseConnection } from "@/lib/types";

const postgres: DatabaseConnection = {
  id: "pg-1",
  name: "Orders",
  type: "postgres",
  host: "localhost",
  port: 5432,
  createdAt: new Date("2026-11-20T10:00:00.000Z"),
};
const unknown = { ...postgres, id: "u-1", name: "Acme Store", type: "acmefoo" } as unknown as DatabaseConnection;

function renderPalette(onSelectConnection = mock<(conn: DatabaseConnection) => void>(() => {})) {
  const noop = () => {};
  const view = render(
    <CommandPalette
      connections={[postgres, unknown]}
      activeConnection={postgres}
      schema={[]}
      onSelectConnection={onSelectConnection}
      onTableClick={noop}
      onExecuteQuery={noop}
      onLoadSavedQuery={noop}
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
  return { ...view, onSelectConnection };
}

afterEach(() => {
  cleanup();
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
