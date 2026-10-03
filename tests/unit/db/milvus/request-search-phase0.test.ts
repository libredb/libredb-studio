/**
 * Phase 0 of entities/search and entities/hybrid_search (vector-family spec 5.4, 5.6, E12, E28, E34, E35): the
 * input shape, the caps, the candidate arithmetic, the search-parameter table's kinds and ranges, the closed rerank
 * table and the keys that can name a service, each refused before any call.
 */
import { describe, expect, test } from "bun:test";
import { RequestRefusal } from "@/lib/db/console/dialect";
import {
  type HybridPhase0,
  milvusPhase0,
  parseMilvusRequest,
  type SearchPhase0,
} from "@/lib/db/providers/vector/milvus/request";
import { NORM_SCORE_REFUSAL, permanentRefusalSentence } from "@/lib/db/providers/vector/milvus/routes";

const VECTOR = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

function phase0(text: string) {
  return milvusPhase0(parseMilvusRequest(text), { database: "default" });
}

function refused(text: string): { phase: number; key: string | null; message: string } {
  try {
    phase0(text);
  } catch (error) {
    if (error instanceof RequestRefusal) return { phase: error.phase, key: error.key, message: error.message };
    throw error;
  }
  throw new Error(`expected a refusal of ${text}`);
}

const searchText = (body: Record<string, unknown>) =>
  `POST /v2/vectordb/entities/search\n${JSON.stringify({ collectionName: "docs_int64", annsField: "vec", ...body })}`;
const search = (body: Record<string, unknown>) => phase0(searchText(body)) as SearchPhase0;
const refuseSearch = (body: Record<string, unknown>) => refused(searchText(body));

const hybridText = (body: Record<string, unknown>) =>
  `POST /v2/vectordb/entities/hybrid_search\n${JSON.stringify({
    collectionName: "docs_varchar",
    search: [
      { annsField: "f16", data: [VECTOR], limit: 10 },
      { annsField: "sparse", data: [{ "17": 0.4 }], limit: 10 },
    ],
    rerank: { strategy: "rrf", params: { k: 60 } },
    ...body,
  })}`;
const hybrid = (body: Record<string, unknown>) => phase0(hybridText(body)) as HybridPhase0;
const refuseHybrid = (body: Record<string, unknown>) => refused(hybridText(body));

describe("entities/search input (5.4, R51 U5)", () => {
  test("data searches by vectors, with the defaults of 5.4", () => {
    expect(search({ data: [VECTOR] })).toMatchObject({
      op: "entities/search",
      collection: "docs_int64",
      annsField: "vec",
      input: { kind: "data" },
      limit: 100,
      offset: 0,
      filter: "",
      output: { kind: "default" },
      searchParams: { metric: undefined, params: undefined, roundDecimal: -1 },
      grouping: undefined,
      consistency: { kind: "default" },
    });
  });

  test("ids search by the stored vectors of those rows", () => {
    expect(search({ ids: ["vc-0000", "vc-0001"] }).input).toEqual({ kind: "ids", values: ["vc-0000", "vc-0001"] });
  });

  test("data and ids together, or neither, are refused naming both", () => {
    const message =
      "entities/search takes data or ids, exactly one: data searches by vectors, ids by the stored vectors of those rows.";
    expect(refuseSearch({ data: [VECTOR], ids: [1] })).toEqual({ phase: 0, key: "data", message });
    expect(refuseSearch({})).toEqual({ phase: 0, key: "data", message });
  });

  test("annsField is always named (5.4)", () => {
    expect(refused(`POST entities/search\n{"collectionName": "c", "data": [[1, 2]]}`)).toEqual({
      phase: 0,
      key: "annsField",
      message: "entities/search needs annsField.",
    });
  });

  test.each([
    [{ data: [] }, "data", "data holds no query vector."],
    [{ data: Array.from({ length: 11 }, () => VECTOR) }, "data", "data holds 11 entries; Studio sends at most 10."],
    [{ data: [5] }, "data[0]", "data[0] takes a vector: a list of numbers, an index map or text."],
    [{ data: [{ constructor: 0.5 }] }, "data[0].constructor", "constructor cannot be a key of a sparse vector."],
    [{ data: [{ prototype: 0.5 }] }, "data[0].prototype", "prototype cannot be a key of a sparse vector."],
    [{ ids: [] }, "ids", "ids names no entity: give one id or a list of ids."],
    [{ ids: Array.from({ length: 11 }, (_, index) => index) }, "ids", "ids names 11 ids; Studio sends at most 10."],
    [{ data: [VECTOR], limit: 1025 }, "limit", 'limit is "1025"; Studio accepts 1 to 1024.'],
    [{ data: [VECTOR], limit: 0 }, "limit", "limit 0 would read every row in REST; Studio takes 1 to 1024."],
  ])("%j is refused", (body, key, message) => {
    expect(refuseSearch(body)).toEqual({ phase: 0, key, message });
  });

  test("functionScore, functionChains and searchAggregation are refused in every release (E34)", () => {
    for (const key of ["functionScore", "functionChains", "searchAggregation"]) {
      expect(
        refuseSearch({ data: [VECTOR], [key]: { functions: [{ params: { endpoint: "http://example.invalid" } }] } }),
      ).toEqual({
        phase: 0,
        key,
        message: permanentRefusalSentence(key),
      });
    }
  });

  test("the REST top-level params is refused naming searchParams.params (R40 M16)", () => {
    expect(refuseSearch({ data: [VECTOR], params: { radius: 0.9 } })).toEqual({
      phase: 0,
      key: "params",
      message:
        "params on entities/search is never read by Milvus, so Studio refuses it: put search parameters in searchParams.params.",
    });
  });
});

