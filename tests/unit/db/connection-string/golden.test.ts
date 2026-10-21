import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GOLDEN_KEYS, renderConnectionStringGolden } from "./fixtures";

/**
 * Each key's scheme, parses and seed checks held to `golden/<key>.txt`, written from the code as it stood before the
 * engine-contract move. `UPDATE_GOLDEN=1` writes the files instead and fails, so a rewrite is never a silent pass.
 */
const GOLDEN_DIR = join(import.meta.dir, "golden");

describe("connection string and seed check golden output", () => {
  for (const key of GOLDEN_KEYS) {
    test(key, () => {
      const rendered = renderConnectionStringGolden(key);
      const file = join(GOLDEN_DIR, `${key}.txt`);
      if (process.env.UPDATE_GOLDEN === "1") {
        writeFileSync(file, rendered);
        throw new Error("golden files written, commit them");
      }
      expect(rendered).toBe(readFileSync(file, "utf8"));
    });
  }
});
