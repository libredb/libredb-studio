/**
 * The browser's verdict on a Qdrant console text (vector-family spec 3.4, 3.9, QE9, QE11): `qdrantRefusal` is the
 * grammar and every phase 0 rule but the version gates, so a statement it refuses is never sent and never stored;
 * `readQdrantOperations` is the vocabulary row's `read`, the route's class for a text the console accepts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConsole } from "@/lib/db/console/parser";
import {
  QDRANT_DESTRUCTIVE_OPERATIONS,
  qdrantRefusal,
  readQdrantOperations,
} from "@/lib/db/providers/vector/qdrant/guard";
import { parseQdrantRequest, qdrantPhase0, qdrantVersionGates } from "@/lib/db/providers/vector/qdrant/request";
import { QDRANT_CONSOLE, QDRANT_ROUTES } from "@/lib/db/providers/vector/qdrant/routes";

/** The ten examples of spec 6.4, as a user types them. */
const EXAMPLES: readonly string[] = [
  "GET /collections",
  "GET /collections/docs/points/42",
  'POST /collections/docs/points/scroll\n{\n    "filter": {\n        "must": [\n            { "key": "category", "match": { "value": "alpha" } }\n        ]\n    },\n    "limit": 1,\n    "with_payload": true,\n    "with_vector": false\n}',
  'POST /collections/plain/points/query?consistency=majority\n{\n    "query": [0.2, 0.1, 0.9, 0.7],\n    "filter": { "must": [ { "key": "city", "match": { "value": "London" } } ] },\n    "params": { "hnsw_ef": 128, "exact": false },\n    "limit": 3\n}',
  'POST /collections/docs/points/query\n{"query": {"indices": [1, 3, 5, 7], "values": [0.1, 0.2, 0.3, 0.4]}, "using": "keywords"}',
  'POST /collections/docs/points/count\n{"filter": {"must": [{"key": "category", "match": {"value": "alpha"}}]}, "exact": true}',
  'POST /collections/docs/points/query\n{"query": {"text": "vector search", "model": "qdrant/bm25"}, "using": "keywords", "limit": 5, "with_payload": true}',
  'POST /collections/docs/points/query/batch\n{"searches": [{"query": 42, "using": "text", "limit": 3}, {"query": 42, "using": "image", "limit": 3}]}',
  'POST /collections/docs/points/query/groups\n{"query": 42, "using": "text", "group_by": "category", "group_size": 2, "limit": 3}',
  '// two titles from a scroll\nPOST /collections/docs/points/scroll\n{\n    "limit": 2, // two points\n    "with_payload": ["title"]\n}',
];

describe("qdrantRefusal", () => {
  test("accepts each example of spec 6.4", () => {
    for (const text of EXAMPLES) expect(qdrantRefusal(text), text).toBeUndefined();
  });

  test("refuses a model that is not local, naming the model and the rule, and PUT by the method set", () => {
    expect(
      qdrantRefusal(
        'POST /collections/docs/points/query\n{"query": {"text": "find similar", "model": "sentence-transformers/all-minilm-l6-v2"}, "using": "text"}',
      ),
    ).toBe(
      'query names the model "sentence-transformers/all-minilm-l6-v2", which this console does not send. Studio sends no inference input except a text for the local BM25 model: {"text": "...", "model": "qdrant/bm25"} or "bm25", in lower case, with no options, aimed at a sparse vector.',
    );
    expect(qdrantRefusal('PUT /collections/docs/points\n{"points": []}')).toContain(
      "PUT /collections/docs/points is a point or payload write",
    );
  });

  test("refuses the closed-console corpus of QE10 with its sentences", () => {
    for (const text of [
      'POST /collections/docs/points/scroll\n{"fliter": "x == 1"}',
      'POST /collections/docs/points/scroll\n{"filter": {"must_nto": []}}',
      'POST /collections/docs/points/scroll\n{"filter": {"must": [{"key": "n", "match": {"value": 1}, "rnage": {"gt": 0}}]}}',
      'POST /collections/docs/points/query?api_key=x\n{"query": [0.1]}',
      "PUT /collections/docs",
      "GET /collections/docs/points/42/payload",
      "GET /collections\nGET /aliases",
    ]) {
      expect(qdrantRefusal(text), text).toBeString();
    }
    expect(qdrantRefusal("GET /collections/a#b")).toBe("A route takes no # fragment. (line 1, column 19)");
  });

  test("a text refused only by a version gate passes the browser's verdict; the server's gate refuses it", () => {
    const text = 'POST /collections/docs/points/query\n{"query": [0.1], "using": "text", "params": {"idf": "global"}}';
    expect(qdrantRefusal(text)).toBeUndefined();
    expect(() => qdrantVersionGates(qdrantPhase0(parseQdrantRequest(text)), "1.18.3")).toThrow(
      "params.idf needs Qdrant 1.19.0 or later",
    );
  });

  test("a text refused only in phase 1 passes the browser's verdict", () => {
    expect(
      qdrantRefusal('POST /collections/docs/points/query\n{"query": {"text": "t", "model": "bm25"}, "using": "text"}'),
    ).toBeUndefined();
  });

  test("of the documentation blocks the v1 table accepts, the 18 with a model that is not local and the 5 carrying a provider key in options are refused", () => {
    const blocks = (
      JSON.parse(
        readFileSync(
          join(import.meta.dir, "..", "..", "..", "fixtures", "vector", "corpus", "qdrant-docs.json"),
          "utf8",
        ),
      ) as { readonly blocks: readonly { readonly file: string; readonly text: string }[] }
    ).blocks.filter((block) => {
      try {
        parseConsole(QDRANT_CONSOLE, QDRANT_ROUTES, block.text);
        return true;
      } catch {
        return false;
      }
    });
    const refused = blocks.filter((block) => qdrantRefusal(block.text) !== undefined);
    const nonLocal = refused.filter((block) => qdrantRefusal(block.text)?.includes("names the model"));
    const providerKey = blocks.filter((block) => /"[a-z]+-api-key"/.test(block.text));
    expect(nonLocal).toHaveLength(18);
    expect(providerKey).toHaveLength(5);
    for (const block of providerKey) expect(qdrantRefusal(block.text), block.file).toBeString();
  });

  test("an error that is not a refusal is not swallowed", () => {
    expect(() => qdrantRefusal(undefined as unknown as string)).toThrow(TypeError);
  });
});

describe("readQdrantOperations", () => {
  test("names the route's class for an accepted text, and undefined for a refused one", () => {
    expect(readQdrantOperations("GET /collections")).toEqual(["read"]);
    for (const text of EXAMPLES) expect(readQdrantOperations(text), text).toEqual(["read"]);
    expect(readQdrantOperations("DELETE /collections/docs")).toBeUndefined();
    expect(readQdrantOperations('POST /collections/docs/points/scroll\n{"fliter": {}}')).toBeUndefined();
    expect(() => readQdrantOperations(undefined as unknown as string)).toThrow(TypeError);
  });

  test("no v1 operation asks for a confirmation", () => {
    expect(QDRANT_DESTRUCTIVE_OPERATIONS.size).toBe(0);
  });
});
