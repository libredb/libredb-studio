/**
 * Guard for the checked-in static SVG assets.
 *
 * An SVG's `id` is not scoped to the file. The moment somebody inlines the markup into a
 * page beside another SVG - which is exactly what a logo directory such as svgl or
 * VectorLogoZone does with a submitted mark - every `id` lands in one document-wide
 * namespace and the last definition wins. A gradient named `logo-gradient` or, worse, a
 * filter named `glow` will silently take over, or be taken over by, somebody else's.
 *
 * `src/components/libredb-logo.tsx` already solves this for the rendered component by
 * suffixing every id with React's `useId()`. A static file cannot do that, so the
 * equivalent is a fixed product prefix. This test holds both halves: the ids are
 * namespaced, and every `url(#...)` still resolves inside its own file, since a rename
 * that misses a reference produces an invisible logo rather than a failure.
 *
 * A `<style>` block is the same hazard one level worse, which is why it is refused
 * outright rather than namespaced. Inlined, its selectors are not scoped to the SVG at
 * all: they become a document-wide stylesheet that restyles anything else on the page
 * matching them. Illustrator emits exactly this, as `.cls-1` through `.cls-N`, and that
 * is the single most common class name in the world's SVG files. Presentation attributes
 * say the same thing and cannot leak, so an exported asset gets its stylesheet dissolved
 * on the way in.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const REQUIRED_PREFIX = "libredb-";

function committedSvgPaths(): string[] {
  return execFileSync("git", ["ls-files", "*.svg"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.length > 0);
}

function definedIds(markup: string): string[] {
  return [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
}

function referencedIds(markup: string): string[] {
  return [...markup.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1]);
}

/** What an Illustrator export leaks into the host page when it is inlined. */
function leakedStyling(markup: string): string[] {
  return [
    ...[...markup.matchAll(/<style\b/g)].map(() => "<style> block"),
    ...[...markup.matchAll(/\bclass="([^"]+)"/g)].map((match) => `class="${match[1]}"`),
  ];
}

const ILLUSTRATOR_EXPORT = '<svg><defs><style>.cls-1{fill:red;}</style></defs><g class="cls-1"/></svg>';

const svgPaths = committedSvgPaths();

describe("static SVG asset id namespacing", () => {
  test("there are static SVG assets to check", () => {
    // Without this the two suites below pass by scanning nothing.
    expect(svgPaths.length).toBeGreaterThan(0);
  });

  test.each(svgPaths)("%s namespaces every id it defines", (relativePath) => {
    const markup = readFileSync(join(ROOT, relativePath), "utf8");
    const ids = definedIds(markup);

    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => !id.startsWith(REQUIRED_PREFIX))).toEqual([]);
  });

  test.each(svgPaths)("%s resolves every url(#...) it references", (relativePath) => {
    const markup = readFileSync(join(ROOT, relativePath), "utf8");
    const ids = new Set(definedIds(markup));
    const references = referencedIds(markup);

    expect(references.length).toBeGreaterThan(0);
    expect(references.filter((reference) => !ids.has(reference))).toEqual([]);
  });

  test("the stylesheet detector recognises an Illustrator export", () => {
    // The control for the assertion below, which would otherwise pass on markup it
    // cannot read at all rather than on markup that is clean.
    expect(leakedStyling(ILLUSTRATOR_EXPORT)).toEqual(["<style> block", 'class="cls-1"']);
  });

  test.each(svgPaths)("%s carries no styling that escapes the file", (relativePath) => {
    expect(leakedStyling(readFileSync(join(ROOT, relativePath), "utf8"))).toEqual([]);
  });
});
