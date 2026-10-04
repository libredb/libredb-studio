/**
 * The Oxia object surface (SB2-7): one declared kind the tree lists, `shard`, and the `key` kind the Keys panel
 * enumerates, each with a Source tab.
 *
 * A shard row carries its id and hash range only; its leader reaches the shard's Source tab alone, in its parsed
 * `host:port` form, so plan-mode grounding, which reads rows, carries no address (SB2-7.2, SB2-10). The namespace,
 * the key order, how it was learned and the leaders are shown in each shard's Source tab, which is where the overview
 * facts of O14 live (SB2-12 D4). A key's Source tab reads the key with one EQUAL get, and shows its value as JSON, text
 * or a hex dump, and its version as metadata whose label carries the ephemeral badge (SB2-12 D8). No part offers an
 * edit: v1 only reads (O1).
 */
import { QueryError } from "@/lib/db/errors";
import { applySourceBound } from "@/lib/db/object-kinds";
import type {
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  ObjectSourceDocument,
  ObjectSourcePart,
} from "@/lib/db/types";
import type { OxiaCallOptions, OxiaRecordView, OxiaShard } from "./client";
import { OXIA_INTERNAL_KEY_SENTENCE } from "./commands";
import { OXIA_INTERNAL_PREFIX, OXIA_RECEIVE_CAP_BYTES, OXIA_SOURCE_HEX_BYTES, OXIA_TYPE } from "./constants";
import { keyOrderWords } from "./labels";
import { hexDump, isoFromEpochMs, shownKey, viewOxiaValue } from "./values";
import { type OxiaSurface, readKeys } from "./walks";

/** SB2-7.1: the shard folder, and the key the Keys panel enumerates; neither declares columns, edits or children. */
export const OXIA_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "shard", role: "config", label: "Shard", labelPlural: "Shards", hasSource: true, sourceLanguage: "json" },
  {
    id: "key",
    role: "config",
    label: "Key",
    labelPlural: "Keys",
    enumeratedBy: "key-browser",
    hasSource: true,
    sourceLanguage: "json",
  },
] as const);

/** SB2-7.2: the `key` listing's refusal, J3-14's sentence; `tableStatsCaption` restates it (SB2-12 D3). */
export const OXIA_KEYS_LISTED_ELSEWHERE = "Keys are listed in the Keys panel and with list in the console.";

const RECEIVE_CAP_MIB = OXIA_RECEIVE_CAP_BYTES / (1024 * 1024);
const WITHHELD_SOURCE = `The value is larger than ${RECEIVE_CAP_MIB} MiB, the most Studio receives in one message, so it is withheld. Its version is below.`;
const EMPTY_SOURCE =
  "The value is empty (0 bytes). Pulsar and other ZooKeeper-style clients write parent paths this way.";

function requireKind(kind: string): void {
  if (!OXIA_OBJECT_KINDS.some((spec) => spec.id === kind))
    throw new QueryError(`Oxia declares no object kind "${kind}"`, OXIA_TYPE);
}

/** Every Oxia path is one segment: no container level is declared, and no kind is attached to another. */
function requirePath(path: readonly string[], kind: string): string {
  requireKind(kind);
  if (path.length !== 1)
    throw new QueryError(`An Oxia "${kind}" path is [name], received ${JSON.stringify(path)}`, OXIA_TYPE);
  return path[0];
}

/** Shard ids are 64-bit decimal strings, so they are ordered as numbers, not as text. */
const byShardId = (a: OxiaShard, b: OxiaShard): number => {
  const left = BigInt(a.id);
  const right = BigInt(b.id);
  return left < right ? -1 : left > right ? 1 : 0;
};

/** SB2-7.2: the shard count of the snapshot; `key` is never counted (`enumeratedBy`). */
export async function countOxiaObjects(
  surface: OxiaSurface,
  call: OxiaCallOptions,
): Promise<Record<string, KindCount>> {
  const snapshot = await surface.snapshot(call);
  return { shard: { count: snapshot.shards.length } };
}

/** SB2-7.2: one row per shard in ascending id, with its inclusive hash range; the key kind is refused by name. */
export async function listOxiaObjects(
  surface: OxiaSurface,
  kind: string,
  call: OxiaCallOptions,
): Promise<DatabaseObject[]> {
  if (kind === "key") throw new QueryError(OXIA_KEYS_LISTED_ELSEWHERE, OXIA_TYPE);
  requireKind(kind);
  const snapshot = await surface.snapshot(call);
  return [...snapshot.shards].sort(byShardId).map((shard) => ({
    path: [shard.id],
    name: `Shard ${shard.id}`,
    kind: "shard",
    status: `hashes ${shard.minHash} to ${shard.maxHash}`,
  }));
}

/** SB2-7.3: no kind declares columns, so both answer an empty detail, with no read. */
export function describeOxiaObject(path: readonly string[], kind: string): ObjectDetail {
  requirePath(path, kind);
  return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
}

/** SB2-7.3: nothing to describe, for either kind. */
export function describeOxiaObjects(kind: string): ObjectDetailBatch {
  requireKind(kind);
  return { details: [] };
}

/** A JSON part rendered by Studio, under the caller's bound. */
function renderedJson(id: string, label: string, value: unknown, limit: number | undefined): ObjectSourcePart {
  const bounded = applySourceBound(JSON.stringify(value, null, 2), limit);
  return {
    id,
    label,
    text: bounded.text,
    language: "json",
    form: "complete",
    origin: "rendered",
    ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
  };
}

