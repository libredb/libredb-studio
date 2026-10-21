import assert from "node:assert/strict";
import type { ObjectKindSpec, ObjectRole } from "@/lib/db/types";
import { EngineIcons, type IconNode, nodeIcon, ROLE_ICONS, readEngineIndex } from "../../../src/host/tree/icons";
import { PG } from "../../fakes/profiles";
import { Uri } from "../../fakes/vscode";

const TABLE: ObjectKindSpec = { id: "table", role: "relation", label: "Table", labelPlural: "Tables" };
const ORDERS = { path: ["public", "orders"], name: "orders", kind: "table" };
const base = { connectionId: PG.id };

function objectNode(role: ObjectRole | undefined): IconNode {
  return { ...base, id: "o/x", node: "object", object: ORDERS, kindLabel: "Table", role, hasColumns: true };
}

function column(isPrimary: boolean): IconNode {
  return {
    ...base,
    id: "l/x",
    node: "column",
    object: ORDERS,
    column: { name: "id", type: "integer", nullable: false, isPrimary },
  };
}

describe("tree icons", () => {
  describe("readEngineIndex", () => {
    it("reads an object of labels", () => {
      assert.deepEqual(readEngineIndex('{"postgres":{"label":"PostgreSQL"}}'), { postgres: { label: "PostgreSQL" } });
    });

    for (const text of ["[]", '{"postgres":{}}', '{"postgres":{"label":3}}', "not json", "null", '{"postgres":"x"}']) {
      it(`refuses ${text}`, () => {
        assert.throws(
          () => readEngineIndex(text),
          (error: Error) => error.message.startsWith("media/engines/index.json is not an engine index:"),
        );
      });
    }
  });

  describe("EngineIcons", () => {
    const icons = new EngineIcons(Uri.file("/ext"), { postgres: { label: "PostgreSQL" } });

    it("answers the two generated files of a listed type", () => {
      const path = icons.iconPath("postgres");
      assert.equal(path.light.fsPath, "/ext/media/engines/postgres.light.svg");
      assert.equal(path.dark.fsPath, "/ext/media/engines/postgres.dark.svg");
    });

    it("refuses the icon of a type the index does not hold, with no fallback", () => {
      assert.throws(() => icons.iconPath("mysql"), {
        message: "media/engines/index.json has no label for mysql; rebuild the extension.",
      });
    });

    it("answers a listed type's label and refuses an unlisted one", () => {
      assert.equal(icons.label("postgres"), "PostgreSQL");
      assert.throws(() => icons.label("mysql"), {
        message: "media/engines/index.json has no label for mysql; rebuild the extension.",
      });
    });
  });

  describe("nodeIcon", () => {
    const cases: [string, IconNode, string | undefined][] = [
      [
        "a container",
        {
          ...base,
          id: "k/x",
          node: "container",
          container: { path: ["p"], name: "p", level: 0 },
          levelLabel: "Schema",
        },
        "symbol-namespace",
      ],
      [
        "a group",
        {
          ...base,
          id: "g/x",
          node: "group",
          containerPath: [],
          group: { id: "g", label: "G" },
          kinds: [],
          counts: undefined,
        },
        "folder",
      ],
      ["a folder", { ...base, id: "f/x", node: "folder", containerPath: [], kind: TABLE }, "folder"],
      ["a relation", objectNode("relation"), "table"],
      ["a routine", objectNode("routine"), "symbol-method"],
      ["an attached object", objectNode("attached"), "symbol-method"],
      ["a group object", objectNode("group"), "folder-library"],
      ["a config object", objectNode("config"), "file-code"],
      ["a primary key column", column(true), "key"],
      ["a column", column(false), "symbol-field"],
      ["an invalid entry", { id: "i/1", node: "invalid", reason: "R" }, "error"],
      ["an error", { ...base, id: "x/x", node: "error", message: "boom" }, "error"],
      ["an empty node", { ...base, id: "n/x", node: "empty", label: "No Tables" }, undefined],
      ["an object with no role", objectNode(undefined), undefined],
    ];

    for (const [what, node, id] of cases) {
      it(`gives ${what} ${id ?? "no icon"}`, () => {
        assert.equal(nodeIcon(node)?.id, id);
      });
    }

    it("colours the error node and leaves the invalid one uncoloured", () => {
      assert.equal(nodeIcon({ ...base, id: "x/x", node: "error", message: "boom" })?.color?.id, "list.errorForeground");
      assert.equal(nodeIcon({ id: "i/1", node: "invalid", reason: "R" })?.color, undefined);
    });

    it("maps every role", () => {
      assert.deepEqual(ROLE_ICONS, {
        relation: "table",
        routine: "symbol-method",
        attached: "symbol-method",
        group: "folder-library",
        config: "file-code",
      });
    });
  });
});
