import "../setup-dom";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionGlobalConfig } from "framer-motion";

import { ConnectionModal as AppConnectionModal } from "@/components/ConnectionModal";
import { ConnectionModal as PackagedConnectionModal } from "@/exports/components";
import { getDBConfig } from "@/lib/db-ui-config";
import { SHIPPED_DATABASE_TYPES, WRITE_REACH } from "@/lib/db/compatibility";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";

/**
 * The read-only control in the real dialog, through the real form hook and the real `DB_UI_CONFIG`, with nothing
 * mocked, once as the app imports the dialog and once as the package exports it: the standalone app and the embedded
 * library surface render different chrome around it, so each is drawn here. Which engine gets which control comes from
 * `WRITE_REACH`, never from a type-id list in this file.
 */

// The dialog's banners animate in; happy-dom cancels an animation still running when the test ends.
MotionGlobalConfig.skipAnimations = true;

afterEach(cleanup);

const TOGGLE_HINT =
  "Writes, value edits and maintenance are refused on this connection. You can turn this off here, so on your own connection it is a safety rail, not a permission.";
const FIXED_HINT = "Studio has no write path on this engine, so every connection to it is read-only.";

const SURFACES = [
  ["the app's dialog", AppConnectionModal],
  ["the packaged dialog", PackagedConnectionModal],
] as const;

const byReach = (reach: string): DatabaseType[] => SHIPPED_DATABASE_TYPES.filter((type) => WRITE_REACH[type] === reach);

function choose(type: DatabaseType): void {
  fireEvent.click(screen.getByRole("button", { name: getDBConfig(type).label }));
}

function hint(): string | null {
  return document.getElementById("readOnly-hint")?.textContent ?? null;
}

test("the package exports the app's dialog itself, so both surfaces draw the control below", () => {
  expect(PackagedConnectionModal).toBe(AppConnectionModal);
});

describe.each(SURFACES)("the read-only control in %s", (_surface, Modal) => {
  // One engine per test: each engine switch re-renders the whole form, about 25 ms here and 200 ms on one busy core,
  // so a loop over a reach's population spent seconds of one test's 5000 ms default on re-renders.
  test("the engines Studio has no write path on include the three that used to fall back to the toggle's sentence", () => {
    // Vacuity, by name: the three engines that used to fall back to the toggle's sentence are in the population.
    expect(byReach("none")).toEqual(expect.arrayContaining(["qdrant", "weaviate", "netconf"]));
  });

  test.each(byReach("none"))(
    "%s, where Studio has no write path, draws the fixed label and the shared sentence, and no box",
    (type) => {
      render(<Modal isOpen onClose={() => {}} onConnect={() => {}} />);
      choose(type);
      expect({
        type,
        box: document.getElementById("readOnly") === null,
        label: document.getElementById("readOnly-label")?.textContent,
        hint: hint(),
      }).toEqual({ type, box: true, label: "Read-only", hint: FIXED_HINT });
    },
  );

  test("the guarded engines include etcd and milvus", () => {
    expect(byReach("guarded")).toEqual(expect.arrayContaining(["etcd", "milvus"]));
  });

  test.each(byReach("guarded"))("%s, a guarded engine, draws the toggle with the toggle's sentence", (type) => {
    render(<Modal isOpen onClose={() => {}} onConnect={() => {}} />);
    choose(type);
    const box = screen.getByLabelText("Read-only") as HTMLInputElement;
    expect({ type, kind: box.type, label: document.getElementById("readOnly-label"), hint: hint() }).toEqual({
      type,
      kind: "checkbox",
      label: null,
      hint: TOGGLE_HINT,
    });
  });

  test("the engines whose reach is open include postgres", () => {
    expect(byReach("open")).toContain("postgres");
  });

  test.each(byReach("open"))("%s, whose reach is open, draws neither", (type) => {
    render(<Modal isOpen onClose={() => {}} onConnect={() => {}} />);
    choose(type);
    expect({
      type,
      box: document.getElementById("readOnly"),
      label: document.getElementById("readOnly-label"),
    }).toEqual({ type, box: null, label: null });
  });

  test("a seed copy keeps the fixed label where Studio has no write path, and loses the toggle where it is guarded", () => {
    const seed = (type: DatabaseType): DatabaseConnection => ({
      id: `seed:prod-${type}`,
      seedId: `prod-${type}`,
      name: `Prod ${type}`,
      type,
      host: "seed.internal",
      createdAt: new Date(0),
    });
    const { unmount } = render(
      <Modal isOpen onClose={() => {}} onConnect={() => {}} editConnection={seed("qdrant")} />,
    );
    expect(document.getElementById("readOnly-label")?.textContent).toBe("Read-only");
    expect(hint()).toBe(FIXED_HINT);
    unmount();

    render(<Modal isOpen onClose={() => {}} onConnect={() => {}} editConnection={seed("etcd")} />);
    expect(document.getElementById("readOnly")).toBeNull();
    expect(document.getElementById("readOnly-label")).toBeNull();
    expect(hint()).toBeNull();
  });
});
