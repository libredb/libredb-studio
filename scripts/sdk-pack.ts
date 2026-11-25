#!/usr/bin/env bun
/**
 * Packs the provider SDK, packages/provider-sdk, into a tarball of built ES modules with declarations, which a
 * developer outside the repository installs with npm and builds a provider against under Node or Bun
 * (docs/TOOLCHAIN.md, "The SDK tarball").
 *
 * The repository's manifest points `types` and every `exports` entry at the SDK's TypeScript source, and every
 * in-repository consumer (Next.js, the library build, the VS Code extension's bundles, the type check and Bun's tests
 * and scripts) resolves that source. The packed manifest must point at `dist/` instead. It is written here, at pack
 * time, by one rule over the repository's manifest (`publishedManifest`), and the repository's manifest never changes:
 * - Standard conditional exports (`types` and `default` targets under `dist/`) would make every one of those consumers
 *   read `dist/`, so Studio would build and test against a build output, failing when it is absent and passing
 *   silently when it is stale.
 * - A custom condition listed first selects the source only in a tool configured with it (`bun --conditions`,
 *   esbuild's `conditions`, TypeScript's `customConditions`), and Turbopack documents no way to take one, so
 *   `next build` would read `dist/`; an unconfigured tool would read `dist/` without a word.
 * - Either form is an `exports` target that is not a path string under `src/`, which the source plane test
 *   (tests/unit/source-plane.test.ts) and `workspacePackageSourcePaths` (scripts/workspace-packages.mjs, read when
 *   tsup.config.ts loads) refuse.
 * - `publishConfig.exports` and `publishConfig.types` are copied into the tarball verbatim by both packers the
 *   repository has, npm 11 and `bun pm pack`, so the tarball's `exports` would name source files it does not hold.
 *
 * The build and the staged package live in a temporary directory outside the repository, removed when the pack ends,
 * so nothing is written under packages/provider-sdk/: a package-local `dist/` would be linted by ESLint and taken by
 * the root type check on a developer's machine, and never in CI.
 *
 * The build is tsup's `build()`, with every option stated and the build tsconfig named
 * (packages/provider-sdk/tsconfig.build.json). tsup also reads the working directory: it adds the `dependencies` and
 * `peerDependencies` of the working directory's package.json to its externals and takes the output extension from its
 * `type`, and esbuild resolves relative paths against the working directory it saw when it loaded. So `packSdk`
 * changes into the SDK directory before it loads tsup, sets esbuild's `absWorkingDir` to it as well, and changes back
 * when the build ends, so tsup's own reads agree with the options stated here.
 *
 * The packed package keeps `"private": true`: neither packer requires it removed, npm installs a private tarball, and
 * npm refuses to publish one, which this command never does.
 *
 * Installing the tarball needs its dependency, ajv, from a registry or as a tarball beside it; the pack test
 * (packages/provider-sdk/tests/pack.test.ts) packs ajv's closure from the repository's install and installs offline.
 *
 * Run: bun run sdk:pack -- --out <dir>
 * `<dir>` is resolved against the working directory and created when absent. The tarball's absolute path is the only
 * line on standard output. A refusal is one `sdk:pack: <sentence>` line on standard error and exit 1; a command line
 * other than `--out <dir>` prints the usage line and exits 2 before any build.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** The SDK's directory in the repository. */
export const SDK_DIRECTORY = path.join(REPO_ROOT, "packages", "provider-sdk");

/** The compiler options the build reads, named so no tool discovers them and the build inherits nothing else. */
export const SDK_BUILD_TSCONFIG = path.join(SDK_DIRECTORY, "tsconfig.build.json");

const USAGE = "Usage: bun run sdk:pack -- --out <dir>";

/** A package manifest, as JSON.parse answers it. */
type Manifest = Readonly<Record<string, unknown>>;

/** The one form of the command line, `--out <dir>`, or null for any other. */
export function parsePackArguments(argv: readonly string[]): { out: string } | null {
  const [flag, out, ...rest] = argv;
  if (flag !== "--out" || out === undefined || out.startsWith("--") || rest.length > 0) return null;
  return { out };
}

/** The `<p>` and extension of a target `./src/<p>.ts` or `./src/<p>.json`, or null for any other value. */
function sourceTarget(target: unknown): { stem: string; extension: ".ts" | ".json" } | null {
  if (typeof target !== "string" || !target.startsWith("./src/")) return null;
  for (const extension of [".ts", ".json"] as const) {
    if (target.endsWith(extension) && target.length > "./src/".length + extension.length) {
      return { stem: target.slice("./src/".length, -extension.length), extension };
    }
  }
  return null;
}

/** The manifest's `exports` object; a manifest that is not an ES module or has no exports object is refused. */
function exportsOf(manifest: Manifest): Readonly<Record<string, unknown>> {
  if (manifest.type !== "module") {
    throw new Error(`the SDK's package.json "type" is ${JSON.stringify(manifest.type)}, not "module"`);
  }
  const exports = manifest.exports;
  if (exports === null || typeof exports !== "object" || Array.isArray(exports)) {
    throw new Error("the SDK's package.json has no exports object");
  }
  return exports as Readonly<Record<string, unknown>>;
}

/** Each `exports` entry's subpath and source target; an entry that is not one TypeScript or JSON file under src/ is refused. */
function sourceEntries(manifest: Manifest): { subpath: string; stem: string; extension: ".ts" | ".json" }[] {
  return Object.entries(exportsOf(manifest)).map(([subpath, target]) => {
    const source = sourceTarget(target);
    if (source === null) {
      throw new Error(
        `exports ${JSON.stringify(subpath)} is ${JSON.stringify(target)}, not one TypeScript or JSON file under ./src/`,
      );
    }
    return { subpath, stem: source.stem, extension: source.extension };
  });
}

