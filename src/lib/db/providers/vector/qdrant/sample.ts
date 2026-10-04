/**
 * The payload sample (vector-family spec 6.3): the one scroll that finds the payload keys no index declares, and
 * the typing of what it returns. Qdrant's payload is schemaless and `payload_schema` lists indexed fields only, so
 * the tree's other payload columns come from 1,000 points read with their payloads and without their vectors.
 *
 * On a server that has the `slice` condition the sample is slice 0 of ceil(points_count / 1,000), which is uniform
 * over ids and so sees a field whose type changed with the id; an older server refuses `slice`, so it gets the
 * first page, the lowest ids. A collection that reports no points is not sampled.
 *
 * Typing reads JSON families only. Integer and float are one family, because a float written from JavaScript with
 * an integral value is stored as an integer; null marks a key nullable and is no type; two or more families make
 * the key `mixed`. The answer is parsed plainly on purpose: a rounded integer is still a number, and no value of
 * the sample is ever shown. Every sampled column carries `provenance: "sampled"`, which keeps it from every
 * machine-facing surface.
 */
import { QueryError } from "@/lib/db/errors";
import { type TaggedJson, taggedNumber, toJsonText } from "@/lib/db/console/tagged-json";
import type { ColumnSchema, DatabaseType } from "@/lib/types";
import type { QdrantRequest } from "./client";
import { payloadColumnName } from "./columns";

const PROVIDER: DatabaseType = "qdrant";

/** The points one sample reads. */
export const QDRANT_SAMPLE_POINTS = 1_000;

/** The sample's request and what it is a sample of. */
export interface QdrantSampleRead {
  readonly request: QdrantRequest & { readonly op: "scroll_points" };
  /** How the points were chosen, as the Source states it. */
  readonly method: string;
  /** True for one slice of several: uniform over ids. False for the lowest ids. */
  readonly uniform: boolean;
}

const integer = (value: number): TaggedJson => taggedNumber(String(value));

/**
 * The sample of a collection that reports `pointsCount` points, or null for one that reports none. The count is
 * Qdrant's estimate, which is all the slice arithmetic needs; where the server reports no count, or has no `slice`
 * condition, the sample is the first page.
 */
export function qdrantSampleRead(
  collection: string,
  pointsCount: number | null,
  sliceSupported: boolean,
): QdrantSampleRead | null {
  if (pointsCount === 0) return null;
  const page = { limit: integer(QDRANT_SAMPLE_POINTS), with_payload: true, with_vector: false };
  const request = (body: TaggedJson): QdrantSampleRead["request"] => ({
    op: "scroll_points",
    params: { collection_name: collection },
    query: {},
    body: toJsonText(body),
  });
  if (!sliceSupported || pointsCount === null) {
    return { request: request(page), method: "first page, the lowest ids", uniform: false };
  }
  const total = Math.ceil(pointsCount / QDRANT_SAMPLE_POINTS);
  const slice = { slice: { index: integer(0), total: integer(total) } };
  return {
    request: request({ filter: { must: [slice] }, ...page }),
    method: total > 1 ? `slice 0 of ${total}, uniform by id` : "slice 0 of 1, the lowest ids",
    uniform: total > 1,
  };
}

/** The JSON families a payload value falls into; integer and float are one. */
export type PayloadFamily = "string" | "number" | "boolean" | "object" | "array";

const FAMILY_ORDER: readonly PayloadFamily[] = ["string", "number", "boolean", "object", "array"];

/** One top-level payload key the sample found. */
export interface QdrantSampledKey {
  /** The key as the payload holds it, which is what a filter writes. */
  readonly key: string;
  /** Its column, by the column-name rule. */
  readonly column: string;
  /** The families of its non-null values, in a fixed order. */
  readonly families: readonly PayloadFamily[];
  /** A null was seen, or a sampled point does not carry the key. */
  readonly nullable: boolean;
  /** The type text: the one family, `mixed (...)` for several, `unknown` where every value seen was null. */
  readonly type: string;
}

