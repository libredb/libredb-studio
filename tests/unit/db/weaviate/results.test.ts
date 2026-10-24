/**
 * A Weaviate answer to a `QueryResult` (#1566 spec 5.2, 5.6, 5.7, 3.6), over answers the seeded servers gave and
 * hand-written ones in their shape: one row per entry for the metadata reads, per object for the object reads with
 * their vectors and times, per hit for a search with the same columns on REST and GraphQL, one count row or one per
 * group for an aggregate; the GraphQL int32 null marked, a long text cut with a marker, and the byte budget dropping
 * whole rows with a warning.
 */
import { describe, expect, test } from "bun:test";
import { taggedNumber } from "@/lib/db/console/tagged-json";
import { QueryError } from "@/lib/db/errors";
import type { WeaviateConsoleOp } from "@/lib/db/providers/vector/weaviate/client";
import type { WeaviateSearchModel } from "@/lib/db/providers/vector/weaviate/request";
import { type WeaviateResultShape, weaviateResult } from "@/lib/db/providers/vector/weaviate/results";
import { readWeaviateClass, weaviateCollectionFacts } from "@/lib/db/providers/vector/weaviate/schema";
import { capturedText } from "../../../helpers/weaviate-surface";

const OPTIONS = { executionTime: 3 };
const factsOf = (name: string) =>
  weaviateCollectionFacts(
    readWeaviateClass(JSON.parse(capturedText("weaviate/reads.json", "GET", `/v1/schema/${name}`)), name),
  );

function model(over: Partial<WeaviateSearchModel> = {}): WeaviateSearchModel {
  return {
    op: "search_bm25",
    collection: "Article",
    tenant: null,
    where: null,
    limit: null,
    offset: null,
    autoLimit: null,
    consistencyLevel: null,
    returnProperties: null,
    returnMetadata: [],
    query: null,
    queryProperties: null,
    fusionType: null,
    maxVectorDistance: null,
    vector: null,
    id: null,
    targetVector: null,
    distance: null,
    certainty: null,
    groupBy: null,
    ...over,
  };
}

function shape(op: WeaviateConsoleOp, over: Partial<WeaviateResultShape> = {}): WeaviateResultShape {
  return { op, facts: null, path: null, model: null, limit: null, warnings: [], ...over };
}

const row = (value: Record<string, unknown>) => Object.assign(Object.create(null), value);

describe("the metadata reads", () => {
  test("meta, a definition, a tenant, an alias: one row, one column per top-level key in order", () => {
    const result = weaviateResult(
      capturedText("weaviate/reads.json", "GET", "/v1/aliases/Articles"),
      shape("alias"),
      OPTIONS,
    );
    expect(result).toEqual({
      rows: [row({ alias: "Articles", class: "Article" })],
      fields: ["alias", "class"],
      rowCount: 1,
      executionTime: 3,
      columnTypes: {},
    });
    expect(Object.getPrototypeOf(result.rows[0])).toBeNull();
    const meta = weaviateResult(capturedText("weaviate/reads.json", "GET", "/v1/meta"), shape("meta"), OPTIONS);
    expect(meta.fields).toEqual(["grpcMaxMessageSize", "hostname", "license", "modules", "version"]);
  });

  test("the lists: schema classes, shards, tenants, aliases, nodes; a key absent on one row is null", () => {
    const tenants = weaviateResult(
      capturedText("weaviate/reads.json", "GET", "/v1/schema/TenantNotes/tenants"),
      shape("tenants"),
      OPTIONS,
    );
    // Weaviate's own order differs between two identical reads, so the rows are compared by name.
    const byName = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      String(a.name).localeCompare(String(b.name));
    expect([...tenants.rows].sort(byName)).toEqual([
      row({ activityStatus: "HOT", name: "acme" }),
      row({ activityStatus: "HOT", name: "globex" }),
      row({ activityStatus: "COLD", name: "initech" }),
    ]);
    const mixed = weaviateResult('[{"a":1},{"b":2}]', shape("shards"), OPTIONS);
    expect(mixed.fields).toEqual(["a", "b"]);
    expect(mixed.rows).toEqual([row({ a: 1, b: null }), row({ a: null, b: 2 })]);
    expect(
      weaviateResult(capturedText("weaviate/reads.json", "GET", "/v1/schema"), shape("schema"), OPTIONS).rowCount,
    ).toBe(7);
    expect(
      weaviateResult(capturedText("weaviate/reads.json", "GET", "/v1/aliases"), shape("aliases"), OPTIONS).rowCount,
    ).toBe(1);
    expect(
      weaviateResult(capturedText("weaviate/reads.json", "GET", "/v1/nodes"), shape("nodes"), OPTIONS).rowCount,
    ).toBe(1);
    expect(
      weaviateResult(
        capturedText("weaviate/reads.json", "GET", "/v1/nodes/Article?output=verbose"),
        shape("collection_nodes"),
        OPTIONS,
      ).rowCount,
    ).toBe(1);
  });

  test("an empty or absent list still names a column", () => {
    for (const [text, op] of [
      ['{"classes":[]}', "schema"],
      ['{"classes":null}', "schema"],
      ["[]", "tenants"],
      ["{}", "aliases"],
    ] as const) {
      const result = weaviateResult(text, shape(op), OPTIONS);
      expect(result.fields, text).toEqual(["$id"]);
      expect(result.rows).toEqual([]);
    }
  });

  test("an answer that is not JSON, not a list, or holds a non-object entry is refused", () => {
    expect(() => weaviateResult("<html>", shape("meta"), OPTIONS)).toThrow(
      new QueryError("Weaviate answered with a body that is not JSON.", "weaviate"),
    );
    expect(() => weaviateResult('{"classes":{}}', shape("schema"), OPTIONS)).toThrow(
      "Weaviate answered with no list of classes.",
    );
    expect(() => weaviateResult('{"nodes":"x"}', shape("nodes"), OPTIONS)).toThrow(
      "Weaviate answered with no list of nodes.",
    );
    expect(() => weaviateResult("[1]", shape("shards"), OPTIONS)).toThrow(
      "Weaviate answered with no object where one was expected.",
    );
  });
});

