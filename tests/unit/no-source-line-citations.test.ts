/**
 * No tracked file cites a source location by its line number.
 *
 * A line number goes stale as soon as anything above the cited line changes, and nothing tells the reader it did; a
 * test that pins one turns every unrelated edit above it red. A citation names what the sentence means instead: the
 * enclosing symbol, `Class.method`, a constant, a test by its quoted title, a Markdown section by its heading, a YAML
 * key path, or, for code outside the repository, the upstream symbol and the pinned package version.
 *
 * What is read and what is left out, with the reason for each, is described in
 * tests/helpers/source-line-citation.ts. Two forms are rewritten by hand because no matcher can tell them from
 * measured output: a bare list of numbers after a quoted label, and a sentence that cites a line of its own file
 * without naming the file.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { trackedFiles } from "../helpers/repo-text-scope";
import { citationFindings, citationSyntax, trackedPathResolver } from "../helpers/source-line-citation";

const ROOT = resolve(import.meta.dir, "../..");
/** The matchers' own fixture test plants every form this guard refuses, on purpose. */
const FIXTURES = "tests/unit/source-line-citation-matcher.test.ts";

describe("no source line citations", () => {
  test("no tracked file cites a location by line number", () => {
    const tracked = trackedFiles(ROOT);
    const resolves = trackedPathResolver(tracked);
    const found = tracked
      .filter((path) => path !== FIXTURES && citationSyntax(path) !== null)
      .flatMap((path) => citationFindings(path, readFileSync(resolve(ROOT, path), "utf8"), resolves))
      .map((finding) => `${finding.path}:${finding.line} ${finding.text}`);
    expect(found, "cite the enclosing symbol, test title or section heading instead").toEqual([]);
  }, 120_000);
});
