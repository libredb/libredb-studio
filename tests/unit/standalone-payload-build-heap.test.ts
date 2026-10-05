/**
 * The Node heap the standalone payload build runs under.
 *
 * `next build` type-checks the whole tree, and on a fresh checkout that outgrows the default heap of
 * the smaller release runners: the 0.18.0 tag stopped on macos-14 and macos-15-intel with
 * "JavaScript heap out of memory" at about 2 GB, while the Linux runners, whose default is larger,
 * passed. The pull request checks build on Linux only, so this is the one place that holds it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const script = readFileSync(join(import.meta.dir, "..", "..", "scripts/build-standalone-payload.sh"), "utf8");
const smokeStart = script.indexOf('if [ "$RUN_SMOKE" = "true" ]');
const build = script.slice(0, smokeStart);
const smoke = script.slice(smokeStart);

describe("the standalone payload build", () => {
  test("raises the Node heap for next build, keeping any NODE_OPTIONS the caller set", () => {
    expect(build).toMatch(
      /NODE_OPTIONS="\$\{NODE_OPTIONS:\+\$NODE_OPTIONS \}--max-old-space-size=6144"[^\n]* bun run build\n/,
    );
  });

  test("starts the smoke test's server on the defaults a user gets", () => {
    expect(smokeStart).toBeGreaterThan(0);
    expect(smoke).not.toContain("max-old-space-size");
  });
});