describe("the object reads", () => {
  test("an object list: $id, the declared properties first, the vector, the times in epoch ms", () => {
    const result = weaviateResult(
      capturedText("weaviate/reads.json", "GET", "/v1/objects?class=Article&limit=2&include=vector"),
      shape("objects", { facts: factsOf("Article"), limit: 2 }),
      OPTIONS,
    );
    const declared = factsOf("Article").plainProperties.filter((name) => result.fields.includes(name));
    expect(result.fields.slice(0, declared.length + 1)).toEqual(["$id", ...declared]);
    expect(result.fields.slice(-3)).toEqual(["$vector", "$creationTime", "$lastUpdateTime"]);
    expect(result.vectorColumns).toEqual({ $vector: { kind: "dense", dtype: "float32", dimension: 16 } });
    expect(result.columnTypes).toEqual({ $id: "uuid", $creationTime: "epoch ms", $lastUpdateTime: "epoch ms" });
    expect(result.rows[0]?.$creationTime).toBe(1792754764912);
  });

  test("a list that fills its limit says how to read the next page; one that does not, nothing", () => {
    const text = capturedText("weaviate/reads.json", "GET", "/v1/objects?class=Author&limit=2");
    const full = weaviateResult(text, shape("objects", { limit: 2 }), OPTIONS);
    const last = full.rows[1]?.$id as string;
    expect(full.warnings).toEqual([{ message: `More objects may follow: add &after=${last} to read the next 2.` }]);
    expect(full.vectorColumns).toBeUndefined();
    expect(weaviateResult(text, shape("objects", { limit: 5 }), OPTIONS).warnings).toBeUndefined();
    expect(weaviateResult('{"objects":[]}', shape("objects", { limit: 0 }), OPTIONS).warnings).toBeUndefined();
  });

  test("a list that already names after is told to set it, not to add a second", () => {
    const text = capturedText("weaviate/reads.json", "GET", "/v1/objects?class=Author&limit=2");
    const full = weaviateResult(text, shape("objects", { limit: 2, afterGiven: true }), OPTIONS);
    expect(full.warnings).toEqual([
      { message: `More objects may follow: set after=${full.rows[1]?.$id as string} to read the next 2.` },
    ]);
  });

  test("named vectors are one column each, with their own dimension", () => {
    const result = weaviateResult(
      capturedText("weaviate/reads.json", "GET", "/v1/objects?class=Product&limit=1&include=vector"),
      shape("objects", { facts: factsOf("Product"), limit: 1 }),
      OPTIONS,
    );
    expect(result.vectorColumns).toEqual({
      "$vector.image": { kind: "dense", dtype: "float32", dimension: 8 },
      "$vector.text": { kind: "dense", dtype: "float32", dimension: 16 },
    });
  });

  test("one object by id is one row; an empty unnamed vector or a non-list named one is no column", () => {
    const one = weaviateResult(
      JSON.stringify({ id: "a", properties: { x: 1 }, vector: [], vectors: { v: "x", w: [1, 2] } }),
      shape("object"),
      OPTIONS,
    );
    expect(one.fields).toEqual(["$id", "x", "$vector.w"]);
    expect(one.rows).toEqual([row({ $id: "a", x: 1, "$vector.w": [1, 2] })]);
    expect(one.columnTypes).toEqual({ $id: "uuid" });
  });

  test("an object with no id is refused", () => {
    expect(() => weaviateResult('{"properties":{}}', shape("object"), OPTIONS)).toThrow(
      "Weaviate answered an object with no id.",
    );
  });
});

