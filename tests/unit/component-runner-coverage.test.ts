import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const runner = readFileSync(path.join(root, "tests/run-components.sh"), "utf8");
const commands = runner
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");
const named = new Set(commands.match(/tests\/(?:components|isolated)\/[^\s"']+\.test\.tsx?\b/g) ?? []);

function testFiles(directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return testFiles(file);
    return entry.isFile() && /\.test\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

const onDisk = new Set(["tests/components", "tests/isolated"].flatMap(testFiles));

describe("component runner coverage", () => {
  test("every component and isolated test file is named by the runner", () => {
    expect([...onDisk].filter((file) => !named.has(file)).sort()).toEqual([]);
  });

  test("every test path named by the runner exists on disk", () => {
    expect([...named].filter((file) => !onDisk.has(file)).sort()).toEqual([]);
  });

  test("TOTAL_GROUPS matches the number of run_group calls", () => {
    const declared = runner.match(/^TOTAL_GROUPS=(\d+)$/m);
    expect(declared).not.toBeNull();
    expect(Number(declared![1])).toBe((runner.match(/^run_group /gm) ?? []).length);
  });
});
