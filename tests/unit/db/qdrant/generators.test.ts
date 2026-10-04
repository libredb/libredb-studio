/**
 * The tree click and Generate Command for a Qdrant collection (vector-family spec 6.7): each output round-tripped
 * through the real console parser, every probe accepted by the shared vector checks for its field, and every name
 * kept in its place, whatever characters it holds.
 */
import { describe, expect, test } from "bun:test";
import { parseConsole } from "@/lib/db/console/parser";
import { toJsonText, type TaggedObject } from "@/lib/db/console/tagged-json";
import { qdrantSelectQuery, qdrantTableQuery } from "@/lib/db/providers/vector/qdrant/generators";
import { QDRANT_CONSOLE, QDRANT_ROUTES } from "@/lib/db/providers/vector/qdrant/routes";
import { qdrantDeclaredColumns, readQdrantCollection } from "@/lib/db/providers/vector/qdrant/schema";
import { vectorNameOfColumn, vectorTargetOfType } from "@/lib/db/providers/vector/qdrant/type-spelling";
import { checkDenseElements, checkMultiVector, vectorNumbers } from "@/lib/db/vector/dense";
import { checkSparse, sparseFromIndicesValues } from "@/lib/db/vector/sparse";
import type { ColumnSchema } from "@/lib/types";
import { resultOf, SEEDED_COLLECTIONS, vectorCapture } from "../../../helpers/qdrant-surface-fixtures";

const parse = (text: string) => parseConsole(QDRANT_CONSOLE, QDRANT_ROUTES, text);
const columnsOf = (collection: string) =>
  qdrantDeclaredColumns(readQdrantCollection(collection, resultOf(vectorCapture(`describe-${collection}`))));

/** The names a tree can list: a legacy name, spaces, URL delimiters, a line break, non-ASCII, percent signs. */
const NAMES = ["docs", "a:b", "with space", "hash#name", "q?x=1", "line\nbreak", "ünïcode", "100%", "%2e%2e", "a+b"];

describe("qdrantTableQuery", () => {
  test("docs: the scroll of the design, run at once", () => {
    expect(qdrantTableQuery(["docs"])).toBe(
      'POST /collections/docs/points/scroll\n{"limit": 100, "with_payload": true, "with_vector": false}',
    );
  });

  test.each(NAMES)("the click on %j scrolls exactly that collection", (name) => {
    const request = parse(qdrantTableQuery([name]));
    expect(request.route.op).toBe("scroll_points");
    expect(request.params).toEqual({ collection_name: name });
    expect(toJsonText(request.body)).toBe('{"limit":100,"with_payload":true,"with_vector":false}');
  });
});

