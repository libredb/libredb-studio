import "../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import React from "react";

/**
 * Whether the dialog draws its mobile drawer. A flag rather than a fixed answer, so one file drives both the desktop
 * dialog and the drawer; every test sets it, and `afterEach` puts it back.
 */
let mobile = false;
mock.module("@/hooks/use-mobile", () => ({ useIsMobile: () => mobile }));

// The drawer as a passthrough, as tests/components/ConnectionModal.mobile.test.tsx mocks it: vaul's own drawer is not
// what this file tests, and only the mobile path renders it.
mock.module("@/components/ui/drawer", () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children);
  return {
    Drawer: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
      open ? React.createElement("div", { "data-testid": "drawer" }, children) : null,
    DrawerContent: passthrough,
    DrawerHeader: passthrough,
    DrawerTitle: ({ children }: { children?: React.ReactNode }) => React.createElement("h2", null, children),
    DrawerDescription: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("p", { "data-testid": "drawer-description" }, children),
  };
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionGlobalConfig } from "framer-motion";

import { ConnectionModal } from "@/exports/components";
import { ABSENT_TYPE_SENTENCE, MALFORMED_TYPE_SENTENCE, unknownTypeSentence } from "@/lib/db/type-id";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The published connection dialog handed a connection to edit whose type names no provider (FND-1), through the real
 * form hook and the real `DB_UI_CONFIG`: tests/components/ConnectionModal.test.tsx and ConnectionModal.mobile.test.tsx
 * mock both, and a dialog test against a mocked `getDBConfig` passes whatever the dialog does with such a type.
 *
 * A host application hands the dialog any record it holds. Such a record is refused by name in place of the form,
 * open or closed, and nothing is tested, saved, or rebound to the picker's default engine.
 */

// The dialog's banners animate in; happy-dom cancels an animation still running when the test ends.
MotionGlobalConfig.skipAnimations = true;

afterEach(() => {
  cleanup();
  mobile = false;
});

/** A fabricated credential, only ever looked for in the dialog's inputs. */
const CANARY = "SEED-CANARY-7f3a";

const record = (fields: object) => ({ createdAt: new Date(0), ...fields }) as unknown as DatabaseConnection;
const U = record({ id: "u", name: "Acme", type: "acmefoo", host: "acme.internal", port: 7000 });
const P1 = record({
  id: "p1",
  name: "DB One",
  type: "postgres",
  host: "one.internal",
  user: "reader",
  password: CANARY,
});
const P2 = record({ id: "p2", name: "DB Two", type: "postgres", host: "two.internal" });

function dialog(editConnection: DatabaseConnection, isOpen = true) {
  const onClose = mock(() => {});
  const onConnect = mock<(conn: DatabaseConnection) => void>(() => {});
  const onTestConnection = mock<(conn: DatabaseConnection) => Promise<{ success: boolean }>>(async () => ({
    success: true,
  }));
  const element = (target: DatabaseConnection, open = isOpen) => (
    <ConnectionModal
      isOpen={open}
      onClose={onClose}
      onConnect={onConnect}
      editConnection={target}
      onTestConnection={onTestConnection}
    />
  );
  const view = render(element(editConnection));
  return { ...view, element, onClose, onConnect, onTestConnection };
}

/** The value in the Host box, which the dialog draws with the id `host`. */
function hostBox(): string | undefined {
  return (document.getElementById("host") as HTMLInputElement | null)?.value;
}

/** The refusal the dialog draws in place of its form, asserted whole. */
function expectRefusal(line: string): void {
  expect(screen.getByRole("heading", { name: "Connection unavailable" })).toBeTruthy();
  expect(screen.getByTestId("connection-edit-refusal").textContent).toBe(line);
  expect(screen.queryByRole("button", { name: "Save Changes" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Test Connection/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Paste URL/ })).toBeNull();
  expect(screen.queryAllByRole("textbox")).toEqual([]);
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
}

describe("the published ConnectionModal and a connection whose type names no provider (FND-1)", () => {
  test("refuses to edit a connection whose type names no provider, by name, with no form", () => {
    dialog(U);

    expectRefusal(`Acme: ${unknownTypeSentence("acmefoo")}`);
    // The dialog's accessible description is the refusal too, so a screen reader is not read the form's description.
    const describedBy = screen.getByRole("dialog").getAttribute("aria-describedby");
    expect(describedBy === null ? null : document.getElementById(describedBy)?.textContent).toBe(
      `Acme: ${unknownTypeSentence("acmefoo")}`,
    );
  });

  test("names a connection with no type, a type that is not text, or a prototype key in its own words", () => {
    const cases: [DatabaseConnection, string][] = [
      [record({ id: "n", name: "Untyped" }), `Untyped: ${ABSENT_TYPE_SENTENCE}`],
      [record({ id: "m", name: "Malformed", type: { id: "postgres" } }), `Malformed: ${MALFORMED_TYPE_SENTENCE}`],
      [record({ id: "c", name: "Proto", type: "constructor" }), `Proto: ${unknownTypeSentence("constructor")}`],
    ];
    for (const [target, line] of cases) {
      dialog(target);
      expectRefusal(line);
      cleanup();
    }
  });

  test("a closed dialog handed such a connection renders nothing and does not throw", () => {
    for (const target of [U, record({ id: "u2", name: "Acme", type: "acmefoo" })]) {
      dialog(target, false);
      expect(screen.queryByRole("dialog")).toBeNull();
      cleanup();
    }
  });

  test("Close closes it, and nothing is tested or saved", () => {
    const { onClose, onConnect, onTestConnection } = dialog(U);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConnect).not.toHaveBeenCalled();
    expect(onTestConnection).not.toHaveBeenCalled();
  });

  test("an earlier target's values are withdrawn, and a later target a provider can open is edited as before", () => {
    const { rerender, element } = dialog(P1);
    expect(hostBox()).toBe("one.internal");

    rerender(element(U));
    expectRefusal(`Acme: ${unknownTypeSentence("acmefoo")}`);
    const values = Array.from(document.querySelectorAll("input"), (input) => input.value);
    expect(values).not.toContain(CANARY);

    rerender(element(P2));
    expect(screen.queryByTestId("connection-edit-refusal")).toBeNull();
    expect(hostBox()).toBe("two.internal");
  });

  test("the mobile drawer shows the same refusal", () => {
    mobile = true;
    dialog(U);

    expect(screen.getByTestId("drawer")).toBeTruthy();
    expectRefusal(`Acme: ${unknownTypeSentence("acmefoo")}`);
    expect(screen.getByTestId("drawer-description").textContent).toBe(`Acme: ${unknownTypeSentence("acmefoo")}`);
  });

  test("control: a connection a provider can open is edited as before", () => {
    dialog(P2);

    expect(screen.queryByTestId("connection-edit-refusal")).toBeNull();
    expect(hostBox()).toBe("two.internal");
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeTruthy();
  });
});
