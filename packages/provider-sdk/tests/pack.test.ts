/**
 * The SDK packs into a tarball a developer outside the repository installs with npm and builds against, under Node
 * and under Bun, with types (docs/TOOLCHAIN.md, "The SDK tarball").
 *
 * The test runs the script `bun run sdk:pack` runs, `bun scripts/sdk-pack.ts`, from the repository root into a
 * temporary directory, with no `bun run` between it and the test, so the step's timeout kills the process that builds.
 * It lists and extracts the tarball it writes, installs it with npm into an empty directory beside it, offline, and
 * imports and type-checks the installed package there. Every step is a child process with a timeout of its own, run once and shared by the tests that need
 * it; the steps' machinery is packages/provider-sdk/tests/helpers/packed-sdk.ts. The build runs in the child, from the
 * SDK's source, every time, so the tarball can never be stale.
 *
 * Each subpath's export names are compared with what this process imports of the same subpath, which resolves the
 * SDK's source through the workspace link, so the packed surface is the source's surface, measured on both sides.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { compileManifestValidator } from "@libredb/provider-sdk/manifest";
import {
  ancestorNodeModules,
  type ChildResult,
  childEnvironment,
  dependencyClosure,
  npmCommand,
  runChild,
  succeeded,
} from "./helpers/packed-sdk";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..");
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const SDK_NAME = "@libredb/provider-sdk";
const SOURCE_MANIFEST_TEXT = readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8");
const SOURCE_MANIFEST = JSON.parse(SOURCE_MANIFEST_TEXT) as {
  readonly exports: Readonly<Record<string, string>>;
  readonly [field: string]: unknown;
};
/** The subpaths whose entry is a TypeScript module, in the manifest's order. */
const MODULE_SUBPATHS = Object.entries(SOURCE_MANIFEST.exports)
  .filter(([, target]) => target.endsWith(".ts"))
  .map(([subpath]) => subpath);
/** How long one test may wait on the shared steps; each step's own timeout is shorter, so it fails first, by name. */
const TEST_TIMEOUT_MS = 200_000;

/** The specifier that imports `subpath` of the SDK. */
function specifierOf(subpath: string): string {
  return subpath === "." ? SDK_NAME : `${SDK_NAME}/${subpath.slice(2)}`;
}

/** The node on PATH; no node fails by name. */
function nodeBinary(): string {
  const node = Bun.which("node");
  if (node === null) throw new Error("No node on PATH: the pack test imports the packed SDK under Node");
  return node;
}

/**
 * The consumer's probe, run under Node and Bun with the subpaths as its argument: every subpath's export names or the
 * error that stopped its import, every name two entries both export as different objects, the calls entry's two
 * functions, and the contract of a validator compiled from the packed schema, read by path and imported as JSON.
 */
const PROBE = `import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const subpaths = JSON.parse(process.argv[2]);
const report = { entries: {}, failures: {}, divergent: [], calls: null, validator: null };
const modules = {};
for (const subpath of subpaths) {
  const specifier = subpath === "." ? "${SDK_NAME}" : "${SDK_NAME}/" + subpath.slice(2);
  try {
    modules[subpath] = await import(specifier);
    report.entries[subpath] = Object.keys(modules[subpath]).sort();
  } catch (error) {
    report.failures[subpath] = (error.code ?? error.name) + ": " + String(error.message).split("\\n")[0];
  }
}
const loaded = Object.keys(modules);
for (const a of loaded) {
  for (const b of loaded) {
    if (a >= b) continue;
    for (const name of report.entries[a]) {
      if (name in modules[b] && modules[a][name] !== modules[b][name]) report.divergent.push(a + " " + b + " " + name);
    }
  }
}
if (modules["./calls"] !== undefined) {
  report.calls = {
    defineProvider: typeof modules["./calls"].defineProvider,
    checkProviderModule: typeof modules["./calls"].checkProviderModule,
  };
}
try {
  const schemaFile = createRequire(import.meta.url).resolve("${SDK_NAME}/manifest.schema.json");
  const { compileManifestValidator } = await import("${SDK_NAME}/manifest");
  const imported = await import("${SDK_NAME}/manifest.schema.json", { with: { type: "json" } });
  report.validator = { contract: compileManifestValidator(readFileSync(schemaFile)).contract, schemaId: imported.default.$id };
} catch (error) {
  report.validator = { failure: (error.code ?? error.name) + ": " + String(error.message).split("\\n")[0] };
}
process.stdout.write(JSON.stringify(report) + "\\n");
`;

