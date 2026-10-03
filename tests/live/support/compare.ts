/**
 * The comparator of two snapshot records, one taken before a live run and one after (vector-family spec 4.2
 * VF10, R51 U19). Collections under the harness prefix are the harness's own and are skipped. Every other
 * collection's stable fields must be equal; its volatile fields are recorded for information only; the shared
 * writable scratch collections, named by their collection keys, are compared on schema, configuration, aliases and
 * load state only, whatever class the caller gives those four, because other agents write rows there. A field the caller classified as neither stable nor volatile, or as both, fails the
 * comparison loudly instead of being skipped.
 */
import { collectionKey, type CollectionSnapshot, type FieldReading, type SnapshotRecord } from "./snapshot";

/** What a scratch collection is compared on; any other field of it is recorded as volatile. */
export const SCRATCH_FIELDS = ["schema", "configuration", "aliases", "loadState"] as const;

export interface FieldClasses {
  readonly stable: readonly string[];
  readonly volatile: readonly string[];
}

export interface SnapshotDifference {
  readonly collection: string;
  /** null when the whole collection appeared or disappeared. */
  readonly field: string | null;
  readonly before: FieldReading | "absent";
  readonly after: FieldReading | "absent";
}

export interface VolatileReading {
  readonly collection: string;
  readonly field: string;
  readonly before: FieldReading;
  readonly after: FieldReading;
}

export interface SnapshotComparison {
  readonly differences: readonly SnapshotDifference[];
  readonly volatile: readonly VolatileReading[];
}

/** JSON with every object's keys sorted, so two readings compare by content and not by key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  // JSON.stringify writes Infinity and NaN as null; a non-finite number keeps its own text, which no JSON value has.
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return JSON.stringify(value);
}

function outside(record: SnapshotRecord, when: string): Map<string, CollectionSnapshot> {
  const collections = new Map<string, CollectionSnapshot>();
  for (const collection of record.collections) {
    const key = collectionKey(collection);
    if (collections.has(key)) throw new Error(`the record taken ${when} the run holds ${key} twice`);
    if (!collection.name.startsWith(record.prefix)) collections.set(key, collection);
  }
  return collections;
}

function classOf(classes: FieldClasses, field: string, collection: string): "stable" | "volatile" {
  if (classes.stable.includes(field)) return "stable";
  if (classes.volatile.includes(field)) return "volatile";
  throw new Error(`${collection} holds the field ${field}, which is classified neither stable nor volatile`);
}

export function compareSnapshots(
  before: SnapshotRecord,
  after: SnapshotRecord,
  classes: FieldClasses,
): SnapshotComparison {
  const both = classes.stable.filter((field) => classes.volatile.includes(field));
  if (both.length > 0) throw new Error(`classified both stable and volatile: ${both.join(", ")}`);
  if (before.prefix !== after.prefix) {
    throw new Error(`the two records use different prefixes: ${before.prefix} and ${after.prefix}`);
  }
  if (canonical(before.scratch) !== canonical(after.scratch)) {
    throw new Error("the two records name different scratch collections");
  }
  const differences: SnapshotDifference[] = [];
  const volatile: VolatileReading[] = [];
  const earlier = outside(before, "before");
  const later = outside(after, "after");
  const keys = [...new Set([...earlier.keys(), ...later.keys()])].sort();
  for (const key of keys) {
    const was = earlier.get(key);
    const is = later.get(key);
    if (was === undefined || is === undefined) {
      differences.push({
        collection: key,
        field: null,
        before: was === undefined ? "absent" : { value: "present" },
        after: is === undefined ? "absent" : { value: "present" },
      });
      continue;
    }
    const scratch = before.scratch.includes(key);
    const fields = [...new Set([...Object.keys(was.fields), ...Object.keys(is.fields)])].sort();
    for (const field of fields) {
      const fieldClass = classOf(classes, field, key);
      const readBefore = was.fields[field];
      const readAfter = is.fields[field];
      if (readBefore === undefined || readAfter === undefined) {
        differences.push({ collection: key, field, before: readBefore ?? "absent", after: readAfter ?? "absent" });
        continue;
      }
      const compared = scratch ? (SCRATCH_FIELDS as readonly string[]).includes(field) : fieldClass === "stable";
      if (!compared) {
        volatile.push({ collection: key, field, before: readBefore, after: readAfter });
      } else if (canonical(readBefore) !== canonical(readAfter)) {
        differences.push({ collection: key, field, before: readBefore, after: readAfter });
      }
    }
  }
  return { differences, volatile };
}

/** Throws, listing every difference, unless the comparison found none. */
export function assertUnchanged(comparison: SnapshotComparison): void {
  if (comparison.differences.length === 0) return;
  const lines = comparison.differences.map(
    (difference) =>
      `${difference.collection} ${difference.field ?? "(the collection)"}: ${canonical(difference.before)} -> ${canonical(difference.after)}`,
  );
  throw new Error(`The live run changed what it does not own:\n${lines.join("\n")}`);
}
