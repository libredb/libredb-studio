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
  test("every engine Studio has no write path on draws the fixed label and the shared sentence, and no box", () => {
    render(<Modal isOpen onClose={() => {}} onConnect={() => {}} />);
    const none = byReach("none");
    // Vacuity, by name: the three engines that used to fall back to the toggle's sentence are in the population.
    expect(none).toEqual(expect.arrayContaining(["qdrant", "weaviate", "netconf"]));
    for (const type of none) {
      choose(type);
      expect({
        type,
        box: document.getElementById("readOnly") === null,
        label: document.getElementById("readOnly-label")?.textContent,
        hint: hint(),
      }).toEqual({ type, box: true, label: "Read-only", hint: FIXED_HINT });
    }
  });

  test("every guarded engine draws the toggle with the toggle's sentence", () => {
    render(<Modal isOpen onClose={() => {}} onConnect={() => {}} />);
    const guarded = byReach("guarded");
    expect(guarded).toEqual(expect.arrayContaining(["etcd", "milvus"]));
    for (const type of guarded) {
      choose(type);
      const box = screen.getByLabelText("Read-only") as HTMLInputElement;
      expect({ type, kind: box.type, label: document.getElementById("readOnly-label"), hint: hint() }).toEqual({
        type,
        kind: "checkbox",
        label: null,
        hint: TOGGLE_HINT,
      });
    }
  });

  test("an engine whose reach is open draws neither", () => {
    render(<Modal isOpen onClose={() => {}} onConnect={() => {}} />);
    const open = byReach("open");
    expect(open).toContain("postgres");
    for (const type of open) {
      choose(type);
      expect({
        type,
        box: document.getElementById("readOnly"),
        label: document.getElementById("readOnly-label"),
      }).toEqual({ type, box: null, label: null });
    }
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
