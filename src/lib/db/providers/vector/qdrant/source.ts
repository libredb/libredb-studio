/**
 * A collection's Source (vector-family spec 6.3): two JSON parts, a human surface only.
 *
 * `Schema` is the collection in the vocabulary of the create-collection request of the pinned OpenAPI: the
 * description's `config.params` at the top level, then the rest of `config` with the one name the two spell
 * differently mapped by a single rule, `optimizer_config` to `optimizers_config`, and the payload indexes as the
 * create-index request writes them. `State` is the description's own vocabulary: the status in Qdrant's words, the
 * point count labelled an estimate, the aliases, the snapshot list, the optimizations, the cluster information,
 * the collection's `metadata` under its own key, and the payload sample with the fields it found.
 *
 * Pure: it receives the answers and never a client. Where 1.19 reports a `memory` tier beside the deprecated
 * `on_disk`, `always_ram` or `on_disk_payload` flag, the two can contradict each other, so the flag is kept under a
 * key that says `memory` decides.
 */
import { applySourceBound } from "@/lib/db/object-kinds";
import type { ObjectSourcePart } from "@/lib/db/types";
import type { QdrantPayloadSample, QdrantSampledKey } from "./sample";
import { qdrantSampleCoverage, qdrantSampleNotices } from "./sample";
import { type QdrantCollection, qdrantCount, qdrantPayloadIndexes } from "./schema";

type JsonObject = Readonly<Record<string, unknown>>;

/** The answers a Source is built from, each the `result` of its read. */
export interface QdrantSourceInput {
  readonly collection: QdrantCollection;
  readonly aliases: unknown;
  readonly snapshots: unknown;
  readonly optimizations: unknown;
  readonly cluster: unknown;
  /** The payload sample, or null where the collection reports no points and none was read. */
  readonly sample: QdrantPayloadSample | null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The single named rule between the description's vocabulary and the create request's. */
const CREATE_NAMES: Readonly<Record<string, string>> = { optimizer_config: "optimizers_config" };

/** What a deprecated flag is shown as beside a `memory` tier. */
export const DEPRECATED_SUFFIX = " (deprecated: memory decides)";

const DEPRECATED_FLAGS = new Set(["on_disk", "always_ram"]);

/** An object with each key `deprecated` names kept under the deprecated name, its values marked in turn. */
function renamed(value: JsonObject, deprecated: (key: string) => boolean): JsonObject {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      deprecated(key) ? `${key}${DEPRECATED_SUFFIX}` : key,
      markDeprecated(entry),
    ]),
  );
}

/** Every object that holds a `memory` tier keeps its `on_disk` and `always_ram` flags under the deprecated name. */
function markDeprecated(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(markDeprecated);
  if (!isObject(value)) return value;
  const tiered = Object.hasOwn(value, "memory");
  return renamed(value, (key) => tiered && DEPRECATED_FLAGS.has(key));
}

/** The `Schema` part's document. */
export function qdrantSchemaDocument(collection: QdrantCollection): JsonObject {
  const { params } = collection;
  // The payload's own tier decides where the payload lives; `on_disk_payload` is the flag it replaced.
  const payloadTiered = isObject(params.payload) && Object.hasOwn(params.payload, "memory");
  const document: Record<string, unknown> = {
    ...renamed(params, (key) => (key === "on_disk_payload" ? payloadTiered : false)),
  };
  for (const [key, value] of Object.entries(collection.config)) {
    if (key === "params" || key === "metadata") continue;
    document[Object.hasOwn(CREATE_NAMES, key) ? CREATE_NAMES[key] : key] = markDeprecated(value);
  }
  document.payload_indexes = qdrantPayloadIndexes(collection).map((index) => ({
    field_name: index.key,
    field_schema: index.params ?? index.type,
  }));
  return document;
}

const NOT_SAMPLED = "not sampled: the collection reports no points";
const FULL_SCAN =
  "indexed_vectors_count is below points_count, so the points not yet indexed are searched by full scan.";

/** The alias names of a `GET /collections/{collection_name}/aliases` answer; an entry with no name is left out. */
function aliasNames(aliases: unknown): readonly string[] {
  if (!isObject(aliases) || !Array.isArray(aliases.aliases)) return [];
  return aliases.aliases.flatMap((alias: unknown) =>
    isObject(alias) && typeof alias.alias_name === "string" ? [alias.alias_name] : [],
  );
}

/** A sampled field as the State lists it: the original key, its column where the column rule renamed it, its type. */
function sampledField(entry: QdrantSampledKey, sampleSize: number): JsonObject {
  const field: Record<string, unknown> = { key: entry.key };
  if (entry.column !== entry.key) field.column = entry.column;
  field.type = entry.type;
  field.nullable = entry.nullable;
  field.sampleSize = sampleSize;
  return field;
}

/** The `State` part's document. */
export function qdrantStateDocument(input: QdrantSourceInput): JsonObject {
  const { info, config } = input.collection;
  const points = qdrantCount(info.points_count);
  const indexed = qdrantCount(info.indexed_vectors_count);
  const indexedKeys = new Set(qdrantPayloadIndexes(input.collection).map((index) => index.key));
  const { sample } = input;
  return {
    status: info.status,
    optimizer_status: info.optimizer_status,
    points_count: info.points_count,
    pointsCountKind: "estimate",
    indexed_vectors_count: info.indexed_vectors_count,
    ...(points !== null && indexed !== null && indexed < points ? { indexCoverage: FULL_SCAN } : {}),
    segments_count: info.segments_count,
    ...(info.warnings === undefined ? {} : { warnings: info.warnings }),
    aliases: aliasNames(input.aliases),
    snapshots: input.snapshots,
    optimizations: input.optimizations,
    cluster: input.cluster,
    ...(config.metadata === undefined ? {} : { metadata: config.metadata }),
    payloadSample:
      sample === null
        ? { points: 0, method: NOT_SAMPLED, keys: 0 }
        : { points: sample.points, method: sample.method, keys: sample.keys.length },
    ...(sample === null
      ? {}
      : {
          sampleCoverage: qdrantSampleCoverage(sample),
          sampledFields: sample.keys
            .filter((entry) => !indexedKeys.has(entry.key))
            .map((entry) => sampledField(entry, sample.points)),
          ...(qdrantSampleNotices(sample).length === 0 ? {} : { sampleNotices: qdrantSampleNotices(sample) }),
        }),
  };
}

function jsonPart(id: string, label: string, document: JsonObject, limit: number | undefined): ObjectSourcePart {
  const bounded = applySourceBound(JSON.stringify(document, null, 2), limit);
  return {
    id,
    label,
    text: bounded.text,
    language: "json",
    form: "partial",
    origin: "rendered",
    ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
  };
}

/** The two parts, Schema then State, each cut at the caller's bound through the shared helper. */
export function qdrantSourceParts(
  input: QdrantSourceInput,
  limit?: number,
): readonly [ObjectSourcePart, ObjectSourcePart] {
  return [
    jsonPart("schema", "Schema", qdrantSchemaDocument(input.collection), limit),
    jsonPart("state", "State", qdrantStateDocument(input), limit),
  ];
}