/** The consumer's TypeScript file: it imports defineProvider and the other names a provider starts from. */
const CONSUMER_SOURCE = `import { checkProviderModule, defineProvider, type CallContext } from "${SDK_NAME}/calls";
import { compileManifestValidator } from "${SDK_NAME}/manifest";
import type { SqlGrammar } from "${SDK_NAME}/sql";
export const define: typeof defineProvider = defineProvider;
export const check: typeof checkProviderModule = checkProviderModule;
export type Context = CallContext;
export type Grammar = SqlGrammar;
export const compile = compileManifestValidator;
`;

/** The consumer's compiler options: Node's own module resolution, strict, every declaration checked, no path mapping. */
const CONSUMER_TSCONFIG = {
  compilerOptions: {
    module: "nodenext",
    moduleResolution: "nodenext",
    target: "es2023",
    lib: ["es2023"],
    types: ["node"],
    strict: true,
    noEmit: true,
    skipLibCheck: false,
  },
  files: ["provider.ts"],
};

interface ProbeReport {
  readonly entries: Record<string, string[]>;
  readonly failures: Record<string, string>;
  readonly divergent: string[];
  readonly calls: { defineProvider: string; checkProviderModule: string } | null;
  readonly validator: { contract?: string; schemaId?: string; failure?: string };
}

