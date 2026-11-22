/**
 * Drift guards for the operator documentation of the shutdown handler (src/lib/shutdown-handler.ts).
 *
 * docs/DISTRIBUTION.md "Stopping the server" is where an operator reads who ends the server on SIGTERM and SIGINT,
 * how long each step may take and what the exit code says. The variable, the bounds and the codes are the modules'
 * own, so a change to either side that the other misses fails here. The pages that describe the boot, the query event
 * delivery and the provider closes link the section.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PROVIDER_CACHE_CLOSE_DEADLINE_MS, SHUTDOWN_HOOKS_DEADLINE_MS } from "@/lib/shutdown";
import { DRAIN_DEADLINE_MS, REQUEST_START_CHANNEL } from "@/lib/shutdown-drain";
import { MANUAL_SIGNAL_HANDLING_VARIABLE } from "@/lib/shutdown-handler";
import { UNCAUGHT_EXCEPTION_EXIT_CODE } from "@/lib/uncaught-exception";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const HEADING = "## Stopping the server";
const LINK = "DISTRIBUTION.md#stopping-the-server";

/** The section from its heading to the next level-two heading. */
function section(): string {
  const doc = read("docs/DISTRIBUTION.md");
  const start = doc.indexOf(`\n${HEADING}\n`);
  expect(start).toBeGreaterThan(-1);
  const end = doc.indexOf("\n## ", start + HEADING.length + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

describe("docs/DISTRIBUTION.md, Stopping the server", () => {
  test("it names the variable and its two accepted states", () => {
    const text = section();

    expect(text).toContain(`\`${MANUAL_SIGNAL_HANDLING_VARIABLE}=true\``);
    expect(text).toContain(`\`${MANUAL_SIGNAL_HANDLING_VARIABLE}\` unset or empty`);
    expect(text).toContain("never in a `.env` file");
  });

  test("it names the drain's, the hooks' and the closes' bounds in seconds, and their sum, as the modules set them", () => {
    const text = section();

    expect(text).toContain(`waits at most ${DRAIN_DEADLINE_MS / 1000} s for the requests in flight`);
    expect(text).toContain(
      `close the governance pool, all at once and for at most ${SHUTDOWN_HOOKS_DEADLINE_MS / 1000} s`,
    );
    expect(text).toContain(`at most ${PROVIDER_CACHE_CLOSE_DEADLINE_MS / 1000} s`);
    expect(text).toContain(
      `${(DRAIN_DEADLINE_MS + SHUTDOWN_HOOKS_DEADLINE_MS + PROVIDER_CACHE_CLOSE_DEADLINE_MS) / 1000} s at most`,
    );
  });

  test("it names the experimental channel the drain reads and the test that watches it", () => {
    const text = section();

    expect(text).toContain(`\`${REQUEST_START_CHANNEL}\``);
    expect(text).toContain("Stability 1");
    expect(text).toContain("tests/unit/lib/shutdown-drain-runtimes.test.ts");
  });

  test("it says the images set the variable, and how a container leaves the exit to Next.js", () => {
    const text = section();

    expect(text).toContain(`The three images set \`${MANUAL_SIGNAL_HANDLING_VARIABLE}=true\``);
    expect(text).toContain(`\`docker run -e ${MANUAL_SIGNAL_HANDLING_VARIABLE}= ...\``);
    expect(text).toContain("npx and the other launchers do not set it yet");
  });

  test("it says the server refuses Studio's exit on Bun, and names the end line's counts", () => {
    const text = section();

    expect(text).toContain(
      `\`${MANUAL_SIGNAL_HANDLING_VARIABLE}=true\` with the server on Bun: the server refuses to start`,
    );
    for (const count of ["responsesCut", "responsesInFlightAtExit", "queryEventsLost"]) {
      expect(text).toContain(`\`${count}\``);
    }
  });

  test("it names every exit code the shutdown ends with, and the uncaught exit's", () => {
    const text = section();

    for (const code of [0, 143, 130, UNCAUGHT_EXCEPTION_EXIT_CODE]) expect(text).toContain(`| ${code} |`);
  });

  test("Uncaught errors and restarts gives the same codes and links the section", () => {
    const text = read("docs/DISTRIBUTION.md");

    expect(text).toContain("0 is a complete shutdown on SIGTERM or SIGINT, 143 and 130 a shutdown on that signal");
    expect(text).toContain("(#stopping-the-server)");
  });

  test.each([
    "docs/GOVERNANCE.md",
    "docs/ARCHITECTURE.md",
    "docs/providers/libredb.md",
    "docs/providers/redis.md",
    "docs/providers/postgres.md",
  ])("%s links the section", (page) => {
    expect(read(page)).toContain(LINK);
  });
});