describe("grouping (5.4, R40 M16)", () => {
  test("groupingField with groupSize and strictGroupSize", () => {
    expect(search({ data: [VECTOR], groupingField: "label", groupSize: 2, strictGroupSize: true }).grouping).toEqual({
      field: "label",
      size: 2,
      strict: true,
    });
    expect(search({ data: [VECTOR], groupingField: "label" }).grouping).toEqual({
      field: "label",
      size: undefined,
      strict: undefined,
    });
  });

  test.each([
    [{ groupSize: 2 }, "groupSize", "groupSize needs groupingField: without it Milvus ignores groupSize."],
    [
      { strictGroupSize: true },
      "strictGroupSize",
      "strictGroupSize needs groupingField: without it Milvus ignores strictGroupSize.",
    ],
    [{ groupingField: "label", groupSize: 11 }, "groupSize", 'groupSize is "11"; Studio accepts 1 to 10.'],
    [{ groupingField: "label", groupSize: 0 }, "groupSize", 'groupSize is "0"; Studio accepts 1 to 10.'],
    [{ groupingField: "label", strictGroupSize: "yes" }, "strictGroupSize", "strictGroupSize takes true or false."],
  ])("%j is refused", (body, key, message) => {
    expect(refuseSearch({ data: [VECTOR], ...body })).toEqual({ phase: 0, key, message });
  });
});

describe("the candidate arithmetic of 5.6 (E28)", () => {
  const vectors = (count: number) => Array.from({ length: count }, () => VECTOR);

  test("nq 1, limit 1,024 and groupSize 10 is accepted (10,240)", () => {
    expect(search({ data: vectors(1), limit: 1024, groupingField: "label", groupSize: 10 }).limit).toBe(1024);
  });

  test("the same with offset 1 is refused (10,250)", () => {
    expect(refuseSearch({ data: vectors(1), limit: 1024, offset: 1, groupingField: "label", groupSize: 10 })).toEqual({
      phase: 0,
      key: "limit",
      message:
        "This search asks Milvus for 1 times (offset plus limit) times 10 = 10250 results; Studio's bound is 10,240 (nq, times (offset plus limit), times groupSize).",
    });
  });

  test("nq 10, limit 103 and groupSize 10 is refused (10,300) although nq times limit is 1,030", () => {
    expect(refuseSearch({ data: vectors(10), limit: 103, groupingField: "label", groupSize: 10 }).message).toContain(
      "= 10300 results",
    );
  });

  test("offset 15,000 with limit 1,024 and nq 10 is refused", () => {
    expect(refuseSearch({ data: vectors(10), limit: 1024, offset: 15_000 }).message).toContain("= 160240 results");
  });

  test("an offset past the query window is refused as an offset", () => {
    expect(refuseSearch({ data: vectors(1), offset: 16_385 })).toEqual({
      phase: 0,
      key: "offset",
      message: 'offset is "16385"; Studio accepts 0 to 16384.',
    });
  });
});

