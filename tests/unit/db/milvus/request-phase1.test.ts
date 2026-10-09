/**
 * Phase 1 and the lowering of the Milvus metadata routes, entities/query and entities/get (vector-family spec 5.4,
 * 3.9, E12, E16, E26): the projection rules over a freshly described schema, the id types, the partition-key rule,
 * the consistency wire rule and the exact request each route sends. Phase 1 refusals carry phase 1; the one
 * DescribeCollection they read is the caller's, asserted with `expectCalls` in part C's execute tests.
 */
import { describe, expect, test } from "bun:test";
import { RequestRefusal } from "@/lib/db/console/dialect";
import {
  type MilvusOperation,
  milvusPhase0,
  milvusPhase1,
  type MilvusPhase1Reads,
  parseMilvusRequest,
} from "@/lib/db/providers/vector/milvus/request";
import { collectionSchema, describeAnswer, describedCollection, fieldSchema } from "../../../helpers/milvus-described";

const NOT_READ = { kind: "not-read" } as const;

function lower(text: string, reads: MilvusPhase1Reads = { index: NOT_READ }): MilvusOperation {
  return milvusPhase1(milvusPhase0(parseMilvusRequest(text), { database: "default" }), reads);
}

function lowerOn(collection: string, route: string, body: Record<string, unknown> | string): MilvusOperation {
  const text = typeof body === "string" ? `POST ${route}\n${body}` : `POST ${route}\n${JSON.stringify(body)}`;
  return lower(text, { collection: describedCollection(collection), index: NOT_READ });
}

