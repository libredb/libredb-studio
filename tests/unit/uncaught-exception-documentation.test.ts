/**
 * Drift guards for the operator documentation of the uncaught-exception exit (src/lib/uncaught-exception.ts).
 *
 * docs/DISTRIBUTION.md "Uncaught errors and restarts" is where an operator reads why the server stopped with code 70
 * and what restarts it. The code, the constant and the example line it shows are the module's own, so a change to
 * either side that the other misses fails here, and the pages that describe the boot and the chart's probes link it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { UNCAUGHT_EXCEPTION_EXIT_CODE, uncaughtExceptionLine } from "@/lib/uncaught-exception";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const HEADING = "## Uncaught errors and restarts";

/** The section from its heading to the next level-two heading. */
function section(): string {
  const doc = read("docs/DISTRIBUTION.md");
  const start = doc.indexOf(`\n${HEADING}\n`);
  expect(start).toBeGreaterThan(-1);
  const end = doc.indexOf("\n## ", start + HEADING.length + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

describe("docs/DISTRIBUTION.md, Uncaught errors and restarts", () => {
  test("docs/DISTRIBUTION.md names the exit code by its number and its constant", () => {
    const text = section();

    expect(text).toContain(`exits with code ${UNCAUGHT_EXCEPTION_EXIT_CODE}`);
    expect(text).toContain("`UNCAUGHT_EXCEPTION_EXIT_CODE`");
  });

  test("the line it shows is the line the server logs", () => {
    const text = section();
    const line = uncaughtExceptionLine(new TypeError("connect failed for postgres://alice:s3cret@db.example:5432/app"));

    expect(text).toContain(`{route=uncaught-exception} ${line}`);
    expect(text).not.toContain("s3cret");
  });

  test("it says an unhandled promise rejection does not stop the server", () => {
    expect(section()).toContain("A promise rejection that nothing handles does not stop the server");
  });

  test("docs/ARCHITECTURE.md and docs/HELM_CHART.md link the section", () => {
    expect(read("docs/ARCHITECTURE.md")).toContain("DISTRIBUTION.md#uncaught-errors-and-restarts");
    expect(read("docs/HELM_CHART.md")).toContain("DISTRIBUTION.md#uncaught-errors-and-restarts");
  });
});
