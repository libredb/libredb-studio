/**
 * Drift guards for the operator documentation of the uncaught-exception exit (src/lib/uncaught-exception.ts).
 *
 * docs/DISTRIBUTION.md "Uncaught errors and restarts" is where an operator reads why the server stopped with code 70
 * and what restarts it. The code, the constant and the lines it shows are the module's own, and every page that names
 * the code names it through `UNCAUGHT_EXCEPTION_EXIT_CODE` here, so a change to either side that the other misses
 * fails here. The pages that describe the boot, the chart's probes, the query event delivery and the Kafka client's
 * uncaught exceptions link the section.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { UNCAUGHT_EXCEPTION_EXIT_CODE, uncaughtExceptionLine } from "@/lib/uncaught-exception";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const HEADING = "## Uncaught errors and restarts";
const C = UNCAUGHT_EXCEPTION_EXIT_CODE;

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

    expect(text).toContain(`exits with code ${C}`);
    expect(text).toContain(`Code ${C} is \`UNCAUGHT_EXCEPTION_EXIT_CODE\``);
    expect(text).toContain(`the server exits with ${C} for it too`);
    expect(text).toContain(`back after code ${C}:`);
    expect(text).toContain(`the launcher exits with ${C}`);
    expect(text).toContain(`\`libredb-studio.exe\` exits with ${C}`);
  });

  test("the line it shows is the line the server logs", () => {
    const text = section();
    const line = uncaughtExceptionLine(new TypeError("connect failed for postgres://alice:s3cret@db.example:5432/app"));

    expect(text).toContain(`{route=uncaught-exception} ${line}`);
    expect(text).not.toContain("s3cret");
  });

  test("it says an unhandled promise rejection does not stop the server, unless Node.js raises it as an exception", () => {
    const text = section();
    const strictLine = uncaughtExceptionLine(new Error("late"), "unhandledRejection");

    expect(text).toContain("A promise rejection that nothing handles does not stop the server");
    expect(text).toContain("`--unhandled-rejections=strict`");
    expect(text).toContain(`the line begins \`${strictLine.slice(0, strictLine.indexOf(","))}\``);
  });

  test("it says the query events still queued are lost and counted", () => {
    expect(section()).toContain("{route=uncaught-exception, queryEventsLost=");
    expect(read("docs/GOVERNANCE.md")).toContain("the line Studio logs for that exit counts them as `queryEventsLost`");
  });

  test.each([
    ["docs/ARCHITECTURE.md", [`ends the process with exit code ${C}`, `\`bun dev\` ends with code ${C}`]],
    ["docs/HELM_CHART.md", [`uncaught exception exits with code ${C}`]],
    ["docs/providers/kafka.md", [`the exception ends the process with exit code ${C}`]],
    ["docs/GOVERNANCE.md", []],
  ])("%s links the section and names the code as the module does", (page, phrases) => {
    const text = read(page);

    expect(text).toContain("DISTRIBUTION.md#uncaught-errors-and-restarts");
    for (const phrase of phrases) expect(text).toContain(phrase);
  });
});
