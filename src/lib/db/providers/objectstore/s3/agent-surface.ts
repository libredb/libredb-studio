/**
 * What an S3 handle opened for an agent-mode profile answers outside `queryReadOnly`: the object surface the grounding
 * walk and MCP `inspect_schema` read, and the readings of the operations workflow. Every read here goes through the
 * agent's client (`S3AgentClient`), which holds the agent's reads alone.
 *
 * Metadata only, as the agent's reads are: buckets are listed by name and creation time, and object keys, which count
 * as stored values, are never listed, previewed or described from the server; an object's or a bucket's source (which
 * holds the endpoint, the ETag, the version id, user metadata, tags and a preview), the editor's console, the Keys
 * panel, the overview and every reading S3 does not report are answered by their reason, never by an empty answer or
 * a zero, so the model is told what it was not shown rather than reading an absence as the server's own answer. Nothing
 * read here is kept for a later call. The editor's handles keep every surface.
 */
import { QueryError } from "@/lib/db/errors";
import type { DatabaseObject, HealthInfo, KindCount } from "@/lib/db/types";
import type { S3AgentClient, S3CallOptions } from "./client";
import { S3_TYPE } from "./constants";
import { S3_OBJECT_KINDS } from "./objects";

const AGENT_READS =
  "Agent mode on S3 reads metadata only: bucket names, creation times, existence, regions, locations and versioning status, a whole bucket's object count and total size, and one named object's existence, size, last-modified time and storage class.";

const KEYS_WITHHELD =
  "Object keys count as stored values, since key paths name tenants and people, so no key is listed in agent mode.";

/** Each surface or figure an agent-mode handle does not read, with its reason. No sentence names a key or the endpoint. */
export const S3_AGENT_WITHHELD = {
  objects: `${AGENT_READS} ${KEYS_WITHHELD} Count a bucket's objects with aws s3 ls s3://BUCKET --recursive --summarize through run_read_query.`,
  keys: `${AGENT_READS} ${KEYS_WITHHELD} The Keys panel is not read on an agent-mode handle.`,
  source: `${AGENT_READS} An object's or a bucket's source holds the endpoint, the ETag, the version id, user metadata, tags and a preview of the content, which agent mode does not read.`,
  query: `${AGENT_READS} ${KEYS_WITHHELD} The editor's console, which lists keys and previews objects, is refused on an agent-mode handle; agent reads go through queryReadOnly.`,
  databaseSize: `${AGENT_READS} S3 reports no size for the whole store, so none is reported; a bucket's total is read with run_read_query.`,
  overview: `${AGENT_READS} S3 reports no server version, uptime or connection figures, so no overview reading is taken; this is not a reading of none.`,
  storage: `${AGENT_READS} S3 reports no storage figure for the whole store, so no storage reading is taken; a bucket's total size is read with run_read_query.`,
  tableStats: `${AGENT_READS} S3 has no tables, so no table reading is taken; a bucket's object count is read with run_read_query.`,
  indexStats: `${AGENT_READS} S3 has no indexes, so no index reading is taken; this is not a reading of none.`,
  slowQueries: `${AGENT_READS} S3 keeps no query log, so no slow-query reading is taken; this is not a reading of none.`,
  sessions: `${AGENT_READS} S3 does not list client sessions, so no session reading is taken; this is not a reading of none.`,
  performance: `${AGENT_READS} S3 reports no performance figures, so no performance reading is taken; this is not a reading of none.`,
} as const;

/** Studio's own refusals of a container or a kind, made before the agent's client is called. Neither quotes input. */
export const S3_AGENT_SHAPE = {
  container:
    "An S3 connection has no container level, so an agent-mode read names none. Nothing was sent to the server.",
  kind: "S3 declares the object kinds bucket and object only. Nothing was sent to the server.",
} as const;

const refusal = (sentence: string) => new QueryError(sentence, S3_TYPE);

/** Refuses a container on an agent-mode handle, before anything is sent. */
export function requireAgentRoot(container: readonly string[]): void {
  if (container.length !== 0) throw refusal(S3_AGENT_SHAPE.container);
}

/** The buckets, by name and creation time, read afresh: nothing is kept for a later call. */
async function bucketObjects(
  client: S3AgentClient,
  pinnedBucket: string | undefined,
  call: S3CallOptions,
): Promise<{ readonly objects: DatabaseObject[]; readonly truncated: boolean }> {
  if (pinnedBucket !== undefined)
    return { objects: [{ path: [pinnedBucket], name: pinnedBucket, kind: "bucket" }], truncated: false };
  const listing = await client.listBuckets(call);
  return {
    objects: listing.buckets.map((bucket) => ({
      path: [bucket.name],
      name: bucket.name,
      kind: "bucket",
      ...(bucket.created === undefined ? {} : { status: `created ${bucket.created.slice(0, 10)}` }),
    })),
    truncated: listing.truncated,
  };
}

const SAMPLED_FROM = "the first 10,000 buckets this key may list";

/** The bucket count on an agent-mode handle: the bucket listing's, a pinned connection's one bucket with no request. */
export async function agentCountObjects(
  client: S3AgentClient,
  container: readonly string[],
  pinnedBucket: string | undefined,
  call: S3CallOptions,
): Promise<Record<string, KindCount>> {
  requireAgentRoot(container);
  const { objects, truncated } = await bucketObjects(client, pinnedBucket, call);
  return { bucket: truncated ? { count: objects.length, sampledFrom: SAMPLED_FROM } : { count: objects.length } };
}

/** One kind's listing on an agent-mode handle: buckets by name, and the object kind refused with its reason. */
export async function agentListObjects(
  client: S3AgentClient,
  container: readonly string[],
  kind: string,
  pinnedBucket: string | undefined,
  call: S3CallOptions,
): Promise<DatabaseObject[]> {
  requireAgentRoot(container);
  if (kind === "object") throw refusal(S3_AGENT_WITHHELD.objects);
  if (!S3_OBJECT_KINDS.some((spec) => spec.id === kind)) throw refusal(S3_AGENT_SHAPE.kind);
  return (await bucketObjects(client, pinnedBucket, call)).objects;
}

/**
 * Health on an agent-mode handle: one read proves the server answers S3 (the bucket listing, or a pinned bucket's first
 * page, whose one entry is dropped here), and the size of the store, which S3 does not report, is its reason.
 */
export async function agentHealth(
  client: S3AgentClient,
  pinnedBucket: string | undefined,
  call: S3CallOptions,
): Promise<HealthInfo> {
  await agentProbe(client, pinnedBucket, call);
  return { databaseSize: S3_AGENT_WITHHELD.databaseSize, cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] };
}

/**
 * The agent-mode probe: an unpinned connection's bucket listing, or a pinned bucket's first whole-bucket page of one
 * entry, each answer parsed as S3 XML. How many buckets were listed, null when pinned; no key is kept.
 */
export async function agentProbe(
  client: S3AgentClient,
  pinnedBucket: string | undefined,
  call: S3CallOptions,
): Promise<{ readonly listedBuckets: number | null }> {
  if (pinnedBucket !== undefined) {
    await client.listBucketPage({ bucket: pinnedBucket, maxKeys: 1 }, call);
    return { listedBuckets: null };
  }
  return { listedBuckets: (await client.listBuckets(call)).buckets.length };
}
