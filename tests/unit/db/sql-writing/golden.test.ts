import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { GOLDEN_KEYS, goldenFileName, renderGolden } from "./fixtures";

/**
 * Today's literal, identifier and placeholder output per engine, pinned before the SQL
 * writing contract moves it into per-engine modules.
 *
 * `UPDATE_GOLDEN=1` rewrites the files from the current tree and fails, so a rewrite is
 * never a silent pass: the diff is what a reviewer reads.
 */
const GOLDEN_DIR = path.join(import.meta.dir, "golden");

const keyOf = (key: string): string | undefined =>
  key === "no-connection" ? undefined : key === "empty-string" ? "" : key;

describe("SQL writing golden output", () => {
  test("one golden file per key and no stray file", () => {
    const files = fs
      .readdirSync(GOLDEN_DIR)
      .filter((name) => name.endsWith(".txt"))
      .sort();
    expect(files).toEqual(GOLDEN_KEYS.map(goldenFileName).sort());
  });

  for (const key of GOLDEN_KEYS) {
    test(key, async () => {
      const file = path.join(GOLDEN_DIR, goldenFileName(key));
      const rendered = await renderGolden(keyOf(key));
      if (process.env.UPDATE_GOLDEN === "1") {
        fs.writeFileSync(file, rendered);
        throw new Error("golden files written, commit them");
      }
      expect(rendered).toBe(fs.readFileSync(file, "utf8"));
    });
  }
});
