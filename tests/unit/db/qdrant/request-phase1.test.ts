/**
 * The version gates (QE30) and phase 1 (vector-family spec 6.4, QE12, QE14): a key newer than the server is refused
 * by name with the version it needs, with no call; then every query vector is checked against the collection
 * described for this request, and the body is written from the parser's tokens, dense and multivector numbers as
 * doubles by the target vector's kind.
 */
import { describe, expect, test } from "bun:test";
import { RequestRefusal } from "@/lib/db/console/dialect";
import {
  parseQdrantRequest,
  type QdrantCollectionFacts,
  qdrantPhase0,
  qdrantPhase1,
  qdrantVersionGates,
} from "@/lib/db/providers/vector/qdrant/request";
import { dense, factsOf, seededFacts } from "../../../helpers/qdrant-facts";

const plan = (text: string) => qdrantPhase0(parseQdrantRequest(text));
const docs = new Map([["docs", seededFacts("docs")]]);
const query = (body: string) => `POST /collections/docs/points/query\n${body}`;
function wire(text: string, facts: ReadonlyMap<string, QdrantCollectionFacts> = docs) {
  return qdrantPhase1(plan(text), facts);
}
function refused(run: () => unknown): RequestRefusal {
  try {
    run();
  } catch (error) {
    if (error instanceof RequestRefusal) return error;
    throw error;
  }
  throw new Error("accepted");
}

describe("the version gates (QE30)", () => {
  const gated = (text: string, version: string | null) => refused(() => qdrantVersionGates(plan(text), version));

  test("a 1.19 key against a 1.17 server is refused naming the version it needs, in phase 0", () => {
    const refusal = gated(query('{"query": [0.1], "params": {"idf": "global"}}'), "1.17.1");
    expect({ phase: refusal.phase, key: refusal.key, message: refusal.message }).toEqual({
      phase: 0,
      key: "params.idf",
      message:
        "params.idf needs Qdrant 1.19.0 or later, and this server is 1.17.1. An older server ignores the key or answers an error that names no key, so Studio refuses it.",
    });
  });

  test("params.idf against 1.18 and rrf.weights against 1.16 are refused; each opens on the version that reads it", () => {
    expect(gated(query('{"query": [0.1], "params": {"idf": "global"}}'), "1.18.3").key).toBe("params.idf");
    const weights = query('{"prefetch": [{"query": [0.1]}], "query": {"rrf": {"weights": [3.0, 1.0]}}}');
    expect(gated(weights, "1.16.3").key).toBe("rrf.weights");
    expect(() => qdrantVersionGates(plan(weights), "1.17.0")).not.toThrow();
    expect(() =>
      qdrantVersionGates(plan(query('{"query": [0.1], "params": {"idf": "global"}}')), "1.19.1"),
    ).not.toThrow();
    expect(() =>
      qdrantVersionGates(plan(query('{"query": [0.1], "params": {"idf": "global"}}')), "2.0.0"),
    ).not.toThrow();
  });

  test("relevance feedback, match.prefix, slice and the 1.19.1 formula forms each name their version", () => {
    const feedback = query(
      '{"query": {"relevance_feedback": {"target": [0.1], "feedback": [{"example": 7, "score": 0.5}], "strategy": {"naive": {"a": 1, "b": 0.5, "c": 1}}}}}',
    );
    expect(gated(feedback, "1.16.3").message).toContain("relevance_feedback needs Qdrant 1.17.0 or later");
    const scroll = (condition: string) => `POST /collections/docs/points/scroll\n{"filter": {"must": [${condition}]}}`;
    expect(gated(scroll('{"key": "a", "match": {"prefix": "al"}}'), "1.18.3").message).toContain(
      "match.prefix needs Qdrant 1.19.0 or later",
    );
    expect(gated(scroll('{"slice": {"index": 0, "total": 2}}'), "1.18.3").message).toContain(
      "slice needs Qdrant 1.19.0",
    );
    const formula = query('{"prefetch": {"query": [0.1]}, "query": {"formula": {"acosh": 2}}}');
    expect(gated(formula, "1.19.0").message).toContain(
      "formula acosh needs Qdrant 1.19.1 or later, and this server is 1.19.0",
    );
  });

  test("a version that is missing or not plain major.minor.patch refuses every gated key, and a request with none opens", () => {
    const idf = query('{"query": [0.1], "params": {"idf": "global"}}');
    expect(gated(idf, "1.20.0-dev").message).toContain(
      'and this server reported the version "1.20.0-dev", which is not a plain major.minor.patch.',
    );
    expect(gated(idf, null).message).toContain("and this server reported no version.");
    expect(() => qdrantVersionGates(plan(query('{"query": [0.1]}')), null)).not.toThrow();
  });
});

