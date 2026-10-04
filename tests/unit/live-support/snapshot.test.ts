/**
 * The vector live harnesses' snapshot record (tests/live/support/snapshot.ts; vector-family spec 4.2):
 * the closed set of unavailable reasons, the read that records one and fails loudly on anything else, and the
 * parser that refuses a record the schema does not allow.
 */
import { describe, expect, test } from "bun:test";
import {
  collectionKey,
  isUnavailableReason,
  parseSnapshotRecord,
  readField,
  type SnapshotEngine,
  type SnapshotJson,
  SnapshotReadError,
  UNAVAILABLE_REASONS,
  type UnavailableReason,
  unavailable,
} from "../../live/support/snapshot";

const RECORD = {
  harness: "milvus-live-check",
  takenAt: "2026-10-03T12:00:00.000Z",
  prefix: "libredb_live_",
  scratch: ["milvus:default/scratch"],
  collections: [
    {
      engine: "milvus",
      database: "default",
      name: "docs_int64",
      fields: { schema: { value: { fields: ["id", "vec"] } }, rowCount: { value: 2000 } },
    },
    {
      engine: "milvus",
      database: "default",
      name: "unloaded_big",
      fields: { rowCount: { unavailable: "not-loaded" } },
    },
    {
      engine: "qdrant",
      database: null,
      name: "docs",
      fields: { exactCount: { unavailable: "strict-mode-exact-disabled" } },
    },
  ],
};

/** RECORD with one change, as JSON text. */
function variant(change: (record: Record<string, unknown>) => void): string {
  const copy = structuredClone(RECORD) as unknown as Record<string, unknown>;
  change(copy);
  return JSON.stringify(copy);
}

function firstCollection(record: Record<string, unknown>): Record<string, unknown> {
  return (record.collections as Record<string, unknown>[])[0];
}

describe("the unavailable record", () => {
  test("the reason set is closed and holds exactly the two reasons the spec names", () => {
    expect([...UNAVAILABLE_REASONS]).toEqual(["not-loaded", "strict-mode-exact-disabled"]);
  });

  test("isUnavailableReason accepts each closed reason and nothing else", () => {
    const accepted: readonly UnavailableReason[] = UNAVAILABLE_REASONS.filter(isUnavailableReason);
    expect(accepted).toEqual([...UNAVAILABLE_REASONS]);
    for (const other of ["loaded", "Not-Loaded", "", 3, null, undefined, { unavailable: "not-loaded" }]) {
      expect(isUnavailableReason(other)).toBe(false);
    }
  });

  test("each closed reason builds its record", () => {
    expect(unavailable("not-loaded")).toEqual({ unavailable: "not-loaded" });
    expect(unavailable("strict-mode-exact-disabled")).toEqual({ unavailable: "strict-mode-exact-disabled" });
  });

  test("any other reason throws, naming the closed set", () => {
    expect(() => unavailable("timeout")).toThrow(
      '"timeout" is not one of the closed unavailable reasons: not-loaded, strict-mode-exact-disabled',
    );
  });
});

describe("readField", () => {
  test("a read that answers is recorded as its value", async () => {
    expect(
      await readField(
        "milvus:default/docs_int64",
        "rowCount",
        async () => 2000,
        () => null,
      ),
    ).toEqual({
      value: 2000,
    });
  });

  test("a read that fails with a closed reason is recorded as unavailable", async () => {
    const reading = await readField(
      "milvus:default/unloaded_big",
      "rowCount",
      async () => {
        throw new Error("collection not loaded");
      },
      () => "not-loaded",
    );
    expect(reading).toEqual({ unavailable: "not-loaded" });
  });

  test("any other read error fails loudly, naming the collection and the field, with the cause kept", async () => {
    const cause = new Error("connection refused");
    const error = await readField(
      "qdrant:/docs",
      "pointsCount",
      async () => {
        throw cause;
      },
      () => null,
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SnapshotReadError);
    expect((error as SnapshotReadError).message).toBe("Could not read pointsCount of qdrant:/docs: connection refused");
    expect((error as SnapshotReadError).cause).toBe(cause);
    expect((error as SnapshotReadError).collection).toBe("qdrant:/docs");
    expect((error as SnapshotReadError).field).toBe("pointsCount");
  });

  test("a classifier that answers a reason outside the closed set fails loudly too", async () => {
    const failed = readField(
      "qdrant:/docs",
      "exactCount",
      async () => {
        throw new Error("rate limited");
      },
      () => "rate-limited" as never,
    );
    await expect(failed).rejects.toThrow('"rate-limited" is not one of the closed unavailable reasons');
  });
});

