/**
 * Drift guard for the patched dependencies (docs/TOOLCHAIN.md, "Patched dependencies").
 *
 * `patchedDependencies` in package.json names a patch per exact `name@version`, and `bun install` applies it. When the
 * installed version stops matching the key, as after a version bump, Bun 1.4.4 only warns
 * ("patches/<file> no longer applies (<name> is now <version>)"), installs the package unpatched and drops the entry
 * from bun.lock, with exit code 0, `--frozen-lockfile` included (measured 2026-11-21). So this file fails instead:
 * every entry's package must be installed at the key's version with the patch applied, every patch file must belong
 * to an entry, bun.lock must record the entries, every entry must have its row in the TOOLCHAIN table, and every image
 * build that installs from a partial file set must copy the patches in first (Bun itself refuses an install whose
 * patch file is missing or does not apply).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const PATCHED: Record<string, string> = JSON.parse(read("package.json")).patchedDependencies ?? {};

/** `ioredis@5.11.1` -> ["ioredis", "5.11.1"]; a scoped `@scope/name@1.0.0` keeps its leading `@`. */
function splitKey(key: string): [string, string] {
  const at = key.lastIndexOf("@");
  return [key.slice(0, at), key.slice(at + 1)];
}

interface Hunk {
  readonly file: string;
  /** The hunk's lines as the patched file holds them: its context and added lines, in order. */
  readonly after: string;
}

/** Each hunk of a git-style unified diff, read from the `+++ b/<file>` header that precedes it. */
function hunks(patch: string): Hunk[] {
  const found: Hunk[] = [];
  let file = "";
  let lines: string[] | null = null;
  const close = () => {
    if (lines !== null) found.push({ file, after: lines.join("\n") });
    lines = null;
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) close();
    else if (line.startsWith("+++ b/")) file = line.slice("+++ b/".length);
    else if (line.startsWith("@@")) {
      close();
      lines = [];
    } else if (lines !== null && (line.startsWith(" ") || line.startsWith("+"))) lines.push(line.slice(1));
  }
  close();
  return found;
}

describe("patched dependencies", () => {
  const entries = Object.entries(PATCHED);

  test("the hunk reader reads a two-file patch", () => {
    const patch = [
      "diff --git a/one.js b/one.js",
      "--- a/one.js",
      "+++ b/one.js",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
      "diff --git a/two.js b/two.js",
      "--- a/two.js",
      "+++ b/two.js",
      "@@ -1 +1,2 @@",
      " a",
      "+b",
      "",
    ].join("\n");
    expect(hunks(patch)).toEqual([
      { file: "one.js", after: "keep\nnew" },
      { file: "two.js", after: "a\nb" },
    ]);
  });

  test.each(entries)("%s is installed at that version", (key) => {
    const [name] = splitKey(key);
    const installed = JSON.parse(read(join("node_modules", name, "package.json"))).version;
    expect(`${name}@${installed}`).toBe(key);
  });

  test.each(entries)("%s holds every hunk of its patch", (key, patchFile) => {
    const [name] = splitKey(key);
    const found = hunks(read(patchFile));
    expect(found.length).toBeGreaterThan(0);
    const missing = found.filter(({ file, after }) => !read(join("node_modules", name, file)).includes(after));
    expect(missing.map(({ file }) => file)).toEqual([]);
  });

  test("every file in patches/ belongs to an entry", () => {
    const files = readdirSync(join(ROOT, "patches")).map((file) => `patches/${file}`);
    expect(files.sort()).toEqual(Object.values(PATCHED).sort());
  });

  test("bun.lock records the same entries", () => {
    const lock = read("bun.lock");
    const absent = entries.filter(([key, patchFile]) => !lock.includes(`"${key}": "${patchFile}",`));
    expect(absent.map(([key]) => key)).toEqual([]);
  });

  test("the TOOLCHAIN table has a row for every entry, and no row for anything else", () => {
    const toolchain = read("docs/TOOLCHAIN.md");
    const start = toolchain.indexOf("\n## Patched dependencies\n");
    expect(start).toBeGreaterThan(0);
    const end = toolchain.indexOf("\n## ", start + 1);
    const section = toolchain.slice(start, end < 0 ? undefined : end);
    const rows = section
      .split("\n")
      .filter((line) => line.startsWith("| `"))
      .map((line) => line.split("|").map((cell) => cell.trim()));
    const named = rows.map(([, pkg, patchFile]) => `${pkg} ${patchFile}`);
    for (const [key, patchFile] of entries) expect(named).toContain(`\`${key}\` \`${patchFile}\``);
    for (const [, pkg] of rows) expect(Object.keys(PATCHED)).toContain(pkg.replaceAll("`", ""));
  });

  test.each(["Dockerfile", "Dockerfile.alpine", "Dockerfile.alpine-slim"])(
    "%s copies the patches in before its dependency install",
    (dockerfile) => {
      const lines = read(dockerfile).split("\n");
      const install = lines.indexOf("RUN bun install --frozen-lockfile");
      expect(install).toBeGreaterThan(0);
      expect(lines.slice(install - 2, install)).toEqual(["COPY package.json bun.lock ./", "COPY patches ./patches"]);
    },
  );
});