describe("dense vectors", () => {
  test("a typed integer is written as a double, so a pasted cell keeps its meaning", () => {
    const facts = new Map([["plain", factsOf([dense("", 4, { metric: "dot", nativeMetric: "Dot" })])]]);
    expect(wire('POST /collections/plain/points/query\n{"query": [1, 2, 3, 4]}', facts).body).toBe(
      '{"query":[1.0,2.0,3.0,4.0],"limit":10}',
    );
    expect(wire('POST /collections/plain/points/query\n{"query": [0.2, 0.1, 0.9, 0.7]}', facts).body).toBe(
      '{"query":[0.2,0.1,0.9,0.7],"limit":10}',
    );
  });

  test("the length must equal the vector's size", () => {
    const refusal = refused(() => wire(query('{"query": [0.1, 0.2], "using": "image"}')));
    expect({ phase: refusal.phase, message: refusal.message }).toEqual({
      phase: 1,
      message: 'query: Vector field "image" (float32): 2 elements given, the field\'s dimension is 64.',
    });
  });

  test("each element is checked in its own datatype's range: float16 within 65,504, uint8 integers 0 to 255, turbo4 as float32", () => {
    const facts = new Map([["small", seededFacts("small_dtypes")]]);
    const eight = (value: string) => [value, "0", "0", "0", "0", "0", "0", "0"].join(", ");
    const run = (vector: string, using: string) =>
      wire(`POST /collections/small/points/query\n{"query": [${vector}], "using": "${using}"}`, facts);
    expect(run(eight("65504"), "f16").body).toContain('"query":[65504.0,');
    expect(refused(() => run(eight("65504.00390625"), "f16")).message).toContain("element 0 is 65504.00390625");
    expect(run(eight("255"), "u8").body).toContain('"query":[255.0,');
    for (const value of ["256", "-1", "1.5"]) {
      expect(refused(() => run(eight(value), "u8")).message, value).toContain("not an integer from 0 to 255");
    }
    const t4 = Array.from({ length: 64 }, () => "0.1").join(", ");
    expect(run(t4, "t4").body).toContain('"using":"t4"');
    expect(
      refused(() => run(Array.from({ length: 64 }, (_, index) => (index === 3 ? "1e39" : "0.1")).join(", "), "t4"))
        .message,
    ).toContain("element 3 is 1e+39");
  });

  test("1e39, finite as a double and infinite as a float32, is refused before any request", () => {
    const refusal = refused(() => plan(query('{"query": [1e39, 0.1], "using": "text"}')));
    expect({ phase: refusal.phase, key: refusal.key }).toEqual({ phase: 0, key: "query" });
    expect(refusal.message).toContain("element 0 is 1e+39");
  });

  test("a null element, which is how Qdrant prints a float16 that overflowed, is refused by name in phase 0", () => {
    expect(refused(() => plan(query('{"query": [null, 1.0, 2.0, 3.0], "using": "f16"}'))).message).toBe(
      "query: element 0 is null. Qdrant prints a float16 element that overflowed as null, and a vector with one cannot be sent back as a query.",
    );
  });

  test("a vector whose declared size is outside 1 to 65,536 takes no query vector", () => {
    const facts = new Map([["odd", factsOf([dense("v", 70_000)])]]);
    expect(
      refused(() => wire('POST /collections/odd/points/query\n{"query": [0.1], "using": "v"}', facts)).message,
    ).toBe('"v" declares the size 70000, outside 1 to 65536, so no query vector fits it.');
  });
});

