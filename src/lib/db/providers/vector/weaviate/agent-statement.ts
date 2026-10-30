/**
 * The agent's reader of one Weaviate request: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure, and safe in a browser bundle: it reads only the console's own grammar and phase 0 (`request.ts`), the parser
 * with every body key closed at every level, and three refusals on top of them, each from the answers in
 * tests/fixtures/weaviate/1.40.2/agent-boundary/:
 *
 * - **Metadata only.** An object list, a read by id and every search answer stored property values and, on request,
 *   vectors (`objects-viewer`, `object-viewer`, `search-*-viewer`), so none of them is an agent read: an agent reads the
 *   meta, schema, shard, tenant, alias and node reads and an aggregate count, and every answer is projected to names,
 *   counts and flags (`agent-read.ts`).
 * - **A bare count.** An aggregate's `where` and `groupBy` count by stored values, so a series of counts would read a
 *   value out one comparison at a time; the agent's aggregate takes a `tenant` and `returnMetrics` only.
 * - **No GraphQL, no module.** The grammar already refuses `/v1/graphql`, every write, near-text, near-image and
 *   near-media, hybrid at any `alpha` but 0 and the generative and rerank keys, each of which makes the server call a
 *   model provider (`egress-*`); no agent read reaches a search at all.
 *
 * Not the boundary. The boundary is the provider's closed operation table, which can name no write, and the viewer
 * the server proves before every agent request (`agent-read.ts`); this is what lets the model read why it was refused,
 * before anything is sent.
 */
import { RequestRefusal } from "@/lib/db/console/dialect";
import type { WeaviateConsoleOp } from "./client";
import { parseWeaviateRequest, type WeaviatePlan, weaviatePhase0 } from "./request";

export type WeaviateAgentRefusalCode = "request" | "metadata-only" | "aggregate-shape";

export type WeaviateAgentReading =
  | { readonly ok: true; readonly plan: WeaviatePlan }
  | { readonly ok: false; readonly code: WeaviateAgentRefusalCode; readonly message: string };

/** The console operations an agent request may name: every one whose answer is metadata or a count. */
export const WEAVIATE_AGENT_OPS: ReadonlySet<WeaviateConsoleOp> = new Set<WeaviateConsoleOp>([
  "meta",
  "schema",
  "collection",
  "shards",
  "tenants",
  "tenant",
  "aliases",
  "alias",
  "nodes",
  "collection_nodes",
  "aggregate",
]);

/** The keys an agent's aggregate body may hold. */
const AGGREGATE_KEYS: ReadonlySet<string> = new Set(["tenant", "returnMetrics"]);

const AGENT_READS =
  "Agent mode on Weaviate reads metadata only: GET /v1/meta, /v1/schema, /v1/schema/{collection}, its shards, tenants and one tenant, /v1/aliases and one alias, /v1/nodes and /v1/nodes/{collection}, and POST /v1/aggregate/{collection} for a count.";

export const WEAVIATE_AGENT_SENTENCES = {
  /** `line` is the request's method and route template, never user text. */
  metadataOnly: (line: string): string =>
    `${line} answers stored objects, their properties or their vectors, which agent mode does not read. ${AGENT_READS} Nothing was sent.`,
  /** `key` is a key the closed AggregateRequest schema declares, never user text. */
  aggregateShape: (key: string): string =>
    `An agent's aggregate counts a whole collection or tenant, so it takes "tenant" and "returnMetrics" only; "${key}" counts by stored values. Nothing was sent.`,
} as const;

/** One agent request read: the console's own reading, then the agent's rules. Never sends anything. */
export function readWeaviateAgentStatement(text: string): WeaviateAgentReading {
  let plan: WeaviatePlan;
  try {
    plan = weaviatePhase0(parseWeaviateRequest(text));
  } catch (error) {
    if (!(error instanceof RequestRefusal)) throw error;
    return { ok: false, code: "request", message: error.message };
  }
  const route = plan.route;
  if (!WEAVIATE_AGENT_OPS.has(route.op)) {
    return {
      ok: false,
      code: "metadata-only",
      message: WEAVIATE_AGENT_SENTENCES.metadataOnly(`${route.method} /v1/${route.template}`),
    };
  }
  const extra = plan.body === null ? undefined : Object.keys(plan.body).find((key) => !AGGREGATE_KEYS.has(key));
  if (extra !== undefined) {
    return { ok: false, code: "aggregate-shape", message: WEAVIATE_AGENT_SENTENCES.aggregateShape(extra) };
  }
  return { ok: true, plan };
}
