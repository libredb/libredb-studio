/**
 * The FIFO helper and the child process the never-blocks tests run their opens in
 * (tests/helpers/special-files.ts). The point of the child is that a blocked open fails the test
 * instead of hanging the suite, so that is what this holds it to.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_HARD_TIMEOUT_MS, MISSING_POSIX_SPECIAL_FILES, makeFifo, runInChild } from "../helpers/special-files";
import { testIf } from "../helpers/posix-tools";

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "special-files-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

testIf(MISSING_POSIX_SPECIAL_FILES, "makeFifo makes a FIFO with the mode asked for", () => {
  const fifo = join(scratch, "made");
  makeFifo(fifo, "600");
  const made = statSync(fifo);
  expect(made.isFIFO()).toBe(true);
  expect(made.mode & 0o777).toBe(0o600);
});

testIf(MISSING_POSIX_SPECIAL_FILES, "makeFifo raises mkfifo's own refusal", () => {
  const fifo = join(scratch, "missing-folder", "fifo");
  expect(() => makeFifo(fifo)).toThrow(`mkfifo ${fifo} failed with exit 1: `);
});

test("runInChild hands back what the child reported", async () => {
  expect(await runInChild("report({ answer: 42 });")).toEqual({ report: { answer: 42 }, failure: null });
});

test("runInChild names the exit of a child that ended without a report, with its stderr", async () => {
  const outcome = await runInChild('console.error("no report"); process.exit(3);');
  expect(outcome).toEqual({
    report: null,
    failure: `failed with exit 3 (hard limit ${CHILD_HARD_TIMEOUT_MS} ms): no report\n`,
  });
});

testIf(
  MISSING_POSIX_SPECIAL_FILES,
  "a child blocked opening a FIFO is killed at the hard limit, and the outcome names the kill",
  async () => {
    const fifo = join(scratch, "nobody-writes");
    makeFifo(fifo);
    const started = Date.now();
    const outcome = await runInChild(
      `require("node:fs").openSync(${JSON.stringify(fifo)}, "r");\nreport({ opened: true });`,
      1_000,
    );
    expect(outcome).toEqual({ report: null, failure: "was killed by SIGKILL (hard limit 1000 ms): " });
    expect(Date.now() - started).toBeLessThan(5_000);
  },
);