export interface QdrantPayloadSample {
  /** The points the sample returned. */
  readonly points: number;
  readonly method: string;
  readonly uniform: boolean;
  /** True where the sample is every point of the collection: the lowest ids, with no page after them. */
  readonly complete: boolean;
  /** The keys in first-seen order. */
  readonly keys: readonly QdrantSampledKey[];
}

function familyOf(value: unknown): PayloadFamily | null {
  if (value === null) return null;
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return typeof value === "string" ? "string" : "object";
}

function typeText(families: readonly PayloadFamily[]): string {
  if (families.length === 0) return "unknown";
  return families.length === 1 ? families[0] : `mixed (${families.join(", ")})`;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The sample read from the text of its scroll answer. Seen families are kept in a Map, so a key named
 * `constructor` or `__proto__` is a key like any other.
 */
export function readQdrantPayloadSample(
  collection: string,
  answerText: string,
  read: Pick<QdrantSampleRead, "method" | "uniform">,
): QdrantPayloadSample {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answerText);
  } catch {
    parsed = undefined;
  }
  const result = isObject(parsed) ? parsed.result : undefined;
  const points = isObject(result) ? result.points : undefined;
  if (!isObject(result) || !Array.isArray(points)) {
    throw new QueryError(
      `Qdrant's answer to the payload sample of collection ${JSON.stringify(collection)} is not one Studio can read.`,
      PROVIDER,
    );
  }
  const seen = new Map<string, { readonly families: Set<PayloadFamily>; carried: number; sawNull: boolean }>();
  for (const point of points) {
    const payload = isObject(point) && isObject(point.payload) ? point.payload : {};
    for (const [key, value] of Object.entries(payload)) {
      const entry = seen.get(key) ?? { families: new Set<PayloadFamily>(), carried: 0, sawNull: false };
      seen.set(key, entry);
      entry.carried += 1;
      const family = familyOf(value);
      if (family === null) entry.sawNull = true;
      else entry.families.add(family);
    }
  }
  const keys = [...seen].map(([key, entry]): QdrantSampledKey => {
    const families = FAMILY_ORDER.filter((family) => entry.families.has(family));
    return {
      key,
      column: payloadColumnName(key),
      families,
      nullable: entry.sawNull || entry.carried < points.length,
      type: typeText(families),
    };
  });
  return {
    points: points.length,
    method: read.method,
    uniform: read.uniform,
    complete: !read.uniform && result.next_page_offset === null,
    keys,
  };
}

/** The sampled columns: one per key that no payload index declares, each marked as sampled. */
export function qdrantSampledColumns(
  sample: QdrantPayloadSample,
  indexedKeys: ReadonlySet<string>,
): readonly ColumnSchema[] {
  return sample.keys
    .filter((entry) => !indexedKeys.has(entry.key))
    .map(
      (entry): ColumnSchema => ({
        name: entry.column,
        type: entry.type,
        nullable: entry.nullable,
        isPrimary: false,
        provenance: "sampled",
      }),
    );
}

/** One notice per key whose values fall into two or more families. */
export function qdrantSampleNotices(sample: QdrantPayloadSample): readonly string[] {
  return sample.keys
    .filter((entry) => entry.families.length > 1)
    .map(
      (entry) =>
        `Payload key ${JSON.stringify(entry.key)} holds ${entry.families.join(" and ")} values in the sample, so its type is mixed.`,
    );
}

const count = (value: number) => value.toLocaleString("en-US");

/** The chance that `points` uniformly chosen points include one of the `share` of points that carry a key, cut to four places. */
function found(points: number, share: number): string {
  return (Math.floor((1 - (1 - share) ** points) * 10_000) / 10_000).toFixed(4);
}

/** What the sample can and cannot have seen, which the Source states beside the sampled fields. */
export function qdrantSampleCoverage(sample: QdrantPayloadSample): string {
  if (sample.complete) return `The sample is every point of the collection (${count(sample.points)}).`;
  if (!sample.uniform) {
    return `The sample is the ${count(sample.points)} lowest ids, so a key that only later points carry is not in it.`;
  }
  return `A key present on 1 percent of points is in a uniform sample of ${count(sample.points)} points with probability ${found(sample.points, 0.01)}, and one present on 0.1 percent with probability ${found(sample.points, 0.001)}.`;
}