describe("the searches", () => {
  test("REST and GraphQL answer the same columns; GraphQL's times are numbers too", () => {
    const facts = factsOf("Article");
    const asked = model({ returnProperties: ["title"], returnMetadata: ["distance", "creationTime"] });
    const rest = weaviateResult(
      JSON.stringify({
        results: [{ id: "a", properties: { title: "t" }, metadata: { distance: 0.25, creationTime: 1792754764912 } }],
      }),
      shape("search_near_vector", { facts, path: "rest", model: asked }),
      OPTIONS,
    );
    const graphql = weaviateResult(
      JSON.stringify({
        data: {
          Get: {
            Article: [{ title: "t", _additional: { id: "a", distance: 0.25, creationTimeUnix: "1792754764912" } }],
          },
        },
      }),
      shape("search_near_vector", { facts, path: "graphql", model: asked }),
      OPTIONS,
    );
    expect(rest.fields).toEqual(["$id", "title", "$distance", "$creationTime"]);
    expect(graphql.fields).toEqual(rest.fields);
    expect(graphql.rows).toEqual(rest.rows);
    expect(rest.columnTypes).toEqual({
      $id: "uuid",
      $distance: "distance, lower is closer",
      $creationTime: "epoch ms",
    });
  });

  test("with no property named, every plain property, then any the answer adds; a missing value is null", () => {
    const facts = factsOf("Author");
    const result = weaviateResult(
      JSON.stringify({ results: [{ id: "a", properties: { name: "n", extra: 1 } }, { id: "b" }] }),
      shape("search_bm25", { facts, path: "rest", model: model({ collection: "Author" }) }),
      OPTIONS,
    );
    expect(result.fields).toEqual(["$id", ...facts.plainProperties, "extra"]);
    expect(result.rows[1]).toEqual(row({ $id: "b", name: null, country: null, extra: null }));
  });

  test("a GraphQL null in an int column is marked as maybe outside int32; REST's never is", () => {
    const facts = factsOf("EdgeValues");
    const text =
      '{"data":{"Get":{"EdgeValues":[{"_additional":{"id":"08f3aa7e"},"big":null,"label":"9007199254740991"}]}}}';
    const graphql = weaviateResult(
      text,
      shape("search_bm25", {
        facts,
        path: "graphql",
        model: model({ collection: "EdgeValues", returnProperties: ["label", "big"] }),
        warnings: [{ message: "Answered via GraphQL." }],
      }),
      OPTIONS,
    );
    expect(graphql.warnings).toEqual([
      { message: "Answered via GraphQL." },
      {
        message:
          "GraphQL answers null for an int outside the 32-bit range, so a null in big may be such a value; Weaviate 1.39.7 and later answer it over REST.",
      },
    ]);
    const rest = weaviateResult(
      '{"results":[{"id":"08f3aa7e","properties":{"big":null}}]}',
      shape("search_bm25", {
        facts,
        path: "rest",
        model: model({ collection: "EdgeValues", returnProperties: ["big"] }),
      }),
      OPTIONS,
    );
    expect(rest.warnings).toBeUndefined();
  });

  test("an empty near-vector result on a compressed index says a wrong vector length looks the same", () => {
    const facts = { ...factsOf("Article"), vectors: [{ ...factsOf("Article").vectors[0], quantization: "pq" }] };
    const empty = weaviateResult(
      '{"results":[]}',
      shape("search_near_vector", { facts, path: "rest", model: model({ op: "search_near_vector" }) }),
      OPTIONS,
    );
    expect(empty.warnings?.[0]?.message).toStartWith("No results. The vector index is pq-compressed");
    const uncompressed = weaviateResult(
      '{"results":[]}',
      shape("search_near_vector", {
        facts: factsOf("Article"),
        path: "rest",
        model: model({ op: "search_near_vector" }),
      }),
      OPTIONS,
    );
    expect(uncompressed.warnings).toBeUndefined();
    const otherVector = weaviateResult(
      '{"results":[]}',
      shape("search_near_vector", {
        facts,
        path: "rest",
        model: model({ op: "search_near_vector", targetVector: "image" }),
      }),
      OPTIONS,
    );
    expect(otherVector.warnings).toBeUndefined();
  });

  test("a hit with no id is refused on either path; an absent list is no hit", () => {
    const facts = factsOf("Article");
    expect(() =>
      weaviateResult(
        '{"results":[{"properties":{}}]}',
        shape("search_bm25", { facts, path: "rest", model: model() }),
        OPTIONS,
      ),
    ).toThrow("Weaviate answered a result with no id.");
    expect(() =>
      weaviateResult(
        '{"data":{"Get":{"Article":[{"title":"t"}]}}}',
        shape("search_bm25", { facts, path: "graphql", model: model() }),
        OPTIONS,
      ),
    ).toThrow("Weaviate answered a result with no id.");
    for (const text of ['{"data":null}', '{"data":{"Get":null}}', "[]"]) {
      expect(
        weaviateResult(text, shape("search_bm25", { facts, path: "graphql", model: model() }), OPTIONS).rowCount,
      ).toBe(0);
    }
    expect(weaviateResult("[]", shape("search_bm25", { facts, path: "rest", model: model() }), OPTIONS).rowCount).toBe(
      0,
    );
  });

  test("REST hit properties and metadata that are not objects read as none", () => {
    const result = weaviateResult(
      '{"results":[{"id":"a","properties":"x","metadata":[1]}]}',
      shape("search_bm25", {
        facts: factsOf("Author"),
        path: "rest",
        model: model({ returnProperties: [], returnMetadata: ["score"] }),
      }),
      OPTIONS,
    );
    expect(result.rows).toEqual([row({ $id: "a", $score: null })]);
  });
});

