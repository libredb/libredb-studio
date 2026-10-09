import { describe, test, expect } from "bun:test";
import { keyScanShape, type KeyScanCapability, type KeyScanShape } from "@/lib/db/types";
import type { KeyScanOptions, KeyScanPage } from "@/lib/db/types";

/**
 * `keyScanShape`, the one reader of `KeyScanCapability`'s four optional fields (spec 3.4).
 *
 * AN ABSENT FIELD IS TODAY'S WALK. That is the compatibility rule the published interface owes an
 * implementer who declared `keyScan` before the fields existed, and it is why Redis's declaration is
 * not edited: `tests/integration/db/redis-provider.test.ts` pins that it is exactly the two batch
 * sizes, and this file pins what those two sizes read as.
 */
describe("keyScanShape()", () => {
  test("reads a declaration with none of the four fields as today's walk", () => {
    const today: KeyScanShape = { separator: ":", cursor: "decimal", pattern: "glob", totalScope: "database" };

    expect(keyScanShape({ defaultCount: 500, maxCount: 1000 })).toEqual(today);
    // Spelling today's values out is the same declaration, so a provider may write them or not.
    expect(
      keyScanShape({
        defaultCount: 500,
        maxCount: 1000,
        separator: ":",
        cursor: "decimal",
        pattern: "glob",
        totalScope: "database",
      }),
    ).toEqual(today);
  });

  test("reads every field etcd declares", () => {
    const etcd: KeyScanCapability = {
      defaultCount: 500,
      maxCount: 1000,
      separator: "/",
      cursor: "opaque",
      pattern: "prefix",
      totalScope: "walk",
    };

    expect(keyScanShape(etcd)).toEqual({ separator: "/", cursor: "opaque", pattern: "prefix", totalScope: "walk" });
  });

  test('reads "none", the scope of an engine that publishes no count', () => {
    const uncounted: KeyScanCapability = {
      defaultCount: 500,
      maxCount: 1000,
      separator: "/",
      cursor: "opaque",
      pattern: "prefix",
      totalScope: "none",
    };
    const shape: KeyScanShape = keyScanShape(uncounted);

    expect(shape).toEqual({ separator: "/", cursor: "opaque", pattern: "prefix", totalScope: "none" });
    // On its own it moves nothing else, as each other field does.
    expect(keyScanShape({ defaultCount: 1, maxCount: 1, totalScope: "none" })).toEqual({
      separator: ":",
      cursor: "decimal",
      pattern: "glob",
      totalScope: "none",
    });
  });

  test("reads each field on its own, so one declared field moves nothing else", () => {
    const base = { defaultCount: 1, maxCount: 1 };

    expect(keyScanShape({ ...base, separator: "/" })).toEqual({
      separator: "/",
      cursor: "decimal",
      pattern: "glob",
      totalScope: "database",
    });
    expect(keyScanShape({ ...base, cursor: "opaque" })).toEqual({
      separator: ":",
      cursor: "opaque",
      pattern: "glob",
      totalScope: "database",
    });
    expect(keyScanShape({ ...base, pattern: "prefix" })).toEqual({
      separator: ":",
      cursor: "decimal",
      pattern: "prefix",
      totalScope: "database",
    });
    expect(keyScanShape({ ...base, totalScope: "walk" })).toEqual({
      separator: ":",
      cursor: "decimal",
      pattern: "glob",
      totalScope: "walk",
    });
  });

  test("answers the shape and nothing else: the batch sizes stay on the declaration", () => {
    expect(Object.keys(keyScanShape({ defaultCount: 500, maxCount: 1000 })).sort()).toEqual([
      "cursor",
      "pattern",
      "separator",
      "totalScope",
    ]);
  });
});

/**
 * The level declaration (Keys panel levels, spec 3.1): an optional field on the capability that the
 * shape does not read, so the four `toEqual` pins on the shape stay byte-identical.
 */
describe("keyScanShape() and the level declaration", () => {
  test("answers the same four fields for a declaration with levels as without it", () => {
    const withoutLevels: KeyScanCapability = {
      defaultCount: 500,
      maxCount: 1000,
      separator: "/",
      cursor: "opaque",
      pattern: "prefix",
      totalScope: "none",
    };
    const withLevels: KeyScanCapability = { ...withoutLevels, levels: { rootKind: "bucket" } };

    expect(keyScanShape(withLevels)).toStrictEqual(keyScanShape(withoutLevels));
    expect(Object.keys(keyScanShape(withLevels)).sort()).toEqual(["cursor", "pattern", "separator", "totalScope"]);
  });

  test("types the level option and the folder prefixes as optional additions, and levels alone moves no default", () => {
    const options = { cursor: "0", count: 1, level: true } satisfies KeyScanOptions;
    const page = { keys: [], cursor: "0", total: 0, types: {}, prefixes: ["a/"] } satisfies KeyScanPage;

    expect(options.level).toBe(true);
    expect(page.prefixes).toEqual(["a/"]);
    // A declaration with levels and none of the four fields still reads as today's walk.
    expect(keyScanShape({ defaultCount: 1, maxCount: 1, levels: {} })).toStrictEqual({
      separator: ":",
      cursor: "decimal",
      pattern: "glob",
      totalScope: "database",
    });
  });
});
