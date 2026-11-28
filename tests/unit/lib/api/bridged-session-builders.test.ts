/**
 * Which module of the caller facades builds a legacy provider's bridged session
 * (src/lib/provider-host/legacy-bridge.ts): session-target.ts alone, so every facade under src/lib/api runs on a
 * session target or a read form that module builds, and no facade forks on who serves an engine. The check reads each
 * source file's raw text for a builder's name followed by its opening parenthesis, a call, so a docblock that names a
 * builder in backticks is not one. Paths are joined with `path.join` and compared with forward slashes, so every
 * platform reaches the same step.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The bridge's builders of a legacy provider's session, each as the text that calls it. */
const BUILDERS = [
  "bridgedConsole(",
  "bridgedScriptUnit(",
  "bridgedTransactionScriptUnit(",
  "bridgedComposedStatements(",
  "bridgedMaintenance(",
] as const;

/** Every TypeScript source file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the bridged session builders", () => {
  test("no caller facade under src/lib/api builds a legacy provider's bridged session: session-target.ts is the one module that does", () => {
    const callers = sources(join("src", "lib", "api"))
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        return BUILDERS.some((builder) => text.includes(builder));
      })
      .map((path) => path.replaceAll("\\", "/"))
      .sort();
    expect(callers).toEqual(["src/lib/api/session-target.ts"]);
  });
});
