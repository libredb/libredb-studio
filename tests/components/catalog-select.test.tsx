import "../setup-dom";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { CatalogSelect } from "@/components/catalog-select";

/** The database a server-level connection reads, one select for every surface (#1530). */
afterEach(cleanup);

describe("CatalogSelect", () => {
  test("draws nothing on a connection that lists no databases", () => {
    const view = render(<CatalogSelect catalogs={[]} value={undefined} onChange={() => {}} />);
    expect(view.container.innerHTML).toBe("");
  });

  test("shows the chosen database and hands a new choice over", () => {
    const onChange = mock((_catalog: string) => {});
    const view = render(<CatalogSelect catalogs={["analytics", "shop"]} value="shop" onChange={onChange} />);
    const trigger = view.getByRole("combobox", { name: "Database" });
    expect(trigger.textContent).toContain("shop");
    expect(trigger.getAttribute("title")).toBe("Database");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(view.getByRole("option", { name: "analytics" }), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("analytics");
  });

  test("a disabled select says why", () => {
    const view = render(
      <CatalogSelect
        catalogs={["shop"]}
        value="shop"
        onChange={() => {}}
        disabled
        disabledReason="The open transaction runs in this database"
      />,
    );
    const trigger = view.getByRole("combobox", { name: "Database" });
    expect(trigger.getAttribute("title")).toBe("The open transaction runs in this database");
    expect(trigger.hasAttribute("disabled")).toBe(true);
  });
});
