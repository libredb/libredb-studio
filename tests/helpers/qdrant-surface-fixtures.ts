/**
 * The recorded Qdrant answers the object-surface and monitoring tests read. Two directories, one encoding:
 * `tests/fixtures/vector/qdrant/` holds what tests/live/vector-evidence.ts captured before any provider existed (the
 * description of every seeded collection, `GET /` and `GET /aliases`), and `tests/fixtures/qdrant-surface/` what
 * tests/live/qdrant-surface-evidence.ts captured for the reads only the provider's surfaces make. Each file is
 * `{ $captured, outcome, payload }`, and `payload.body` is the exact text the server sent.
 *
 * A missing file, or one whose outcome is not `pass`, fails the test that reads it; nothing here falls back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QdrantAnswer, QdrantRequest } from "@/lib/db/providers/vector/qdrant/client";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

/** The seeded collections, in the order `GET /collections` lists them. */
export const SEEDED_COLLECTIONS = [
  "docs",
  "edge_values",
  "empty_novec",
  "payload_spread",
  "plain",
  "scratch",
  "small_dtypes",
] as const;

export interface QdrantCapture {
  readonly $captured: {
    readonly version: string;
    readonly digest: string;
    readonly request: { readonly method: string; readonly path: string; readonly body: string | null };
  };
  readonly outcome: string;
  readonly payload: { readonly status: number; readonly bodyBytes: number; readonly body: string };
}

/** A capture as recorded, refused when its outcome is not a pass: a test reads only answers the server gave. */
export function requirePass(recorded: QdrantCapture, file: string): QdrantCapture {
  if (recorded.outcome !== "pass") throw new Error(`${file} records the outcome ${recorded.outcome}, not pass`);
  return recorded;
}

function capture(directory: readonly string[], name: string): QdrantCapture {
  const file = join(FIXTURES, ...directory, `${name}.json`);
  return requirePass(JSON.parse(readFileSync(file, "utf8")) as QdrantCapture, file);
}

/** A capture of tests/fixtures/vector/qdrant/: `root`, `aliases`, `describe-<collection>`. */
export function vectorCapture(name: string): QdrantCapture {
  return capture(["vector", "qdrant"], name);
}

/** A capture of tests/fixtures/qdrant-surface/: `collections`, and `<read>-<collection>` for each surface read. */
export function surfaceCapture(name: string): QdrantCapture {
  return capture(["qdrant-surface"], name);
}

/** A capture as the client hands it over. */
export function answerOf(recorded: QdrantCapture): QdrantAnswer {
  return {
    status: recorded.payload.status,
    contentType: "application/json",
    retryAfter: null,
    text: recorded.payload.body,
  };
}

/** The `result` of a capture's body, parsed plainly: enough for a description, whose integers are all small. */
export function resultOf(recorded: QdrantCapture): unknown {
  return (JSON.parse(recorded.payload.body) as { readonly result: unknown }).result;
}

/** The capture that answers each surface read of a collection, by the read's operation. */
const BY_OP: Readonly<Record<string, (collection: string) => QdrantCapture>> = {
  get_collection: (collection) => vectorCapture(`describe-${collection}`),
  get_collection_aliases: (collection) => surfaceCapture(`aliases-${collection}`),
  list_snapshots: (collection) => surfaceCapture(`snapshots-${collection}`),
  get_optimizations: (collection) => surfaceCapture(`optimizations-${collection}`),
  collection_cluster_info: (collection) => surfaceCapture(`cluster-${collection}`),
  scroll_points: (collection) => surfaceCapture(`sample-${collection}`),
};

/**
 * The recorded answer to a request, as the seeded server gave it: `GET /`, `GET /collections`, `GET /aliases` and
 * the six reads of a seeded collection. A request no capture answers fails the test by name.
 */
export function recordedAnswer(request: QdrantRequest): QdrantAnswer {
  if (request.op === "root") return answerOf(vectorCapture("root"));
  if (request.op === "get_collections") return answerOf(surfaceCapture("collections"));
  if (request.op === "get_collections_aliases") return answerOf(vectorCapture("aliases"));
  const read = Object.hasOwn(BY_OP, request.op) ? BY_OP[request.op] : undefined;
  if (read === undefined) throw new Error(`No capture answers the operation ${request.op}`);
  return answerOf(read(request.params.collection_name));
}

/** What the server answers for a collection it does not hold: built, not captured, in the 404 shape Qdrant writes. */
export function collectionNotFound(collection: string): QdrantAnswer {
  return {
    status: 404,
    contentType: "application/json",
    retryAfter: null,
    text: JSON.stringify({ status: { error: `Not found: Collection \`${collection}\` doesn't exist!` }, time: 0 }),
  };
}

const READS: Readonly<Record<string, string>> = {
  aliases: "get_collection_aliases",
  snapshots: "list_snapshots",
  optimizations: "get_optimizations",
  cluster: "collection_cluster_info",
  "points/scroll": "scroll_points",
};

/**
 * The recorded answer to a request line as the transport sees it, `GET /collections/docs/aliases`: the same
 * captures as `recordedAnswer`, a collection the seed does not hold answered as Qdrant answers it, and a sample
 * scroll whose body is not the one the evidence run recorded refused by name, so a test that passes proves the
 * provider sent the recorded request.
 */
export function recordedLineAnswer(line: string, body: string | null): QdrantAnswer {
  const [method, target] = line.split(" ");
  const path = target.split("?")[0];
  if (method === "GET" && path === "/") return answerOf(vectorCapture("root"));
  if (method === "GET" && path === "/collections") return answerOf(surfaceCapture("collections"));
  if (method === "GET" && path === "/aliases") return answerOf(vectorCapture("aliases"));
  const match = /^\/collections\/([^/]+)(?:\/(.+))?$/.exec(path);
  if (match === null) throw new Error(`No capture answers ${line}`);
  const collection = decodeURIComponent(match[1]);
  if (!(SEEDED_COLLECTIONS as readonly string[]).includes(collection)) return collectionNotFound(collection);
  if (match[2] === undefined) return answerOf(vectorCapture(`describe-${collection}`));
  const op = READS[match[2]];
  if (op === undefined) throw new Error(`No capture answers ${line}`);
  if (op === "scroll_points") {
    const recorded = surfaceCapture(`sample-${collection}`);
    if (body !== recorded.$captured.request.body) {
      throw new Error(`${line} sent ${body}, not the recorded sample body ${recorded.$captured.request.body}`);
    }
    return answerOf(recorded);
  }
  return recordedAnswer({ op: op as QdrantRequest["op"], params: { collection_name: collection }, query: {} });
}