describe("the aggregate", () => {
  const facts = factsOf("Article");
  const count = (text: string, path: "rest" | "graphql", groupBy: string | null = null) =>
    weaviateResult(text, shape("aggregate", { facts, path, model: model({ op: "aggregate", groupBy }) }), OPTIONS);

  test("one exact count row over either path", () => {
    for (const result of [
      count('{"count":500}', "rest"),
      count('{"data":{"Aggregate":{"Article":[{"meta":{"count":500}}]}}}', "graphql"),
    ]) {
      expect(result.fields).toEqual(["count"]);
      expect(result.rows).toEqual([row({ count: 500 })]);
      expect(result.columnTypes).toEqual({ count: "Int64, exact count" });
    }
  });

  test("one row per group over either path, the group's value under the property's name", () => {
    const rest = count(
      '{"groups":[{"count":100,"groupedBy":{"value":"alpha"}},{"count":3},"junk"]}',
      "rest",
      "category",
    );
    const graphql = count(
      '{"data":{"Aggregate":{"Article":[{"groupedBy":{"value":"alpha"},"meta":{"count":100}},{"meta":{"count":3}},1]}}}',
      "graphql",
      "category",
    );
    for (const result of [rest, graphql]) {
      expect(result.fields).toEqual(["category", "count"]);
      expect(result.rows).toEqual([row({ category: "alpha", count: 100 }), row({ category: null, count: 3 })]);
    }
    expect(
      count('{"data":{"Aggregate":{"Article":[{"groupedBy":{"value":"x"}}]}}}', "graphql", "category").rows,
    ).toEqual([row({ category: "x", count: null })]);
  });

  test("groups that reach their limit say more may exist; fewer say nothing", () => {
    // Both paths stop at 100 groups when no limit is given (measured on 1.37.4 and 1.40.2); phase 0 writes it out.
    const grouped = (n: number, limit: number) =>
      weaviateResult(
        JSON.stringify({ groups: Array.from({ length: n }, (_, i) => ({ count: 1, groupedBy: { value: `g${i}` } })) }),
        shape("aggregate", {
          facts,
          path: "rest",
          model: model({ op: "aggregate", groupBy: "title", limit: taggedNumber(String(limit)) }),
        }),
        OPTIONS,
      );
    expect(grouped(2, 2).warnings).toEqual([
      { message: "Weaviate answered the 2 groups the limit allows; more may exist: raise limit (at most 1000)." },
    ]);
    expect(grouped(1, 2).warnings).toBeUndefined();
  });

  test("an aggregate with no count is refused", () => {
    for (const [text, path] of [
      ['{"count":"500"}', "rest"],
      ["[]", "rest"],
      ['{"data":{"Aggregate":{"Article":[]}}}', "graphql"],
      ['{"data":{"Aggregate":null}}', "graphql"],
      ['{"data":"x"}', "graphql"],
    ] as const) {
      expect(() => count(text, path), text).toThrow("Weaviate answered an aggregate with no count.");
    }
  });
});

