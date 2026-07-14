import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Exercise the CLI end-to-end on synthetic fixtures. SF paths point at files
// that do not exist on disk so stripNonExecutableLines leaves the records
// untouched and assertions stay deterministic.
const SCRIPT = path.resolve(import.meta.dir, "../../scripts/merge-lcov.mjs");
const workDir = mkdtempSync(path.join(tmpdir(), "merge-lcov-test-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function runMerge(name: string, inputs: string[]): Map<string, Map<number, number>> {
  const inputPaths = inputs.map((content, i) => {
    const p = path.join(workDir, `${name}-in-${i}.info`);
    writeFileSync(p, content);
    return p;
  });
  const outPath = path.join(workDir, `${name}-out.info`);
  const result = Bun.spawnSync(["node", SCRIPT, ...inputPaths, outPath]);
  expect(result.exitCode).toBe(0);

  const records = new Map<string, Map<number, number>>();
  let current: Map<number, number> | null = null;
  for (const line of readFileSync(outPath, "utf8").split("\n")) {
    if (line.startsWith("SF:")) {
      current = new Map();
      records.set(line.slice(3), current);
    } else if (line.startsWith("DA:") && current) {
      const [ln, hits] = line.slice(3).split(",").map(Number);
      current.set(ln, hits);
    }
  }
  return records;
}

function lcov(sf: string, lines: Array<[number, number]>): string {
  const da = lines.map(([ln, hits]) => `DA:${ln},${hits}`).join("\n");
  const lh = lines.filter(([, hits]) => hits > 0).length;
  return `SF:${sf}\nFNF:1\nFNH:0\n${da}\nLF:${lines.length}\nLH:${lh}\nend_of_record\n`;
}

describe("merge-lcov authority-universe rule", () => {
  test("drops zero-hit lines that only a coarse load-only record claims", () => {
    // Exercised record: fine map, 2 hit lines, 2 real gaps.
    const fine = lcov("src/virtual/widget.tsx", [
      [1, 5],
      [10, 3],
      [20, 0],
      [30, 0],
    ]);
    // Load-only record: coarse map with extra never-coverable lines 15/25.
    const coarse = lcov("src/virtual/widget.tsx", [
      [1, 2],
      [15, 0],
      [20, 0],
      [25, 0],
      [30, 0],
    ]);

    const merged = runMerge("phantom", [fine, coarse]).get("src/virtual/widget.tsx")!;
    expect([...merged.keys()].sort((a, b) => a - b)).toEqual([1, 10, 20, 30]);
    expect(merged.get(20)).toBe(0);
    expect(merged.get(30)).toBe(0);
  });

  test("keeps per-line max from secondary exercised records inside the authority universe", () => {
    // Desktop group: authority (3 hit lines), mobile branch at line 40 unexecuted.
    const desktop = lcov("src/virtual/modal.tsx", [
      [1, 9],
      [10, 4],
      [20, 2],
      [40, 0],
    ]);
    // Mobile group: fewer hit lines overall, but it covers the drawer line 40.
    const mobile = lcov("src/virtual/modal.tsx", [
      [1, 3],
      [40, 7],
    ]);

    const merged = runMerge("secondary", [desktop, mobile]).get("src/virtual/modal.tsx")!;
    expect(merged.get(40)).toBe(7);
    expect(merged.get(10)).toBe(4);
  });

  test("keeps single-record files untouched even when barely executed", () => {
    // The orphan file appears in only one input; the other input covers an
    // unrelated file, so no authority competition exists for the orphan.
    const loadOnly = lcov("src/virtual/orphan.ts", [
      [1, 1],
      [5, 0],
      [9, 0],
    ]);
    const unrelated = lcov("src/virtual/other.ts", [[1, 4]]);

    const merged = runMerge("single", [loadOnly, unrelated]).get("src/virtual/orphan.ts")!;
    expect([...merged.keys()].sort((a, b) => a - b)).toEqual([1, 5, 9]);
    expect(merged.get(5)).toBe(0);
  });
});
