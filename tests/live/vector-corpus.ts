/**
 * Writes tests/fixtures/vector/corpus/ (tests/live/vector-corpus-derive.ts): the Qdrant documentation blocks as
 * derived data, beside the sha256 of each source snippet, and the nine Milvus console requests.
 *
 * Run by hand, never by `bun run test`, over the snippet directory of the pinned documentation commit, as a checkout
 * holds it or flattened one file per snippet (tests/live/vector-corpus-derive.ts, flatName):
 *   bun tests/live/vector-corpus.ts --snippets <landing_page>/qdrant-landing/content/documentation/headless/snippets
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  deriveBlock,
  flatName,
  MILVUS_REQUESTS,
  PLACEHOLDER_FILL,
  QDRANT_DOCS_COMMIT,
  QDRANT_DOCS_DIRECTORY,
  QDRANT_DOCS_REPOSITORY,
} from "./vector-corpus-derive";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "tests/fixtures/vector/corpus");
const BY = "tests/live/vector-corpus.ts";

const index = process.argv.indexOf("--snippets");
const directory = index === -1 ? undefined : process.argv[index + 1];
if (directory === undefined || directory.startsWith("--")) throw new Error("--snippets <directory> is required");

/** Every http.md snippet under the directory, at any depth, as [its corpus name, its path]. */
function snippets(root: string, relative = ""): Array<[string, string]> {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry): Array<[string, string]> => {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) return snippets(root, child);
    return child.endsWith("http.md") ? [[flatName(child), path.join(root, child)]] : [];
  });
}

const blocks = snippets(directory)
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([file, source]) => {
    const bytes = readFileSync(source);
    const text = deriveBlock(bytes.toString("utf8"));
    if (text === null) throw new Error(`${file} holds no http block`);
    return { file, sourceSha256: createHash("sha256").update(bytes).digest("hex"), text };
  });

mkdirSync(OUT, { recursive: true });
writeFileSync(
  path.join(OUT, "qdrant-docs.json"),
  `${JSON.stringify(
    {
      $generated: {
        by: BY,
        source: QDRANT_DOCS_REPOSITORY,
        commit: QDRANT_DOCS_COMMIT,
        directory: QDRANT_DOCS_DIRECTORY,
        derivation:
          "each snippet's http block, its placeholders filled and the prose of every comment replaced by note",
        fill: PLACEHOLDER_FILL,
      },
      blocks,
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  path.join(OUT, "milvus-requests.json"),
  `${JSON.stringify({ $generated: { by: BY, source: "the vector-family design's Milvus console examples" }, requests: MILVUS_REQUESTS }, null, 2)}\n`,
);
console.error(`wrote ${blocks.length} Qdrant blocks and ${MILVUS_REQUESTS.length} Milvus requests`);
