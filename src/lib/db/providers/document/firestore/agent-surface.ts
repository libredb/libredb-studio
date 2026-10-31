/**
 * What a Firestore handle opened for an agent-mode profile answers outside `queryReadOnly`: the object surface the
 * grounding walk reads, and the readings of the operations workflow. Every read here goes through the agent's client
 * (`FirestoreAgentClient`), which holds the agent's reads alone and charges each one to the run's read allowance
 * before it is sent.
 *
 * Metadata only, as the agent's reads are: top-level collections are listed by id, each with `__name__` as its one
 * column, and nothing is read from a document. Document ids, paths, field names and field values count as stored
 * values, so a collection's sampled fields, the Keys panel, a document's Source tab, the console and every reading
 * Firestore does not report are answered by their reason, never by an empty answer or a zero, so the model is told what
 * it was not shown rather than reading an absence as the server's own answer. A read that carries no allowance sends
 * nothing: every Firestore read is billed, and only the run's allowance may pay for it. Nothing read here is kept for
 * a later call. The editor's handles keep every surface.
 */
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import type { RunReadAllowance } from "@/lib/db/read-allowance";
import type { DatabaseObject, KindCount, ObjectDetailBatch } from "@/lib/db/types";
import { type FirestoreAgentCall, type FirestoreAgentClient, studioWorded } from "./agent-client";
import { LIMITS } from "./constants";
import { compareUtf8, idRefusal } from "./names";
import { type CallBase, FIRESTORE_OBJECT_KINDS, FIRESTORE_OBJECT_SENTENCES } from "./objects";
import { nameColumn } from "./sampling";

const AGENT_READS =
  "Agent mode on Firestore reads metadata only: collection ids, a whole collection's document count, and whether a document the request names in full exists and when it was created and last updated.";

const VALUES =
  "Document ids, paths, field names and field values count as stored values, since they name users and tenants, so none of them is read in agent mode.";

/** Each surface or figure an agent-mode handle does not read, with its reason. No sentence names a path or an id. */
export const FIRESTORE_AGENT_WITHHELD = {
  fields: `${AGENT_READS} ${VALUES} A collection's fields are sampled from its documents, so agent mode lists each collection with __name__ as its one column.`,
  documents: `${AGENT_READS} ${VALUES} Documents are never listed in agent mode; count a collection with db.collection("ID").count() through run_read_query.`,
  keys: `${AGENT_READS} ${VALUES} The Keys panel, which lists document ids, is not read on an agent-mode handle.`,
  source: `${AGENT_READS} ${VALUES} A document's Source tab holds its fields, which agent mode does not read.`,
  query: `${AGENT_READS} ${VALUES} The editor's console, which reads documents, is refused on an agent-mode handle; agent reads go through queryReadOnly.`,
  noAllowance: `${AGENT_READS} Firestore bills every read, so an agent-mode handle sends one only within an agent run's read allowance, and this read carries none: nothing was sent. Read the collection ids with db.listCollections() through run_read_query.`,
  databaseSize: `${AGENT_READS} Firestore reports no size for the database, so none is reported.`,
  overview: `${AGENT_READS} Firestore reports no uptime, connection or object figures, so no overview reading is taken; this is not a reading of none.`,
  storage: `${AGENT_READS} Firestore reports no storage figure Studio reads, so no storage reading is taken; this is not a reading of none.`,
  tableStats: `${AGENT_READS} Firestore reports no per-collection statistics Studio reads, so no table reading is taken; a collection's document count is read with run_read_query.`,
  indexStats: `${AGENT_READS} Firestore reports no index statistics Studio reads, so no index reading is taken; this is not a reading of none.`,
  slowQueries: `${AGENT_READS} Firestore keeps no query log Studio reads, so no slow-query reading is taken; this is not a reading of none.`,
  sessions: `${AGENT_READS} Firestore does not list client sessions, so no session reading is taken; this is not a reading of none.`,
  performance: `${AGENT_READS} Firestore reports no performance figures Studio reads, so no performance reading is taken; this is not a reading of none.`,
} as const;

/** Studio's own refusals of a surface, a container or a kind, made before the agent's client is called. */
const refusal = (sentence: string) => studioWorded(sentence);

