/**
 * The two engines' vector fixtures as the shared vector suites read them (vector-family spec 7.3): the expected
 * `VectorFieldInfo[]` per seeded collection, the expected cells in Studio's cell form and the non-finite scores,
 * all under tests/fixtures/vector/ and derived from the seeds' manifests by tests/live/vector-evidence.ts. A missing
 * or malformed file fails the suite that reads it; nothing here falls back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaggedJson } from "@/lib/db/console/tagged-json";
import { taggedNumber } from "@/lib/db/console/tagged-json";
import type { VectorTarget } from "@/lib/db/vector/dense";
import type { ExpectedCells, ExpectedVectorField } from "../live/vector-evidence-derive";

export const ENGINES = ["milvus", "qdrant"] as const;
export type Engine = (typeof ENGINES)[number];

const FIXTURES = join(import.meta.dir, "..", "fixtures", "vector");

function readJson<T>(...path: string[]): T {
  return JSON.parse(readFileSync(join(FIXTURES, ...path), "utf8")) as T;
}

/** Every seeded collection's expected vector fields, keyed "<database>/<collection>" on Milvus, "<collection>" on Qdrant. */
function expectedFields(engine: Engine): Readonly<Record<string, readonly ExpectedVectorField[]>> {
  const file = readJson<{ fields?: Record<string, ExpectedVectorField[]> }>(engine, "expected-fields.json");
  if (file.fields === undefined || Object.keys(file.fields).length === 0) {
    throw new Error(`tests/fixtures/vector/${engine}/expected-fields.json holds no fields`);
  }
  return file.fields;
}

/** Every expected field of an engine, with the collection it belongs to. */
export function allFields(
  engine: Engine,
): readonly { readonly collection: string; readonly field: ExpectedVectorField }[] {
  return Object.entries(expectedFields(engine)).flatMap(([collection, fields]) =>
    fields.map((field) => ({ collection, field })),
  );
}

export function expectedCells(engine: Engine): ExpectedCells {
  const file = readJson<ExpectedCells>(engine, "expected-cells.json");
  if (!Array.isArray(file.cells) || file.cells.length === 0) {
    throw new Error(`tests/fixtures/vector/${engine}/expected-cells.json holds no cells`);
  }
  return file;
}

export interface ExpectedScores {
  readonly milvus: {
    readonly collection: string;
    readonly field: string;
    readonly score: number | "Infinity" | "-Infinity" | "NaN";
  };
  readonly qdrant: { readonly collection: string; readonly field: string; readonly printed: number | null };
}

export function expectedScores(): ExpectedScores {
  return readJson<ExpectedScores>("expected-scores.json");
}

/** The target a cell of `collection`'s `field` is checked against: the field's expected facts. */
export function targetOf(engine: Engine, collection: string, field: string): VectorTarget {
  const found = expectedFields(engine)[collection]?.find((entry) => entry.name === field);
  if (found === undefined) throw new Error(`${engine} ${collection} has no expected field ${field}`);
  return { name: found.name, kind: found.kind, dtype: found.dtype, dimension: found.dimension };
}

/**
 * The sparse index bound each engine's provider will declare, as test data until it does: Milvus's indices are
 * below 2^32 - 1, Qdrant's below 2^32.
 */
export const SPARSE_INDEX_BOUND: Readonly<Record<Engine, number>> = { milvus: 4_294_967_295, qdrant: 4_294_967_296 };

/**
 * The multivector element bound each engine's provider will declare, as test data until it does: Milvus takes at
 * most 262,144 elements per query vector, Qdrant fewer than 1,048,576.
 */
export const MULTIVECTOR_ELEMENTS: Readonly<Record<Engine, number>> = { milvus: 262_144, qdrant: 1_048_575 };

/**
 * A plain JSON value as the console reads it: every number a tagged literal, every object on no prototype. A number
 * is written as JavaScript writes it, which a JSON number literal also reads, so `3.4e+38` stays a float literal.
 */
export function tagged(value: unknown): TaggedJson {
  if (typeof value === "number") return taggedNumber(String(value));
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(tagged));
  const object: Record<string, TaggedJson> = Object.create(null);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) object[key] = tagged(entry);
  return Object.freeze(object);
}
