import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { valueImportClosure, valueImportsOf } from "../../../helpers/value-import-closure";

// Core owns the egress decision (FND-2, the provider plugins design section 0.1): one module reads
// DB_HTTP_BLOCK_PRIVATE_HOSTS, the factory hands its decision to every provider that takes a context, and the guard
// takes it as an argument, so no provider reads the setting or imports the module that does. Parsed, not grepped, as
// the sign-in mode's scan (`tests/unit/lib/config/auth-provider-single-reader.test.ts`) is: comments and sentences that
// name the variable are not reads. Imports are walked with the repository's own walker, so a type-only import is erased
// and a dynamic import() counts.
const VARIABLE = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const READER = "src/lib/db/egress-decision.ts";
const PROVIDERS = "src/lib/db/providers/";
const FACTORY = "src/lib/db/factory.ts";
const BOOT_PREFLIGHT = "src/lib/config/egress-preflight.ts";

/**
 * The core modules that read core's decision on a provider's behalf until a later slice of FND-2 slice 2b hands them
 * the decision as an argument. Each slice deletes its own entry; an entry whose module no longer imports the reader
 * fails the importer test, so the list never outlives the code.
 */
const INTERIM_READERS: Readonly<Record<string, string>> = {
  "src/lib/db/http/endpoint.ts": "httpOrigin, until slice 2b-3",
  "src/lib/db/http/node-transport.ts": "createNodeTransport and createNodeByteTransport, until slice 2b-4",
};

function readsTheSetting(source: string, fileName = "probe.ts"): boolean {
  // The script kind follows the extension: parsed as TSX, a generic arrow or an angle-bracket assertion in a .ts file
  // opens a JSX element, and a read after it would never be visited.
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node) && node.name.text === VARIABLE) found = true;
    else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === VARIABLE)
      found = true;
    else if (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(file) === VARIABLE) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function trackedSources(...roots: string[]): string[] {
  const listed = execFileSync("git", ["ls-files", ...roots], { cwd: process.cwd(), encoding: "utf8" });
  return listed.split("\n").filter((name) => /\.(ts|tsx|mts|cts)$/.test(name));
}

/**
 * The provider modules the reach tests below scan: every tracked module under `src/lib/db/providers/`. The population
 * tests hold that it is not empty and that every provider module the factory builds from lies inside it, so a provider
 * module that leaves the directory fails here instead of leaving the scan.
 */
function providerModules(): string[] {
  return trackedSources(PROVIDERS).filter((name) => /\.tsx?$/.test(name));
}

/** The specifiers of the factory's dynamic `import()` calls, one for each provider module it builds from. */
function factoryDynamicImports(): string[] {
  return new Bun.Transpiler({ loader: "ts" })
    .scanImports(readFileSync(join(process.cwd(), FACTORY), "utf8"))
    .filter((entry) => entry.kind === "dynamic-import")
    .map((entry) => entry.path);
}

function importersOfTheReader(): string[] {
  return trackedSources("src")
    .filter((name) => /\.tsx?$/.test(name) && valueImportsOf(name).includes(READER))
    .sort();
}

