/**
 * The agent's reader of one Qdrant request: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure, and safe in a browser bundle: it reads only the console's own grammar and phase 0 (`request.ts`), the parser
 * with every body key closed at every level, and two refusals on top of them, each from the answers in
 * tests/fixtures/qdrant/1.19.1/agent-boundary/:
 *
 * - **Metadata only.** A point read, a scroll, a facet and every query answer stored payloads and, on request,
 *   vectors (`points-read-only`, `point-read-only`, `scroll-read-only`, `facet-read-only`, `query-*-read-only`), and a
 *   query whose body names a Document, an Image or an inference object makes the server call its inference address
 *   (`inference-*-read-only`), so none of them is an agent read. Neither are the optimization and snapshot lists,
 *   which no metadata projection reads. An agent reads the version, the collection list, one collection's
 *   configuration, its existence, the aliases, a count and the shard layout, and every answer is projected to names,
 *   counts and flags (`metadata-read.ts`).
 * - **A bare count.** A count's `filter` counts by stored values, so a series of counts would read a value out one
 *   comparison at a time, and its `shard_key` counts by a key's value; the agent's count takes `exact` only.
 *
 * Not the boundary. The boundary is the provider's closed route table, which can name no write, and the read-only key
 * the server proves before every agent request (`metadata-read.ts`); this is what lets the model read why it was
 * refused, before anything is sent.
 */
import { RequestRefusal } from "@/lib/db/console/dialect";
import type { QdrantOp } from "./client";
import { parseQdrantRequest, type QdrantPhase0, qdrantPhase0 } from "./request";

export type QdrantAgentRefusalCode = "request" | "metadata-only" | "count-shape";

export type QdrantAgentReading =
  | { readonly ok: true; readonly plan: QdrantPhase0 }
  | { readonly ok: false; readonly code: QdrantAgentRefusalCode; readonly message: string };

/** The console routes an agent request may name: every one whose answer is metadata or a count. */
export const QDRANT_AGENT_OPS: ReadonlySet<QdrantOp> = new Set<QdrantOp>([
  "root",
  "get_collections",
  "get_collection",
  "collection_exists",
  "get_collections_aliases",
  "get_collection_aliases",
  "count_points",
  "collection_cluster_info",
]);

/** The keys an agent's count body may hold. */
const COUNT_KEYS: ReadonlySet<string> = new Set(["exact"]);

const AGENT_READS =
  "Agent mode on Qdrant reads metadata only: GET /, /collections, /collections/{collection}, its exists, aliases and cluster reads, /aliases, and POST /collections/{collection}/points/count for a count.";

export const QDRANT_AGENT_SENTENCES = {
  /** `line` is the request's method and route template, never user text. */
  metadataOnly: (line: string): string =>
    `${line} is not one of agent mode's reads: it answers stored payloads or vectors, or what no metadata projection reads. ${AGENT_READS} Nothing was sent.`,
  /** `key` is a key the closed CountRequest schema declares, never user text. */
  countShape: (key: string): string =>
    `An agent's count counts a whole collection, so it takes "exact" only; "${key}" counts by stored values. Nothing was sent.`,
} as const;

/** One agent request read: the console's own reading, then the agent's rules. Never sends anything. */
export function readQdrantAgentStatement(text: string): QdrantAgentReading {
  let plan: QdrantPhase0;
  try {
    plan = qdrantPhase0(parseQdrantRequest(text));
  } catch (error) {
    if (!(error instanceof RequestRefusal)) throw error;
    return { ok: false, code: "request", message: error.message };
  }
  const route = plan.route;
  if (!QDRANT_AGENT_OPS.has(route.op)) {
    return {
      ok: false,
      code: "metadata-only",
      message: QDRANT_AGENT_SENTENCES.metadataOnly(`${route.method} /${route.template}`),
    };
  }
  const extra = plan.body === null ? undefined : Object.keys(plan.body).find((key) => !COUNT_KEYS.has(key));
  if (extra !== undefined) {
    return { ok: false, code: "count-shape", message: QDRANT_AGENT_SENTENCES.countShape(extra) };
  }
  return { ok: true, plan };
}
