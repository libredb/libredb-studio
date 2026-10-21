import assert from "node:assert/strict";
import type { ObjectKindSpec, ObjectRole } from "@/lib/db/types";
import { contextValueOf, nodeId, refreshTarget, type TreeNode } from "../../../src/host/tree/nodes";
import { PG } from "../../fakes/profiles";

const TABLE: ObjectKindSpec = { id: "table", role: "relation", label: "Table", labelPlural: "Tables" };
const ORDERS = { path: ["public", "orders"], name: "orders", kind: "table" };

const connection: TreeNode = { id: "c/1kq2v7x93j0ab", node: "connection", connectionId: PG.id, entry: PG };
const container: TreeNode = {
  id: "k/1kq2v7x93j0ab/public",
  node: "container",
  connectionId: PG.id,
  parent: connection,
  container: { path: ["public"], name: "public", level: 0 },
  levelLabel: "Schema",
};

function objectNode(role: ObjectRole | undefined): TreeNode {
  return {
    id: "o/1kq2v7x93j0ab/public/orders/table",
    node: "object",
    connectionId: PG.id,
    object: ORDERS,
    kindLabel: "Table",
    role,
    hasColumns: true,
  };
}

describe("tree nodes", () => {
  describe("nodeId", () => {
    it("encodes each segment and joins them with a slash", () => {
      assert.equal(nodeId("c", ["1kq2v7x93j0ab"]), "c/1kq2v7x93j0ab");
      assert.equal(nodeId("o", ["c1", "public", "a/b", "table"]), "o/c1/public/a%2Fb/table");
      assert.equal(nodeId("o", ["c1", "public", "p%q", "table"]), "o/c1/public/p%25q/table");
      assert.equal(nodeId("o", ["c1", "public", "a.b", "table"]), "o/c1/public/a.b/table");
      assert.equal(nodeId("o", ["c1", "public", "çay", "table"]), "o/c1/public/%C3%A7ay/table");
    });

    it("gives distinct ids to the pairs that share names, paths or segments", () => {
      const pairs: [string, string][] = [
        [nodeId("c", ["c1"]), nodeId("c", ["c2"])],
        [nodeId("o", ["c1", "public", "f", "table"]), nodeId("o", ["c1", "public", "f", "function"])],
        [nodeId("k", ["c1", "a/b"]), nodeId("k", ["c1", "a", "b"])],
        [nodeId("k", ["c1", "public"]), nodeId("f", ["c1", "public"])],
      ];
      assert.deepEqual(pairs, [
        ["c/c1", "c/c2"],
        ["o/c1/public/f/table", "o/c1/public/f/function"],
        ["k/c1/a%2Fb", "k/c1/a/b"],
        ["k/c1/public", "f/c1/public"],
      ]);
      const ids = pairs.flat();
      assert.equal(new Set(ids).size, ids.length);
    });

    it("answers equal strings for equal arguments", () => {
      assert.equal(
        nodeId("l", ["c1", "public", "orders", "table", "id"]),
        nodeId("l", ["c1", "public", "orders", "table", "id"]),
      );
    });
  });

  describe("contextValueOf", () => {
    const cases: [TreeNode, string][] = [
      [connection, "libredb;node=connection"],
      [{ id: "i/1", node: "invalid", connectionId: "bad1", name: "bad", reason: "R" }, "libredb;node=invalid"],
      [{ id: "i/2", node: "invalid", reason: "S" }, "libredb;node=malformed"],
      [container, "libredb;node=container"],
      [
        {
          id: "g/1kq2v7x93j0ab/public/programmability",
          node: "group",
          connectionId: PG.id,
          containerPath: ["public"],
          group: { id: "programmability", label: "Programmability" },
          kinds: [],
          counts: undefined,
        },
        "libredb;node=group",
      ],
      [
        {
          id: "f/1kq2v7x93j0ab/public/table",
          node: "folder",
          connectionId: PG.id,
          containerPath: ["public"],
          kind: TABLE,
        },
        "libredb;node=folder",
      ],
      [objectNode("relation"), "libredb;node=object;role=relation"],
      [objectNode("routine"), "libredb;node=object;role=routine"],
      [objectNode("group"), "libredb;node=object;role=group"],
      [objectNode("attached"), "libredb;node=object;role=attached"],
      [objectNode("config"), "libredb;node=object;role=config"],
      [objectNode(undefined), "libredb;node=object"],
      [
        {
          id: "l/1kq2v7x93j0ab/public/orders/table/id",
          node: "column",
          connectionId: PG.id,
          object: ORDERS,
          column: { name: "id", type: "integer", nullable: false, isPrimary: true },
        },
        "libredb;node=column",
      ],
      [{ id: "n/f%2F1", node: "empty", connectionId: PG.id, label: "No Tables" }, "libredb;node=empty"],
      [{ id: "x/f%2F1", node: "error", connectionId: PG.id, message: "boom" }, "libredb;node=error"],
    ];

    for (const [node, expected] of cases) {
      it(`answers ${expected}`, () => {
        const value = contextValueOf(node);
        assert.equal(value, expected);
        const [head, ...tokens] = value.split(";");
        assert.equal(head, "libredb");
        for (const token of tokens) assert.match(token, /^[a-z]+=[a-z]+$/);
      });
    }
  });

  describe("refreshTarget", () => {
    it("answers undefined for no argument and a tree node as itself", () => {
      assert.equal(refreshTarget(undefined), undefined);
      assert.equal(refreshTarget(connection), connection);
    });

    for (const target of ["x", { id: 5, node: "folder" }, { id: "f/c1", node: "table" }, null]) {
      it(`refuses ${JSON.stringify(target)}`, () => {
        assert.throws(() => refreshTarget(target), { message: "libredb.refresh takes a tree node or nothing." });
      });
    }
  });
});
