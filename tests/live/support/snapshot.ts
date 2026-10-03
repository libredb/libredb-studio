/**
 * The record a vector live harness writes when it snapshots every collection outside its own prefix, before and
 * after a run (vector-family spec 4.2 and 3.9). It holds no provider code: the Milvus and Qdrant providers'
 * collectors fill it through their own admin clients, with read calls only, and `compare.ts` judges two of them.
 *
 * A field that cannot be read without a state change is recorded as `{ unavailable: reason }`, from a closed set
 * of reasons; any other read error fails the run loudly, with no silent skip and no retry.
 */

/** The closed set of reasons a field may be recorded as unavailable, and nothing else. */
export const UNAVAILABLE_REASONS = ["not-loaded", "strict-mode-exact-disabled"] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export type SnapshotJson =
  | null
  | boolean
  | number
  | string
  | readonly SnapshotJson[]
  | { readonly [key: string]: SnapshotJson };

export interface Unavailable {
  readonly unavailable: UnavailableReason;
}

export type FieldReading = { readonly value: SnapshotJson } | Unavailable;

export type SnapshotEngine = "milvus" | "qdrant";

export interface CollectionSnapshot {
  readonly engine: SnapshotEngine;
  /** The database a Milvus collection lives in; null on Qdrant, which has none. */
  readonly database: string | null;
  readonly name: string;
  readonly fields: Readonly<Record<string, FieldReading>>;
}

export interface SnapshotRecord {
  readonly harness: string;
  readonly takenAt: string;
  /** Every collection whose name starts with it is the harness's own and is not snapshotted. */
  readonly prefix: string;
  /**
   * The shared writable collections, each named by its `collectionKey` (`milvus:default/scratch`, `qdrant:/scratch`),
   * compared on schema, configuration, aliases and load state only.
   */
  readonly scratch: readonly string[];
  readonly collections: readonly CollectionSnapshot[];
}

export class SnapshotReadError extends Error {
  constructor(
    readonly collection: string,
    readonly field: string,
    cause: unknown,
  ) {
    super(`Could not read ${field} of ${collection}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = "SnapshotReadError";
  }
}

export function isUnavailableReason(value: unknown): value is UnavailableReason {
  return typeof value === "string" && (UNAVAILABLE_REASONS as readonly string[]).includes(value);
}

function closedSetMessage(reason: unknown): string {
  return `"${String(reason)}" is not one of the closed unavailable reasons: ${UNAVAILABLE_REASONS.join(", ")}`;
}

export function unavailable(reason: string): Unavailable {
  if (!isUnavailableReason(reason)) throw new Error(closedSetMessage(reason));
  return { unavailable: reason };
}

/**
 * Reads one field. A read that fails is recorded as unavailable only when `unavailableOn` names a closed reason
 * for its error; any other error is thrown as a `SnapshotReadError` that keeps the original as its cause.
 */
export async function readField(
  collection: string,
  field: string,
  read: () => Promise<SnapshotJson>,
  unavailableOn: (error: unknown) => UnavailableReason | null,
): Promise<FieldReading> {
  try {
    return { value: await read() };
  } catch (error) {
    const reason = unavailableOn(error);
    if (reason === null) throw new SnapshotReadError(collection, field, error);
    return unavailable(reason);
  }
}

export function collectionKey(snapshot: Pick<CollectionSnapshot, "engine" | "database" | "name">): string {
  return `${snapshot.engine}:${snapshot.database ?? ""}/${snapshot.name}`;
}

function object(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${where} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function array(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Error(`${where} must be a string`);
  return value;
}

function fieldReading(value: unknown, where: string): FieldReading {
  const reading = object(value, where);
  const keys = Object.keys(reading);
  if (keys.length === 1 && keys[0] === "value") return { value: reading.value as SnapshotJson };
  if (keys.length === 1 && keys[0] === "unavailable") {
    if (!isUnavailableReason(reading.unavailable)) {
      throw new Error(`${where}.unavailable: ${closedSetMessage(reading.unavailable)}`);
    }
    return { unavailable: reading.unavailable };
  }
  throw new Error(`${where} must be exactly { value } or { unavailable }`);
}

function databaseOf(engine: SnapshotEngine, value: unknown, where: string): string | null {
  if (engine === "milvus") return text(value, where);
  if (value !== null) throw new Error(`${where} must be null on Qdrant, which has no databases`);
  return null;
}

/** Parses a written record, refusing anything the schema above does not allow, and names where. */
export function parseSnapshotRecord(json: string): SnapshotRecord {
  const record = object(JSON.parse(json) as unknown, "the record");
  const prefix = text(record.prefix, "prefix");
  if (prefix === "") throw new Error("prefix must not be empty");
  const scratch = array(record.scratch, "scratch").map((name, index) => text(name, `scratch[${index}]`));
  const seen = new Set<string>();
  const collections = array(record.collections, "collections").map((entry, index) => {
    const where = `collections[${index}]`;
    const raw = object(entry, where);
    if (raw.engine !== "milvus" && raw.engine !== "qdrant")
      throw new Error(`${where}.engine must be "milvus" or "qdrant"`);
    const fields = Object.fromEntries(
      Object.entries(object(raw.fields, `${where}.fields`)).map(([field, reading]) => [
        field,
        fieldReading(reading, `${where}.fields.${field}`),
      ]),
    );
    const snapshot: CollectionSnapshot = {
      engine: raw.engine,
      database: databaseOf(raw.engine, raw.database, `${where}.database`),
      name: text(raw.name, `${where}.name`),
      fields,
    };
    const key = collectionKey(snapshot);
    if (seen.has(key)) throw new Error(`${where} repeats ${key}`);
    seen.add(key);
    return snapshot;
  });
  return {
    harness: text(record.harness, "harness"),
    takenAt: text(record.takenAt, "takenAt"),
    prefix,
    scratch,
    collections,
  };
}
