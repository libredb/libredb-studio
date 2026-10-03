/**
 * The comparator of two snapshot records (tests/live/support/compare.ts; vector-family spec 4.2 VF10, R51 U19):
 * stable fields must be equal outside the harness prefix, volatile fields are recorded only, the scratch
 * collections are compared on schema, configuration, aliases and load state only, and anything unclassified fails.
 */
import { describe, expect, test } from "bun:test";
import {
  assertUnchanged,
  compareSnapshots,
  type FieldClasses,
  SCRATCH_FIELDS,
  type SnapshotComparison,
  type SnapshotDifference,
  type VolatileReading,
} from "../../live/support/compare";
import type { CollectionSnapshot, FieldReading, SnapshotRecord } from "../../live/support/snapshot";

const CLASSES: FieldClasses = {
  stable: ["schema", "configuration", "aliases", "loadState", "rowCount"],
  volatile: ["segments", "memory"],
};

function collection(name: string, fields: Record<string, FieldReading>): CollectionSnapshot {
  return { engine: "milvus", database: "default", name, fields };
}

const DOCS = collection("docs_int64", {
  schema: { value: { fields: ["id", "vec"], dynamic: true } },
  rowCount: { value: 2000 },
  memory: { value: 271 },
});
const SCRATCH = collection("scratch", {
  schema: { value: { fields: ["id", "vec", "note"] } },
  rowCount: { value: 0 },
});

function record(collections: readonly CollectionSnapshot[]): SnapshotRecord {
  return {
    harness: "test",
    takenAt: "2026-10-03T12:00:00.000Z",
    prefix: "libredb_live_",
    scratch: ["milvus:default/scratch"],
    collections,
  };
}