describe("multivectors and sparse vectors", () => {
  test("a two-row integral multivector is written as doubles, so Qdrant does not read it as a sparse pair", () => {
    const facts = new Map([
      ["mv", factsOf([dense("colbert", 2, { kind: "multi", metric: "dot", nativeMetric: "Dot" })])],
    ]);
    expect(wire('POST /collections/mv/points/query\n{"query": [[1, 2], [3, 4]], "using": "colbert"}', facts).body).toBe(
      '{"query":[[1.0,2.0],[3.0,4.0]],"using":"colbert","limit":10}',
    );
    expect(
      refused(() => wire('POST /collections/mv/points/query\n{"query": [[1, 2, 3]], "using": "colbert"}', facts))
        .message,
    ).toBe('query: Vector field "colbert" (float32): row 0 holds 3 elements, the field\'s dimension is 2.');
  });

  test("a flat list aimed at a multivector is one row of it", () => {
    const facts = new Map([
      ["mv", factsOf([dense("colbert", 2, { kind: "multi", metric: "dot", nativeMetric: "Dot" })])],
    ]);
    expect(wire('POST /collections/mv/points/query\n{"query": [1, 2], "using": "colbert"}', facts).body).toBe(
      '{"query":[1.0,2.0],"using":"colbert","limit":10}',
    );
  });

  test("rows times size stays below 1,048,576 for every caller", () => {
    const facts = new Map([["mv", factsOf([dense("m", 4096, { kind: "multi" })])]]);
    const rows = (count: number) =>
      Array.from({ length: count }, () => `[${Array.from({ length: 4096 }, () => "0").join(",")}]`);
    const big = { ...plan(`POST /collections/mv/points/query\n{"query": [${rows(1).join(",")}], "using": "m"}`) };
    // 256 rows of 4,096 pass the console's own bounds only through a caller that builds the plan itself.
    const literal = big.literals[0];
    const wide = {
      ...big,
      literals: [
        {
          ...literal,
          node: Object.freeze(Array.from({ length: 256 }, () => (literal.node as readonly unknown[])[0])) as never,
        },
      ],
    };
    expect(refused(() => qdrantPhase1(wide, facts)).message).toContain(
      "256 rows hold 1048576 elements, above the bound of 1048575",
    );
  });

  test("a sparse query takes indices up to 4294967295, distinct, and refuses one past it in phase 0", () => {
    expect(wire(query('{"query": {"indices": [0, 4294967295], "values": [0.5, 1]}, "using": "keywords"}')).body).toBe(
      '{"query":{"indices":[0,4294967295],"values":[0.5,1]},"using":"keywords","limit":10}',
    );
    expect(
      refused(() => plan(query('{"query": {"indices": [4294967296], "values": [1]}, "using": "keywords"}'))).message,
    ).toContain("index 4294967296 is not an integer from 0 to below 4294967296");
    expect(
      refused(() => plan(query('{"query": {"indices": [1, 1], "values": [1, 2]}, "using": "keywords"}'))).message,
    ).toContain("index 1 is given twice");
    expect(refused(() => wire(query('{"query": {"indices": [1], "values": [1]}, "using": "text"}'))).message).toBe(
      'query is a sparse vector, and "text" is a dense vector: write a list of numbers.',
    );
    expect(refused(() => wire(query('{"query": [0.1], "using": "keywords"}'))).message).toBe(
      'query is a list of numbers, and "keywords" is a sparse vector: write {"indices": [...], "values": [...]}.',
    );
  });
});