describe("the bounds", () => {
  test("a text cell past 65,536 characters is cut with a marker, never inside a surrogate pair", () => {
    const long = "x".repeat(70_000);
    const result = weaviateResult(
      JSON.stringify([{ a: long, b: `${"y".repeat(65_535)}😀z` }]),
      shape("shards"),
      OPTIONS,
    );
    expect(result.rows[0]?.a).toBe(`${"x".repeat(65_536)}...[cut: 65536 of 70000 characters shown]`);
    expect(result.rows[0]?.b).toBe(`${"y".repeat(65_535)}...[cut: 65535 of 65538 characters shown]`);
    expect(result.warnings).toEqual([
      { message: "2 text cells were longer than 65536 characters and are cut, with a marker." },
    ]);
  });

  test("a vector cell is never cut", () => {
    const vector = Array.from({ length: 70_000 }, () => 0.5);
    const result = weaviateResult(JSON.stringify({ id: "a", vector }), shape("object"), OPTIONS);
    expect(result.rows[0]?.$vector).toHaveLength(70_000);
  });

  test("past the byte budget the remaining rows are dropped whole, with a warning and a limited page", () => {
    const rows = JSON.stringify([{ a: "x".repeat(40) }, { a: "y".repeat(40) }, { a: "z".repeat(40) }]);
    const result = weaviateResult(rows, shape("shards"), { executionTime: 1, budgetBytes: 100 });
    expect(result.rowCount).toBe(2);
    expect(result.warnings).toEqual([
      {
        message:
          "The result reached Studio's 100-byte result budget after 2 rows; the remaining 1 rows are not shown. Lower the limit, or ask for fewer properties.",
      },
    ]);
    expect(result.pagination).toEqual({ limit: 2, offset: 0, hasMore: false, totalReturned: 2, wasLimited: true });
    const mib = weaviateResult(rows, shape("shards"), { executionTime: 1, budgetBytes: 1_048_576 });
    expect(mib.warnings).toBeUndefined();
    expect(mib.pagination).toBeUndefined();
  });

  test("a full page the budget cuts names the last row shown for the next page, so no dropped row is skipped", () => {
    // Measured on a 3000-object collection: limit=1000 kept 689 rows, and the notice named the 1000th id until fixed.
    const objects = ["a", "b", "c"].map((id) => ({ class: "Big", id, properties: { body: id.repeat(40) } }));
    const result = weaviateResult(JSON.stringify({ objects }), shape("objects", { limit: 3 }), {
      executionTime: 1,
      budgetBytes: 150,
    });
    expect(result.rows.map((row) => row.$id)).toEqual(["a", "b"]);
    expect(result.warnings?.[0]).toEqual({ message: "More objects may follow: add &after=b to read the next 3." });
  });

  test("the default budget is 8 MiB, named so in the warning", () => {
    const cell = "x".repeat(60_000);
    const perRow = JSON.stringify({ a: cell }).length;
    const kept = Math.floor((8 * 1_048_576) / perRow);
    const result = weaviateResult(
      JSON.stringify(Array.from({ length: 200 }, () => ({ a: cell }))),
      shape("tenants"),
      OPTIONS,
    );
    expect(result.rowCount).toBe(kept);
    expect(result.warnings?.at(-1)?.message).toBe(
      `The result reached Studio's 8 MiB result budget after ${kept} rows; the remaining ${200 - kept} rows are not shown. Lower the limit, or ask for fewer properties.`,
    );
  });
});
