/**
 * The agent's reader of one Milvus request: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure, and safe in a browser bundle: it reads only the console's own grammar and phase 0 (`request.ts`), which close
 * every body key of every route, and two refusals on top of them, each from the answers in
 * tests/fixtures/milvus/3.0.2/agent-boundary/:
 *
 * - **Metadata only.** A query and a get answer stored scalar, vector and dynamic field values (`query-values-*`), and
 *   a search with a text input makes the server run the collection's function on it (`search-text-*`), so no entity
 *   route is an agent read. An agent reads the databases, the collections, one collection's schema, statistics and
 *   load state, its partitions, its indexes and the aliases, and every answer is projected to names, counts and flags
 *   (`metadata-read.ts`).
 * - **The connection's database.** A body's `dbName` would point the request at another database, so an agent request
 *   names none or the connection's own, and every call it makes names the connection's database. Read without the
 *   connection (the agent's admission), a `dbName` is left to the provider, which reads it again with its database.
 *
 * Not the boundary. The boundary is the provider's closed RPC table, which holds no write the agent can reach, and the
 * read-only user the server proves before every agent request (`read-only-proof.ts`); this is what lets the model
 * read why it was refused, before anything is sent.
 */
import { RequestRefusal } from "@/lib/db/console/dialect";
import { type MilvusPhase0, milvusPhase0, parseMilvusRequest } from "./request";
import type { MilvusOp } from "./routes";

export type MilvusAgentRefusalCode = "request" | "metadata-only" | "database";

/** A request the agent may send: one of the metadata routes. */
export type MilvusAgentPlan = Exclude<MilvusPhase0, { readonly op: `entities/${string}` }>;

export type MilvusAgentReading =
  | { readonly ok: true; readonly plan: MilvusAgentPlan }
  | { readonly ok: false; readonly code: MilvusAgentRefusalCode; readonly message: string };

/** The console routes an agent request may name: every one whose answer is metadata. */
export const MILVUS_AGENT_OPS: ReadonlySet<MilvusOp> = new Set<MilvusOp>([
  "databases/list",
  "databases/describe",
  "collections/list",
  "collections/describe",
  "collections/get_stats",
  "collections/get_load_state",
  "partitions/list",
  "indexes/list",
  "indexes/describe",
  "aliases/list",
  "aliases/describe",
]);

const AGENT_READS =
  "Agent mode on Milvus reads metadata only: POST /v2/vectordb/ databases/list, databases/describe, collections/list, collections/describe, collections/get_stats, collections/get_load_state, partitions/list, indexes/list, indexes/describe, aliases/list and aliases/describe.";

export const MILVUS_AGENT_SENTENCES = {
  /** `route` is a console route the table declares, never user text. */
  metadataOnly: (route: string): string =>
    `POST /v2/vectordb/${route} is not one of agent mode's reads: it answers stored field values or vectors, or runs a function on the server. ${AGENT_READS} Nothing was sent.`,
  database:
    "An agent request reads the connection's own database: leave dbName out, or name that database. Nothing was sent.",
} as const;

function isAgentPlan(plan: MilvusPhase0): plan is MilvusAgentPlan {
  return MILVUS_AGENT_OPS.has(plan.op);
}

/**
 * One agent request read: the console's own reading, then the agent's rules. `database` is the connection's, which
 * every call names; without it (the agent's admission) a `dbName` is not judged. Never sends anything.
 */
export function readMilvusAgentStatement(text: string, database?: string): MilvusAgentReading {
  let plan: MilvusPhase0;
  try {
    plan = milvusPhase0(parseMilvusRequest(text), { database: database ?? "default" });
  } catch (error) {
    if (!(error instanceof RequestRefusal)) throw error;
    return { ok: false, code: "request", message: error.message };
  }
  if (!isAgentPlan(plan)) {
    return { ok: false, code: "metadata-only", message: MILVUS_AGENT_SENTENCES.metadataOnly(plan.op) };
  }
  if (database !== undefined && plan.db !== database) {
    return { ok: false, code: "database", message: MILVUS_AGENT_SENTENCES.database };
  }
  return { ok: true, plan };
}