describe("qdrantSelectQuery", () => {
  test("plain: the design's text for the unnamed vector", () => {
    expect(qdrantSelectQuery(["plain"], columnsOf("plain"))).toBe(
      [
        "// Replace query with your vector: the unnamed vector, Dense(4, float32, Dot)",
        "POST /collections/plain/points/query",
        '{"query": [0.5, 0.5, 0.5, 0.5], "limit": 10, "with_payload": true}',
      ].join("\n"),
    );
  });

  test("docs: the first dense vector with using, and a comment line for every other vector", () => {
    const lines = qdrantSelectQuery(["docs"], columnsOf("docs")).split("\n");
    expect(lines.slice(0, 4)).toEqual([
      '// Replace query with your vector: vector "image", Dense(64, float32, Euclid)',
      '// Also in this collection: vector "colbert", Multi(16, float32, Dot, max_sim)',
      '// Also in this collection: vector "text", Dense(384, float32, Cosine; stored normalised)',
      '// Also in this collection: vector "keywords", Sparse(idf)',
    ]);
    expect(lines[4]).toBe("POST /collections/docs/points/query");
    expect(lines[5]).toStartWith('{"query": [0.125, 0.125,');
    expect(lines[5]).toEndWith('], "using": "image", "limit": 10, "with_payload": true}');
  });

  test("a sparse-only collection gets the design's sparse probe", () => {
    const columns: ColumnSchema[] = [{ name: "vector.kw", type: "Sparse(idf)", nullable: true, isPrimary: false }];
    expect(qdrantSelectQuery(["s"], columns).split("\n").slice(1)).toEqual([
      "POST /collections/s/points/query",
      '{"query": {"indices": [0], "values": [1.0]}, "using": "kw", "limit": 10, "with_payload": true}',
    ]);
  });

  test("a multivector-only collection gets a one-row matrix", () => {
    const columns: ColumnSchema[] = [
      { name: "vector.m", type: "Multi(4, float32, Dot, max_sim)", nullable: true, isPrimary: false },
    ];
    expect(qdrantSelectQuery(["s"], columns).split("\n")[2]).toBe(
      '{"query": [[0.5, 0.5, 0.5, 0.5]], "using": "m", "limit": 10, "with_payload": true}',
    );
  });

  test("a uint8 vector's probe is written as doubles of 1", () => {
    const columns: ColumnSchema[] = [
      { name: "vector.u", type: "Dense(3, uint8, Euclid)", nullable: true, isPrimary: false },
    ];
    expect(qdrantSelectQuery(["s"], columns).split("\n")[2]).toBe(
      '{"query": [1.0, 1.0, 1.0], "using": "u", "limit": 10, "with_payload": true}',
    );
  });

  test("a collection with no vector gets a comment and no request", () => {
    expect(qdrantSelectQuery(["empty_novec"], columnsOf("empty_novec"))).toBe(
      '// Collection "empty_novec" declares no vector to search.',
    );
  });

  test("payload columns, a sampled one included, are never taken for a vector", () => {
    const columns: ColumnSchema[] = [
      {
        name: "payload.vector.x",
        type: "Dense(4, float32, Dot)",
        nullable: true,
        isPrimary: false,
        provenance: "sampled",
      },
      { name: "category", type: "keyword", nullable: true, isPrimary: false },
    ];
    expect(qdrantSelectQuery(["c"], columns)).toBe('// Collection "c" declares no vector to search.');
  });

  test.each([...SEEDED_COLLECTIONS].filter((name) => name !== "empty_novec"))(
    "%s: the request parses, aims at its vector and passes that vector's checks",
    (collection) => {
      const columns = columnsOf(collection);
      const request = parse(qdrantSelectQuery([collection], columns));
      expect(request.route.op).toBe("query_points");
      const body = request.body as TaggedObject;
      const using = typeof body.using === "string" ? body.using : "";
      const column = columns.find((entry) => vectorNameOfColumn(entry.name) === using);
      const target = column === undefined ? null : vectorTargetOfType(using, column.type);
      if (target === null) throw new Error(`${collection}: the query aims at no declared vector`);
      if (target.kind === "sparse") {
        const query = body.query as TaggedObject;
        const sparse = sparseFromIndicesValues(target, query.indices as never, query.values as never, 4_294_967_296);
        expect("sentence" in sparse ? sparse : checkSparse(target, sparse, 4_294_967_296)).toBeNull();
      } else if (target.kind === "multi") {
        const rows = (body.query as never[]).map((row) => vectorNumbers(target, row));
        expect(checkMultiVector(target, rows as number[][], 1_048_575)).toBeNull();
      } else {
        const values = vectorNumbers(target, body.query as never);
        expect("sentence" in values ? values : checkDenseElements(target, values)).toBeNull();
      }
    },
  );

  test.each(NAMES)("Generate Command on %j queries exactly that collection", (name) => {
    expect(parse(qdrantSelectQuery([name], columnsOf("plain"))).params).toEqual({ collection_name: name });
  });

  test("a vector name with a line break stays inside its comment and its string", () => {
    const columns: ColumnSchema[] = [
      { name: "vector.a\nGET /collections", type: "Dense(2, float32, Dot)", nullable: true, isPrimary: false },
    ];
    const text = qdrantSelectQuery(["c"], columns);
    expect(text.split("\n")).toHaveLength(3);
    const request = parse(text);
    expect(request.route.op).toBe("query_points");
    expect((request.body as TaggedObject).using).toBe("a\nGET /collections");
  });
});