describe("vector names", () => {
  test("a collection of named vectors needs using, naming the vectors it has", () => {
    expect(refused(() => wire(query('{"query": [0.2, 0.1, 0.9, 0.7]}'))).message).toBe(
      'The collection "docs" has no unnamed vector, so the search needs "using" with a vector\'s name: it has text, image, colbert, keywords.',
    );
  });

  test("a using that names no vector is refused naming the collection's vectors, also for a point-id query", () => {
    expect(refused(() => wire(query('{"query": 42, "using": "texts"}'))).message).toBe(
      'using names "texts", which is no vector of the collection "docs": it has text, image, colbert, keywords.',
    );
  });

  test("a stage that searches no vector needs no using", () => {
    expect(wire(query('{"query": {"order_by": "seq"}}')).body).toBe('{"query":{"order_by":"seq"},"limit":10}');
    expect(wire("POST /collections/docs/points/scroll").body).toBe('{"limit":10}');
  });

  test("a lookup_from vector must exist in the collection it names", () => {
    const facts = new Map([
      ["docs", seededFacts("docs")],
      ["other", factsOf([dense("image-512", 4)])],
    ]);
    const text = query(
      '{"query": 42, "using": "image", "lookup_from": {"collection": "other", "vector": "image-512"}}',
    );
    expect(wire(text, facts).body).toBe(
      '{"query":42,"using":"image","lookup_from":{"collection":"other","vector":"image-512"},"limit":10}',
    );
    expect(
      refused(() =>
        wire(
          query('{"query": 42, "using": "image", "lookup_from": {"collection": "other", "vector": "missing"}}'),
          facts,
        ),
      ).message,
    ).toBe('lookup_from.vector names "missing", which is no vector of the collection "other": it has image-512.');
  });

  test("a collection phase 1 needs and was not described is a programming error, not a refusal", () => {
    expect(() => qdrantPhase1(plan(query('{"query": [0.1]}')), new Map())).toThrow(
      "The collection docs was not described for this request",
    );
  });
});

describe("the wire", () => {
  test("carries the operation, the path parameters, the declared query keys and the shape the result reads", () => {
    const written = wire(
      'POST /collections/docs/points/count?consistency=2\n{"filter": {"must": [{"key": "category", "match": {"value": "alpha"}}]}}',
      new Map(),
    );
    expect(written).toEqual({
      op: "count_points",
      params: { collection_name: "docs" },
      query: { consistency: "2" },
      body: '{"filter":{"must":[{"key":"category","match":{"value":"alpha"}}]},"exact":true}',
      shape: { op: "count_points", facts: null, searches: [], exact: true, warnings: [] },
    });
    expect(wire("GET /collections", new Map())).toEqual({
      op: "get_collections",
      params: {},
      query: {},
      shape: { op: "get_collections", facts: null, searches: [], exact: false, warnings: [] },
    });
  });

  test("Review Focus: a match on an integer above 2^53 reaches the wire with exactly its digits", () => {
    expect(
      wire(
        'POST /collections/docs/points/query\n{"query": [0.1], "using": "image", "filter": {"must": [{"key": "big_int", "match": {"any": [9007199254740993, 18014398509481985]}}]}}',
        new Map([["docs", factsOf([dense("image", 1, { metric: "euclidean", nativeMetric: "Euclid" })])]]),
      ).body,
    ).toBe(
      '{"query":[0.1],"using":"image","filter":{"must":[{"key":"big_int","match":{"any":[9007199254740993,18014398509481985]}}]},"limit":10}',
    );
  });

  test("a batch's searches each record their form and their vector, for the score column", () => {
    const written = wire(
      'POST /collections/docs/points/query/batch\n{"searches": [{"query": 42, "using": "text", "limit": 3}, {"query": 42, "using": "image", "limit": 3}]}',
    );
    expect(written.shape.searches).toEqual([
      { form: "id", using: "text" },
      { form: "id", using: "image" },
    ]);
  });
});

describe("the local BM25 model (QE11)", () => {
  test("qdrant/bm25 and bm25 without options are accepted in phase 0, and on the sparse keywords vector in phase 1", () => {
    for (const model of ["qdrant/bm25", "bm25"]) {
      const read = plan(
        query(`{"query": {"text": "vector search", "model": "${model}"}, "using": "keywords", "limit": 5}`),
      );
      const wire = qdrantPhase1(read, docs);
      expect(wire.body).toBe(`{"query":{"text":"vector search","model":"${model}"},"using":"keywords","limit":5}`);
    }
  });

  test("bm25 aimed at a dense vector is refused in phase 1, after the collection read", () => {
    const read = plan(query('{"query": {"text": "vector search", "model": "bm25"}, "using": "text"}'));
    let refused: unknown;
    try {
      qdrantPhase1(read, docs);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(RequestRefusal);
    expect((refused as RequestRefusal).phase).toBe(1);
    expect((refused as RequestRefusal).message).toBe(
      'query is a text for the local BM25 model, which writes a sparse vector, and "text" is a dense vector: aim it at a sparse vector with "using".',
    );
  });
});