/**
 * The manifest the tarball carries: the repository's, with `types` and each `exports` entry `./src/<p>.ts` pointed at
 * `./dist/<p>.d.ts` and `{ "types": "./dist/<p>.d.ts", "default": "./dist/<p>.js" }`, and each entry `./src/<p>.json`
 * at `./dist/<p>.json`. Every other field is copied as it is, in its order.
 */
export function publishedManifest(manifest: Manifest): Record<string, unknown> {
  const exports = Object.fromEntries(
    sourceEntries(manifest).map(({ subpath, stem, extension }) => [
      subpath,
      extension === ".json" ? `./dist/${stem}.json` : { types: `./dist/${stem}.d.ts`, default: `./dist/${stem}.js` },
    ]),
  );
  const types = sourceTarget(manifest.types);
  if (types === null || types.extension !== ".ts") {
    throw new Error(`types is ${JSON.stringify(manifest.types)}, not one TypeScript file under ./src/`);
  }
  const published: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(manifest)) {
    if (field === "exports") published[field] = exports;
    else if (field === "types") published[field] = `./dist/${types.stem}.d.ts`;
    else published[field] = value;
  }
  return published;
}

/** What the build makes: the tsup entries, keyed by their path under dist/, and the files copied as they are. */
export interface BuildPlan {
  readonly entries: Readonly<Record<string, string>>;
  readonly copies: readonly { readonly from: string; readonly to: string }[];
}

/** The build entry of each TypeScript entry and the copy of each JSON entry, as absolute paths under `sdkDirectory`. */
export function buildPlan(manifest: Manifest, sdkDirectory: string): BuildPlan {
  const entries: Record<string, string> = {};
  const copies: { from: string; to: string }[] = [];
  for (const { stem, extension } of sourceEntries(manifest)) {
    const from = path.join(sdkDirectory, "src", ...`${stem}${extension}`.split("/"));
    if (extension === ".ts") entries[stem] = from;
    else copies.push({ from, to: path.join("dist", ...`${stem}${extension}`.split("/")) });
  }
  return { entries, copies };
}

/** Every published target, as `<field> <target>`, that the staged package at `stagedDirectory` does not hold. */
export function missingPublishedFiles(published: Manifest, stagedDirectory: string): string[] {
  const targets: { label: string; target: string }[] = [{ label: "types", target: published.types as string }];
  for (const [subpath, target] of Object.entries(published.exports as Record<string, unknown>)) {
    const label = `exports[${JSON.stringify(subpath)}]`;
    if (typeof target === "string") targets.push({ label, target });
    else {
      for (const [condition, leaf] of Object.entries(target as Record<string, string>)) {
        targets.push({ label: `${label}.${condition}`, target: leaf });
      }
    }
  }
  return targets
    .filter(({ target }) => !existsSync(path.join(stagedDirectory, ...target.split("/"))))
    .map(({ label, target }) => `${label} ${target}`);
}

/** Builds the SDK into a staged package outside the repository, packs it into `out` and answers the tarball's path. */
export async function packSdk(out: string): Promise<string> {
  const manifest = JSON.parse(readFileSync(path.join(SDK_DIRECTORY, "package.json"), "utf8")) as Manifest;
  const published = publishedManifest(manifest);
  const plan = buildPlan(manifest, SDK_DIRECTORY);
  const temp = mkdtempSync(path.join(realpathSync(tmpdir()), "libredb-sdk-pack-"));
  try {
    const staged = path.join(temp, "package");
    const previous = process.cwd();
    process.chdir(SDK_DIRECTORY);
    try {
      const { build } = await import("tsup");
      await build({
        config: false,
        entry: { ...plan.entries },
        outDir: path.join(staged, "dist"),
        format: ["esm"],
        platform: "node",
        target: "node24",
        splitting: true,
        dts: true,
        sourcemap: false,
        minify: false,
        removeNodeProtocol: false,
        external: Object.keys((manifest.dependencies ?? {}) as Record<string, string>),
        outExtension: () => ({ js: ".js", dts: ".d.ts" }),
        tsconfig: SDK_BUILD_TSCONFIG,
        esbuildOptions(options) {
          options.absWorkingDir = SDK_DIRECTORY;
        },
        silent: true,
      });
    } finally {
      process.chdir(previous);
    }
    for (const copy of plan.copies) {
      mkdirSync(path.dirname(path.join(staged, copy.to)), { recursive: true });
      copyFileSync(copy.from, path.join(staged, copy.to));
    }
    copyFileSync(path.join(REPO_ROOT, "LICENSE"), path.join(staged, "LICENSE"));
    writeFileSync(path.join(staged, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
    const missing = missingPublishedFiles(published, staged);
    if (missing.length > 0) throw new Error(`the built package lacks ${missing.join(", ")}`);

    mkdirSync(out, { recursive: true });
    const pack = Bun.spawnSync([process.execPath, "pm", "pack", "--quiet", "--ignore-scripts", "--destination", out], {
      cwd: staged,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (pack.exitCode !== 0) {
      throw new Error(`bun pm pack exited ${pack.exitCode}: ${pack.stderr.toString().trim()}`);
    }
    return pack.stdout.toString().trim();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parsePackArguments(argv);
  if (parsed === null) {
    console.error(USAGE);
    return 2;
  }
  try {
    console.log(await packSdk(path.resolve(parsed.out)));
    return 0;
  } catch (error) {
    console.error(`sdk:pack: ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