describe("searchParams (5.6, E12, E28)", () => {
  const withParams = (searchParams: unknown, extra: Record<string, unknown> = {}) =>
    refuseSearch({ data: [VECTOR], searchParams, ...extra });

  test("example 6: an index parameter at least offset plus limit is accepted", () => {
    expect(search({ data: [VECTOR], limit: 5, searchParams: { params: { ef: 64 } } }).searchParams).toMatchObject({
      metric: undefined,
      roundDecimal: -1,
    });
  });

  test("metric_type, round_decimal and number options are read as typed", () => {
    expect(
      search({
        data: [VECTOR],
        searchParams: { metric_type: "COSINE", round_decimal: 3, params: { refine_k: 1.5, drop_ratio_search: 0.2 } },
      }).searchParams,
    ).toMatchObject({ metric: "COSINE", roundDecimal: 3 });
  });

  test.each([
    [
      { params: { ef: 65_537 } },
      {},
      "searchParams.params.ef",
      'searchParams.params.ef is "65537"; Studio accepts 1 to 65536.',
    ],
    [
      { params: { ef: 15 } },
      { limit: 10, offset: 20 },
      "searchParams.params.ef",
      "searchParams.params.ef is 15, below the 30 results this search asks for: Milvus needs ef at least offset plus limit.",
    ],
    [
      { params: { ef: "64" } },
      {},
      "searchParams.params.ef",
      "searchParams.params.ef takes a JSON integer such as 10, written without quotes, a fraction or an exponent.",
    ],
    [
      { params: { drop_ratio_search: 0.99999999 } },
      {},
      "searchParams.params.drop_ratio_search",
      "searchParams.params.drop_ratio_search is 0.99999999, 1 as Milvus stores it; it must be at least 0 and below 1.",
    ],
    [
      { params: { dim_max_score_ratio: 1.31 } },
      {},
      "searchParams.params.dim_max_score_ratio",
      "searchParams.params.dim_max_score_ratio is 1.31, 1.309999942779541 as Milvus stores it; it must be at least 0.5 and at most 1.3.",
    ],
    [
      { params: { refine_k: 0.5 } },
      {},
      "searchParams.params.refine_k",
      "searchParams.params.refine_k is 0.5; it must be at least 1 and at most 64.",
    ],
    [
      { params: { refine_k: "2" } },
      {},
      "searchParams.params.refine_k",
      "searchParams.params.refine_k takes a JSON number, written without quotes.",
    ],
    [
      { params: { radius: "0.9" } },
      {},
      "searchParams.params.radius",
      "searchParams.params.radius takes a JSON number, written without quotes.",
    ],
    [
      { params: { range_filter: 0.5 } },
      {},
      "searchParams.params.range_filter",
      "range_filter needs radius: it bounds a range search that radius opens.",
    ],
    [
      { params: { nlist: 128 } },
      {},
      "searchParams.params.nlist",
      '"nlist" is not a search parameter Studio sends; it sends nprobe, ef, reorder_k, search_list, refine_k, rbq_bits_query, drop_ratio_search, dim_max_score_ratio, refine_factor, filter_threshold, beamwidth, vectors_beamwidth, radius, range_filter, each to the index types that take it.',
    ],
    [
      { params: { toString: 1 } },
      {},
      "searchParams.params.toString",
      expect.stringContaining('"toString" is not a search parameter'),
    ],
    [{ params: [] }, {}, "searchParams.params", "searchParams.params takes an object."],
    [
      { round_decimal: 7 },
      {},
      "searchParams.round_decimal",
      'searchParams.round_decimal is "7"; Studio accepts -1 to 6.',
    ],
    [
      { metricType: "COSINE" },
      {},
      "searchParams.metricType",
      'searchParams does not take "metricType": Studio refuses a key it does not know rather than let Milvus drop it, and it takes metric_type, params, round_decimal.',
    ],
  ])("%j is refused", (searchParams, extra, key, message) => {
    expect(withParams(searchParams, extra)).toEqual({ phase: 0, key, message });
  });

  test("nprobe 16.0 is a double literal, refused for an integer key (E12)", () => {
    expect(
      refused(
        'POST entities/search\n{"collectionName": "c", "annsField": "v", "data": [[1, 2]], "searchParams": {"params": {"nprobe": 16.0}}}',
      ),
    ).toEqual({
      phase: 0,
      key: "searchParams.params.nprobe",
      message:
        "searchParams.params.nprobe takes a JSON integer such as 10, written without quotes, a fraction or an exponent.",
    });
  });

  test("searchParams must be an object", () => {
    expect(withParams(5)).toEqual({ phase: 0, key: "searchParams", message: "searchParams takes an object." });
  });

  test.each([
    [{ params: { url: "http://example.invalid" } }, "searchParams.params.url"],
    [{ params: { nested: [{ Endpoint: "http://example.invalid" }] } }, "searchParams.params.nested[0].Endpoint"],
    [{ provider: "openai" }, "searchParams.provider"],
    [{ params: { credential: "label" } }, "searchParams.params.credential"],
    [{ params: { api_key: "x" } }, "searchParams.params.api_key"],
  ])("a key that can name a service is refused at any depth (E34): %j", (searchParams, key) => {
    expect(withParams(searchParams)).toEqual({
      phase: 0,
      key,
      message: `${key} is refused in every release: a key that can name a service, a model provider or a credential never reaches Milvus from Studio.`,
    });
  });
});

