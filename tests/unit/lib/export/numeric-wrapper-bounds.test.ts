/**
 * The export's numeric wrapper is taken off a declared type only while its capture is a strictly shorter type, in a
 * bounded Node child (src/lib/export/result-export.ts, `unwrappedNumericType`; docs/providers/CONTRACT.md, clause S-15).
 *
 * The schema admits any one-group pattern as an engine's `numericWrapper`, so the CSV writer cannot strip it while it
 * merely matches: a capture as long as the type, `^(.*)$`, matches its own capture forever, and a group that can be
 * absent answers no type at all. Each child plants such a wrapper on clickhouse, as a declaration states it: through a
 * stub of ClickHouse's SQL writing row, the shipped row with its numeric wrapper replaced. Without the bound the first
 * case turns the loop until the spawn timeout kills the child within seconds, and the second throws a TypeError on the
 * absent capture, so each case fails by its exit. The child holds a referenced interval, so it cannot exit early
 * (tests/helpers/bounded-node-child.ts).
 *
 * Each case answers the CSV text of one `Float64` column holding the word `-Infinity`: a numeric column lets the word
 * through the formula guard, so the expected text is the one the same column gets with a wrapper that matches nothing.
 * tests/unit/lib/export/result-export.test.ts and the SQL writing golden files hold every shipped wrapper's answers, in
 * the test process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { buildResultExport } from "@/lib/export/result-export";
import { type BoundedChild, boundedChild } from "../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly buildResultExport: typeof buildResultExport;
}

const SOURCE = path.join(import.meta.dir, "..", "..", "..", "..", "src");

/** What a `Float64` column holding `-Infinity` exports as when no wrapper matches its type. */
const NUMERIC_COLUMN_CSV = "x\n-Infinity";

/** A stub of ClickHouse's SQL writing row: the shipped row with `source` as its numeric wrapper, no flags. */
function plantedClickhouse(source: string): string {
  const shipped = path.join(SOURCE, "lib", "db", "providers", "sql", "clickhouse", "sql-writing.ts");
  return [
    `import { CLICKHOUSE_SQL_WRITING as SHIPPED } from ${JSON.stringify(shipped)};`,
    "export const CLICKHOUSE_SQL_WRITING = {",
    "  ...SHIPPED,",
    "  export: {",
    "    ...SHIPPED.export,",
    `    typeVocabulary: { ...SHIPPED.export.typeVocabulary, numericWrapper: new RegExp(${JSON.stringify(source)}) },`,
    "  },",
    "};",
    "",
  ].join("\n");
}

/** A child whose clickhouse row declares the numeric wrapper `source`, answering the CSV of one `Float64` column. */
function childPlanting(label: string, source: string): BoundedChild {
  return boundedChild({
    label,
    imports: [{ from: path.join(SOURCE, "lib", "export", "result-export.ts"), names: ["buildResultExport"] }],
    runCase: (deps: ChildDeps): string =>
      deps.buildResultExport("csv", {
        rows: [{ x: "-Infinity" }],
        fields: ["x"],
        tabName: "t",
        dialect: "clickhouse",
        columnTypes: { x: "Float64" },
      }).content,
    heapLimitMiB: 256,
    timeoutMs: 10_000,
    stubs: [{ specifier: "@/lib/db/providers/sql/clickhouse/sql-writing", source: plantedClickhouse(source) }],
  });
}

const wholeType = childPlanting("numeric-wrapper-whole-type", "^(.*)$");
const absentGroup = childPlanting("numeric-wrapper-absent-group", String.raw`^(?:Nullable\((.*)\))?Float64$`);

beforeAll(async () => {
  await wholeType.build();
  await absentGroup.build();
});

afterAll(() => {
  wholeType.remove();
  absentGroup.remove();
});

describe("a declared numeric wrapper in a bounded child", () => {
  test("a wrapper whose capture is not shorter than the type ends the unwrapping, so the export reads the type as it is", async () => {
    expect(await wholeType.run<string>("whole-type")).toBe(NUMERIC_COLUMN_CSV);
  }, 20_000);

  test("a wrapper whose group is absent ends the unwrapping", async () => {
    expect(await absentGroup.run<string>("absent-group")).toBe(NUMERIC_COLUMN_CSV);
  }, 20_000);
});
