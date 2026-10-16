/**
 * The band this provider's secrets requirement now rests on.
 *
 * Y-S2 says nothing read from a device is written to a log, an export or a measurement artifact.
 * There used to be a filter for that, and it was called from nowhere: the one place that reached it
 * branched on its answer with two identical arms and threw the result away. A filter nothing calls
 * protects nothing and reads as protection, so it is gone, and what holds the requirement now is
 * that there is NO OUTWARD WRITE AT ALL. That is a stronger property than filtering and a more
 * fragile one: a single `console.log` added tomorrow ends it silently.
 *
 * So the property is held here rather than in a comment. A comment is not a gate.
 *
 * Protocol writes are not outward writes and are not counted: this provider writes to a device's
 * channel on every request, which is its job. What is counted is anything that puts text where a
 * person or another program reads it later.
 */
import { test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expectEqual, strippedSource } from "./helpers";

const DIR = join(import.meta.dir, "../../../../src/lib/db/providers/network/netconf");

const OUTWARD = [
  /\bconsole\s*\./,
  /\blogger\b/,
  /\bwriteFileSync?\b/,
  /\bappendFileSync?\b/,
  /\bcreateWriteStream\b/,
  /\bprocess\s*\.\s*(stdout|stderr)\b/,
  /\bfs\s*\.\s*write/,
];

test("no file in this provider writes anything outward, which is what Y-S2 now rests on", () => {
  const found: string[] = [];
  for (const name of readdirSync(DIR).filter((f) => f.endsWith(".ts"))) {
    const body = strippedSource(readFileSync(join(DIR, name), "utf8"));
    body.split("\n").forEach((line, at) => {
      for (const pattern of OUTWARD) {
        if (pattern.test(line)) found.push(`${name}:${at + 1}: ${line.trim().slice(0, 60)}`);
      }
    });
  }
  // Named rather than counted: a failure has to say WHERE, because the answer is either to remove
  // the write or to bring back a filter, and both start by reading that line.
  expectEqual(found, []);
});

/**
 * The band proved in the other direction, which is the half that is usually missing: a check that
 * cannot fail is not a check, and this one is a text scan, the kind most likely to be quietly
 * broken by its own cleaning step.
 */
test("the band goes red on a write, and its cleaning does not hide one", () => {
  const withWrite = strippedSource('function f() {\n  console.log("x");\n}');
  expectEqual(
    OUTWARD.some((p) => p.test(withWrite)),
    true,
  );
  // A write inside a COMMENT is not a write. A write inside a string is not one either, and this
  // band will raise on it anyway: strings are not removed, because every attempt to remove them
  // deleted real code instead. That failure direction is deliberate and stated in `strippedSource`.
  for (const harmless of ["// console.log here", "/* logger */"]) {
    expectEqual(
      OUTWARD.some((p) => p.test(strippedSource(harmless))),
      false,
    );
  }
});
