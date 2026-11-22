/**
 * Every image installs its dependencies the way a checkout does (packages/README.md, "Docker").
 *
 * Each Dockerfile's deps stage installs from a partial file set, and two files decide what
 * that install does without failing when they are absent (measured on bun 1.4.4):
 * without `bunfig.toml` a workspace root installs with bun's isolated linker, a different
 * node_modules layout from the hoisted one the repository builds and tests with; without
 * a package's `package.json` a frozen install skips the package and still exits 0. So the
 * stage copies `bunfig.toml` beside `package.json` and `bun.lock`, and one explicit line
 * per workspace package, since Docker's wildcard COPY flattens directories.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { workspacePackageDirectories } from "../../scripts/workspace-packages.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const DOCKERFILES = ["Dockerfile", "Dockerfile.alpine", "Dockerfile.alpine-slim"];
const INSTALL = "RUN bun install --frozen-lockfile";

/** The deps stage's lines before its dependency install. */
function linesBeforeInstall(text: string): string[] {
  const lines = text.split("\n");
  const install = lines.indexOf(INSTALL);
  if (install < 0) throw new Error(`no "${INSTALL}" line`);
  return lines.slice(0, install);
}

/** The COPY line each package needs before the install, for every package the text lacks it for. */
function missingManifestCopies(text: string, packages: readonly string[]): string[] {
  const before = linesBeforeInstall(text);
  return packages
    .map((directory) => `COPY ${directory}/package.json ./${directory}/`)
    .filter((line) => !before.includes(line));
}

describe("the image installs workspace packages as a checkout does", () => {
  test.each(DOCKERFILES)("%s copies package.json, bun.lock and bunfig.toml before its dependency install", (file) => {
    expect(linesBeforeInstall(readFileSync(path.join(ROOT, file), "utf8"))).toContain(
      "COPY package.json bun.lock bunfig.toml ./",
    );
  });

  test.each(DOCKERFILES)("%s copies every workspace package manifest before its dependency install", (file) => {
    const text = readFileSync(path.join(ROOT, file), "utf8");

    expect(missingManifestCopies(text, workspacePackageDirectories(ROOT))).toEqual([]);
  });

  test("the manifest check names a planted package's missing COPY line", () => {
    const text = ["FROM oven/bun AS deps", "COPY package.json bun.lock bunfig.toml ./", INSTALL].join("\n");

    expect(missingManifestCopies(text, ["packages/planted"])).toEqual([
      "COPY packages/planted/package.json ./packages/planted/",
    ]);
    // The control: the same text with the line is clean, and a line after the install does not count.
    const withLine = text.replace(INSTALL, `COPY packages/planted/package.json ./packages/planted/\n${INSTALL}`);
    expect(missingManifestCopies(withLine, ["packages/planted"])).toEqual([]);
    const afterInstall = `${text}\nCOPY packages/planted/package.json ./packages/planted/`;
    expect(missingManifestCopies(afterInstall, ["packages/planted"])).toHaveLength(1);
  });

  test.each(DOCKERFILES)("%s asserts that its standalone output holds no packages directory", (file) => {
    const text = readFileSync(path.join(ROOT, file), "utf8");

    expect(text).toContain("test ! -e .next/standalone/src; \\\n    test ! -e .next/standalone/packages; \\");
  });
});