/** SB2-7.4: the shard's facts, its leader parsed, the namespace's key order in words. */
async function shardSource(
  surface: OxiaSurface,
  id: string,
  limit: number | undefined,
  call: OxiaCallOptions,
): Promise<ObjectSourceDocument> {
  const snapshot = await surface.snapshot(call);
  const shard = snapshot.shards.find((candidate) => candidate.id === id);
  if (shard === undefined)
    throw new QueryError(`This namespace has no shard ${shownKey(id)}: shards are listed under Shards.`, OXIA_TYPE);
  const verdict = await surface.order(call);
  const facts = {
    namespace: snapshot.namespace,
    shard: shard.id,
    hash_range: { min_inclusive: String(shard.minHash), max_inclusive: String(shard.maxHash) },
    leader: shard.leader.address,
    key_order: verdict.order,
    key_order_learned: keyOrderWords(verdict),
    shards_in_namespace: snapshot.shards.length,
  };
  return { path: [id], kind: "shard", parts: [renderedJson("shard", "Shard", facts, limit)] };
}

/** A read value's bytes: a Source read always asks for the value, so a record with none and no withheld mark is a defect. */
function valueBytes(record: OxiaRecordView): Uint8Array {
  if (record.value === undefined)
    throw new Error(
      "An Oxia record reached the Source tab with no value and no withheld mark: the read asks for the value",
    );
  return record.value;
}

/** SB2-7.5 part 1: the value as JSON, text or a hex dump, or the sentence for an empty or withheld one. */
function valuePart(record: OxiaRecordView, limit: number | undefined): ObjectSourcePart {
  if (record.withheld === true) return { id: "value", label: "Value", unavailable: WITHHELD_SOURCE };
  const bytes = valueBytes(record);
  if (bytes.length === 0) return { id: "value", label: "Value", unavailable: EMPTY_SOURCE };
  const view = viewOxiaValue(bytes, { hex: false, cellLimit: Number.POSITIVE_INFINITY });
  let text: string;
  let language: string;
  let origin: "stored" | "rendered";
  let dumpCut = false;
  if (view.encoding === "json") {
    text = JSON.stringify(JSON.parse(view.text), null, 2);
    language = "json";
    origin = text === view.text ? "stored" : "rendered";
  } else if (view.encoding === "text" && view.text.trim() !== "") {
    text = view.text;
    language = "plaintext";
    origin = "stored";
  } else {
    // Bytes that are no printable text, and text of blanks only, which a part may not hold as its text.
    text = hexDump(bytes, OXIA_SOURCE_HEX_BYTES);
    language = "plaintext";
    origin = "rendered";
    dumpCut = bytes.length > OXIA_SOURCE_HEX_BYTES;
  }
  const bounded = applySourceBound(text, limit);
  return {
    id: "value",
    label: "Value",
    text: bounded.text,
    language,
    form: dumpCut || bounded.truncated !== undefined ? "partial" : "complete",
    origin,
    ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
  };
}

/** SB2-7.5 part 2: the version, with the cell rules of SB2-6.1, labelled with the ephemeral badge when it has one. */
function metadataPart(key: string, record: OxiaRecordView, limit: number | undefined): ObjectSourcePart {
  const { version } = record;
  const bytes = record.withheld === true ? undefined : valueBytes(record);
  const encoding =
    bytes === undefined
      ? "withheld"
      : viewOxiaValue(bytes, { hex: false, cellLimit: Number.POSITIVE_INFINITY }).encoding;
  const metadata = {
    key,
    shard: record.shard,
    version_id: version.versionId,
    modifications_count: version.modificationsCount,
    created_timestamp: isoFromEpochMs(version.createdTimestamp),
    modified_timestamp: isoFromEpochMs(version.modifiedTimestamp),
    ephemeral: version.sessionId !== undefined,
    session_id: version.sessionId ?? null,
    client_identity:
      version.clientIdentity === undefined || version.clientIdentity === "" ? null : version.clientIdentity,
    value_encoding: encoding,
    value_bytes: bytes === undefined ? null : bytes.length,
  };
  const label =
    version.sessionId === undefined
      ? "Metadata"
      : `Metadata (ephemeral: deleted when session ${version.sessionId} ends)`;
  return renderedJson("metadata", label, metadata, limit);
}

/** SB2-7.5: one EQUAL get on the key's shard; an internal key is refused before any call. */
async function keySource(
  surface: OxiaSurface,
  key: string,
  limit: number | undefined,
  call: OxiaCallOptions,
): Promise<ObjectSourceDocument> {
  if (key.startsWith(OXIA_INTERNAL_PREFIX)) throw new QueryError(OXIA_INTERNAL_KEY_SENTENCE, OXIA_TYPE);
  const snapshot = await surface.snapshot(call);
  const [record] = await readKeys(surface.client, snapshot, [{ key, includeValue: true }], call);
  if (record === undefined)
    throw new QueryError(`Oxia holds no key ${shownKey(key)} in namespace \`${snapshot.namespace}\`.`, OXIA_TYPE);
  return { path: [key], kind: "key", parts: [valuePart(record, limit), metadataPart(key, record, limit)] };
}

/** SB2-7.4 and SB2-7.5: a shard's or a key's Source document. */
export async function readOxiaObjectSource(
  surface: OxiaSurface,
  path: readonly string[],
  kind: string,
  limit: number | undefined,
  call: OxiaCallOptions,
): Promise<ObjectSourceDocument> {
  const name = requirePath(path, kind);
  return kind === "shard" ? shardSource(surface, name, limit, call) : keySource(surface, name, limit, call);
}
