/**
 * The console grammar's documentation corpus (tests/fixtures/vector/corpus/, derived by
 * tests/live/vector-corpus-derive.ts; vector-family spec 3.4): the derivation's rules over small inputs, and the
 * committed corpus's shape, which the corpus test of src/lib/db/console reads.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  deriveBlock,
  fillPlaceholders,
  flatName,
  httpBlock,
  MILVUS_REQUESTS,
  neutraliseComments,
  PLACEHOLDER_FILL,
  QDRANT_DOCS_COMMIT,
} from "../../../live/vector-corpus-derive";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/vector/corpus", name), "utf8")) as unknown;

describe("the derivation", () => {
  test("names a snippet by its path, flattened, and keeps a name that is already flat", () => {
    expect(flatName("query-points/simple-dense/http.md")).toBe("query-points__simple-dense.http.md");
    expect(flatName("query-points/hybrid-rrf/_server/http.md")).toBe("query-points__hybrid-rrf___server.http.md");
    expect(flatName("query-points__simple-dense.http.md")).toBe("query-points__simple-dense.http.md");
    expect(() => flatName("query-points/simple-dense/python.md")).toThrow(
      "query-points/simple-dense/python.md is not an http.md snippet",
    );
  });

  test("takes the http block of a snippet, or nothing when it holds none", () => {
    expect(httpBlock("text\n```http\nGET /collections\n```\nmore")).toBe("GET /collections\n");
    expect(httpBlock("```python\nclient.get_collections()\n```")).toBeNull();
  });

  test("fills every placeholder the corpus fills, each everywhere it stands", () => {
    expect(
      fillPlaceholders(
        'POST /collections/{collection_name}/points/{point_id}\n{"using": "{vector_name}", "c": "{collection_name}"}',
      ),
    ).toBe('POST /collections/docs/points/42\n{"using": "text", "c": "docs"}');
    expect(PLACEHOLDER_FILL.map(([placeholder]) => placeholder)).toEqual([
      "{collection_name}",
      "<your-collection>",
      "{vector_name}",
      "{point_id}",
      "{snapshot_name}",
    ]);
  });

  test("replaces the prose of a comment before the request line and of a body comment, keeping the markers", () => {
    expect(
      neutraliseComments('# find the closest points\n// and filter them\nPOST /x\n{\n  "a": 1 // <--- Dense vector\n}'),
    ).toBe('# note\n// note\nPOST /x\n{\n  "a": 1 // note\n}');
  });

  test("leaves // inside a string, an escaped quote and the request line alone", () => {
    const text = 'POST /x // not a body\n{"url": "http://h//p", "q": "say \\"//\\" here"}';
    expect(neutraliseComments(text)).toBe(text);
  });

  test("a # line after the body, the comment of a second request, is neutralised too", () => {
    expect(neutraliseComments("PUT /x\n{}\n\n# Search in the collection\nPOST /y")).toBe(
      "PUT /x\n{}\n\n# note\nPOST /y",
    );
  });

  test("a comment after a string on the same line is still found", () => {
    expect(neutraliseComments('GET /x\n{"a": "b"} // trailing words')).toBe('GET /x\n{"a": "b"} // note');
  });

  test("deriveBlock fills, then neutralises", () => {
    expect(
      deriveBlock(
        '```http\nPOST /collections/{collection_name}/points/query\n{\n  "query": [0.2] // <--- Dense vector\n}\n```',
      ),
    ).toBe('POST /collections/docs/points/query\n{\n  "query": [0.2] // note\n}\n');
  });
});

interface QdrantCorpus {
  readonly $generated: { readonly commit: string; readonly fill: readonly (readonly [string, string])[] };
  readonly blocks: readonly { readonly file: string; readonly sourceSha256: string; readonly text: string }[];
}

describe("the committed corpus", () => {
  const qdrant = read("qdrant-docs.json") as QdrantCorpus;
  const milvus = read("milvus-requests.json") as {
    readonly requests: readonly { readonly name: string; readonly text: string }[];
  };

  test("holds the 257 Qdrant blocks of the pinned commit, one per snippet, each with its source's sha256", () => {
    expect(qdrant.$generated.commit).toBe(QDRANT_DOCS_COMMIT);
    expect(qdrant.$generated.fill).toEqual(PLACEHOLDER_FILL.map(([a, b]) => [a, b]));
    expect(qdrant.blocks).toHaveLength(257);
    expect(new Set(qdrant.blocks.map((block) => block.file)).size).toBe(257);
    for (const block of qdrant.blocks) {
      expect(block.file).toMatch(/\.http\.md$/);
      expect(block.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("no block keeps a placeholder the corpus fills", () => {
    for (const block of qdrant.blocks) {
      for (const [placeholder] of PLACEHOLDER_FILL)
        expect({ file: block.file, holds: block.text.includes(placeholder) }).toEqual({
          file: block.file,
          holds: false,
        });
    }
  });

  test("every comment of every block is reduced to its marker and the word note", () => {
    for (const block of qdrant.blocks) {
      for (const line of block.text.split("\n")) {
        const leading = /^\s*(#|\/\/)(.*)$/.exec(line);
        if (leading !== null)
          expect({ file: block.file, line }).toEqual({
            file: block.file,
            line: line.replace(/(#|\/\/).*$/, "$1 note"),
          });
      }
    }
  });

  test("holds the nine Milvus requests, each a POST to a Milvus route", () => {
    expect(milvus.requests).toEqual([...MILVUS_REQUESTS]);
    expect(milvus.requests).toHaveLength(9);
    for (const request of milvus.requests)
      expect(request.text).toMatch(/^(# [^\n]*\n)?POST (\/v2\/vectordb\/)?[a-z_]+\/[a-z_]+\n/);
  });
});
