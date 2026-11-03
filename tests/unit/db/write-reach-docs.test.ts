import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHIPPED_DATABASE_TYPES, WRITE_REACH } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { WRITE_PATHS } from "@/lib/db/write-reach";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * Every provider doc states its engine's write reach in one header row, `| **Write reach** | <value>: <sentence> |`,
 * and the row agrees with `WRITE_REACH`: the same value, and, where the reach is not open, every gate and proof
 * symbol the provider declares named in it, so a renamed gate or a changed value fails here instead of leaving the
 * doc behind.
 */
const DOCS = join(import.meta.dir, "..", "..", "..", "docs", "providers");
const ROW = /^\| \*\*Write reach\*\* \| (none|guarded|open): (.+) \|$/;

function writeReachRows(type: string): RegExpExecArray[] {
  const text = readFileSync(join(DOCS, `${type}.md`), "utf8");
  return text
    .split("\n")
    .filter((line) => line.startsWith("| **Write reach**"))
    .map((line) => ROW.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
}

describe("each provider doc's Write reach row", () => {
  test.each([...SHIPPED_DATABASE_TYPES])("%s: one row, its value the record's", (type) => {
    const rows = writeReachRows(type);
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toBe(WRITE_REACH[type]);
  });

  test.each(SHIPPED_DATABASE_TYPES.filter((type) => WRITE_REACH[type] !== "open"))(
    "%s: names every gate and proof its provider declares",
    async (type) => {
      const declared = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities().writeReach;
      const sentence = writeReachRows(type)[0][2];
      for (const path of WRITE_PATHS) {
        const reach = declared?.[path];
        const named = reach?.reach === "gated" ? reach.gate : reach?.reach === "absent" ? reach.proof : undefined;
        if (named !== undefined) expect(sentence).toContain(`\`${named.symbol}\``);
      }
    },
  );

  test("the docs no longer carry a separate Writes row beside it", () => {
    for (const type of SHIPPED_DATABASE_TYPES) {
      const text = readFileSync(join(DOCS, `${type}.md`), "utf8");
      expect({ type, writes: text.split("\n").some((line) => /^\| \*\*Writes\*\* /.test(line)) }).toEqual({
        type,
        writes: false,
      });
    }
  });
});