describe("compareSnapshots", () => {
  test("two identical records differ in nothing, and the volatile fields are still recorded", () => {
    const comparison = compareSnapshots(record([DOCS, SCRATCH]), record([DOCS, SCRATCH]), CLASSES);
    expect(comparison.differences).toEqual([]);
    expect(comparison.volatile).toContainEqual({
      collection: "milvus:default/docs_int64",
      field: "memory",
      before: { value: 271 },
      after: { value: 271 },
    });
  });

  test("a changed stable field outside the prefix is a difference naming the collection and the field", () => {
    const changed = collection("docs_int64", { ...DOCS.fields, rowCount: { value: 2001 } });
    expect(compareSnapshots(record([DOCS]), record([changed]), CLASSES).differences).toEqual([
      { collection: "milvus:default/docs_int64", field: "rowCount", before: { value: 2000 }, after: { value: 2001 } },
    ]);
  });

  test("a changed volatile field is recorded and is no difference", () => {
    const changed = collection("docs_int64", { ...DOCS.fields, memory: { value: 512 } });
    const comparison = compareSnapshots(record([DOCS]), record([changed]), CLASSES);
    expect(comparison.differences).toEqual([]);
    expect(comparison.volatile).toEqual([
      { collection: "milvus:default/docs_int64", field: "memory", before: { value: 271 }, after: { value: 512 } },
    ]);
  });

  test("a collection under the harness prefix is skipped, whatever happens to it", () => {
    const own = collection("libredb_live_copy", { rowCount: { value: 1 } });
    const ownLater = collection("libredb_live_copy", { rowCount: { value: 50000 } });
    expect(compareSnapshots(record([DOCS, own]), record([DOCS, ownLater]), CLASSES).differences).toEqual([]);
    expect(compareSnapshots(record([DOCS]), record([DOCS, own]), CLASSES).differences).toEqual([]);
  });

  test("a collection that disappears or appears outside the prefix is a difference", () => {
    expect(compareSnapshots(record([DOCS]), record([]), CLASSES).differences).toEqual([
      { collection: "milvus:default/docs_int64", field: null, before: { value: "present" }, after: "absent" },
    ]);
    expect(compareSnapshots(record([]), record([DOCS]), CLASSES).differences).toEqual([
      { collection: "milvus:default/docs_int64", field: null, before: "absent", after: { value: "present" } },
    ]);
  });

  test("a scratch collection is compared on schema, configuration, aliases and load state only", () => {
    expect([...SCRATCH_FIELDS]).toEqual(["schema", "configuration", "aliases", "loadState"]);
    const moreRows = collection("scratch", { ...SCRATCH.fields, rowCount: { value: 40 } });
    const rows = compareSnapshots(record([SCRATCH]), record([moreRows]), CLASSES);
    expect(rows.differences).toEqual([]);
    expect(rows.volatile).toContainEqual({
      collection: "milvus:default/scratch",
      field: "rowCount",
      before: { value: 0 },
      after: { value: 40 },
    });
    const newField = collection("scratch", {
      ...SCRATCH.fields,
      schema: { value: { fields: ["id", "vec", "note", "x"] } },
    });
    expect(compareSnapshots(record([SCRATCH]), record([newField]), CLASSES).differences).toHaveLength(1);
  });

  test("a scratch collection is compared on its four fields even when the caller classifies one volatile", () => {
    const loadVolatile = {
      stable: ["schema", "configuration", "aliases", "rowCount"],
      volatile: ["loadState", "memory"],
    };
    const loaded = collection("scratch", { ...SCRATCH.fields, loadState: { value: "Loaded" } });
    const released = collection("scratch", { ...SCRATCH.fields, loadState: { value: "NotLoad" } });
    expect(compareSnapshots(record([loaded]), record([released]), loadVolatile).differences).toEqual([
      {
        collection: "milvus:default/scratch",
        field: "loadState",
        before: { value: "Loaded" },
        after: { value: "NotLoad" },
      },
    ]);
  });

  test("scratch names one collection by engine, database and name, not every collection called scratch", () => {
    const elsewhere: CollectionSnapshot = { ...SCRATCH, database: "probe_db" };
    const written: CollectionSnapshot = { ...elsewhere, fields: { ...SCRATCH.fields, rowCount: { value: 1 } } };
    expect(compareSnapshots(record([elsewhere]), record([written]), CLASSES).differences).toEqual([
      { collection: "milvus:probe_db/scratch", field: "rowCount", before: { value: 0 }, after: { value: 1 } },
    ]);
    const qdrant: CollectionSnapshot = { ...SCRATCH, engine: "qdrant", database: null };
    const qdrantWritten: CollectionSnapshot = { ...qdrant, fields: { ...SCRATCH.fields, rowCount: { value: 1 } } };
    expect(compareSnapshots(record([qdrant]), record([qdrantWritten]), CLASSES).differences).toHaveLength(1);
  });

  test("a record that holds the same collection twice cannot be compared", () => {
    const again = collection("docs_int64", { ...DOCS.fields, rowCount: { value: 1 } });
    expect(() => compareSnapshots(record([DOCS, again]), record([DOCS]), CLASSES)).toThrow(
      "the record taken before the run holds milvus:default/docs_int64 twice",
    );
    expect(() => compareSnapshots(record([DOCS]), record([again, DOCS]), CLASSES)).toThrow(
      "the record taken after the run holds milvus:default/docs_int64 twice",
    );
  });

  test("a non-finite number is not equal to null", () => {
    const infinite = collection("docs_int64", { ...DOCS.fields, rowCount: { value: Number.POSITIVE_INFINITY } });
    const empty = collection("docs_int64", { ...DOCS.fields, rowCount: { value: null } });
    expect(compareSnapshots(record([infinite]), record([empty]), CLASSES).differences).toHaveLength(1);
    expect(compareSnapshots(record([infinite]), record([infinite]), CLASSES).differences).toEqual([]);
  });

  test("an unavailable reading equals only the same reason, and becoming readable is a difference", () => {
    const notLoaded = collection("unloaded_big", { rowCount: { unavailable: "not-loaded" } });
    expect(compareSnapshots(record([notLoaded]), record([notLoaded]), CLASSES).differences).toEqual([]);
    const loaded = collection("unloaded_big", { rowCount: { value: 50000 } });
    expect(compareSnapshots(record([notLoaded]), record([loaded]), CLASSES).differences).toEqual([
      {
        collection: "milvus:default/unloaded_big",
        field: "rowCount",
        before: { unavailable: "not-loaded" },
        after: { value: 50000 },
      },
    ]);
  });

  test("a field present on one side only is a difference", () => {
    const fewer = collection("docs_int64", { schema: DOCS.fields.schema, memory: DOCS.fields.memory });
    expect(compareSnapshots(record([DOCS]), record([fewer]), CLASSES).differences).toEqual([
      { collection: "milvus:default/docs_int64", field: "rowCount", before: { value: 2000 }, after: "absent" },
    ]);
  });

  test("key order inside a value does not matter", () => {
    const reordered = collection("docs_int64", {
      ...DOCS.fields,
      schema: { value: { dynamic: true, fields: ["id", "vec"] } },
    });
    expect(compareSnapshots(record([DOCS]), record([reordered]), CLASSES).differences).toEqual([]);
  });

  test("a field classified neither stable nor volatile fails loudly", () => {
    const extra = collection("docs_int64", { ...DOCS.fields, indexState: { value: "Finished" } });
    expect(() => compareSnapshots(record([extra]), record([extra]), CLASSES)).toThrow(
      "milvus:default/docs_int64 holds the field indexState, which is classified neither stable nor volatile",
    );
  });

  test("a field classified both stable and volatile fails loudly", () => {
    expect(() =>
      compareSnapshots(record([DOCS]), record([DOCS]), { stable: ["rowCount"], volatile: ["rowCount"] }),
    ).toThrow("classified both stable and volatile: rowCount");
  });

  test("two records with different prefixes or scratch sets cannot be compared", () => {
    expect(() => compareSnapshots(record([]), { ...record([]), prefix: "other_" }, CLASSES)).toThrow(
      "the two records use different prefixes: libredb_live_ and other_",
    );
    expect(() => compareSnapshots(record([]), { ...record([]), scratch: [] }, CLASSES)).toThrow(
      "the two records name different scratch collections",
    );
  });
});

describe("assertUnchanged", () => {
  test("passes a comparison with no difference, however many volatile readings it records", () => {
    const reading: VolatileReading = {
      collection: "milvus:default/docs_int64",
      field: "memory",
      before: { value: 271 },
      after: { value: 512 },
    };
    const comparison: SnapshotComparison = { differences: [], volatile: [reading] };
    expect(() => assertUnchanged(comparison)).not.toThrow();
  });

  test("a whole collection that appeared is listed as the collection", () => {
    const difference: SnapshotDifference = {
      collection: "qdrant:/docs",
      field: null,
      before: "absent",
      after: { value: "present" },
    };
    expect(() => assertUnchanged({ differences: [difference], volatile: [] })).toThrow(
      'qdrant:/docs (the collection): "absent" -> {"value":"present"}',
    );
  });

  test("throws, listing every difference", () => {
    const changed = collection("docs_int64", { ...DOCS.fields, rowCount: { value: 2001 } });
    expect(() => assertUnchanged(compareSnapshots(record([DOCS, SCRATCH]), record([changed]), CLASSES))).toThrow(
      'The live run changed what it does not own:\nmilvus:default/docs_int64 rowCount: {"value":2000} -> {"value":2001}\nmilvus:default/scratch (the collection): {"value":"present"} -> "absent"',
    );
  });
});
