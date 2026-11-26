/**
 * No doc cites the removed PostgreSQL identifier module: a repository-wide absence check over every Markdown file
 * under docs/, which holds no provider document to code.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "./engine-modules";

/** Every Markdown file under `dir`, recursively. */
function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

describe("docs cite no removed module", () => {
  test("no doc cites the removed PostgreSQL identifier module", () => {
    const citing = markdownFiles(join(ROOT, "docs"))
      .filter((path) => readFileSync(path, "utf8").includes("src/lib/editor/postgres-identifiers.ts"))
      .map((path) => relative(ROOT, path));
    expect(citing).toEqual([]);
  });
});
