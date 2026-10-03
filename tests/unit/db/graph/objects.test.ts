/**
 * The graph object model (spec 4.1, 4.3, SR5, SR19): the declared kinds and container level, the
 * kind-qualified path segment and its inverse, and the pure mappings from catalog rows to the
 * shared object, column and index shapes.
 */
import { describe, expect, test } from "bun:test";
import {
  GRAPH_CONTAINER_LEVELS,
  GRAPH_OBJECT_KINDS,
  type GraphIndexRow,
  type GraphKindId,
  type GraphPropertyRow,
  columnsOf,
  graphObjectSegment,
  indexesOf,
  parseGraphObjectSegment,
  toDatabaseObjects,
} from "@/lib/db/graph/objects";

const KINDS: readonly GraphKindId[] = ["label", "relationship_type", "index", "constraint"];
const NAMES = ["Person", "Weird Label", "Back`tick", "Kişi", "a)b", "x]y"];

describe("GRAPH_OBJECT_KINDS", () => {
  test("declares the four kinds in order with every field explicit", () => {
    expect(GRAPH_OBJECT_KINDS).toEqual([
      {
        id: "label",
        role: "relation",
        label: "Node label",
        labelPlural: "Node labels",
        hasColumns: true,
        hasSource: false,
        acceptsSourceEdits: false,
        acceptsRowWrites: false,
      },
      {
        id: "relationship_type",
        role: "relation",
        label: "Relationship type",
        labelPlural: "Relationship types",
        hasColumns: true,
        hasSource: false,
        acceptsSourceEdits: false,
        acceptsRowWrites: false,
      },
      {
        id: "index",
        role: "config",
        label: "Index",
        labelPlural: "Indexes",
        hasColumns: false,
        hasSource: false,
        acceptsSourceEdits: false,
        acceptsRowWrites: false,
      },
      {
        id: "constraint",
        role: "config",
        label: "Constraint",
        labelPlural: "Constraints",
        hasColumns: false,
        hasSource: false,
        acceptsSourceEdits: false,
        acceptsRowWrites: false,
      },
    ]);
  });

  test("declares one catalog level named Database", () => {
    expect(GRAPH_CONTAINER_LEVELS).toEqual([{ id: "catalog", label: "Database", labelPlural: "Databases" }]);
  });
});

describe("graphObjectSegment and parseGraphObjectSegment", () => {
  test("write each kind's fixed form", () => {
    expect(graphObjectSegment("label", "Person")).toBe("(:Person)");
    expect(graphObjectSegment("relationship_type", "KNOWS")).toBe("[:KNOWS]");
    expect(graphObjectSegment("index", "person_name")).toBe("INDEX person_name");
    expect(graphObjectSegment("constraint", "person_id")).toBe("CONSTRAINT person_id");
  });

  test("round-trip every kind and every awkward name", () => {
    for (const kind of KINDS) {
      for (const name of NAMES) {
        expect(parseGraphObjectSegment(graphObjectSegment(kind, name))).toEqual({ kind, name });
      }
    }
  });

  test("a label and a relationship type of one name get distinct segments", () => {
    expect(graphObjectSegment("label", "X")).not.toBe(graphObjectSegment("relationship_type", "X"));
  });

  test("refuse an empty name", () => {
    expect(() => graphObjectSegment("label", "")).toThrow(RangeError);
  });

  test("answer undefined for a segment no kind produced", () => {
    for (const segment of ["foo", "(:", "[:x", "(:)", "[:]", "INDEX ", "CONSTRAINT ", "", "(:x]", "index x"]) {
      expect(parseGraphObjectSegment(segment)).toBeUndefined();
    }
  });
});

describe("toDatabaseObjects", () => {
  test("paths carry the kind-qualified segment, names stay plain, sorted and deduplicated", () => {
    expect(
      toDatabaseObjects(["neo4j"], "label", [{ name: "b" }, { name: "A" }, { name: "b" }, { name: "Kişi" }]),
    ).toEqual([
      { path: ["neo4j", "(:A)"], name: "A", kind: "label" },
      { path: ["neo4j", "(:b)"], name: "b", kind: "label" },
      { path: ["neo4j", "(:Kişi)"], name: "Kişi", kind: "label" },
    ]);
  });

  test("each kind writes its own segment", () => {
    expect(toDatabaseObjects(["db"], "relationship_type", [{ name: "KNOWS" }])[0].path).toEqual(["db", "[:KNOWS]"]);
    expect(toDatabaseObjects(["db"], "index", [{ name: "i" }])[0].path).toEqual(["db", "INDEX i"]);
    expect(toDatabaseObjects(["db"], "constraint", [{ name: "c" }])[0].path).toEqual(["db", "CONSTRAINT c"]);
  });

  test("an empty catalog answers no objects", () => {
    expect(toDatabaseObjects(["db"], "label", [])).toEqual([]);
  });
});

describe("columnsOf", () => {
  const rows: GraphPropertyRow[] = [
    { owner: "Person", property: "name", types: ["String"], mandatory: true },
    { owner: "Movie", property: "title", types: ["String"], mandatory: true },
    { owner: "Person", property: "age", types: ["Long"], mandatory: false },
    { owner: "Person", property: "age", types: ["String", "Long"], mandatory: false },
    { owner: "Person", property: "born", types: ["Date"], mandatory: true },
    { owner: "Person", property: "born", types: ["Date"], mandatory: false },
    { owner: "Person", property: "tags", types: [], mandatory: true },
  ];

  test("reads the owner's rows only, ordered by property, types merged in first-seen order", () => {
    expect(columnsOf("Person", rows)).toEqual([
      { name: "age", type: "Long | String", nullable: true, isPrimary: false },
      { name: "born", type: "Date", nullable: true, isPrimary: false },
      { name: "name", type: "String", nullable: false, isPrimary: false },
      { name: "tags", type: "ANY", nullable: false, isPrimary: false },
    ]);
  });

  test("an owner with no property answers no columns", () => {
    expect(columnsOf("Empty", rows)).toEqual([]);
  });
});

describe("indexesOf", () => {
  const rows: GraphIndexRow[] = [
    { name: "person_name", type: "RANGE", entityType: "NODE", labelsOrTypes: ["Person"], properties: ["name"] },
    {
      name: "person_id",
      type: "RANGE",
      entityType: "NODE",
      labelsOrTypes: ["Person"],
      properties: ["id", "tenant"],
      unique: true,
      state: "ONLINE",
    },
    { name: "lookup_nodes", type: "LOOKUP", entityType: "NODE", labelsOrTypes: [], properties: [] },
    { name: "lookup_labelled", type: "LOOKUP", entityType: "NODE", labelsOrTypes: ["Person"], properties: [] },
    { name: "rel_person", type: "RANGE", entityType: "RELATIONSHIP", labelsOrTypes: ["Person"], properties: ["x"] },
    { name: "movie_title", type: "TEXT", entityType: "NODE", labelsOrTypes: ["Movie"], properties: ["title"] },
  ];

  test("matches entity type and owner, skips LOOKUP, sorts by name", () => {
    expect(indexesOf("Person", "NODE", rows)).toEqual([
      { name: "person_id", columns: ["id", "tenant"], unique: true },
      { name: "person_name", columns: ["name"], unique: false },
    ]);
  });

  test("a relationship type reads only relationship indexes", () => {
    expect(indexesOf("Person", "RELATIONSHIP", rows)).toEqual([{ name: "rel_person", columns: ["x"], unique: false }]);
  });

  test("an owner with no index answers none", () => {
    expect(indexesOf("Nobody", "NODE", rows)).toEqual([]);
  });
});
