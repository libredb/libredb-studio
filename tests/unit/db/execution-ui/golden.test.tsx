import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GOLDEN_KEYS, renderExecutionUiGolden } from "./fixtures";

/**
 * Each engine's commit keyword, consent deadline sentence and explain engine hint held to `golden/<key>.txt`, written
 * from the code as it stood before the engine-contract move. `UPDATE_GOLDEN=1` writes the files instead and fails, so
 * a rewrite is never a silent pass.
 */
const GOLDEN_DIR = join(import.meta.dir, "golden");

describe("execution UI golden output", () => {
  for (const key of GOLDEN_KEYS) {
    test(key, async () => {
      const rendered = await renderExecutionUiGolden(key);
      const file = join(GOLDEN_DIR, `${key}.txt`);
      if (process.env.UPDATE_GOLDEN === "1") {
        writeFileSync(file, rendered);
        throw new Error("golden files written, commit them");
      }
      expect(rendered).toBe(readFileSync(file, "utf8"));
    });
  }
});
