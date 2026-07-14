import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Exercise the CLI end-to-end on synthetic reports, mirroring
// tests/unit/merge-lcov.test.ts: the script gates every merge, so both its
// verdicts and its diagnostics (compressed file:line ranges) are locked here.
const SCRIPT = path.resolve(import.meta.dir, "../../scripts/check-coverage.mjs");
const workDir = mkdtempSync(path.join(tmpdir(), "check-coverage-test-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function runCheck(name: string, content: string | null): { exitCode: number; stdout: string; stderr: string } {
  const reportPath = path.join(workDir, `${name}.info`);
  if (content !== null) {
    writeFileSync(reportPath, content);
  }
  const result = Bun.spawnSync(["node", SCRIPT, reportPath]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function lcov(sf: string, lines: Array<[number, number]>): string {
  const da = lines.map(([ln, hits]) => `DA:${ln},${hits}`).join("\n");
  const lh = lines.filter(([, hits]) => hits > 0).length;
  return `SF:${sf}\nFNF:1\nFNH:1\n${da}\nLF:${lines.length}\nLH:${lh}\nend_of_record\n`;
}

describe("check-coverage CLI", () => {
  test("passes on a fully covered report", () => {
    const report =
      lcov("src/a.ts", [
        [1, 3],
        [2, 1],
      ]) + lcov("src/b.tsx", [[10, 7]]);

    const { exitCode, stdout } = runCheck("full", report);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK");
    expect(stdout).toContain("3/3 lines (100.00%)");
  });

  test("fails on gaps and prints compressed file:line ranges", () => {
    const report =
      lcov("src/gappy.ts", [
        [1, 5],
        [2, 0],
        [3, 0],
        [4, 0],
        [9, 0],
      ]) + lcov("src/clean.ts", [[1, 2]]);

    const { exitCode, stderr } = runCheck("gaps", report);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("FAIL");
    expect(stderr).toContain("100% required");
    expect(stderr).toContain("src/gappy.ts: 4 line(s) [2-4,9]");
    expect(stderr).not.toContain("src/clean.ts");
  });

  test("fails when the report file is missing", () => {
    const { exitCode, stderr } = runCheck("missing", null);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("cannot read");
    expect(stderr).toContain("test:coverage");
  });

  test("fails on a report with no DA records", () => {
    const { exitCode, stderr } = runCheck("empty", "SF:src/a.ts\nend_of_record\n");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no DA records");
  });

  test("fails fast on a DA record appearing before any SF record", () => {
    const { exitCode, stderr } = runCheck("da-before-sf", "DA:1,5\nSF:src/a.ts\nDA:2,1\nend_of_record\n");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("malformed lcov");
    expect(stderr).toContain("DA record before any SF record");
  });

  test("fails fast on non-numeric DA fields, naming the offending line", () => {
    const { exitCode, stderr } = runCheck("da-nan", "SF:src/a.ts\nDA:abc,5\nend_of_record\n");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("malformed lcov");
    expect(stderr).toContain("DA:abc,5");
  });

  test("tolerates the optional lcov checksum field on DA records", () => {
    const { exitCode, stdout } = runCheck("da-checksum", "SF:src/a.ts\nDA:1,5,3kA9x\nDA:2,2,zzzz\nend_of_record\n");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("2/2 lines (100.00%)");
  });
});