/** What a surface read on an agent-mode handle runs under: the session's signal and base, and the run's allowance. */
export interface FirestoreAgentSurfaceCall {
  readonly signal: AbortSignal;
  readonly base: CallBase;
  readonly allowance: RunReadAllowance | undefined;
}

function chargedCall(call: FirestoreAgentSurfaceCall): FirestoreAgentCall {
  if (call.allowance === undefined) throw refusal(FIRESTORE_AGENT_WITHHELD.noAllowance);
  return { signal: call.signal, base: call.base, allowance: call.allowance };
}

function requireRoot(container: readonly string[]): void {
  if (container.length !== 0) throw refusal(FIRESTORE_OBJECT_SENTENCES.container(container));
}

function requireKind(kind: string): void {
  if (!FIRESTORE_OBJECT_KINDS.some((spec) => spec.id === kind)) throw refusal(FIRESTORE_OBJECT_SENTENCES.kind(kind));
}

/**
 * Every root collection id, up to the id-listing cap, each page charged before it is sent; `complete` is false when
 * the cap stopped the read. An id the id rules refuse is left out, as the editor's listing leaves it out.
 */
async function rootCollectionIds(
  client: FirestoreAgentClient,
  call: FirestoreAgentCall,
): Promise<{ readonly ids: string[]; readonly complete: boolean }> {
  const listed = new Set<string>();
  let token: string | undefined;
  for (let request = 0; request < LIMITS.idListingRequests; request += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page's request carries the token the one before it returned.
    const page = await client.listCollectionIds(
      { parent: [], pageSize: LIMITS.idListingPageSize, ...(token === undefined ? {} : { pageToken: token }) },
      call,
    );
    for (const id of page.ids) listed.add(id);
    if (page.next === undefined) return { ids: valid(listed), complete: true };
    token = page.next;
  }
  return { ids: valid(listed), complete: false };
}

function valid(listed: ReadonlySet<string>): string[] {
  return [...listed].filter((id) => idRefusal(id, "collection") === null).sort(compareUtf8);
}

/**
 * The collection count on an agent-mode handle: the root listing's, charged. With no allowance the count is the
 * reason, sent as nothing, and the walk lists nothing of a kind whose count is its listing.
 */
export async function agentCountObjects(
  client: FirestoreAgentClient,
  container: readonly string[],
  call: FirestoreAgentSurfaceCall,
): Promise<Record<string, KindCount>> {
  requireRoot(container);
  if (call.allowance === undefined) return { collection: { unavailable: FIRESTORE_AGENT_WITHHELD.noAllowance } };
  const { ids, complete } = await rootCollectionIds(client, chargedCall(call));
  return {
    collection: complete
      ? { count: ids.length }
      : { count: ids.length, sampledFrom: FIRESTORE_OBJECT_SENTENCES.sampledFrom },
  };
}

/** One kind's listing on an agent-mode handle: collections by id, and documents refused with their reason. */
export async function agentListObjects(
  client: FirestoreAgentClient,
  container: readonly string[],
  kind: string,
  call: FirestoreAgentSurfaceCall,
): Promise<DatabaseObject[]> {
  requireRoot(container);
  if (kind === "document") throw refusal(FIRESTORE_AGENT_WITHHELD.documents);
  requireKind(kind);
  const { ids } = await rootCollectionIds(client, chargedCall(call));
  return ids.map((id) => ({ path: [id], name: id, kind: "collection" }));
}

/** Every listed collection with `__name__` alone, reading no document; a bound that bites is reported. */
export async function agentDescribeObjects(
  client: FirestoreAgentClient,
  container: readonly string[],
  kind: string,
  limit: number | undefined,
  call: FirestoreAgentSurfaceCall,
): Promise<ObjectDetailBatch> {
  requireRoot(container);
  requireKind(kind);
  if (kind === "document") return { details: [] };
  const { ids, complete } = await rootCollectionIds(client, chargedCall(call));
  const detail = (id: string) => ({ path: [id], columns: [nameColumn()], indexes: [], foreignKeys: [] });
  if (limit !== undefined && ids.length > limit)
    return {
      details: ids.slice(0, limit).map(detail),
      truncated: { limit, reason: callerBoundTruncationReason(limit) },
    };
  const details = ids.map(detail);
  return complete
    ? { details }
    : { details, truncated: { limit: details.length, reason: FIRESTORE_OBJECT_SENTENCES.idCapReason } };
}
