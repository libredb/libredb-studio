/**
 * The MongoDB seams (issue #1614, the D352 lesson): what loads the driver, and what may not.
 *
 * The operations registry and the agent layer read MongoDB commands through `envelope.ts`, which is pure, so a server
 * module that builds a registry or an agent route loads none of the driver. The provider's own modules split the
 * same way: `values.ts`, `extended-json.ts`, `agent-boundary.ts` and `agent-read.ts` serve `index.ts` and never import
 * it back. Three rules, each over every module a file reaches TRANSITIVELY through its runtime imports, because a pure
 * module that imports a sibling that imports the driver loads the driver as surely as one that imports it itself:
 *
 * 1. No module under `src/lib/db/operations` or `src/lib/agent` reaches `mongodb/index.ts` or the `mongodb` package.
 * 2. `envelope.ts` reaches neither the `mongodb` package nor `bson`.
 * 3. `values.ts`, `extended-json.ts`, `agent-boundary.ts` and `agent-read.ts` never reach `mongodb/index.ts`.
 *
 * A runtime import is a static `import` or `export ... from` that binds a value, or a bare `import "x"`; a type-only
 * import loads nothing, and a dynamic `import()` loads only when it runs (the factory's provider imports are dynamic
 * for exactly that reason). Specifiers are resolved as TypeScript resolves them, so an `@/` alias counts. Each rule is
 * proven both ways: the real sources pass, and a violation planted in a copy of a real file's text fails by name. The
 * last test measures the property itself in a fresh process: importing the registries and an agent route loads no
 * module of the driver.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { platformTimeoutMs } from "../../../helpers/platform-timeout";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const MONGO = "src/lib/db/providers/document/mongodb";
const INDEX = `${MONGO}/index.ts`;
const ENVELOPE = `${MONGO}/envelope.ts`;
const PROVIDER_SIDE = [
  `${MONGO}/values.ts`,
  `${MONGO}/extended-json.ts`,
  `${MONGO}/agent-boundary.ts`,
  `${MONGO}/agent-read.ts`,
];
const DRIVER = "mongodb";

const canonical = (path: string): string => realpathSync.native(path).split("\\").join("/");
const ROOT_PATH = canonical(ROOT);

let compilerOptions: ts.CompilerOptions | undefined;

/** A repository file a specifier names, as TypeScript resolves it, or the package it names. */
function resolve(specifier: string, file: string): { readonly file: string } | { readonly pkg: string } {
  if (compilerOptions === undefined) {
    const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile).config;
    compilerOptions = ts.parseJsonConfigFileContent(config, ts.sys, ROOT).options;
  }
  const resolution = ts.resolveModuleName(specifier, join(ROOT, file), compilerOptions, ts.sys).resolvedModule;
  if (resolution !== undefined && resolution.isExternalLibraryImport !== true) {
    return { file: canonical(resolution.resolvedFileName).slice(ROOT_PATH.length + 1) };
  }
  const scoped = specifier.startsWith("@") ? specifier.split("/").slice(0, 2) : specifier.split("/").slice(0, 1);
  return { pkg: scoped.join("/") };
}

/** The specifiers a file loads at run time: value imports, value re-exports, and side-effect imports. */
function runtimeSpecifiers(file: string, text: string): string[] {
  const found: string[] = [];
  for (const statement of ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true).statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly === true) continue;
      const bindings = clause?.namedBindings;
      const onlyTypes =
        clause !== undefined &&
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly);
      if (!onlyTypes) found.push(statement.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      found.push(statement.moduleSpecifier.text);
    }
  }
  return found;
}

/** One file's runtime imports, resolved: repository files by path, packages as `package:<name>`. Memoized per text. */
const EDGES = new Map<string, readonly string[]>();
function edges(file: string, text: string): readonly string[] {
  const key = `${file}\u0000${text}`;
  const known = EDGES.get(key);
  if (known !== undefined) return known;
  const found = runtimeSpecifiers(file, text).map((specifier) => {
    const target = resolve(specifier, file);
    return "pkg" in target ? `package:${target.pkg}` : target.file;
  });
  EDGES.set(key, found);
  return found;
}

/** What `start` reaches through runtime imports, each with the chain that reaches it. */
function reach(start: string, planted: Readonly<Record<string, string>> = {}): Map<string, string[]> {
  const chains = new Map<string, string[]>([[start, [start]]]);
  const queue = [start];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (file.startsWith("package:") || !/\.tsx?$/.test(file) || file.endsWith(".d.ts")) continue;
    for (const target of edges(file, planted[file] ?? readFileSync(join(ROOT, file), "utf8"))) {
      if (chains.has(target)) continue;
      chains.set(target, [...(chains.get(file) as string[]), target]);
      queue.push(target);
    }
  }
  return chains;
}

function sourcesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(ROOT, directory))) {
    const path = `${directory}/${entry}`;
    if (statSync(join(ROOT, path)).isDirectory()) files.push(...sourcesUnder(path));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) files.push(path);
  }
  return files.sort();
}

