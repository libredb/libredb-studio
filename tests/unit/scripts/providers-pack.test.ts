/**
 * The pack step (scripts/providers-pack.ts, `bun run providers:pack -- --out <directory> [<package directory> ...]`):
 * it runs a provider package's own `build` script in the package's directory, with `--outdir` a temporary directory
 * outside the repository and only the environment it names, judges the output with the lock command's own artifact
 * sequence and admission's own checks, naming every finding, and places the artifact as `<out>/<name>/<version>/`;
 * a package it refuses gets nothing written, and the others are packed in the same run.
 *
 * Every planted package lives in a planted root under the system's temporary directory, never under the repository's
 * packages/: the isolation ratchet counts any `packages/provider-<id>/` directory there as an engine. A build is a
 * fixed script the test writes, run by Node.js on PATH: `writingBuild` writes given files into `--outdir`, and
 * `bundlingBuild` bundles the package's source with esbuild, resolved from the planted root's node_modules, a link to
 * the repository's install. Paths are compared by real path, since macOS reaches the temporary directory through
 * `/var`, a link to `/private/var`; a child's lines are split on `\r?\n`, since a Windows child ends them with CRLF.
 * No file mode is asserted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { STUDIO_HELD_NAMES } from "@/lib/db/studio-held-names";
import { admitPackage, hostManifestValidator } from "@/lib/provider-host/admission";
import { isNodeBuiltin } from "@/lib/provider-host/node-builtins";
import { MANIFEST_FILE_NAME } from "@/lib/provider-host/provider-artifact";
import { packageRefusal } from "@/lib/provider-host/lock-refusals";
import { readProvidersLock } from "@/lib/provider-host/providers-lock";
import { LOCK_FILE_NAME } from "@/lib/provider-host/providers-lock-format";
import { plantedRoot, removePlantedRoot } from "../../helpers/planted-package";
import { artifactDirectoryOf, removeScratch, scratchDirectory } from "../../helpers/provider-artifacts";
import { packProviders, type PackResult } from "../../../scripts/providers-pack";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const FIXTURE = path.join(REPOSITORY_ROOT, "tests", "fixtures", "out-of-tree-provider");
const SCHEMA_FILE = path.join(REPOSITORY_ROOT, "packages/provider-sdk/src/manifest/manifest.schema.json");
const USAGE = "Usage: bun run providers:pack -- --out <absolute directory> [<absolute package directory> ...]";
const PREFIX = "providers:pack";
const BUNDLING_TIMEOUT_MS = 60_000;

const scratch = scratchDirectory("libredb-providers-pack-test-");
const roots: string[] = [];
let counter = 0;

afterAll(() => {
  removeScratch(scratch);
  for (const root of roots) removePlantedRoot(root);
});

/** A new empty directory under the scratch root, outside every planted root. */
function fresh(label: string): string {
  counter += 1;
  const directory = path.join(scratch, `${label}-${counter}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

/** A planted root holding `files`, its node_modules a link to the repository's install; its real path. */
function root(files: Readonly<Record<string, string>>): string {
  const planted = fs.realpathSync.native(plantedRoot({ copy: [], workspaces: true, files, linkNodeModules: true }));
  roots.push(planted);
  return planted;
}

/** The minimal manifest the lock reads: one engine id and the entry `dist/index.mjs`, plus `runtime` members. */
function minimalManifest(id: string, runtime: Readonly<Record<string, unknown>> = {}): string {
  return `${JSON.stringify({ engines: [{ id }], runtime: { entry: "dist/index.mjs", ...runtime } }, null, 2)}\n`;
}

/** A package.json with a build script, `node build.mjs`, unless `pkg` says otherwise. */
function packageJson(name: string, pkg: Readonly<Record<string, unknown>> = {}): string {
  return `${JSON.stringify(
    { name, version: "1.0.0", private: true, type: "module", scripts: { build: "node build.mjs" }, ...pkg },
    null,
    2,
  )}\n`;
}

/** A `build.mjs` that writes `files`, by path relative to `--outdir`, and nothing else. */
function writingBuild(files: Readonly<Record<string, string>>): string {
  return [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    'const outdir = process.argv[process.argv.indexOf("--outdir") + 1];',
    `const files = ${JSON.stringify(files)};`,
    "for (const [relative, text] of Object.entries(files)) {",
    '  const file = path.join(outdir, ...relative.split("/"));',
    "  mkdirSync(path.dirname(file), { recursive: true });",
    "  writeFileSync(file, text);",
    "}",
    "",
  ].join("\n");
}

/** A `build.mjs` that bundles `src/entry.ts` with esbuild into `<outdir>/dist/index.mjs`. */
function bundlingBuild(): string {
  return [
    'import path from "node:path";',
    'import { build } from "esbuild";',
    'const outdir = process.argv[process.argv.indexOf("--outdir") + 1];',
    "await build({",
    '  entryPoints: ["src/entry.ts"],',
    "  bundle: true,",
    '  format: "esm",',
    '  platform: "node",',
    '  target: "node24",',
    '  outfile: path.join(outdir, "dist", "index.mjs"),',
    '  logLevel: "warning",',
    "});",
    "",
  ].join("\n");
}

/** The files of a package `packages/<directory>/` whose build writes `files`, with a minimal manifest. */
function writingPackage(
  directory: string,
  name: string,
  files: Readonly<Record<string, string>>,
  manifest: string = minimalManifest(directory.replace(/[^a-z]/g, "").slice(0, 32)),
): Record<string, string> {
  return {
    [`packages/${directory}/package.json`]: packageJson(name),
    [`packages/${directory}/${MANIFEST_FILE_NAME}`]: manifest,
    [`packages/${directory}/build.mjs`]: writingBuild(files),
  };
}

/** An entry module that loads nothing. */
const PLAIN_ENTRY = { "dist/index.mjs": "export default {};\n" };

/**
 * The files of `packages/provider-alpha/`: the out-of-tree fixture's manifest and provider, an entry that re-exports
 * it with a marker from `alpha-dep`, a CommonJS dependency in the package's own node_modules, and the bundling build.
 */
function alphaPackage(marker: string): Record<string, string> {
  const base = "packages/provider-alpha";
  return {
    [`${base}/package.json`]: packageJson("@libredb/provider-alpha"),
    [`${base}/${MANIFEST_FILE_NAME}`]: fs.readFileSync(path.join(FIXTURE, MANIFEST_FILE_NAME), "utf8"),
    [`${base}/src/provider.ts`]: fs.readFileSync(path.join(FIXTURE, "src", "index.ts"), "utf8"),
    [`${base}/src/entry.ts`]: [
      'import provider from "./provider";',
      'import { mark } from "alpha-dep";',
      "export const dependencyMark = mark;",
      "export default provider;",
      "",
    ].join("\n"),
    [`${base}/node_modules/alpha-dep/package.json`]: `${JSON.stringify({ name: "alpha-dep", version: "1.0.0", main: "index.js" })}\n`,
    [`${base}/node_modules/alpha-dep/index.js`]: `exports.mark = ${JSON.stringify(marker)};\n`,
    [`${base}/build.mjs`]: bundlingBuild(),
  };
}

/** Packs `packageDirectories` (the default set when empty) of `repositoryRoot` into `out`. */
function pack(
  repositoryRoot: string,
  out: string,
  packageDirectories: readonly string[] = [],
  options: { temporaryRoot?: string; environment?: Readonly<Record<string, string | undefined>> } = {},
): PackResult {
  return packProviders({
    repositoryRoot,
    out,
    packageDirectories,
    temporaryRoot: options.temporaryRoot ?? fresh("temporary"),
    environment: options.environment ?? process.env,
  });
}

/** Every file and directory under `directory`, by relative path, with its size and modification time; links unfollowed. */
function listing(directory: string): string[] {
  const entries: string[] = [];
  const pending = [""];
  for (let relative = pending.pop(); relative !== undefined; relative = pending.pop()) {
    for (const name of fs.readdirSync(path.join(directory, relative))) {
      const child = path.join(relative, name);
      const stats = fs.lstatSync(path.join(directory, child));
      entries.push(`${child} ${stats.isDirectory() ? "d" : stats.size} ${stats.mtimeMs}`);
      if (stats.isDirectory()) pending.push(child);
    }
  }
  return entries.sort();
}

/**
 * Every regular file under `directory`, by relative POSIX path, with its bytes as hex; links unfollowed.
 * The entry type comes from the directory listing and the bytes from one descriptor whose own stat confirms a regular file, so no path is checked and then read.
 */
function contents(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const pending = [""];
  for (let relative = pending.pop(); relative !== undefined; relative = pending.pop()) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) pending.push(child);
      if (!entry.isFile()) continue;
      const descriptor = fs.openSync(path.join(directory, child), "r");
      try {
        if (!fs.fstatSync(descriptor).isFile()) throw new Error(`${child} is no longer a regular file`);
        files[child.split(path.sep).join("/")] = fs.readFileSync(descriptor).toString("hex");
      } finally {
        fs.closeSync(descriptor);
      }
    }
  }
  return files;
}

interface Run {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `bun <script> <args>` from the repository root under a timeout, and answers how it ended. */
function runBun(script: string, args: readonly string[]): Run {
  const run = Bun.spawnSync([process.execPath, script, ...args], {
    cwd: REPOSITORY_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

const runPack = (...args: string[]): Run => runBun(path.join(REPOSITORY_ROOT, "scripts", "providers-pack.ts"), args);

/** Lines of a child's output, CRLF or LF, without the empty one after the last newline. */
function lines(text: string): string[] {
  const split = text.split(/\r?\n/);
  if (split.at(-1) === "") split.pop();
  return split;
}

/** The sentence that closes a refused package. */
const wroteNothing = (directory: string): string => `${PREFIX}: ${directory}: wrote nothing for this package`;

describe("providers:pack", () => {
  test(
    "a planted provider package is packed with its dependency inside the artifact and admitted",
    async () => {
      const marker = randomUUID();
      const planted = root(alphaPackage(marker));
      const out = fresh("out");
      const result = pack(planted, out);
      expect(result.refusals).toEqual([]);
      const artifact = artifactDirectoryOf(out, { name: "@libredb/provider-alpha", version: "1.0.0" });
      expect(result.packed).toEqual([
        {
          name: "@libredb/provider-alpha",
          version: "1.0.0",
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          directory: artifact,
        },
      ]);
      const files = Object.keys(contents(artifact)).sort();
      expect(files).toEqual(["dist/index.mjs", MANIFEST_FILE_NAME, "package.json"].sort());
      expect(fs.readFileSync(path.join(artifact, "dist", "index.mjs"), "utf8")).toContain(marker);

      const locked = runBun(path.join(REPOSITORY_ROOT, "scripts", "providers-lock.ts"), ["--dir", out]);
      expect([locked.exitCode, locked.stderr]).toEqual([0, ""]);
      const lock = JSON.parse(fs.readFileSync(path.join(out, LOCK_FILE_NAME), "utf8"));
      expect(lock.entries.map((entry: { digest: string }) => entry.digest)).toEqual([result.packed[0]?.digest]);

      const read = readProvidersLock(out);
      if (!read.read) throw new Error(`the lock was refused: ${read.refusal.sentence}`);
      const [only] = read.packages;
      if (only === undefined || !only.verified)
        throw new Error(`the lock refused the package: ${JSON.stringify(only)}`);
      for (const { specifier } of only.imports) {
        expect([
          specifier,
          specifier.startsWith("./") || specifier.startsWith("../") || isNodeBuiltin(specifier),
        ]).toEqual([specifier, true]);
      }
      const admission = await admitPackage(only, {
        validator: hostManifestValidator(fs.readFileSync(SCHEMA_FILE)),
        heldNames: STUDIO_HELD_NAMES,
        deadlineMs: 10_000,
        onLateSettle: () => undefined,
      });
      const fixtureManifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, MANIFEST_FILE_NAME), "utf8"));
      expect(admission.admitted ? admission.engines : admission.refusal.sentence).toEqual(
        fixtureManifest.engines.map((engine: { id: string }) => engine.id),
      );
    },
    BUNDLING_TIMEOUT_MS,
  );

  test(
    "an output that imports a bare name, holds a native addon or a TypeScript file is refused by name, writing nothing",
    () => {
      const planted = root({
        ...writingPackage("provider-addon", "@libredb/provider-addon", {
          ...PLAIN_ENTRY,
          "dist/addon.node": "not an addon\n",
          "dist/second.NODE": "not an addon\n",
        }),
        ...writingPackage("provider-bare", "@libredb/provider-bare", {
          "dist/index.mjs": 'import "left-pad";\nimport "./util.cjs";\nexport default {};\n',
          "dist/util.cjs": 'require("ws");\nrequire("node:fs");\n',
        }),
        ...writingPackage(
          "provider-declared",
          "@libredb/provider-declared",
          PLAIN_ENTRY,
          minimalManifest("declared", { native: [] }),
        ),
        ...writingPackage("provider-types", "@libredb/provider-types", {
          ...PLAIN_ENTRY,
          "dist/types.d.ts": "export {};\n",
          "dist/extra.mts": "export {};\n",
        }),
        ...writingPackage("provider-valid", "@libredb/provider-valid", {
          "dist/index.mjs": 'import "node:fs";\nimport "./util.mjs";\nexport default {};\n',
          "dist/util.mjs": "export {};\n",
        }),
      });
      const out = fresh("out");
      const result = pack(planted, out);
      const at = (directory: string): string => path.join(planted, "packages", directory);
      expect(result.refusals).toEqual([
        `${PREFIX}: @libredb/provider-addon 1.0.0: dist/addon.node is a native addon, which this Studio does not admit yet`,
        `${PREFIX}: @libredb/provider-addon 1.0.0: dist/second.NODE is a native addon, which this Studio does not admit yet`,
        wroteNothing(at("provider-addon")),
        `${PREFIX}: @libredb/provider-bare 1.0.0: dist/index.mjs imports "left-pad", which is neither a relative path inside the package nor a Node.js built-in`,
        `${PREFIX}: @libredb/provider-bare 1.0.0: dist/util.cjs imports "ws", which is neither a relative path inside the package nor a Node.js built-in`,
        wroteNothing(at("provider-bare")),
        `${PREFIX}: @libredb/provider-declared 1.0.0: its manifest declares runtime.native, which this Studio does not admit yet`,
        wroteNothing(at("provider-declared")),
        `${PREFIX}: @libredb/provider-types 1.0.0: dist/extra.mts is a TypeScript file, which a package of this contract does not hold`,
        `${PREFIX}: @libredb/provider-types 1.0.0: dist/types.d.ts is a TypeScript file, which a package of this contract does not hold`,
        wroteNothing(at("provider-types")),
      ]);
      expect(result.packed.map((packed) => packed.name)).toEqual(["@libredb/provider-valid"]);
      expect(fs.readdirSync(out)).toEqual(["@libredb"]);
      expect(fs.readdirSync(path.join(out, "@libredb"))).toEqual(["provider-valid"]);
    },
    BUNDLING_TIMEOUT_MS,
  );

  test(
    "a package with no build script is refused by name",
    () => {
      const planted = root({
        ...writingPackage("provider-empty", "@libredb/provider-empty", PLAIN_ENTRY),
        "packages/provider-empty/package.json": packageJson("@libredb/provider-empty", { scripts: { build: "" } }),
        ...writingPackage("provider-none", "@libredb/provider-none", PLAIN_ENTRY),
        "packages/provider-none/package.json": packageJson("@libredb/provider-none", { scripts: undefined }),
        ...writingPackage("provider-test", "@libredb/provider-test", PLAIN_ENTRY),
        "packages/provider-test/package.json": packageJson("@libredb/provider-test", { scripts: { test: "true" } }),
      });
      const out = fresh("out");
      const result = pack(planted, out);
      const at = (directory: string): string => path.join(planted, "packages", directory);
      expect(result).toEqual({
        packed: [],
        refusals: ["provider-empty", "provider-none", "provider-test"].flatMap((directory) => [
          `${PREFIX}: ${at(directory)}: its package.json has no build script`,
          wroteNothing(at(directory)),
        ]),
      });
      expect(fs.readdirSync(out)).toEqual([]);

      // A package directory named on the command line with no package.json, or one that is not a JSON object.
      const missing = fresh("nopackage");
      fs.writeFileSync(path.join(missing, MANIFEST_FILE_NAME), minimalManifest("nopackage"));
      const array = fresh("arraypackage");
      fs.writeFileSync(path.join(array, "package.json"), "[]\n");
      expect(pack(planted, out, [missing, array])).toEqual({
        packed: [],
        refusals: [missing, array].flatMap((directory) => [
          `${PREFIX}: ${directory}: its package.json is missing, over its byte limit, or not a JSON object`,
          wroteNothing(directory),
        ]),
      });
      expect(fs.readdirSync(out)).toEqual([]);
    },
    BUNDLING_TIMEOUT_MS,
  );

  test(
    "two packs of one package in two directories give one digest",
    () => {
      const planted = root(alphaPackage(randomUUID()));
      const first = fresh("out");
      const second = fresh("out");
      const one = pack(planted, first);
      const two = pack(planted, second);
      expect([one.refusals, two.refusals]).toEqual([[], []]);
      expect(one.packed[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(two.packed[0]?.digest).toBe(one.packed[0]?.digest as string);
      expect(contents(second)).toEqual(contents(first));
    },
    BUNDLING_TIMEOUT_MS,
  );

  test(
    "the pack writes nothing into the repository",
    () => {
      const planted = root(alphaPackage(randomUUID()));
      const before = listing(planted);
      const temporaryRoot = fresh("temporary");
      const out = fresh("out");
      const result = pack(planted, out, [], { temporaryRoot });
      expect(result.refusals).toEqual([]);
      expect(result.packed).toHaveLength(1);
      expect(listing(planted)).toEqual(before);
      expect(fs.readdirSync(temporaryRoot)).toEqual([]);

      // An output or a temporary directory inside the repository is refused before any build.
      const inside = path.join(planted, "inside");
      fs.mkdirSync(inside);
      const withInside = listing(planted);
      expect(pack(planted, inside)).toEqual({
        packed: [],
        refusals: [`${PREFIX}: ${inside}: the output directory lies inside the repository ${planted}`],
      });
      expect(pack(planted, planted)).toEqual({
        packed: [],
        refusals: [`${PREFIX}: ${planted}: the output directory lies inside the repository ${planted}`],
      });
      expect(pack(planted, fresh("out"), [], { temporaryRoot: inside })).toEqual({
        packed: [],
        refusals: [`${PREFIX}: ${inside}: the temporary directory lies inside the repository ${planted}`],
      });
      expect(listing(planted)).toEqual(withInside);

      // A missing output, a file as the output, and a missing temporary directory.
      const absent = path.join(scratch, `absent-${randomUUID()}`);
      const file = path.join(fresh("file"), "notes.txt");
      fs.writeFileSync(file, "not a directory\n");
      expect(pack(planted, absent).refusals).toEqual([`${PREFIX}: ${absent}: the output directory does not exist`]);
      expect(pack(planted, file).refusals).toEqual([`${PREFIX}: ${file}: the output directory is not a directory`]);
      expect(pack(planted, fresh("out"), [], { temporaryRoot: absent }).refusals).toEqual([
        `${PREFIX}: ${absent}: the temporary directory does not exist`,
      ]);
      expect(listing(planted)).toEqual(withInside);
    },
    BUNDLING_TIMEOUT_MS,
  );

  test(
    "a destination <out>/<name>/<version> that lies inside the repository, by --out an ancestor of it or through a link under --out, is refused by name, writing nothing",
    () => {
      // A repository whose directory name is a package name, so that --out its parent puts that package inside it.
      const repository = path.join(fresh("ancestor"), "repository");
      const files: Record<string, string> = {
        ...writingPackage("provider-named", "repository", PLAIN_ENTRY),
        ...writingPackage("provider-linked", "@libredb/provider-linked", PLAIN_ENTRY),
        ...writingPackage("provider-plain", "@libredb/provider-plain", PLAIN_ENTRY),
      };
      for (const [relative, text] of Object.entries(files)) {
        const file = path.join(repository, ...relative.split("/"));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      }
      const inside = path.join(repository, "inside");
      fs.mkdirSync(inside);
      const at = (directory: string): string => path.join(repository, "packages", directory);
      const before = listing(repository);

      const ancestor = path.dirname(repository);
      const named = path.join(ancestor, "repository", "1.0.0");
      expect(pack(repository, ancestor, [at("provider-named")])).toEqual({
        packed: [],
        refusals: [`${PREFIX}: ${named} lies inside the repository ${repository}`, wroteNothing(at("provider-named"))],
      });
      expect(listing(repository)).toEqual(before);

      // A link at <out>/@libredb into the repository; a junction needs no privilege on Windows, and on POSIX the type
      // argument is ignored. A package of another scope under the same --out is still packed.
      const out = fresh("out");
      fs.symlinkSync(inside, path.join(out, "@libredb"), "junction");
      const linked = path.join(out, "@libredb", "provider-linked", "1.0.0");
      const result = pack(repository, out, [at("provider-linked"), at("provider-named")]);
      expect(result.refusals).toEqual([
        `${PREFIX}: ${linked} lies inside the repository ${repository}`,
        wroteNothing(at("provider-linked")),
      ]);
      expect(result.packed.map((packed) => packed.directory)).toEqual([path.join(out, "repository", "1.0.0")]);
      expect(listing(repository)).toEqual(before);
      fs.unlinkSync(path.join(out, "@libredb"));
    },
    BUNDLING_TIMEOUT_MS,
  );

  test(
    "a package with no manifest, a build that fails, writes no runtime.entry or writes a file the step copies, and an artifact already under the output are each refused by name",
    () => {
      const failure = randomUUID();
      const planted = root({
        ...writingPackage("provider-exists", "@libredb/provider-exists", PLAIN_ENTRY),
        ...writingPackage("provider-fails", "@libredb/provider-fails", PLAIN_ENTRY),
        "packages/provider-fails/build.mjs": `console.error(${JSON.stringify(failure)});\nprocess.exit(3);\n`,
        ...writingPackage("provider-manifest", "@libredb/provider-manifest", {
          ...PLAIN_ENTRY,
          [MANIFEST_FILE_NAME]: minimalManifest("manifest"),
        }),
        ...writingPackage("provider-noentry", "@libredb/provider-noentry", { "dist/other.mjs": "export {};\n" }),
        ...writingPackage("provider-nomanifest", "@libredb/provider-nomanifest", PLAIN_ENTRY),
        ...writingPackage("provider-outside", "../outside", PLAIN_ENTRY),
        ...writingPackage("provider-packagejson", "@libredb/provider-packagejson", {
          ...PLAIN_ENTRY,
          "package.json": "{}\n",
        }),
      });
      fs.rmSync(path.join(planted, "packages", "provider-nomanifest", MANIFEST_FILE_NAME));
      const out = fresh("out");
      const existing = artifactDirectoryOf(out, { name: "@libredb/provider-exists", version: "1.0.0" });
      fs.mkdirSync(existing, { recursive: true });
      const absent = path.join(planted, "packages", "provider-absent");
      const file = path.join(planted, "notes.txt");
      fs.writeFileSync(file, "not a package\n");

      const at = (directory: string): string => path.join(planted, "packages", directory);
      const result = pack(planted, out, [
        absent,
        file,
        ...[
          "provider-exists",
          "provider-fails",
          "provider-manifest",
          "provider-noentry",
          "provider-nomanifest",
          "provider-outside",
          "provider-packagejson",
        ].map(at),
      ]);
      expect(result.packed).toEqual([]);
      const failed = result.refusals[6] as string;
      expect(failed.split(/\r?\n/)[0]).toBe(`${PREFIX}: ${at("provider-fails")}: its build exited 3, and printed:`);
      expect(failed).toContain(failure);
      expect(result.refusals).toEqual([
        `${PREFIX}: ${absent}: the package directory does not exist`,
        wroteNothing(absent),
        `${PREFIX}: ${file}: the package directory is not a directory`,
        wroteNothing(file),
        `${PREFIX}: ${existing} already exists`,
        wroteNothing(at("provider-exists")),
        failed,
        wroteNothing(at("provider-fails")),
        `${PREFIX}: ${at("provider-manifest")}: its build wrote ${MANIFEST_FILE_NAME}, which the pack step copies from the package's directory`,
        wroteNothing(at("provider-manifest")),
        packageRefusal(
          { name: "@libredb/provider-noentry", version: "1.0.0" },
          { code: "PROVIDER_PATH_OUTSIDE", rule: "entry-not-a-file" },
        ).sentence,
        wroteNothing(at("provider-noentry")),
        `${PREFIX}: ${at("provider-nomanifest")}: it holds no ${MANIFEST_FILE_NAME}`,
        wroteNothing(at("provider-nomanifest")),
        `${PREFIX}: ${at("provider-outside")}: its package.json names no package name and version in the lock's forms`,
        wroteNothing(at("provider-outside")),
        `${PREFIX}: ${at("provider-packagejson")}: its build wrote package.json, which the pack step copies from the package's directory`,
        wroteNothing(at("provider-packagejson")),
      ]);
      expect(fs.readdirSync(existing)).toEqual([]);
      expect(fs.readdirSync(path.join(out, "@libredb"))).toEqual(["provider-exists"]);

      // A root that holds no provider package, with none named, packs nothing.
      const empty = root({ "packages/provider-sdk/package.json": packageJson("@libredb/provider-sdk") });
      expect(pack(empty, fresh("out"))).toEqual({
        packed: [],
        refusals: [`${PREFIX}: ${path.join(empty, "packages")} holds no provider package, and none was named`],
      });
    },
    BUNDLING_TIMEOUT_MS,
  );

  test(
    "the build runs in the package's directory with --outdir outside the repository and only the environment the step names",
    () => {
      const probe = `LIBREDB_PACK_PROBE_${randomUUID().replaceAll("-", "_")}`;
      const build = [
        'import { mkdirSync, readdirSync, writeFileSync } from "node:fs";',
        'import path from "node:path";',
        "const argv = process.argv.slice(2);",
        'const outdir = argv[argv.indexOf("--outdir") + 1];',
        'mkdirSync(path.join(outdir, "dist"), { recursive: true });',
        'writeFileSync(path.join(outdir, "dist", "index.mjs"), "export default {};\\n");',
        "const home = process.env.HOME;",
        'writeFileSync(path.join(outdir, "probe.json"), JSON.stringify({',
        "  cwd: process.cwd(),",
        "  argv,",
        "  env: Object.keys(process.env),",
        "  home,",
        "  userProfile: process.env.USERPROFILE,",
        "  homeEntries: readdirSync(home),",
        "}));",
        "",
      ].join("\n");
      const planted = root({
        ...writingPackage("provider-probe", "@libredb/provider-probe", PLAIN_ENTRY),
        "packages/provider-probe/build.mjs": build,
      });
      const out = fresh("out");
      const caller = { ...process.env, [probe]: "1", NODE_OPTIONS: "--max-old-space-size=300", NODE_PATH: scratch };
      const result = pack(planted, out, [], { environment: caller });
      expect(result.refusals).toEqual([]);
      const artifact = artifactDirectoryOf(out, { name: "@libredb/provider-probe", version: "1.0.0" });
      const seen = JSON.parse(fs.readFileSync(path.join(artifact, "probe.json"), "utf8"));

      expect(fs.realpathSync.native(seen.cwd)).toBe(path.join(planted, "packages", "provider-probe"));
      expect(seen.argv).toHaveLength(2);
      expect(seen.argv[0]).toBe("--outdir");
      const outdir: string = seen.argv[1];
      expect(path.isAbsolute(outdir)).toBe(true);
      expect(path.relative(planted, outdir).startsWith("..")).toBe(true);
      expect(path.basename(outdir)).toBe("artifact");

      // Every caller variable the step does not name is absent; `bun run` adds NODE, PWD and npm_* of its own.
      const named = new Set(["path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp", "tmpdir"]);
      const added = (key: string): boolean => key === "NODE" || key === "PWD" || key.startsWith("npm_");
      const leaked = Object.keys(caller).filter(
        (key) => !named.has(key.toLowerCase()) && !added(key) && key !== "HOME" && key !== "USERPROFILE",
      );
      expect(leaked).toContain(probe);
      expect(seen.env.filter((key: string) => leaked.includes(key))).toEqual([]);
      expect(seen.env).not.toContain("NODE_OPTIONS");
      expect(seen.env).not.toContain("NODE_PATH");

      // HOME and USERPROFILE name one empty directory outside the repository, not the caller's home.
      expect(seen.userProfile).toBe(seen.home);
      expect(path.isAbsolute(seen.home)).toBe(true);
      expect(path.relative(planted, seen.home).startsWith("..")).toBe(true);
      expect(seen.home).not.toBe(homedir());
      expect(seen.homeEntries).toEqual([]);
    },
    BUNDLING_TIMEOUT_MS,
  );

  test(
    "the command takes an absolute --out and absolute package directories, exits 2 on any other command line, 1 on a refusal and 0 with one line per packed package",
    () => {
      const out = fresh("out");
      for (const args of [
        [],
        ["--out"],
        ["--out", "relative"],
        ["--out", out, "relative"],
        ["--frob"],
        ["--out", out, "--frob"],
      ]) {
        const run = runPack(...args);
        expect([args, run.exitCode, run.stdout, lines(run.stderr)]).toEqual([args, 2, "", [USAGE]]);
      }
      const planted = root({
        ...writingPackage("provider-good", "@libredb/provider-good", PLAIN_ENTRY),
        ...writingPackage("provider-bad", "@libredb/provider-bad", { "dist/index.mjs": 'import "left-pad";\n' }),
      });
      const bad = path.join(planted, "packages", "provider-bad");
      const refused = runPack("--out", out, bad);
      expect([refused.exitCode, refused.stdout, lines(refused.stderr)]).toEqual([
        1,
        "",
        [
          `${PREFIX}: @libredb/provider-bad 1.0.0: dist/index.mjs imports "left-pad", which is neither a relative path inside the package nor a Node.js built-in`,
          wroteNothing(bad),
        ],
      ]);
      const packed = runPack("--out", out, path.join(planted, "packages", "provider-good"));
      expect([packed.exitCode, packed.stderr]).toEqual([0, ""]);
      expect(lines(packed.stdout)).toEqual([
        expect.stringMatching(/^@libredb\/provider-good 1\.0\.0 sha256:[0-9a-f]{64}$/),
      ]);
      expect(fs.readdirSync(path.join(out, "@libredb"))).toEqual(["provider-good"]);
    },
    BUNDLING_TIMEOUT_MS,
  );
  test(
    "an output that calls createRequire is refused by name",
    () => {
      const planted = root({
        ...writingPackage("provider-create", "@libredb/provider-create", {
          "dist/index.mjs": [
            'import { createRequire } from "node:module";',
            "const load = createRequire(import.meta.url);",
            'export default load("x");',
            "",
          ].join("\n"),
        }),
        ...writingPackage("provider-namespace", "@libredb/provider-namespace", {
          "dist/index.mjs": [
            'import * as m from "node:module";',
            "// createRequire in a comment is not a name",
            'const load = m["createRequire"](import.meta.url);',
            "export const other = m[`createRequire`];",
            'export const words = "no createRequire here";',
            'export default load("x");',
            "",
          ].join("\n"),
        }),
      });
      const out = fresh("out");
      const at = (directory: string): string => path.join(planted, "packages", directory);
      expect(pack(planted, out)).toEqual({
        packed: [],
        refusals: [
          `${PREFIX}: @libredb/provider-create 1.0.0: dist/index.mjs line 1 names createRequire`,
          `${PREFIX}: @libredb/provider-create 1.0.0: dist/index.mjs line 2 names createRequire`,
          wroteNothing(at("provider-create")),
          `${PREFIX}: @libredb/provider-namespace 1.0.0: dist/index.mjs line 3 names createRequire`,
          `${PREFIX}: @libredb/provider-namespace 1.0.0: dist/index.mjs line 4 names createRequire`,
          wroteNothing(at("provider-namespace")),
        ],
      });
      expect(fs.readdirSync(out)).toEqual([]);
    },
    BUNDLING_TIMEOUT_MS,
  );

  test(
    "an output that reads require other than to call it with a string, or calls import() or require() with anything but a string, is refused by name",
    () => {
      // esbuild's `require` shim in an ES module bundle, as it writes it: under Node.js it throws for every name it
      // is called with, and under Bun it loads it.
      const shim =
        'var __require = ((x) => typeof require !== "undefined" ? require : x)(function(x) { if (typeof require !== "undefined") return require.apply(this, arguments); throw Error("Dynamic require of \\"" + x + "\\" is not supported"); });';
      const planted = root({
        ...writingPackage("provider-alias", "@libredb/provider-alias", {
          ...PLAIN_ENTRY,
          "dist/alias.cjs": 'const r = require;\nr("x");\n',
        }),
        ...writingPackage("provider-computed", "@libredb/provider-computed", {
          ...PLAIN_ENTRY,
          "dist/computed.cjs":
            'const name = "x";\nrequire(name);\nrequire(`a${name}`);\nrequire();\nrequire(...[name]);\n',
        }),
        ...writingPackage("provider-controls", "@libredb/provider-controls", {
          "dist/index.mjs": [
            'import "./two.cjs";',
            'import "./five.mjs";',
            'import { require as req } from "./four.mjs";',
            'export default await import("./four.mjs");',
            "export const also = await import(`./four.mjs`);",
            "const obj = { require: req };",
            "export const read = obj.require;",
            "require: for (;;) break require;",
            "class K { require() {} static require = 1; }",
            "export { K as require };",
            'export { require as again } from "./four.mjs";',
            "",
          ].join("\n"),
          "dist/two.cjs": 'require("./three.cjs");\nrequire(`./three.cjs`);\nrequire?.("./three.cjs");\n',
          "dist/three.cjs": "exports.x = 1;\n",
          "dist/four.mjs": "const x = 1;\nexport { x as require };\n",
          "dist/five.mjs": 'export * as require from "./four.mjs";\n',
        }),
        ...writingPackage("provider-declared", "@libredb/provider-declared", {
          ...PLAIN_ENTRY,
          "dist/declared.cjs":
            "function require() {}\nconst { require: other } = module;\n{\n  const { require } = module;\n}\n",
        }),
        ...writingPackage("provider-dynamic", "@libredb/provider-dynamic", {
          "dist/index.mjs":
            'const name = "./x.mjs";\nexport const one = await import(name);\nexport default await import(`./${name}`);\n',
        }),
        ...writingPackage("provider-member", "@libredb/provider-member", {
          ...PLAIN_ENTRY,
          "dist/member.cjs":
            'module.require("x");\nprocess.mainModule.require("y");\nmodule["require"]("z");\nmodule?.require("w");\n',
        }),
        ...writingPackage("provider-shim", "@libredb/provider-shim", {
          "dist/index.mjs": `${shim}\n__require("events");\nexport default {};\n`,
        }),
      });
      const out = fresh("out");
      const at = (directory: string): string => path.join(planted, "packages", directory);
      const reads = "reads require other than to call it with a string";
      const computedRequire = "calls require() with something other than a string";
      const computedImport = "calls import() with something other than a string";
      const member = "calls a member named require";
      const result = pack(planted, out);
      expect(result.refusals).toEqual([
        `${PREFIX}: @libredb/provider-alias 1.0.0: dist/alias.cjs line 1 ${reads}`,
        wroteNothing(at("provider-alias")),
        `${PREFIX}: @libredb/provider-computed 1.0.0: dist/computed.cjs line 2 ${computedRequire}`,
        `${PREFIX}: @libredb/provider-computed 1.0.0: dist/computed.cjs line 3 ${computedRequire}`,
        `${PREFIX}: @libredb/provider-computed 1.0.0: dist/computed.cjs line 4 ${computedRequire}`,
        `${PREFIX}: @libredb/provider-computed 1.0.0: dist/computed.cjs line 5 ${computedRequire}`,
        wroteNothing(at("provider-computed")),
        `${PREFIX}: @libredb/provider-declared 1.0.0: dist/declared.cjs line 1 ${reads}`,
        `${PREFIX}: @libredb/provider-declared 1.0.0: dist/declared.cjs line 4 ${reads}`,
        wroteNothing(at("provider-declared")),
        `${PREFIX}: @libredb/provider-dynamic 1.0.0: dist/index.mjs line 2 ${computedImport}`,
        `${PREFIX}: @libredb/provider-dynamic 1.0.0: dist/index.mjs line 3 ${computedImport}`,
        wroteNothing(at("provider-dynamic")),
        `${PREFIX}: @libredb/provider-member 1.0.0: dist/member.cjs line 1 ${member}`,
        `${PREFIX}: @libredb/provider-member 1.0.0: dist/member.cjs line 2 ${member}`,
        `${PREFIX}: @libredb/provider-member 1.0.0: dist/member.cjs line 3 ${member}`,
        `${PREFIX}: @libredb/provider-member 1.0.0: dist/member.cjs line 4 ${member}`,
        wroteNothing(at("provider-member")),
        `${PREFIX}: @libredb/provider-shim 1.0.0: dist/index.mjs line 1 ${reads}`,
        wroteNothing(at("provider-shim")),
      ]);
      expect(result.packed.map((packed) => packed.name)).toEqual(["@libredb/provider-controls"]);
      expect(fs.readdirSync(path.join(out, "@libredb"))).toEqual(["provider-controls"]);
    },
    BUNDLING_TIMEOUT_MS,
  );
});
