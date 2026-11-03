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

/**
 * `docs/DATABASE_PROVIDERS.md` carries one table under `## Write reach`, one row per shipped type-id,
 * `| <engine> | \`<type-id>\` | <value> | <paths> |`, and the row agrees with `WRITE_REACH` as each provider doc's row
 * does: the same value, and every gate and proof symbol the provider declares named where the reach is not open.
 */
const PROVIDERS_DOC = join(import.meta.dir, "..", "..", "..", "docs", "DATABASE_PROVIDERS.md");
const TABLE_ROW = /^\| [^|]+ \| `([a-z0-9]+)` \| (none|guarded|open) \| (.+) \|$/;

function writeReachSection(): string[] {
  const lines = readFileSync(PROVIDERS_DOC, "utf8").split("\n");
  const start = lines.indexOf("## Write reach");
  expect(start).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

function tableRows(): RegExpExecArray[] {
  return writeReachSection()
    .map((line) => TABLE_ROW.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
}

describe("the Write reach table in docs/DATABASE_PROVIDERS.md", () => {
  test("follows the Supported Databases section", () => {
    const headings = readFileSync(PROVIDERS_DOC, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("## "));
    expect(headings.indexOf("## Write reach")).toBe(headings.indexOf("## Supported Databases") + 1);
  });

  test("has one row per shipped type-id, and no other", () => {
    const ids = tableRows().map((row) => row[1]);
    expect(ids.toSorted()).toEqual([...SHIPPED_DATABASE_TYPES].toSorted());
  });

  test.each([...SHIPPED_DATABASE_TYPES])("%s: its value is the record's", (type) => {
    const row = tableRows().find((match) => match[1] === type);
    expect(row?.[2]).toBe(WRITE_REACH[type]);
  });

  test.each(SHIPPED_DATABASE_TYPES.filter((type) => WRITE_REACH[type] !== "open"))(
    "%s: names every gate and proof its provider declares",
    async (type) => {
      const declared = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities().writeReach;
      const paths = tableRows().find((match) => match[1] === type)?.[3] ?? "";
      for (const path of WRITE_PATHS) {
        const reach = declared?.[path];
        const named = reach?.reach === "gated" ? reach.gate : reach?.reach === "absent" ? reach.proof : undefined;
        if (named !== undefined) expect(paths).toContain(`\`${named.symbol}\``);
      }
    },
  );
});