function refused(collection: string, route: string, body: Record<string, unknown> | string) {
  try {
    lowerOn(collection, route, body);
  } catch (error) {
    if (error instanceof RequestRefusal) return { phase: error.phase, key: error.key, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("the metadata routes lower to one client call each, reading nothing first (3.9)", () => {
  test.each([
    ["POST databases/list", { kind: "listDatabases", db: "default" }],
    ['POST databases/describe\n{"dbName": "sales"}', { kind: "describeDatabase", db: "sales", request: {} }],
    ['POST collections/list\n{"dbName": "default"}', { kind: "showCollections", db: "default" }],
    [
      'POST collections/describe\n{"collectionName": "unloaded_big"}',
      { kind: "describeCollection", db: "default", request: { collection_name: "unloaded_big" } },
    ],
    [
      'POST collections/get_stats\n{"collectionName": "c"}',
      { kind: "getCollectionStatistics", db: "default", request: { collection_name: "c" } },
    ],
    [
      'POST collections/get_load_state\n{"collectionName": "c"}',
      { kind: "getLoadState", db: "default", request: { collection_name: "c" } },
    ],
    [
      'POST collections/get_load_state\n{"collectionName": "c", "partitionNames": ["2024-01"]}',
      { kind: "getLoadState", db: "default", request: { collection_name: "c", partition_names: ["2024-01"] } },
    ],
    [
      'POST partitions/list\n{"collectionName": "c"}',
      { kind: "showPartitions", db: "default", request: { collection_name: "c" } },
    ],
    [
      'POST indexes/list\n{"collectionName": "c"}',
      { kind: "describeIndex", db: "default", request: { collection_name: "c" } },
    ],
    [
      'POST indexes/describe\n{"collectionName": "c", "indexName": "vec"}',
      { kind: "describeIndex", db: "default", request: { collection_name: "c", index_name: "vec" } },
    ],
    ["POST aliases/list", { kind: "listAliases", db: "default", request: {} }],
    [
      'POST aliases/list\n{"collectionName": "c"}',
      { kind: "listAliases", db: "default", request: { collection_name: "c" } },
    ],
    [
      'POST aliases/describe\n{"aliasName": "cur"}',
      { kind: "describeAlias", db: "default", request: { alias: "cur" } },
    ],
  ])("%s", (text, operation) => {
    expect(lower(text)).toEqual(operation as MilvusOperation);
  });

  test("an entities route lowered without its DescribeCollection answer is a programming error", () => {
    expect(() => lower('POST entities/query\n{"collectionName": "c"}')).toThrow(
      "Phase 1 of an entities route needs the DescribeCollection answer fetched for it",
    );
  });
});

describe("entities/query (5.4)", () => {
  describe("dynamic fields omitted from DescribeCollection.fields (#1417)", () => {
    const fields = [
      fieldSchema({ name: "id", data_type: "Int64", is_primary_key: true }),
      fieldSchema({ name: "title", data_type: "VarChar" }),
      fieldSchema({ name: "vec", data_type: "FloatVector", type_params: [{ key: "dim", value: "4" }] }),
    ];

    test.each(["entities/query", "entities/get"])("%s includes and resolves $meta when enabled", (route) => {
      const reads = {
        collection: describeAnswer(collectionSchema("docs", fields, { enable_dynamic_field: true })),
        index: NOT_READ,
      };
      for (const outputFields of [undefined, ["$meta"]]) {
        const body = { collectionName: "docs", ...(route === "entities/get" ? { id: [1] } : {}), outputFields };
        const operation = lower(`POST ${route}\n${JSON.stringify(body)}`, reads);
        expect(operation.kind === "query" && operation.request.output_fields).toEqual(
          outputFields ?? ["id", "title", "$meta"],
        );
      }
    });

    test("a collection with dynamic fields disabled excludes $meta and refuses it without recommending it", () => {
      const reads = { collection: describeAnswer(collectionSchema("docs", fields)), index: NOT_READ };
      const operation = lower('POST entities/query\n{"collectionName":"docs"}', reads);
      expect(operation.kind === "query" && operation.request.output_fields).toEqual(["id", "title"]);
      expect(() => lower('POST entities/query\n{"collectionName":"docs","outputFields":["$meta"]}', reads)).toThrow(
        '"$meta" is not a field of docs, and docs has no dynamic field.',
      );
    });
  });

  test("example 3: the outputs as named, the dynamic key sent bare, limit and offset always sent (R43)", () => {
    const operation = lowerOn("docs_int64", "/v2/vectordb/entities/query", {
      collectionName: "docs_int64",
      filter: 'seq >= 10 and title like "doc 001%"',
      outputFields: ["id", "seq", "title", "tags", "big_int"],
      limit: 5,
    });
    expect(operation.kind).toBe("query");
    if (operation.kind !== "query") return;
    expect(operation.request).toEqual({
      collection_name: "docs_int64",
      expr: 'seq >= 10 and title like "doc 001%"',
      use_default_consistency: true,
      output_fields: ["id", "seq", "title", "tags", "big_int"],
      query_params: [
        { key: "limit", value: "5" },
        { key: "offset", value: "0" },
      ],
    });
    expect(operation.shape).toMatchObject({ limit: 5, offset: 0 });
    expect(operation.shape.schema.name).toBe("docs_int64");
  });

  test("an absent outputFields is the primary key, every scalar field and $meta, never a vector (R40 M19)", () => {
    const operation = lowerOn("docs_int64", "entities/query", { collectionName: "docs_int64" });
    expect(operation.kind === "query" && operation.request.output_fields).toEqual([
      "id",
      "seq",
      "title",
      "meta",
      "tags",
      "maybe_count",
      "$meta",
    ]);
    const varchar = lowerOn("docs_varchar", "entities/query", { collectionName: "docs_varchar" });
    expect(varchar.kind === "query" && varchar.request.output_fields).toEqual(["pk", "label"]);
  });

  test('"*" and a named vector field bring vectors in', () => {
    const operation = lowerOn("docs_int64", "entities/query", {
      collectionName: "docs_int64",
      outputFields: ["*", "vec"],
    });
    expect(operation.kind === "query" && operation.request.output_fields).toEqual(["*", "vec"]);
  });

  describe("the projection rules (5.4, R43 M10)", () => {
    test("$meta reads every dynamic key", () => {
      const operation = lowerOn("docs_int64", "entities/query", {
        collectionName: "docs_int64",
        outputFields: ["$meta"],
      });
      expect(operation.kind === "query" && operation.request.output_fields).toEqual(["$meta"]);
    });

    test("a declared field is resolved byte for byte, a leading space included", () => {
      const schema = collectionSchema("spaced", [
        fieldSchema({ name: "id", data_type: "Int64", is_primary_key: true }),
        fieldSchema({ name: " a", data_type: "Int32" }),
        fieldSchema({ name: "$meta", data_type: "JSON", is_dynamic: true }),
      ]);
      const operation = lower('POST entities/query\n{"collectionName": "spaced", "outputFields": [" a"]}', {
        collection: describeAnswer(schema),
        index: NOT_READ,
      });
      expect(operation.kind === "query" && operation.request.output_fields).toEqual([" a"]);
      expect(() =>
        lower('POST entities/query\n{"collectionName": "spaced", "outputFields": ["a b"]}', {
          collection: describeAnswer(schema),
          index: NOT_READ,
        }),
      ).toThrow(
        '"a b" is not a field of spaced and cannot be named as a dynamic key: name $meta to read every dynamic key.',
      );
    });

    test("on a collection with no dynamic field, a name it does not declare is refused in phase 1", () => {
      for (const entry of ["big_int", "$meta"]) {
        expect(
          refused("docs_varchar", "entities/query", { collectionName: "docs_varchar", outputFields: [entry] }),
        ).toEqual({
          phase: 1,
          key: "outputFields",
          message: `"${entry}" is not a field of docs_varchar, and docs_varchar has no dynamic field.`,
        });
      }
    });
  });

  test("a named level is sent with the default flag false, never both (R40 M24)", () => {
    const operation = lowerOn("docs_int64", "entities/query", {
      collectionName: "docs_int64",
      consistencyLevel: "Strong",
    });
    expect(operation.kind === "query" && operation.request).toMatchObject({
      consistency_level: "Strong",
      use_default_consistency: false,
    });
  });

  test("exprParams become expr_template_values, an integer from its digits (E12, E26)", () => {
    const operation = lowerOn(
      "docs_int64",
      "entities/query",
      '{"collectionName": "docs_int64", "filter": "big_int == {v}", "exprParams": {"v": 1152921504606846986}}',
    );
    expect(operation.kind === "query" && { ...operation.request.expr_template_values }).toEqual({
      v: { int64_val: "1152921504606846986" },
    });
  });

  test("orderByFields travel as one order_by_fields pair", () => {
    const operation = lowerOn("docs_int64", "entities/query", {
      collectionName: "docs_int64",
      orderByFields: ["seq:desc", "title"],
      partitionNames: ["part_a"],
    });
    expect(operation.kind === "query" && operation.request).toMatchObject({
      partition_names: ["part_a"],
      query_params: [
        { key: "limit", value: "100" },
        { key: "offset", value: "0" },
        { key: "order_by_fields", value: "seq:desc,title" },
      ],
    });
  });

  test("partitionNames on a partition-key collection are refused naming the key field (R42 M15)", () => {
    expect(
      refused("pk_partitioned", "entities/query", { collectionName: "pk_partitioned", partitionNames: ["p0"] }),
    ).toEqual({
      phase: 1,
      key: "partitionNames",
      message:
        "pk_partitioned is partitioned by its key field tenant, so Milvus refuses partitionNames: filter on tenant instead.",
    });
  });

  test("example 4: a lone count is sent as count(*) with no limit and no offset (R40 M23)", () => {
    const operation = lowerOn("docs_int64", "entities/query", {
      collectionName: "docs_int64",
      filter: "maybe_count is null",
      outputFields: [" COUNT(*)"],
    });
    expect(operation).toEqual({
      kind: "count",
      db: "default",
      request: {
        collection_name: "docs_int64",
        expr: "maybe_count is null",
        use_default_consistency: true,
        output_fields: ["count(*)"],
        query_params: [],
      },
    });
  });
});

describe("entities/get (5.4, E12, R45 F3)", () => {
  test("example 5: VarChar ids, a crafted one included, are one template value", () => {
    const crafted = 'zz"] or pk in ["vc-0002';
    const operation = lowerOn("docs_varchar", "entities/get", {
      collectionName: "docs_varchar",
      id: ["vc-0001", crafted],
      outputFields: ["pk", "label"],
    });
    expect(operation.kind).toBe("query");
    if (operation.kind !== "query") return;
    expect(operation.request.expr).toBe("pk in {ids}");
    expect({ ...operation.request.expr_template_values }).toEqual({
      ids: { array_val: { string_data: { data: ["vc-0001", crafted] } } },
    });
    expect(operation.request).toMatchObject({
      output_fields: ["pk", "label"],
      query_params: [{ key: "limit", value: "1000" }],
    });
    expect(operation.shape).toMatchObject({ limit: 2, offset: 0 });
  });

  test("an Int64 key takes a tagged integer or its digits as a string, both exactly (E26)", () => {
    const operation = lowerOn(
      "docs_int64",
      "entities/get",
      '{"collectionName": "docs_int64", "id": [469489107428444015, "-9223372036854775808", 1]}',
    );
    expect(operation.kind === "query" && { ...operation.request.expr_template_values }).toEqual({
      ids: { array_val: { long_data: { data: ["469489107428444015", "-9223372036854775808", "1"] } } },
    });
  });

  test.each(["9223372036854775808", "abc", "1.5", " 12", "007", "-0", "+5"])(
    "the malformed digit string %j against an Int64 key is refused in phase 1 (E12)",
    (id) => {
      expect(refused("docs_int64", "entities/get", { collectionName: "docs_int64", id: [id] })).toEqual({
        phase: 1,
        key: "id[0]",
        message: "id[0] is not an Int64 written as plain digits, and the primary key id is Int64.",
      });
    },
  );

  test("9223372036854775808 typed as a number is refused too", () => {
    expect(
      refused("docs_int64", "entities/get", '{"collectionName": "docs_int64", "id": 9223372036854775808}').key,
    ).toBe("id[0]");
  });

  test("a numeric id against a VarChar key is refused in phase 1 (E26)", () => {
    expect(refused("docs_varchar", "entities/get", { collectionName: "docs_varchar", id: [1] })).toEqual({
      phase: 1,
      key: "id[0]",
      message: "The primary key pk is VarChar: give ids as strings.",
    });
  });

  test("the same id twice is sent as given", () => {
    const operation = lowerOn("docs_varchar", "entities/get", { collectionName: "docs_varchar", id: ["a", "a"] });
    expect(operation.kind === "query" && operation.request.expr).toBe("pk in {ids}");
  });

  test("a primary key a filter cannot name is refused", () => {
    const schema = collectionSchema("odd", [fieldSchema({ name: " id", data_type: "Int64", is_primary_key: true })]);
    expect(() =>
      lower('POST entities/get\n{"collectionName": "odd", "id": 1}', {
        collection: describeAnswer(schema),
        index: NOT_READ,
      }),
    ).toThrow('The primary key " id" cannot be written in a filter, so Studio cannot get by it.');
  });

  test("a described collection with no primary key is a malformed answer", () => {
    const schema = collectionSchema("none", [fieldSchema({ name: "x", data_type: "Int64" })]);
    expect(() =>
      lower('POST entities/get\n{"collectionName": "none", "id": 1}', {
        collection: describeAnswer(schema),
        index: NOT_READ,
      }),
    ).toThrow("A described collection has no primary key field");
  });

  test("partitionNames on a partition-key collection are refused", () => {
    expect(
      refused("pk_partitioned", "entities/get", { collectionName: "pk_partitioned", id: 1, partitionNames: ["p"] })
        .phase,
    ).toBe(1);
  });
});