describe("entities/hybrid_search (5.4, E35)", () => {
  test("example 8 reads two sub-requests and an rrf rerank", () => {
    const parsed = hybrid({ outputFields: ["pk", "label"], limit: 5 });
    expect(parsed).toMatchObject({ op: "entities/hybrid_search", limit: 5, offset: 0, grouping: undefined });
    expect(parsed.subRequests.map((sub) => [sub.annsField, sub.limit, sub.data.length])).toEqual([
      ["f16", 10, 1],
      ["sparse", 10, 1],
    ]);
    expect(parsed.rerank.strategy).toBe("rrf");
  });

  test("a sub-request's absent limit is 100, and it takes a filter, exprParams, params and metricType", () => {
    const parsed = hybrid({
      search: [
        {
          annsField: "f16",
          data: [VECTOR],
          filter: "label == {l}",
          exprParams: { l: "north" },
          params: { ef: 100 },
          metricType: "L2",
        },
      ],
    });
    expect(parsed.subRequests[0]).toMatchObject({ limit: 100, filter: "label == {l}", metric: "L2" });
    expect({ ...parsed.subRequests[0].templates }).toEqual({ l: { kind: "string", value: "north" } });
  });

  test.each([
    [
      { offset: 5 },
      "search[0].offset",
      "offset is ignored by Milvus inside a hybrid sub-request: page with the top-level offset.",
    ],
    [
      { ids: [1] },
      "search[0].ids",
      "ids cannot search inside a hybrid sub-request: Milvus fails a sub-request that carries ids.",
    ],
    [
      { consistencyLevel: "Strong" },
      "search[0].consistencyLevel",
      "consistencyLevel belongs at the top level of entities/hybrid_search, where Milvus reads it; Milvus drops a sub-request's own level.",
    ],
    [
      { ignoreGrowing: true },
      "search[0].ignoreGrowing",
      "ignoreGrowing is not sent: no measurement reached it through Studio's client.",
    ],
    [
      { groupingField: "label" },
      "search[0].groupingField",
      "groupingField belongs at the top level of entities/hybrid_search, where Milvus reads it.",
    ],
    [{ searchParams: {} }, "search[0].searchParams", "a hybrid sub-request names its search parameters in params."],
    [
      { anns: "f16" },
      "search[0].anns",
      'search[0] does not take "anns": Studio refuses a key it does not know rather than let Milvus drop it, and it takes annsField, data, filter, exprParams, limit, params, metricType.',
    ],
    [
      { params: { url: "http://example.invalid" } },
      "search[0].params.url",
      "search[0].params.url is refused in every release: a key that can name a service, a model provider or a credential never reaches Milvus from Studio.",
    ],
    [{ limit: 1025 }, "search[0].limit", 'search[0].limit is "1025"; Studio accepts 1 to 1024.'],
    [
      { params: { ef: 5 } },
      "search[0].params.ef",
      "search[0].params.ef is 5, below the 10 results this search asks for: Milvus needs ef at least offset plus limit.",
    ],
  ])("a sub-request with %j is refused", (extra, key, message) => {
    expect(refuseHybrid({ search: [{ annsField: "f16", data: [VECTOR], limit: 10, ...extra }] })).toEqual({
      phase: 0,
      key,
      message,
    });
  });

  test.each([
    [{ search: "x" }, "search", "search takes a list."],
    [{ search: [] }, "search", "search holds no sub-request."],
    [
      { search: Array.from({ length: 11 }, () => ({ annsField: "f16", data: [VECTOR] })) },
      "search",
      "search holds 11 entries; Studio sends at most 10.",
    ],
    [{ search: [5] }, "search[0]", "search[0] takes an object."],
    [{ search: [{ data: [VECTOR] }] }, "search[0].annsField", "search[0] needs annsField."],
    [{ search: [{ annsField: "f16" }] }, "search[0].data", "search[0] needs data."],
    [
      {
        search: [
          { annsField: "f16", data: [VECTOR, VECTOR] },
          { annsField: "sparse", data: [{ "1": 1 }] },
        ],
      },
      "search[1].data",
      "search[0] holds 2 query vectors and search[1] holds 1: Milvus needs the same number in every sub-request.",
    ],
    [{ functionScore: {} }, "functionScore", permanentRefusalSentence("functionScore")],
    [{ functionChains: [] }, "functionChains", permanentRefusalSentence("functionChains")],
    [{ searchAggregation: {} }, "searchAggregation", permanentRefusalSentence("searchAggregation")],
  ])("%j is refused", (body, key, message) => {
    expect(refuseHybrid(body)).toEqual({ phase: 0, key, message });
  });

  test("rerank is required", () => {
    expect(
      refused(
        `POST entities/hybrid_search\n${JSON.stringify({ collectionName: "c", search: [{ annsField: "v", data: [VECTOR] }] })}`,
      ),
    ).toEqual({ phase: 0, key: "rerank", message: "entities/hybrid_search needs rerank." });
  });

  describe("the closed rerank table (E35)", () => {
    test.each(["model", "decay", "boost", "zzz"])("strategy %s is refused before the request", (strategy) => {
      expect(refuseHybrid({ rerank: { strategy } })).toEqual({
        phase: 0,
        key: "rerank.strategy",
        message: `rerank.strategy takes rrf or weighted, and "${strategy}" is refused before the request: Studio sends no other ranker.`,
      });
    });

    test("rrf with no params, with {} and with k are accepted", () => {
      expect(hybrid({ rerank: { strategy: "rrf" } }).rerank.params).toBeUndefined();
      expect(hybrid({ rerank: { strategy: "rrf", params: {} } }).rerank.strategy).toBe("rrf");
      expect(hybrid({ rerank: { strategy: "rrf", params: { k: 0.5 } } }).rerank.strategy).toBe("rrf");
    });

    test("weighted with one weight per sub-request is accepted", () => {
      expect(hybrid({ rerank: { strategy: "weighted", params: { weights: [0, 1] } } }).rerank.strategy).toBe(
        "weighted",
      );
    });

    test.each([
      [
        { strategy: "rrf", params: { k: 0 } },
        "rerank.params.k",
        "rerank.params.k is 0; Milvus takes a k above 0 and below 16384.",
      ],
      [
        { strategy: "rrf", params: { k: 16384 } },
        "rerank.params.k",
        "rerank.params.k is 16384; Milvus takes a k above 0 and below 16384.",
      ],
      [
        { strategy: "rrf", params: { k: "60" } },
        "rerank.params.k",
        "rerank.params.k takes a JSON number, written without quotes.",
      ],
      [
        { strategy: "rrf", params: { k: 60, url: "http://example.invalid" } },
        "rerank.params.url",
        "rerank.params.url is refused in every release: a key that can name a service, a model provider or a credential never reaches Milvus from Studio.",
      ],
      [
        { strategy: "rrf", params: { weights: [1, 1] } },
        "rerank.params.weights",
        'rerank rrf does not take "weights": Studio refuses a key it does not know rather than let Milvus drop it, and it takes k.',
      ],
      [
        { strategy: "weighted", params: { weights: [1, 1], norm_score: true } },
        "rerank.params.norm_score",
        NORM_SCORE_REFUSAL,
      ],
      [{ strategy: "weighted" }, "rerank.params", "weighted needs params.weights, one per sub-request."],
      [
        { strategy: "weighted", params: { weights: [1] } },
        "rerank.params.weights",
        "rerank.params.weights holds 1 weights for 2 sub-requests: give one per sub-request.",
      ],
      [
        { strategy: "weighted", params: { weights: [1.5, 0] } },
        "rerank.params.weights[0]",
        "rerank.params.weights[0] is 1.5; a weight is 0 to 1.",
      ],
      [
        { strategy: "weighted", params: { weights: 1 } },
        "rerank.params.weights",
        "rerank.params.weights takes a list.",
      ],
      [{ strategy: 1 }, "rerank.strategy", "rerank.strategy takes a string."],
      [
        { strategy: "rrf", ranker: "x" },
        "rerank.ranker",
        'rerank does not take "ranker": Studio refuses a key it does not know rather than let Milvus drop it, and it takes strategy, params.',
      ],
    ])("%j is refused", (rerank, key, message) => {
      expect(refuseHybrid({ rerank })).toEqual({ phase: 0, key, message });
    });

    test("rerank must be an object", () => {
      expect(refuseHybrid({ rerank: "rrf" })).toEqual({ phase: 0, key: "rerank", message: "rerank takes an object." });
    });
  });

  describe("the hybrid arithmetic of 5.6 (E28)", () => {
    const subs = (nq: number, limits: readonly number[]) =>
      limits.map((limit) => ({ annsField: "f16", data: Array.from({ length: nq }, () => VECTOR), limit }));

    test("nq 2, two sub-requests of 1,000 and an outer limit of 1,024 is accepted (6,048)", () => {
      expect(hybrid({ search: subs(2, [1000, 1000]), limit: 1024 }).limit).toBe(1024);
    });

    test("the same at nq 4 is refused (12,096)", () => {
      expect(refuseHybrid({ search: subs(4, [1000, 1000]), limit: 1024 }).message).toContain("= 12096 results");
    });

    test("nq 1, two sub-requests of 500, outer limit 24 and groupSize 10 is accepted (10,240), 25 refused (10,250)", () => {
      expect(
        hybrid({ search: subs(1, [500, 500]), limit: 24, groupingField: "label", groupSize: 10 }).grouping,
      ).toEqual({
        field: "label",
        size: 10,
        strict: undefined,
      });
      expect(refuseHybrid({ search: subs(1, [500, 500]), limit: 25, groupingField: "label", groupSize: 10 })).toEqual({
        phase: 0,
        key: "limit",
        message:
          "This search asks Milvus for 1 times (the sub-request limits plus offset plus limit) times 10 = 10250 results; Studio's bound is 10,240 (nq, times (the sub-request limits plus offset plus limit), times groupSize).",
      });
    });

    test("a sum over sub-requests passes the bound while each alone does not", () => {
      expect(refuseHybrid({ search: subs(2, [1000, 1000, 1000, 1000, 1000, 1000]) }).message).toContain(
        "= 12200 results",
      );
    });

    test("the filters of every sub-request sum to at most 64 KiB", () => {
      const search = [
        { annsField: "f16", data: [VECTOR], filter: "a".repeat(40_000) },
        { annsField: "f16", data: [VECTOR], filter: "a".repeat(40_000) },
      ];
      expect(refuseHybrid({ search }).key).toBe("filter");
    });
  });
});
