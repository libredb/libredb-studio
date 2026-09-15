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

describe("merge-lcov on Windows", () => {
  test("a backslash SF path is the same file as its forward-slash spelling", () => {
    // bun writes SF: with the host separator, so a Windows contributor running
    // `bun run test:coverage` produces `SF:src\virtual\win.tsx`. Without this
    // normalisation the two spellings merge as two files, and the `src/` filter
    // at the end of the script drops both, leaving an empty report that
    // check-coverage rejects for a reason that names nothing real.
    const windows = lcov("src\\virtual\\win.tsx", [
      [1, 4],
      [7, 0],
    ]);
    const posix = lcov("src/virtual/win.tsx", [[7, 2]]);

    const merged = runMerge("separators", [windows, posix]);
    expect([...merged.keys()]).toEqual(["src/virtual/win.tsx"]);
    expect(merged.get("src/virtual/win.tsx")!.get(7)).toBe(2);
  });
});

describe("merge-lcov input manifest", () => {
  test("--inputs-from reads the input list from a file", () => {
    // The test runner passes 500-odd reports, and Windows caps a command line at
    // 32767 characters, so the list travels in a file instead of in argv.
    const first = path.join(workDir, "manifest-in-0.info");
    const second = path.join(workDir, "manifest-in-1.info");
    writeFileSync(first, lcov("src/virtual/manifest.ts", [[1, 1]]));
    writeFileSync(second, lcov("src/virtual/manifest.ts", [[2, 3]]));
    const manifest = path.join(workDir, "manifest.txt");
    writeFileSync(manifest, `${first}\n${second}\n`);
    const outPath = path.join(workDir, "manifest-out.info");

    const result = Bun.spawnSync(["node", SCRIPT, `--inputs-from=${manifest}`, outPath]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(outPath, "utf8")).toContain("SF:src/virtual/manifest.ts");
    expect(result.stdout.toString()).toContain("Merged 2 LCOV file(s)");
  });

  test("an empty manifest is an error, not an empty report", () => {
    const manifest = path.join(workDir, "empty-manifest.txt");
    writeFileSync(manifest, "\n\n");

    const result = Bun.spawnSync(["node", SCRIPT, `--inputs-from=${manifest}`, path.join(workDir, "empty-out.info")]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(manifest);
  });
});
