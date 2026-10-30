import { describe, expect, test } from "bun:test";
import {
  declareMetadataOnly,
  MetadataProjectionError,
  type MetadataProjection,
  projectMetadata,
} from "@/lib/db/redaction/metadata-only";

interface Shard {
  readonly name?: unknown;
  readonly objectCount?: unknown;
  readonly loaded?: unknown;
}

const SHARDS: MetadataProjection<Shard> = Object.freeze([
  { column: "shard", kind: "name", read: (shard: Shard) => shard.name },
  { column: "objects", kind: "count", read: (shard: Shard) => shard.objectCount },
  { column: "loaded", kind: "flag", read: (shard: Shard) => shard.loaded, optional: true },
]);

describe("projectMetadata", () => {
  test("keeps exactly the declared columns, in order, whatever else a source holds", () => {
    const projected = projectMetadata(SHARDS, [
      { name: "s1", objectCount: 3, loaded: true, secret: "stored-value" } as Shard,
      { name: "s2", objectCount: 0 },
    ]);
    expect(projected).toEqual({
      fields: ["shard", "objects", "loaded"],
      rows: [
        { shard: "s1", objects: 3, loaded: true },
        { shard: "s2", objects: 0, loaded: null },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain("stored-value");
  });

  test("column names come from the declaration, never from a source's keys", () => {
    const projected = projectMetadata(SHARDS, [{ name: "s1", objectCount: 1, "stored-key": 1 } as Shard]);
    expect(projected.fields).toEqual(["shard", "objects", "loaded"]);
    expect(Object.keys(projected.rows[0])).toEqual(["shard", "objects", "loaded"]);
  });

  test("an empty source list answers the columns and no row", () => {
    expect(projectMetadata(SHARDS, [])).toEqual({ fields: ["shard", "objects", "loaded"], rows: [] });
  });

  const refusals: readonly [string, Shard, string][] = [
    ["a name that is an object", { name: { nested: "stored-value" }, objectCount: 1 }, "shard"],
    ["a name that is a list", { name: ["stored-value"], objectCount: 1 }, "shard"],
    ["a name that is a number", { name: 7, objectCount: 1 }, "shard"],
    ["an empty name", { name: "", objectCount: 1 }, "shard"],
    ["a name with a line break", { name: "a\nstored-value", objectCount: 1 }, "shard"],
    ["a name with a control character", { name: "a\u0000b", objectCount: 1 }, "shard"],
    ["a name with a unit separator", { name: "a\u001fb", objectCount: 1 }, "shard"],
    ["a name with DEL", { name: "a\u007fb", objectCount: 1 }, "shard"],
    ["a name with a C1 next line", { name: "a\u0085b", objectCount: 1 }, "shard"],
    ["a name with the last C1 control", { name: "a\u009fb", objectCount: 1 }, "shard"],
    ["a name with a line separator", { name: "a\u2028stored-value", objectCount: 1 }, "shard"],
    ["a name with a paragraph separator", { name: "a\u2029stored-value", objectCount: 1 }, "shard"],
    ["a name past 512 characters", { name: "n".repeat(513), objectCount: 1 }, "shard"],
    ["a count that is text", { name: "s", objectCount: "stored-value" }, "objects"],
    ["a negative count", { name: "s", objectCount: -1 }, "objects"],
    ["a fractional count", { name: "s", objectCount: 1.5 }, "objects"],
    ["a count past the safe integers", { name: "s", objectCount: 2 ** 53 }, "objects"],
    ["a flag that is text", { name: "s", objectCount: 1, loaded: "true" }, "loaded"],
    ["a required column absent", { objectCount: 1 }, "shard"],
    ["a required column null", { name: null, objectCount: 1 }, "shard"],
  ];
  for (const [what, source, column] of refusals) {
    test(`refuses the whole answer for ${what}, naming the column and never the value`, () => {
      let thrown: unknown;
      try {
        projectMetadata(SHARDS, [{ name: "ok", objectCount: 1 }, source]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MetadataProjectionError);
      const message = (thrown as Error).message;
      expect(message).toContain(`"${column}"`);
      expect(message).not.toContain("stored-value");
      expect((thrown as MetadataProjectionError).column).toBe(column);
    });
  }

  test("the printable neighbours of every refused range are kept", () => {
    const name = "a b~\u00a0\u2027\u202a";
    expect(projectMetadata(SHARDS, [{ name, objectCount: 1 }]).rows).toEqual([
      { shard: name, objects: 1, loaded: null },
    ]);
  });

  test("a name at exactly 512 printable characters is kept", () => {
    const name = "n".repeat(512);
    expect(projectMetadata(SHARDS, [{ name, objectCount: 1 }]).rows[0].shard).toBe(name);
  });

  test("a non-ASCII name is kept: names are not limited to ASCII", () => {
    expect(projectMetadata(SHARDS, [{ name: "Größe", objectCount: 1 }]).rows[0].shard).toBe("Größe");
  });

  test("refuses a projection that declares one column twice", () => {
    const twice: MetadataProjection<Shard> = [
      { column: "shard", kind: "name", read: (shard) => shard.name },
      { column: "shard", kind: "count", read: (shard) => shard.objectCount },
    ];
    expect(() => projectMetadata(twice, [])).toThrow('declares the column "shard" twice');
  });
});

describe("declareMetadataOnly", () => {
  test("states each operation's columns and kinds, field by field, without the readers", () => {
    const declared = declareMetadataOnly({ shards: SHARDS });
    expect(declared).toEqual({
      shards: [
        { column: "shard", kind: "name" },
        { column: "objects", kind: "count" },
        { column: "loaded", kind: "flag" },
      ],
    });
    expect(Object.isFrozen(declared)).toBe(true);
    expect(Object.isFrozen(declared.shards)).toBe(true);
  });
});