describe("collectionKey", () => {
  test("names the engine, the database and the collection, with no database on Qdrant", () => {
    expect(collectionKey({ engine: "milvus", database: "default", name: "docs_int64" })).toBe(
      "milvus:default/docs_int64",
    );
    expect(collectionKey({ engine: "qdrant", database: null, name: "docs" })).toBe("qdrant:/docs");
  });
});

describe("parseSnapshotRecord", () => {
  test("a value of any JSON shape is kept, and every collection names one of the two engines", () => {
    const value: SnapshotJson = { fields: ["id", 1, 2.5, true, null], nested: { empty: [] } };
    const parsed = parseSnapshotRecord(
      variant((r) => {
        firstCollection(r).fields = { schema: { value } };
      }),
    );
    expect(parsed.collections[0].fields.schema).toEqual({ value });
    const engines: readonly SnapshotEngine[] = parsed.collections.map((collection) => collection.engine);
    expect(engines).toEqual(["milvus", "milvus", "qdrant"]);
  });

  test("a valid record parses to the same record", () => {
    expect(parseSnapshotRecord(JSON.stringify(RECORD))).toEqual(RECORD as never);
  });

  test("an empty prefix is refused, because every collection would then be the harness's own", () => {
    expect(() =>
      parseSnapshotRecord(
        variant((r) => {
          r.prefix = "";
        }),
      ),
    ).toThrow("prefix must not be empty");
  });

  test("a missing field of the record is refused by name", () => {
    expect(() =>
      parseSnapshotRecord(
        variant((r) => {
          delete r.takenAt;
        }),
      ),
    ).toThrow("takenAt must be a string");
    expect(() =>
      parseSnapshotRecord(
        variant((r) => {
          r.scratch = ["scratch", 3];
        }),
      ),
    ).toThrow("scratch[1] must be a string");
  });

  test("an engine outside the family is refused", () => {
    expect(() =>
      parseSnapshotRecord(
        variant((r) => {
          firstCollection(r).engine = "pinecone";
        }),
      ),
    ).toThrow('collections[0].engine must be "milvus" or "qdrant"');
  });

  test("a field reading must be exactly { value } or { unavailable }", () => {
    expect(() =>
      parseSnapshotRecord(
        variant((r) => {
          firstCollection(r).fields = { rowCount: { value: 1, unavailable: "not-loaded" } };
        }),
      ),
    ).toThrow("collections[0].fields.rowCount must be exactly { value } or { unavailable }");
    expect(() =>
      parseSnapshotRecord(
        variant((r) => {
          firstCollection(r).fields = { rowCount: {} };
        }),
      ),
    ).toThrow("collections[0].fields.rowCount must be exactly { value } or { unavailable }");
  });

  test("an unavailable reason outside the closed set is refused", () => {
    expect(() =>
      parseSnapshotRecord(
        variant((r) => {
          firstCollection(r).fields = { rowCount: { unavailable: "timeout" } };
        }),
      ),
    ).toThrow('collections[0].fields.rowCount.unavailable: "timeout" is not one of the closed unavailable reasons');
  });

  test("a Qdrant collection names no database and a Milvus collection names one", () => {
    expect(() =>
      parseSnapshotRecord(
        variant((r) => {
          (r.collections as Record<string, unknown>[])[2].database = "x";
        }),
      ),
    ).toThrow("collections[2].database must be null on Qdrant, which has no databases");
    expect(() =>
      parseSnapshotRecord(
        variant((r) => {
          firstCollection(r).database = null;
        }),
      ),
    ).toThrow("collections[0].database must be a string");
  });

  test("the same collection twice is refused", () => {
    expect(() =>
      parseSnapshotRecord(
        variant((r) => {
          r.collections = [firstCollection(r), structuredClone(firstCollection(r))];
        }),
      ),
    ).toThrow("collections[1] repeats milvus:default/docs_int64");
  });
});
