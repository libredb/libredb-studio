import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FORM_KEYS, renderFormGolden } from "./fixtures";

/**
 * Each engine's connection form, built connection and seed foreign-field checks held to `golden/<type-id>.txt`,
 * written from the code as it stood before the engine-contract move. `UPDATE_GOLDEN=1` writes the files instead and
 * fails, so a rewrite is never a silent pass.
 */
const GOLDEN_DIR = join(import.meta.dir, "golden");

describe("connection form golden output", () => {
  for (const type of FORM_KEYS) {
    test(type, async () => {
      const rendered = await renderFormGolden(type);
      const file = join(GOLDEN_DIR, `${type}.txt`);
      if (process.env.UPDATE_GOLDEN === "1") {
        writeFileSync(file, rendered);
        throw new Error("golden files written, commit them");
      }
      expect(rendered).toBe(readFileSync(file, "utf8"));
    });
  }
});
