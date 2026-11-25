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
 *
 * A `file:` dependency of the root is different: a frozen install whose directory is absent fails by name, and one
 * whose directory holds only its `package.json` installs a package without code and still exits 0. So the stage copies
 * each such directory whole, read here from the root `package.json` rather than from a hand list.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { workspacePackageDirectories } from "../../scripts/workspace-packages.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
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

/** The directory of every `file:` dependency of a manifest, relative to the root and without a leading `./`. */
function fileDependencyDirectories(manifest: Record<string, unknown>): string[] {
  return DEPENDENCY_FIELDS.flatMap((field) => Object.values((manifest[field] ?? {}) as Record<string, string>))
    .filter((specifier) => specifier.startsWith("file:"))
    .map((specifier) => path.posix.normalize(specifier.slice("file:".length)));
}

/** The COPY line each `file:` dependency's directory needs before the install, for every one the text lacks. */
function missingDirectoryCopies(text: string, directories: readonly string[]): string[] {
  const before = linesBeforeInstall(text);
  return directories.map((directory) => `COPY ${directory}/ ./${directory}/`).filter((line) => !before.includes(line));
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

  test.each(DOCKERFILES)("%s copies every file: dependency's directory before its dependency install", (file) => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;
    const directories = fileDependencyDirectories(manifest);
    expect(directories.length).toBeGreaterThan(0);

    expect(missingDirectoryCopies(readFileSync(path.join(ROOT, file), "utf8"), directories)).toEqual([]);
  });

  test("the file: dependency check names a planted dependency's missing COPY line", () => {
    const directories = fileDependencyDirectories({
      dependencies: { planted: "file:./src/lib/planted", registry: "1.0.0" },
      devDependencies: { workspace: "workspace:*" },
    });
    expect(directories).toEqual(["src/lib/planted"]);
    const text = ["FROM oven/bun AS deps", "COPY package.json bun.lock bunfig.toml ./", INSTALL].join("\n");

    expect(missingDirectoryCopies(text, directories)).toEqual(["COPY src/lib/planted/ ./src/lib/planted/"]);
    // The control: the same text with the line is clean, and a line after the install does not count.
    const withLine = text.replace(INSTALL, `COPY src/lib/planted/ ./src/lib/planted/\n${INSTALL}`);
    expect(missingDirectoryCopies(withLine, directories)).toEqual([]);
    expect(missingDirectoryCopies(`${text}\nCOPY src/lib/planted/ ./src/lib/planted/`, directories)).toHaveLength(1);
  });

  test.each(DOCKERFILES)("%s asserts that its standalone output holds no packages directory", (file) => {
    const text = readFileSync(path.join(ROOT, file), "utf8");

    expect(text).toContain("test ! -e .next/standalone/src; \\\n    test ! -e .next/standalone/packages; \\");
  });
});