/** Every finding of the three rules, for the files each rule holds, with a planted text standing in for its file. */
function seamFindings(planted: Readonly<Record<string, string>> = {}): string[] {
  const findings: string[] = [];
  const reached = (from: string, target: string): string[] | undefined => reach(from, planted).get(target);
  for (const file of [...sourcesUnder("src/lib/db/operations"), ...sourcesUnder("src/lib/agent")]) {
    for (const target of [INDEX, `package:${DRIVER}`]) {
      const chain = reached(file, target);
      if (chain !== undefined) findings.push(`rule 1: ${file} reaches ${target} through ${chain.join(" -> ")}`);
    }
  }
  for (const target of [`package:${DRIVER}`, "package:bson"]) {
    const chain = reached(ENVELOPE, target);
    if (chain !== undefined) findings.push(`rule 2: ${ENVELOPE} reaches ${target} through ${chain.join(" -> ")}`);
  }
  for (const file of PROVIDER_SIDE) {
    const chain = reached(file, INDEX);
    if (chain !== undefined) findings.push(`rule 3: ${file} reaches ${INDEX} through ${chain.join(" -> ")}`);
  }
  return findings;
}

const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

describe("the MongoDB seams", () => {
  // Walks the import graph of every operations and agent module: 1.1s alone with coverage and 10.2s
  // under a 15% CPU quota, past bun's 5s default, so it carries its own bound.
  test(
    "the real sources pass all three rules",
    () => {
      expect(seamFindings()).toEqual([]);
    },
    platformTimeoutMs(40_000),
  );

  test("the walk reads real code: the provider reaches the driver, and the reader does not", () => {
    expect(reach(INDEX).has(`package:${DRIVER}`)).toBe(true);
    expect(reach(INDEX).has(ENVELOPE)).toBe(true);
    expect(reach(`${MONGO}/values.ts`).has(`package:${DRIVER}`)).toBe(true);
    expect(reach("src/lib/db/operations/mongo-admission.ts").has(ENVELOPE)).toBe(true);
    expect([...reach(ENVELOPE).keys()]).toEqual([ENVELOPE]);
  });
});

describe("planted violations fail by name", () => {
  test("the driver planted in the reader fails rule 2, and rule 1 through every registry that reads it", () => {
    const findings = seamFindings({ [ENVELOPE]: `import "mongodb";\n${read(ENVELOPE)}` });
    expect(findings).toContain(
      `rule 2: ${ENVELOPE} reaches package:${DRIVER} through ${ENVELOPE} -> package:${DRIVER}`,
    );
    expect(findings).toContain(
      `rule 1: src/lib/db/operations/mongo-admission.ts reaches package:${DRIVER} through src/lib/db/operations/mongo-admission.ts -> ${ENVELOPE} -> package:${DRIVER}`,
    );
  });

  test("bson planted in the reader fails rule 2", () => {
    const findings = seamFindings({ [ENVELOPE]: `import { EJSON } from "bson";\n${read(ENVELOPE)}` });
    expect(findings).toContain(`rule 2: ${ENVELOPE} reaches package:bson through ${ENVELOPE} -> package:bson`);
  });

  test("the provider planted in a registry fails rule 1, reached through a sibling as well", () => {
    const admission = "src/lib/db/operations/mongo-admission.ts";
    const findings = seamFindings({
      [admission]: `import { MongoDBProvider } from "@/lib/db/providers/document/mongodb";\n${read(admission)}`,
    });
    expect(findings).toContain(`rule 1: ${admission} reaches ${INDEX} through ${admission} -> ${INDEX}`);
    expect(findings.some((finding) => finding.startsWith("rule 1: src/lib/db/operations/descriptors.ts reaches"))).toBe(
      true,
    );
  });

  // Walks the same graph several times: 0.6s alone with coverage and 2.9s under a 15% CPU quota.
  test(
    "index.ts planted in a provider-side module fails rule 3, and a type-only import does not",
    () => {
      const values = `${MONGO}/values.ts`;
      expect(seamFindings({ [values]: `import { MongoDBProvider } from "./index";\n${read(values)}` })).toContain(
        `rule 3: ${values} reaches ${INDEX} through ${values} -> ${INDEX}`,
      );
      expect(seamFindings({ [values]: `import type { MongoDBProvider } from "./index";\n${read(values)}` })).toEqual(
        [],
      );
    },
    platformTimeoutMs(40_000),
  );
});

/** How many modules of the driver a fresh bun process holds after importing `entries`. */
function driverModulesLoadedBy(entries: readonly string[]): number {
  const script = `
    for (const entry of ${JSON.stringify(entries)}) await import(${JSON.stringify(`${ROOT}/`)} + entry);
    const loaded = [...(globalThis.Loader?.registry?.keys?.() ?? []), ...Object.keys(require.cache)];
    console.log(JSON.stringify(new Set(loaded.filter((key) => key.split("\\\\").join("/").includes("node_modules/mongodb/"))).size));
  `;
  const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.stdout.toString().trim().split("\n").at(-1) as string) as number;
}

describe("the registries load no module of the driver", () => {
  test("importing the operations and language registries, the agent tools and the runs route loads none", () => {
    const entries = [
      "src/lib/db/operations/descriptors.ts",
      "src/lib/agent/languages/server.ts",
      "src/lib/agent/tools.ts",
      "src/app/api/agent/runs/route.ts",
    ];
    expect(driverModulesLoadedBy(entries)).toBe(0);
    // The measurement sees the driver where it is loaded: the provider itself.
    expect(driverModulesLoadedBy([INDEX])).toBeGreaterThan(0);
  }, 60_000);
});
