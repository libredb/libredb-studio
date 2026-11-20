import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ConnectionItem } from "@/components/sidebar/ConnectionItem";
import { ConnectionsList } from "@/components/sidebar/ConnectionsList";
import { ABSENT_TYPE_SENTENCE, unknownTypeSentence } from "@/lib/db/type-id";
import type { DatabaseConnection } from "@/lib/types";

/*
 * FND-1: a stored connection whose type names no provider, drawn by the real sidebar row and list. This file does not
 * mock `@/lib/db-ui-config`, as the other sidebar tests do: with the module mocked, the row's icon lookup answered for
 * any type, which is why a render that threw on every load with such a record stored was never caught.
 */

const postgres: DatabaseConnection = {
  id: "pg-1",
  name: "Orders",
  type: "postgres",
  host: "localhost",
  port: 5432,
  createdAt: new Date("2026-11-20T10:00:00.000Z"),
};
const unknown = { ...postgres, id: "u-1", name: "Acme Store", type: "acmefoo" } as unknown as DatabaseConnection;
const untyped = (() => {
  const record: Record<string, unknown> = { ...postgres, id: "n-1", name: "Untyped Record" };
  delete record.type;
  return record as unknown as DatabaseConnection;
})();

function renderItem(connection: DatabaseConnection) {
  const handlers = {
    onSelect: mock<(conn: DatabaseConnection) => void>(() => {}),
    onDelete: mock<(id: string) => void>(() => {}),
    onEdit: mock<(conn: DatabaseConnection) => void>(() => {}),
    onDuplicate: mock<(conn: DatabaseConnection) => void>(() => {}),
  };
  const view = render(<ConnectionItem connection={connection} isActive={false} {...handlers} />);
  const row = view.getAllByRole("button")[0];
  return { ...view, row, handlers };
}

afterEach(() => {
  cleanup();
});

describe("a sidebar row for a connection whose type names no provider", () => {
  test("renders with its name, Unavailable and the reason, and offers no Edit or Duplicate", () => {
    const { row } = renderItem(unknown);
    const sentence = unknownTypeSentence("acmefoo");

    expect(within(row).getByText("Acme Store")).toBeTruthy();
    const marker = within(row).getByTitle(sentence);
    expect(marker.textContent).toContain("Unavailable");
    expect(marker.textContent).toContain(sentence);
    // Not aria-disabled: that would read its Delete button as disabled to assistive technology.
    expect(row.getAttribute("aria-disabled")).toBeNull();
    expect(within(row).queryByRole("button", { name: "Edit connection" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Duplicate connection" })).toBeNull();
  });

  test("a read-only record draws no read-only marker, which would be a claim about an engine Studio does not have", () => {
    const { row } = renderItem({ ...unknown, readOnly: true });

    expect(within(row).queryByTitle("Writes, value edits and maintenance are refused on this connection")).toBeNull();
    expect(within(row).getByTitle(unknownTypeSentence("acmefoo")).textContent).toContain("Unavailable");
  });

  test("a row with no type says it names none", () => {
    const { row } = renderItem(untyped);

    expect(within(row).getByText("Untyped Record")).toBeTruthy();
    expect(within(row).getByTitle(ABSENT_TYPE_SENTENCE).textContent).toContain("Unavailable");
  });

  test("its Delete button deletes it", () => {
    const { row, handlers } = renderItem(unknown);

    fireEvent.click(within(row).getByRole("button", { name: "Delete connection" }));

    expect(handlers.onDelete).toHaveBeenCalledWith("u-1");
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  test("a click and Enter hand it to onSelect, which decides", () => {
    const { row, handlers } = renderItem(unknown);

    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });

    expect(handlers.onSelect).toHaveBeenCalledTimes(2);
    expect(handlers.onSelect).toHaveBeenCalledWith(unknown);
  });

  test("the list draws every row, the unavailable ones beside the rest", () => {
    render(
      <ConnectionsList
        connections={[postgres, unknown, untyped]}
        activeConnection={postgres}
        onSelectConnection={() => {}}
        onDeleteConnection={() => {}}
      />,
    );

    expect(screen.getByText("Orders")).toBeTruthy();
    expect(screen.getByText("Acme Store")).toBeTruthy();
    expect(screen.getByText("Untyped Record")).toBeTruthy();
    expect(screen.getAllByTitle(/is installed in this LibreDB Studio|names no type/)).toHaveLength(2);
  });

  test("the control: a postgres row draws its engine, Edit and Duplicate as before", () => {
    const { row } = renderItem(postgres);

    expect(row.getAttribute("aria-disabled")).toBeNull();
    expect(within(row).queryByText("Unavailable")).toBeNull();
    expect(within(row).getByRole("button", { name: "Edit connection" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Duplicate connection" })).toBeTruthy();
  });
});