const temp = mkdtempSync(path.join(realpathSync(tmpdir()), "provider-sdk-pack-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const home = path.join(temp, "home");
const npmFiles = { userConfig: path.join(temp, "npmrc-user"), globalConfig: path.join(temp, "npmrc-global") };
const env = childEnvironment(process.env, home);

/** npm's flags for every call: offline, with its own empty cache and empty user and global configs. */
function npmFlags(cache: string): string[] {
  return [
    "--offline",
    "--cache",
    cache,
    "--userconfig",
    npmFiles.userConfig,
    "--globalconfig",
    npmFiles.globalConfig,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "--loglevel=error",
  ];
}

/** Runs npm with `args` in `cwd`. */
function npm(args: readonly string[], cwd: string, timeoutMs: number): Promise<ChildResult> {
  const command = npmCommand({ platform: process.platform, which: (name) => Bun.which(name), exists: existsSync });
  return runChild([...command, ...args], { cwd, env, timeoutMs });
}

/** An empty ES module package to install into. */
function consumerDirectory(name: string): string {
  const directory = path.join(temp, name);
  mkdirSync(directory);
  writeFileSync(path.join(directory, "package.json"), `${JSON.stringify({ name, private: true, type: "module" })}\n`);
  return directory;
}

interface Packed {
  /** The tarball's absolute path, as the pack printed it. */
  readonly tarball: string;
  /** The `.tgz` files in the out directory. */
  readonly tarballs: string[];
  /** The tarball's entries, as tar lists them. */
  readonly entries: string[];
  /** The extracted package directory. */
  readonly packageDirectory: string;
  /** The packed manifest. */
  readonly manifest: Record<string, unknown> & { readonly exports: Record<string, unknown> };
}

let packedStep: Promise<Packed> | undefined;

/** Packs the SDK with the script `bun run sdk:pack` runs, then lists and extracts the tarball. */
function packed(): Promise<Packed> {
  packedStep ??= (async () => {
    const ancestor = ancestorNodeModules(temp, existsSync);
    if (ancestor !== null) {
      throw new Error(
        `${ancestor} holds node_modules above the temporary directory ${temp}, so the installed SDK could resolve a package it does not declare. Point TMPDIR (TEMP on Windows) at a directory with no node_modules above it.`,
      );
    }
    mkdirSync(home);
    writeFileSync(npmFiles.userConfig, "");
    writeFileSync(npmFiles.globalConfig, "");
    const out = path.join(temp, "out");
    const pack = succeeded(
      "bun scripts/sdk-pack.ts",
      await runChild([process.execPath, "scripts/sdk-pack.ts", "--out", out], {
        cwd: REPOSITORY_ROOT,
        env,
        timeoutMs: 120_000,
      }),
    );
    const tarball = pack.stdout.trim();
    const listed = succeeded(
      "tar -tzf",
      await runChild(["tar", "-tzf", path.basename(tarball)], { cwd: out, env, timeoutMs: 30_000 }),
    );
    const extracted = path.join(temp, "extracted");
    mkdirSync(extracted);
    succeeded(
      "tar -xzf",
      await runChild(["tar", "-xzf", path.basename(tarball), "-C", path.join("..", "extracted")], {
        cwd: out,
        env,
        timeoutMs: 30_000,
      }),
    );
    const packageDirectory = path.join(extracted, "package");
    return {
      tarball,
      tarballs: readdirSync(out).filter((name) => name.endsWith(".tgz")),
      entries: listed.stdout.split("\n").filter((line) => line !== ""),
      packageDirectory,
      manifest: JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8")),
    };
  })();
  return packedStep;
}

let installedStep: Promise<string> | undefined;

/** Installs the tarball and its dependencies' closure, packed from the repository's install, into an empty directory. */
function installed(): Promise<string> {
  installedStep ??= (async () => {
    const { tarball, manifest } = await packed();
    const cache = path.join(temp, "npm-cache");
    const directories = dependencyClosure(
      [...Object.keys((manifest.dependencies ?? {}) as Record<string, string>), "@types/node"],
      PACKAGE_ROOT,
      existsSync,
      (directory) => JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")),
    );
    const deps = path.join(temp, "deps");
    mkdirSync(deps);
    const pack = succeeded(
      "npm pack of the dependency closure",
      await npm(["pack", ...directories, "--json", "--pack-destination", deps, ...npmFlags(cache)], deps, 60_000),
    );
    const closure = (JSON.parse(pack.stdout) as { filename: string }[]).map((item) => path.join(deps, item.filename));
    const consumer = consumerDirectory("consumer");
    succeeded(
      "npm install of the SDK tarball",
      await npm(["install", tarball, ...closure, "--no-save", ...npmFlags(cache)], consumer, 60_000),
    );
    return consumer;
  })();
  return installedStep;
}

const probeSteps = new Map<string, Promise<ProbeReport>>();

/** The probe's report under `runtime`, run in the installed consumer. */
function probe(runtime: "node" | "bun"): Promise<ProbeReport> {
  let step = probeSteps.get(runtime);
  if (step === undefined) {
    step = (async () => {
      const consumer = await installed();
      const file = path.join(consumer, `probe-${runtime}.mjs`);
      writeFileSync(file, PROBE);
      const command =
        runtime === "node"
          ? [nodeBinary(), "--max-old-space-size=256", file]
          : [process.execPath, "--no-install", file];
      const result = succeeded(
        `the ${runtime} probe`,
        await runChild([...command, JSON.stringify(MODULE_SUBPATHS)], { cwd: consumer, env, timeoutMs: 30_000 }),
      );
      return JSON.parse(result.stdout.trim().split("\n").at(-1) as string) as ProbeReport;
    })();
    probeSteps.set(runtime, step);
  }
  return step;
}

/** What this process imports of every subpath: the SDK's source, through the workspace link. */
async function sourceEntries(): Promise<Record<string, string[]>> {
  return Object.fromEntries(
    await Promise.all(
      MODULE_SUBPATHS.map(async (subpath) => [subpath, Object.keys(await import(specifierOf(subpath))).sort()]),
    ),
  );
}

/** A manifest without its two entry point fields, `exports` and `types`. */
function withoutEntryPoints(manifest: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(manifest).filter(([field]) => field !== "exports" && field !== "types"));
}

/** The probe's report under Node and under Bun, run side by side. */
async function probeReports(): Promise<{ runtime: "node" | "bun"; report: ProbeReport }[]> {
  const runtimes = ["node", "bun"] as const;
  const reports = await Promise.all(runtimes.map((runtime) => probe(runtime)));
  return runtimes.map((runtime, index) => ({ runtime, report: reports[index] as ProbeReport }));
}

/** Every file under `directory`, as sorted POSIX paths relative to it. */
function filesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

/** The TypeScript checker's export names of every subpath, resolved from `fromFile` with `options`. */
function declaredNames(fromFile: string, options: ts.CompilerOptions): Record<string, string[]> {
  const resolved = MODULE_SUBPATHS.map((subpath) => {
    const resolvedModule = ts.resolveModuleName(specifierOf(subpath), fromFile, options, ts.sys).resolvedModule;
    if (resolvedModule === undefined) {
      throw new Error(`TypeScript does not resolve ${specifierOf(subpath)} from ${fromFile}`);
    }
    return [subpath, resolvedModule.resolvedFileName] as const;
  });
  const program = ts.createProgram(
    resolved.map(([, file]) => file),
    options,
  );
  const checker = program.getTypeChecker();
  const names: Record<string, string[]> = {};
  for (const [subpath, file] of resolved) {
    const symbol = checker.getSymbolAtLocation(program.getSourceFile(file) as ts.SourceFile);
    if (symbol === undefined) throw new Error(`${file} is not a module`);
    names[subpath] = checker
      .getExportsOfModule(symbol)
      .map((item) => item.name)
      .sort();
  }
  return names;
}

describe("the SDK tarball", () => {
  test(
    "the packed SDK installs into an empty directory and its calls subpath imports under Node",
    async () => {
      const { tarball, tarballs } = await packed();
      expect(path.isAbsolute(tarball)).toBe(true);
      expect(tarballs).toEqual([path.basename(tarball)]);

      const report = await probe("node");
      expect(report.failures["./calls"]).toBeUndefined();
      expect(report.calls).toEqual({ defineProvider: "function", checkProviderModule: "function" });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the pack writes nothing into the repository",
    async () => {
      await packed();

      expect(existsSync(path.join(PACKAGE_ROOT, "dist"))).toBe(false);
      expect(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).toBe(SOURCE_MANIFEST_TEXT);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the packed SDK holds only dist, the schema, the licence and package.json",
    async () => {
      const { entries } = await packed();
      const files = entries.filter((entry) => !entry.endsWith("/"));

      expect(files).toContain("package/package.json");
      expect(files).toContain("package/LICENSE");
      expect(files).toContain("package/dist/manifest/manifest.schema.json");
      expect(
        files.filter((file) => {
          if (file === "package/package.json" || file === "package/LICENSE") return false;
          if (!file.startsWith("package/dist/")) return true;
          if (file === "package/dist/manifest/manifest.schema.json") return false;
          return !file.endsWith(".js") && !file.endsWith(".d.ts");
        }),
      ).toEqual([]);
      expect(
        files.filter((file) => {
          const segments = file.split("/");
          return (
            segments.includes("src") ||
            segments.includes("tests") ||
            /\.(?:test|spec)\./.test(file) ||
            file.endsWith(".map")
          );
        }),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "every exports subpath of the repository package is present in the packed one",
    async () => {
      const { manifest, packageDirectory } = await packed();

      expect(Object.keys(manifest.exports)).toEqual(Object.keys(SOURCE_MANIFEST.exports));
      const leaves = Object.values(manifest.exports).flatMap((target) =>
        typeof target === "string" ? [target] : Object.values(target as Record<string, string>),
      );
      expect(leaves.length).toBeGreaterThan(Object.keys(manifest.exports).length);
      expect(leaves.filter((leaf) => !existsSync(path.join(packageDirectory, leaf)))).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the packed package.json is the repository's, with only exports and types pointing at dist",
    async () => {
      const { manifest } = await packed();
      expect(withoutEntryPoints(manifest)).toEqual(withoutEntryPoints(SOURCE_MANIFEST));
      expect(Object.keys(manifest)).toEqual(Object.keys(SOURCE_MANIFEST));
      expect(manifest.types).toBe("./dist/index.d.ts");
      expect(manifest.type).toBe("module");
      expect(Object.keys(manifest.dependencies as object)).toEqual(["ajv"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the packed schema and licence are the repository's, byte for byte",
    async () => {
      const { packageDirectory } = await packed();
      const licence = readFileSync(path.join(REPOSITORY_ROOT, "LICENSE"));

      expect(licence.toString("utf8").startsWith("MIT License")).toBe(true);
      expect(SOURCE_MANIFEST.license).toBe("MIT");
      expect(readFileSync(path.join(packageDirectory, "LICENSE")).equals(licence)).toBe(true);
      expect(
        readFileSync(path.join(packageDirectory, "dist/manifest/manifest.schema.json")).equals(
          readFileSync(path.join(PACKAGE_ROOT, "src/manifest/manifest.schema.json")),
        ),
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the packed dist imports only its declared dependencies and Node builtins, imports each of them by name, and every relative import names a file of the dist",
    async () => {
      const { manifest, packageDirectory } = await packed();
      const declared = Object.keys(manifest.dependencies as object);
      const dist = path.join(packageDirectory, "dist");
      const files = filesUnder(dist).filter((file) => file.endsWith(".js") || file.endsWith(".d.ts"));
      const imported = new Set<string>();
      const failures: string[] = [];
      for (const file of files) {
        const text = readFileSync(path.join(dist, file), "utf8");
        for (const { fileName: specifier } of ts.preProcessFile(text, true, true).importedFiles) {
          if (specifier.startsWith(".")) {
            const target = path.posix.join(path.posix.dirname(file), specifier);
            const onDisk = file.endsWith(".d.ts") ? target.replace(/\.js$/, ".d.ts") : target;
            if (!existsSync(path.join(dist, onDisk))) failures.push(`${file} imports ${specifier}, not in dist`);
            continue;
          }
          if (isBuiltin(specifier)) continue;
          const parts = specifier.split("/");
          const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
          if (declared.includes(name)) imported.add(name);
          else failures.push(`${file} imports ${specifier}, which the packed package.json does not declare`);
        }
      }

      expect(files.length).toBeGreaterThan(MODULE_SUBPATHS.length * 2);
      expect(failures).toEqual([]);
      expect([...imported].sort()).toEqual([...declared].sort());
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the installed SDK", () => {
  test(
    "every exports subpath of the packed SDK imports under Node and under Bun, and exports the names the source exports",
    async () => {
      const source = await sourceEntries();
      for (const { runtime, report } of await probeReports()) {
        expect({ runtime, failures: report.failures }).toEqual({ runtime, failures: {} });
        expect({ runtime, entries: report.entries }).toEqual({ runtime, entries: source });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the packed SDK keeps one module per source file across its entries, under Node and under Bun",
    async () => {
      for (const { runtime, report } of await probeReports()) {
        expect(Object.keys(report.entries)).toEqual(MODULE_SUBPATHS);
        expect({ runtime, divergent: report.divergent }).toEqual({ runtime, divergent: [] });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the packed manifest validator compiles the packed schema under Node and under Bun",
    async () => {
      const schema = readFileSync(path.join(PACKAGE_ROOT, "src/manifest/manifest.schema.json"));
      const expected = {
        contract: compileManifestValidator(schema).contract,
        schemaId: (JSON.parse(schema.toString("utf8")) as { $id: string }).$id,
      };
      for (const { runtime, report } of await probeReports()) {
        expect({ runtime, validator: report.validator }).toEqual({ runtime, validator: expected });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a TypeScript file importing defineProvider type-checks against the packed SDK with tsc --noEmit and no path mapping",
    async () => {
      const consumer = await installed();
      writeFileSync(path.join(consumer, "provider.ts"), CONSUMER_SOURCE);
      writeFileSync(path.join(consumer, "tsconfig.json"), `${JSON.stringify(CONSUMER_TSCONFIG, null, 2)}\n`);
      const tsc = path.join(path.dirname(Bun.fileURLToPath(import.meta.resolve("typescript"))), "tsc.js");

      const result = await runChild([nodeBinary(), "--max-old-space-size=1024", tsc, "-p", "tsconfig.json"], {
        cwd: consumer,
        env,
        timeoutMs: 120_000,
      });
      expect({ exitCode: result.exitCode, output: result.stdout + result.stderr }).toEqual({ exitCode: 0, output: "" });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the packed declarations export, at every subpath, exactly the names the source exports",
    async () => {
      const consumer = await installed();
      const source = declaredNames(path.join(PACKAGE_ROOT, "tests", "surface.ts"), {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        types: ["node"],
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
      });
      const packedNames = declaredNames(path.join(consumer, "surface.ts"), {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        types: ["node"],
        noEmit: true,
        skipLibCheck: true,
      });

      expect(Object.values(source).every((names) => names.length > 0)).toBe(true);
      expect(packedNames).toEqual(source);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an offline install of the SDK tarball alone is refused for ajv, so these installs reach no registry",
    async () => {
      const { tarball } = await packed();
      const consumer = consumerDirectory("consumer-alone");

      const result = await npm(
        ["install", tarball, "--no-save", ...npmFlags(path.join(temp, "npm-cache-alone"))],
        consumer,
        60_000,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("ENOTCACHED");
      expect(result.stderr).toContain("ajv");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the pack test's machinery", () => {
  test("npm runs from its PATH entry on POSIX and through the npm-cli.js beside npm.cmd on Windows, and a missing one is refused by name", () => {
    const onPath = (entries: Record<string, string>) => (name: string) => entries[name] ?? null;
    const shim = path.join("C:", "node", "npm.cmd");
    const cli = path.join("C:", "node", "node_modules", "npm", "bin", "npm-cli.js");

    expect(npmCommand({ platform: "linux", which: onPath({ npm: "/usr/bin/npm" }), exists: () => false })).toEqual([
      "/usr/bin/npm",
    ]);
    expect(() => npmCommand({ platform: "darwin", which: onPath({}), exists: () => true })).toThrow("No npm on PATH");
    expect(
      npmCommand({
        platform: "win32",
        which: onPath({ "npm.cmd": shim, node: "node.exe", npm: "npm-should-not-be-used" }),
        exists: (file) => file === cli,
      }),
    ).toEqual(["node.exe", cli]);
    expect(() => npmCommand({ platform: "win32", which: onPath({ node: "node.exe" }), exists: () => true })).toThrow(
      "No npm.cmd on PATH",
    );
    expect(() =>
      npmCommand({ platform: "win32", which: onPath({ "npm.cmd": shim, node: "node.exe" }), exists: () => false }),
    ).toThrow(`No ${cli} beside ${shim}`);
    expect(() => npmCommand({ platform: "win32", which: onPath({ "npm.cmd": shim }), exists: () => true })).toThrow(
      "No node on PATH",
    );
  });

  test("the children's environment drops Node's and npm's settings and points HOME at the given directory", () => {
    expect(
      childEnvironment(
        {
          PATH: "/bin",
          NODE_OPTIONS: "--x",
          node_path: "/y",
          npm_config_registry: "http://registry",
          NPM_CONFIG_CACHE: "/c",
          HOME: "/home/a",
          UserProfile: "C:\\a",
          UNSET: undefined,
        },
        "/empty",
      ),
    ).toEqual({ PATH: "/bin", HOME: "/empty", USERPROFILE: "/empty" });
  });

  test("a consumer directory with node_modules above it is refused, naming the ancestor", () => {
    const base = path.resolve("/a/b/c");

    expect(ancestorNodeModules(base, (candidate) => candidate === path.resolve("/a/node_modules"))).toBe(
      path.resolve("/a"),
    );
    expect(ancestorNodeModules(base, (candidate) => candidate === path.join(base, "node_modules"))).toBeNull();
    expect(ancestorNodeModules(base, () => false)).toBeNull();
  });

  test("a dependency's closure lists it and every package it depends on, found as Node finds a package directory", () => {
    const root = path.resolve("/r");
    const at = (...segments: string[]) => path.join(root, ...segments);
    const manifests: Record<string, { dependencies?: Record<string, string> }> = {
      [at("node_modules", "a")]: { dependencies: { b: "1", c: "1" } },
      [at("node_modules", "a", "node_modules", "b")]: { dependencies: { c: "1" } },
      [at("node_modules", "b")]: {},
      [at("node_modules", "c")]: {},
      [at("node_modules", "@s", "d")]: { dependencies: { a: "1" } },
    };
    const exists = (file: string) => path.dirname(file) in manifests && path.basename(file) === "package.json";
    const read = (directory: string) => manifests[directory] as { dependencies?: Record<string, string> };
    const from = at("packages", "p");

    expect(dependencyClosure(["@s/d"], from, exists, read)).toEqual(
      [
        at("node_modules", "@s", "d"),
        at("node_modules", "a"),
        at("node_modules", "a", "node_modules", "b"),
        at("node_modules", "c"),
      ].sort(),
    );
    expect(() => dependencyClosure(["a", "missing"], from, exists, read)).toThrow(
      `missing, needed by ${from}, is not installed in any node_modules above it`,
    );
  });
});
