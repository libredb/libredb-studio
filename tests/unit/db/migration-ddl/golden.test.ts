/**
 * Golden files of the migration text per key, clock frozen (see fixtures.ts).
 *
 * `UPDATE_GOLDEN=1` writes the files instead of comparing, and fails so a regenerated
 * set is never mistaken for a passing run.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { GOLDEN_KEYS, renderGolden } from "./fixtures";

const GOLDEN_DIR = join(import.meta.dir, "golden");
/** Every type id: the external engines plus the embedded LibreDB store. */
const ENGINE_COUNT = EXTERNAL_DATABASE_TYPES.length + 1;

describe("migration DDL golden files", () => {
  test("the keys are every engine id, then the three non-engine keys", () => {
    expect(GOLDEN_KEYS.length).toBe(ENGINE_COUNT + 3);
    expect([...GOLDEN_KEYS.slice(0, ENGINE_COUNT)].sort()).toEqual([...EXTERNAL_DATABASE_TYPES, "libredb"].sort());
    expect(GOLDEN_KEYS.slice(ENGINE_COUNT)).toEqual(["no-connection", "constructor", "not-an-engine"]);
  });

  for (const key of GOLDEN_KEYS) {
    test(key, () => {
      const file = join(GOLDEN_DIR, `${key}.txt`);
      const actual = renderGolden(key);
      if (process.env.UPDATE_GOLDEN === "1") {
        writeFileSync(file, actual);
        throw new Error("golden files written, commit them");
      }
      expect(actual).toBe(readFileSync(file, "utf8"));
    });
  }
});
