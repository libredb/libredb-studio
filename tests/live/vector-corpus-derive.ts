/**
 * The console grammar's documentation corpus as derived data (vector-family spec 3.4), written by
 * tests/live/vector-corpus.ts into tests/fixtures/vector/corpus/. Pure, so tests/unit/db/vector/doc-corpus.test.ts
 * holds every rule over small inputs.
 *
 * Each Qdrant block is derived from one `http.md` snippet of the Qdrant documentation source at a pinned commit: its
 * http block, with the placeholders filled as the design's corpus fills them, and the prose of every comment
 * replaced by "note", keeping the comment marker where it stood, so the lexer meets every comment the documentation
 * holds without the corpus carrying the documentation's words. The nine Milvus requests are the console examples of
 * the design, written for this repository.
 */

export const QDRANT_DOCS_REPOSITORY = "github.com/qdrant/landing_page";
export const QDRANT_DOCS_COMMIT = "bb7f15b97237c97748fdbeea45499e2fcaba2377";
export const QDRANT_DOCS_DIRECTORY = "qdrant-landing/content/documentation/headless/snippets/";

/** The placeholders the documentation writes and the names that fill them, in this order. */
export const PLACEHOLDER_FILL: readonly (readonly [string, string])[] = [
  ["{collection_name}", "docs"],
  ["<your-collection>", "docs"],
  ["{vector_name}", "text"],
  ["{point_id}", "42"],
  ["{snapshot_name}", "snap.snapshot"],
];

/**
 * A snippet's name in the corpus: its path below the snippet directory, "/" replaced by "__" and the final
 * "/http.md" by ".http.md", so `query-points/simple-dense/http.md` is `query-points__simple-dense.http.md`. A name
 * that is already flat is kept.
 */
export function flatName(relative: string): string {
  if (!relative.includes("/")) return relative;
  if (!relative.endsWith("/http.md")) throw new Error(`${relative} is not an http.md snippet`);
  return `${relative.slice(0, -"/http.md".length).replaceAll("/", "__")}.http.md`;
}

export function httpBlock(markdown: string): string | null {
  const match = /```http\n([\s\S]*?)```/.exec(markdown);
  return match === null ? null : match[1];
}

export function fillPlaceholders(text: string): string {
  let filled = text;
  for (const [placeholder, name] of PLACEHOLDER_FILL) filled = filled.replaceAll(placeholder, name);
  return filled;
}

const REQUEST_LINE = /^\s*[A-Z]+\s+\S/;
const LEADING_COMMENT = /^(\s*)(#|\/\/)/;

/**
 * The line with the prose of a comment after the request line replaced: a line that starts with `#`, which no JSON
 * line does, and `//` outside a string, to the end of the line.
 */
function neutraliseBodyLine(line: string): string {
  const hash = /^(\s*)#/.exec(line);
  if (hash !== null) return `${hash[1]}# note`;
  let inString = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (inString) {
      if (character === "\\") index++;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === "/" && line[index + 1] === "/") {
      return `${line.slice(0, index)}// note`;
    }
  }
  return line;
}

/**
 * Replaces the prose of every comment with "note": a `#` or `//` line before the request line, and after it a `#`
 * line or a `//` comment outside a string. The request line itself is left alone, and so is everything that is not comment prose.
 */
export function neutraliseComments(text: string): string {
  let seenRequest = false;
  return text
    .split("\n")
    .map((line) => {
      if (!seenRequest) {
        const comment = LEADING_COMMENT.exec(line);
        if (comment !== null) return `${comment[1]}${comment[2]} note`;
        if (REQUEST_LINE.test(line)) seenRequest = true;
        return line;
      }
      return neutraliseBodyLine(line);
    })
    .join("\n");
}

export function deriveBlock(markdown: string): string | null {
  const block = httpBlock(markdown);
  return block === null ? null : neutraliseComments(fillPlaceholders(block));
}

/** The nine Milvus console requests of the design's examples, written for this repository. */
export const MILVUS_REQUESTS: readonly { readonly name: string; readonly text: string }[] = [
  { name: "collections-list", text: 'POST /v2/vectordb/collections/list\n{"dbName": "default"}' },
  { name: "collections-describe", text: 'POST /v2/vectordb/collections/describe\n{"collectionName": "unloaded_big"}' },
  {
    name: "query-filter",
    text: 'POST /v2/vectordb/entities/query\n{"collectionName": "docs_int64", "filter": "seq >= 10 and title like \\"doc 001%\\"",\n "outputFields": ["id", "seq", "title", "tags", "big_int"], "limit": 5}',
  },
  {
    name: "query-count",
    text: 'POST /v2/vectordb/entities/query\n{"collectionName": "docs_int64", "filter": "maybe_count is null", "outputFields": ["count(*)"]}',
  },
  {
    name: "get-short-form",
    text: 'POST entities/get\n{"collectionName": "docs_varchar", "id": ["vc-0001", "vc-0002"], "outputFields": ["pk", "label"]}',
  },
  {
    name: "search-commented",
    text: '# nearest neighbours of a unit vector, filtered by seq\nPOST /v2/vectordb/entities/search\n{"collectionName": "docs_int64", "annsField": "vec",\n "data": [[0.35355339, 0.35355339, 0.35355339, 0.35355339, 0.35355339, 0.35355339, 0.35355339, 0.35355339]],\n "filter": "seq >= 100", "searchParams": {"params": {"ef": 64}}, "outputFields": ["seq", "title"], "limit": 5}',
  },
  {
    name: "search-bm25",
    text: 'POST /v2/vectordb/entities/search\n{"collectionName": "fts", "annsField": "text_sparse", "data": ["vector index"], "outputFields": ["id", "text"], "limit": 5}',
  },
  {
    name: "hybrid-rrf",
    text: 'POST /v2/vectordb/entities/hybrid_search\n{"collectionName": "docs_varchar",\n "search": [{"annsField": "f16", "data": [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]], "limit": 10},\n            {"annsField": "sparse", "data": [{"17": 0.4, "230": 0.2}], "limit": 10}],\n "rerank": {"strategy": "rrf", "params": {"k": 60}}, "outputFields": ["pk", "label"], "limit": 5}',
  },
  {
    name: "generated-search",
    text: '# Replace data with your query vector: vec, FloatVector, dim 8\nPOST /v2/vectordb/entities/search\n{"dbName": "default", "collectionName": "docs_int64", "annsField": "vec",\n "data": [[0.35355339, 0.35355339, 0.35355339, 0.35355339, 0.35355339, 0.35355339, 0.35355339, 0.35355339]],\n "outputFields": ["id", "seq", "title"], "limit": 10}',
  },
];