describe("a setting core owns has one reader, and no provider imports it (FND-2 slice 2b)", () => {
  test("the read detector finds a property, an element, a destructuring and the name as a string literal, and ignores comments and sentences", () => {
    expect(readsTheSetting("const a = process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;")).toBe(true);
    expect(readsTheSetting('const a = process.env["DB_HTTP_BLOCK_PRIVATE_HOSTS"];')).toBe(true);
    expect(readsTheSetting("const a = process.env['DB_HTTP_BLOCK_PRIVATE_HOSTS'];")).toBe(true);
    expect(readsTheSetting("const a = process.env[`DB_HTTP_BLOCK_PRIVATE_HOSTS`];")).toBe(true);
    expect(readsTheSetting("const { DB_HTTP_BLOCK_PRIVATE_HOSTS } = process.env;")).toBe(true);
    expect(readsTheSetting("const { DB_HTTP_BLOCK_PRIVATE_HOSTS: flag = 'false' } = process.env;")).toBe(true);
    expect(readsTheSetting('const KEY = "DB_HTTP_BLOCK_PRIVATE_HOSTS";')).toBe(true);
    expect(readsTheSetting('const flag = readSetting("DB_HTTP_BLOCK_PRIVATE_HOSTS");')).toBe(true);
    expect(readsTheSetting("// process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS\n/* env.DB_HTTP_BLOCK_PRIVATE_HOSTS */")).toBe(
      false,
    );
    expect(readsTheSetting('const BLOCKED = "Invalid host: blocked by DB_HTTP_BLOCK_PRIVATE_HOSTS";')).toBe(false);
  });

  test("the read detector parses a .ts file as TypeScript, so a generic arrow or an angle-bracket assertion before the read hides nothing", () => {
    // Parsed as TSX, `<T,>(` and `<string>` open a JSX element and the rest of the file becomes JSX text.
    expect(
      readsTheSetting(
        "export const first = <T,>(items: T[]): T | undefined => items[0];\nexport const a = process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;",
        "probe.ts",
      ),
    ).toBe(true);
    expect(readsTheSetting("const flag = <string>process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;", "probe.ts")).toBe(true);
  });

  test("the read detector parses a .tsx file as TSX, so JSX text that looks like a comment opener hides no read", () => {
    // Parsed as TS, the `/*` in the JSX text opens a block comment that swallows the read below it.
    expect(
      readsTheSetting(
        "export const Hint = () => <p>matches src/*.ts</p>;\nexport const a = process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;",
        "probe.tsx",
      ),
    ).toBe(true);
  });

  test("no source file under src/ or vscode-extension/src/ other than src/lib/db/egress-decision.ts reads DB_HTTP_BLOCK_PRIVATE_HOSTS", () => {
    // Each read shape spells the name, so only a file whose text names the variable is parsed.
    const offenders = trackedSources("src", "vscode-extension/src").filter((name) => {
      if (name === READER) return false;
      const source = readFileSync(join(process.cwd(), name), "utf8");
      return source.includes(VARIABLE) && readsTheSetting(source, name);
    });
    expect(offenders).toEqual([]);
  });

  test("src/lib/db/egress-decision.ts reads it", () => {
    expect(readsTheSetting(readFileSync(join(process.cwd(), READER), "utf8"), READER)).toBe(true);
  });

  test("the provider population the reach tests scan is not empty and holds every provider module the factory builds from", () => {
    const population = providerModules();
    expect(population).not.toEqual([]);
    const dynamic = factoryDynamicImports();
    expect(dynamic).not.toEqual([]);
    expect(dynamic.filter((specifier) => !specifier.startsWith("./providers/"))).toEqual([]);
    const built = valueImportsOf(FACTORY).filter((name) => name.startsWith(PROVIDERS));
    expect(built).not.toEqual([]);
    expect(built.filter((name) => !population.includes(name))).toEqual([]);
  });

  test("no module under src/lib/db/providers/ imports src/lib/db/egress-decision.ts", () => {
    expect(importersOfTheReader().filter((name) => name.startsWith(PROVIDERS))).toEqual([]);
  });

  test("the modules that import src/lib/db/egress-decision.ts are the provider factory, the boot preflight and the interim readers, each until its slice", () => {
    expect(importersOfTheReader()).toEqual([BOOT_PREFLIGHT, FACTORY, ...Object.keys(INTERIM_READERS)].sort());
  });

  test("no module under src/lib/db/providers/ reaches the provider factory or the boot preflight through its imports", () => {
    const reaching = providerModules().filter((name) => {
      const { modules } = valueImportClosure(name);
      return modules.includes(FACTORY) || modules.includes(BOOT_PREFLIGHT);
    });
    expect(reaching).toEqual([]);
  });
});
