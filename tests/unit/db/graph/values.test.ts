/**
 * Graph JSON forms and column types (Neo4j provider spec 3.4, revision SR1)
 *
 * The Bolt transport turns nodes, relationships and paths into tagged plain
 * objects before a row leaves the server; these tests pin the browser-safe half:
 * recognising a tagged form, and naming a result column after the one graph form
 * its values share. A map that merely carries a `~graph` key of another value is
 * a user's data and must never be mistaken for a graph value.
 */
import { describe, expect, test } from "bun:test";
import {
  GRAPH_TAG,
  type GraphNodeJson,
  type GraphPathJson,
  type GraphRelationshipJson,
  graphColumnType,
  isGraphValueJson,
} from "@/lib/db/graph/values";

const alice: GraphNodeJson = {
  "~graph": "node",
  elementId: "4:abc:0",
  labels: ["Person"],
  properties: { name: "Alice" },
};
const bob: GraphNodeJson = {
  "~graph": "node",
  elementId: "4:abc:1",
  labels: ["Person", "Weird Label"],
  properties: {},
};
const knows: GraphRelationshipJson = {
  "~graph": "relationship",
  elementId: "5:abc:0",
  type: "KNOWS",
  startNodeElementId: alice.elementId,
  endNodeElementId: bob.elementId,
  properties: { since: 2020 },
};
const path: GraphPathJson = { "~graph": "path", nodes: [alice, bob], relationships: [knows] };

describe("GRAPH_TAG", () => {
  test("is the key every form carries", () => {
    expect(GRAPH_TAG).toBe("~graph");
  });
});

describe("isGraphValueJson", () => {
  test("accepts each of the three forms", () => {
    expect(isGraphValueJson(alice)).toBe(true);
    expect(isGraphValueJson(knows)).toBe(true);
    expect(isGraphValueJson(path)).toBe(true);
  });

  test("accepts a zero-length path (SR18)", () => {
    expect(isGraphValueJson({ "~graph": "path", nodes: [alice], relationships: [] })).toBe(true);
  });

  test("refuses non-objects, null and arrays", () => {
    for (const value of [null, undefined, 1, "node", true, [alice], []]) {
      expect(isGraphValueJson(value)).toBe(false);
    }
  });

  test("refuses a map whose ~graph is another value", () => {
    expect(isGraphValueJson({ "~graph": "edge", elementId: "x", labels: [], properties: {} })).toBe(false);
    expect(isGraphValueJson({ "~graph": 1 })).toBe(false);
    expect(isGraphValueJson({ name: "no tag" })).toBe(false);
  });

  test("refuses a node missing elementId or with mistyped fields", () => {
    expect(isGraphValueJson({ "~graph": "node", labels: ["Person"], properties: { name: "Alice" } })).toBe(false);
    expect(isGraphValueJson({ ...alice, elementId: 7 })).toBe(false);
    expect(isGraphValueJson({ ...alice, labels: "Person" })).toBe(false);
    expect(isGraphValueJson({ ...alice, labels: ["Person", 1] })).toBe(false);
    expect(isGraphValueJson({ ...alice, properties: null })).toBe(false);
    expect(isGraphValueJson({ ...alice, properties: [] })).toBe(false);
  });

  test("refuses a relationship with a missing or mistyped field", () => {
    expect(isGraphValueJson({ ...knows, type: undefined })).toBe(false);
    expect(isGraphValueJson({ ...knows, startNodeElementId: 1 })).toBe(false);
    expect(isGraphValueJson({ ...knows, endNodeElementId: null })).toBe(false);
    expect(isGraphValueJson({ ...knows, elementId: undefined })).toBe(false);
    expect(isGraphValueJson({ ...knows, properties: "x" })).toBe(false);
  });

  test("refuses a path whose members are not arrays", () => {
    expect(isGraphValueJson({ "~graph": "path", nodes: alice, relationships: [] })).toBe(false);
    expect(isGraphValueJson({ "~graph": "path", nodes: [alice], relationships: knows })).toBe(false);
  });

  test("refuses an object that is not a plain object", () => {
    class Tagged {
      readonly "~graph" = "path";
      readonly nodes = [];
      readonly relationships = [];
    }
    expect(isGraphValueJson(new Tagged())).toBe(false);
  });

  test("accepts a plain object with a null prototype", () => {
    const bare = Object.assign(Object.create(null), alice);
    expect(isGraphValueJson(bare)).toBe(true);
  });
});

describe("graphColumnType", () => {
  test("is undefined for an empty or all-null column", () => {
    expect(graphColumnType([])).toBeUndefined();
    expect(graphColumnType([null, undefined, null])).toBeUndefined();
  });

  test("is undefined for a scalar column", () => {
    expect(graphColumnType([1, "a", null, { "~graph": "edge" }])).toBeUndefined();
  });

  test("names the one form every non-null value shares", () => {
    expect(graphColumnType([alice, null, bob])).toBe("Node");
    expect(graphColumnType([knows, undefined])).toBe("Relationship");
    expect(graphColumnType([path])).toBe("Path");
  });

  test("is Mixed for two graph forms", () => {
    expect(graphColumnType([alice, knows])).toBe("Mixed");
  });

  test("is Mixed for a graph value next to a scalar, in either order", () => {
    expect(graphColumnType([alice, 1])).toBe("Mixed");
    expect(graphColumnType(["x", null, path])).toBe("Mixed");
  });
});
