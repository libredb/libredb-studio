/**
 * No server-side inference (vector-family spec 4.2 VF2, QE11): every inference object, a text, an image or an
 * object handed to a model, is refused in phase 0 with no call, at any depth of a query, a prefetch, a batch's
 * searches and a grouped query, unless its model is exactly `qdrant/bm25` or `bm25` in lower case with no `options`;
 * any `options` key anywhere is refused. Aiming the local model at a vector that is not sparse is phase 1's
 * (request-phase1.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { RequestRefusal } from "@/lib/db/console/dialect";
import { parseQdrantRequest, qdrantPhase0 } from "@/lib/db/providers/vector/qdrant/request";

const plan = (text: string) => qdrantPhase0(parseQdrantRequest(text));
function refusal(text: string): RequestRefusal {
  try {
    plan(text);
  } catch (error) {
    if (error instanceof RequestRefusal) return error;
    throw error;
  }
  throw new Error(`accepted: ${text}`);
}

const query = (body: string) => `POST /collections/docs/points/query\n${body}`;
const DOCUMENT = '{"text": "find similar", "model": "sentence-transformers/all-minilm-l6-v2"}';
const IMAGE = '{"image": "https://example.com/a.png", "model": "qdrant/clip-vit-b-32-vision"}';
const OBJECT = '{"object": {"x": 1}, "model": "custom/model"}';
const WITH_OPTIONS = '{"text": "t", "model": "openai/text-embedding-3-small", "options": {"dimensions": 64}}';

describe("refuses inference objects at any depth", () => {
  test.each([
    ["a Document in query", query(`{"query": ${DOCUMENT}, "using": "text"}`), "query"],
    ["an Image in query", query(`{"query": ${IMAGE}, "using": "text"}`), "query"],
    ["an InferenceObject in query", query(`{"query": ${OBJECT}, "using": "text"}`), "query"],
    ["a Document under nearest", query(`{"query": {"nearest": ${DOCUMENT}}, "using": "text"}`), "query.nearest"],
    [
      "a Document in a prefetch two levels down",
      query(
        `{"prefetch": {"prefetch": {"query": ${DOCUMENT}, "using": "text"}, "query": {"fusion": "rrf"}}, "query": {"fusion": "rrf"}}`,
      ),
      "prefetch.prefetch.query",
    ],
    [
      "an Image in a batch's search",
      `POST /collections/docs/points/query/batch\n{"searches": [{"query": [0.1]}, {"query": ${IMAGE}, "using": "text"}]}`,
      "searches[1].query",
    ],
    [
      "an InferenceObject in a grouped query",
      `POST /collections/docs/points/query/groups\n{"query": ${OBJECT}, "using": "text", "group_by": "category"}`,
      "query",
    ],
    [
      "a Document as a recommend example",
      query(`{"query": {"recommend": {"positive": [${DOCUMENT}]}}}`),
      "query.recommend.positive[0]",
    ],
    [
      "a Document as a discover target",
      query(`{"query": {"discover": {"target": ${DOCUMENT}, "context": []}}}`),
      "query.discover.target",
    ],
  ])("%s, with zero calls", (_name, text, where) => {
    const refused = refusal(text);
    expect({ phase: refused.phase, key: refused.key }).toEqual({ phase: 0, key: "model" });
    expect(refused.message.startsWith(`${where} `)).toBe(true);
    expect(refused.message).toContain("Studio sends no inference input except a text for the local BM25 model");
  });

  test("the same objects with options are refused, naming options or the model", () => {
    expect(refusal(query(`{"query": ${WITH_OPTIONS}}`)).key).toBe("model");
    expect(refusal(query('{"query": {"text": "t", "model": "bm25", "options": {"language": "spanish"}}}')).key).toBe(
      "options",
    );
    expect(
      refusal(query('{"query": [0.1], "filter": {"must": [{"key": "a", "match": {"value": 1}}]}, "options": {}}')).key,
    ).toBe("options");
  });

  test("an options key anywhere the closed sets would not already refuse is refused", () => {
    const refused = refusal(query('{"query": {"formula": {"sum": [1]}, "defaults": {"options": 1}}}'));
    expect({ phase: refused.phase, key: refused.key }).toEqual({ phase: 0, key: "options" });
  });

  test("a model name in any case but lower is not the local model", () => {
    for (const model of ["QDRANT/BM25", "Bm25", "Qdrant/bm25"]) {
      expect(refusal(query(`{"query": {"text": "t", "model": "${model}"}, "using": "keywords"}`)).key, model).toBe(
        "model",
      );
    }
  });

  test("an inference input with no model, and the local model handed an image, are refused", () => {
    expect(refusal(query('{"query": {"text": "t"}, "using": "keywords"}')).message).toContain(
      "is an inference input with no model name",
    );
    expect(refusal(query('{"query": {"image": "x", "model": "bm25"}, "using": "keywords"}')).message).toContain(
      "hands the local model an image or an object, and it reads a text",
    );
  });
});
