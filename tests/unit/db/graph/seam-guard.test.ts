/**
 * The graph layer's seam guard (Neo4j provider spec 3.1, 3.3; Global Constraints of the plan)
 *
 * The read-only and browser-safety promises of the graph layer rest on where the
 * driver can be reached from, and this file keeps those lines where they are. It
 * parses every TypeScript file under `src/lib/db/graph/` and
 * `src/lib/db/providers/graph/neo4j/` from disk, so it stays meaningful as files are
 * added, and fails the build when an ordinary edit crosses one:
 *
 * - a `neo4j-driver*` package is imported only by `bolt/bolt-client.ts` and
 *   `bolt/record-values.ts`;
 * - those two files never name `executeQuery`, `executeRead`, `executeWrite`,
 *   `beginTransaction`, `logging` or `resolver` outside a comment, as an identifier or
 *   as a string (a computed member read);
 * - nothing under `src/lib/db/graph/` imports from `src/lib/db/providers/`;
 * - the pure set (every graph file except `bolt/**` and `graph-base-provider.ts`)
 *   imports no Node built-in and nothing from `bolt/` or `graph-base-provider`;
 * - `graph-base-provider.ts` imports from `bolt/` only the `bolt/client` interface, so the
 *   transport an engine runs on is chosen by its composition root (spec 3.5);
 * - the Neo4j provider imports from no other provider directory;
 * - the browser-shipped set (`neo4j/profile.ts`, and `src/lib/db/graph-policy-profiles.ts`,
 *   which `QueryEditor` imports) imports no Node built-in, nothing from `bolt/` or
 *   `graph-base-provider`, and from the provider directories only an engine's `profile`
 *   module, so no catalog, error table or transport reaches the client bundle;
 * - every module name in these files is a plain string.
 *
 * Each rule is proven both ways: the real sources pass, and a planted sample fails
 * by name. The guard is syntactic, as the Kafka and etcd guards are: a name built at
 * run time, reflection, or text run as code is stated here rather than chased.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, normalize, sep } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const GRAPH = "src/lib/db/graph";
const NEO4J = "src/lib/db/providers/graph/neo4j";
const PROVIDERS = "src/lib/db/providers";
const BASE_PROVIDER = `${GRAPH}/graph-base-provider.ts`;
const POLICY_PROFILES = "src/lib/db/graph-policy-profiles.ts";
/** Files outside the pure graph directory that the editor ships to the browser. */
const BROWSER_SHIPPED = new Set([`${NEO4J}/profile.ts`, POLICY_PROFILES]);
const DRIVER_IMPORTERS = new Set([`${GRAPH}/bolt/bolt-client.ts`, `${GRAPH}/bolt/record-values.ts`]);
const BANNED_NAMES = new Set([
  "executeQuery",
  "executeRead",
  "executeWrite",
  "beginTransaction",
  "logging",
  "resolver",
]);
const BUILTINS = new Set(builtinModules);

function filesUnder(dir: string): string[] {
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name) && statSync(join(absolute, name)).isFile())
    .map((name) => `${dir}/${name.split(sep).join("/")}`)
    .sort();
}

interface ModuleReference {
  readonly specifier?: string;
  readonly position: number;
}

/** Every module a file names: imports, re-exports, `import x = require()`, `import()` and `require()`. */
function moduleReferences(sf: ts.SourceFile): ModuleReference[] {
  const found: ModuleReference[] = [];
  const add = (node: ts.Node | undefined, at: ts.Node) => {
    found.push({
      specifier: node && ts.isStringLiteralLike(node) ? node.text : undefined,
      position: at.getStart(sf),
    });
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      add(node.moduleSpecifier, node);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, node);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        add(node.arguments[0], node);
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** A relative or `@/` module name as a repository path without extension; a package name as itself. */
function resolveSpecifier(specifier: string, file: string): string {
  if (specifier.startsWith("@/"))
    return normalize(`src/${specifier.slice(2)}`)
      .split(sep)
      .join("/");
  if (specifier.startsWith("."))
    return normalize(join(dirname(file), specifier))
      .split(sep)
      .join("/");
  return specifier;
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

function isPure(file: string): boolean {
  return (
    BROWSER_SHIPPED.has(file) ||
    (within(file, GRAPH) && !within(file, `${GRAPH}/bolt`) && file !== `${GRAPH}/graph-base-provider.ts`)
  );
}

function namesOutsideComments(sf: ts.SourceFile): Array<{ name: string; position: number }> {
  const found: Array<{ name: string; position: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) {
      const text = ts.isPrivateIdentifier(node) ? node.text.slice(1) : node.text;
      if (BANNED_NAMES.has(text)) found.push({ name: text, position: node.getStart(sf) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Every rule this guard holds, applied to one file's text. `file` is its repository path. */
function violations(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const line = (position: number) => sf.getLineAndCharacterOfPosition(position).line + 1;
  const out: string[] = [];

  for (const reference of moduleReferences(sf)) {
    const where = `${file}:${line(reference.position)}`;
    if (reference.specifier === undefined) {
      out.push(`${where} names a module that is not a plain string`);
      continue;
    }
    const specifier = reference.specifier;
    const target = resolveSpecifier(specifier, file);

    if (/^neo4j-driver/.test(specifier) && !DRIVER_IMPORTERS.has(file)) {
      out.push(`${where} imports ${specifier}, which only bolt/bolt-client.ts and bolt/record-values.ts may`);
    }
    if (within(file, GRAPH) && within(target, PROVIDERS)) {
      out.push(`${where} imports ${specifier} from the provider directories`);
    }
    if (isPure(file)) {
      const bare = specifier.replace(/^node:/, "").split("/")[0];
      if (specifier.startsWith("node:") || BUILTINS.has(bare)) {
        out.push(`${where} imports the Node built-in ${specifier} into the pure set`);
      }
      if (within(target, `${GRAPH}/bolt`) || target === `${GRAPH}/graph-base-provider`) {
        out.push(`${where} imports ${specifier}, server-only, into the pure set`);
      }
    }
    if (BROWSER_SHIPPED.has(file) && within(target, PROVIDERS) && !target.endsWith("/profile")) {
      out.push(`${where} imports ${specifier}, which is not a profile module, into the browser-shipped set`);
    }
    if (file === BASE_PROVIDER && within(target, `${GRAPH}/bolt`) && target !== `${GRAPH}/bolt/client`) {
      out.push(`${where} imports ${specifier}; the base provider may import only bolt/client from the transport`);
    }
    if (within(file, NEO4J) && within(target, PROVIDERS) && !within(target, NEO4J)) {
      out.push(`${where} imports ${specifier} from another provider directory`);
    }
  }

  if (DRIVER_IMPORTERS.has(file)) {
    for (const { name, position } of namesOutsideComments(sf)) {
      out.push(`${file}:${line(position)} names ${name}`);
    }
  }
  return out;
}

describe("the real sources", () => {
  const files = [...filesUnder(GRAPH), ...filesUnder(NEO4J), POLICY_PROFILES];

  test("the guard reads the graph layer, including the Bolt transport and the browser-shipped set", () => {
    expect(files).toContain(`${GRAPH}/values.ts`);
    for (const file of BROWSER_SHIPPED) expect(files).toContain(file);
    expect(files).toContain(`${GRAPH}/bolt/bolt-client.ts`);
    expect(files).toContain(`${GRAPH}/bolt/record-values.ts`);
  });

  test("break no rule", () => {
    const found = files.flatMap((file) => violations(file, readFileSync(join(ROOT, file), "utf8")));
    expect(found).toEqual([]);
  });

  test("the two driver importers do import the driver", () => {
    for (const file of DRIVER_IMPORTERS) {
      const sf = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
      expect(moduleReferences(sf).map((reference) => reference.specifier)).toContain("neo4j-driver-lite");
    }
  });

  test("a missing directory reads as no files", () => {
    expect(filesUnder("src/lib/db/graph/no-such-directory")).toEqual([]);
  });
});

describe("planted violations fail by name", () => {
  const pure = `${GRAPH}/cypher/sample.ts`;
  const bolt = `${GRAPH}/bolt/bolt-client.ts`;
  const records = `${GRAPH}/bolt/record-values.ts`;
  const provider = `${NEO4J}/sample.ts`;

  test.each([
    ["a driver import outside the two files", pure, 'import neo4j from "neo4j-driver-lite";', "neo4j-driver-lite"],
    ["the full driver", `${GRAPH}/bolt/uri.ts`, 'import neo4j from "neo4j-driver";', "neo4j-driver"],
    ["a re-export of the driver", provider, 'export { int } from "neo4j-driver-core";', "neo4j-driver-core"],
    ["a dynamic import of the driver", pure, 'const m = await import("neo4j-driver-lite");', "neo4j-driver-lite"],
    ["a require of the driver", provider, 'const m = require("neo4j-driver-lite");', "neo4j-driver-lite"],
    ["an import-equals of the driver", pure, 'import m = require("neo4j-driver-lite");', "neo4j-driver-lite"],
    ["a type import of the driver", pure, 'type T = import("neo4j-driver-lite").Node;', "neo4j-driver-lite"],
  ])("%s", (_, file, text, named) => {
    const found = violations(file, text);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(`imports ${named}`);
  });

  test.each([
    ["an alias", "@/lib/db/providers/stream/kafka/client"],
    ["a relative path", "../../providers/sql/postgres"],
  ])("a graph file importing a provider through %s", (_, specifier) => {
    const found = violations(`${GRAPH}/bolt/uri.ts`, `import x from "${specifier}";`);
    expect(found).toEqual([expect.stringContaining("from the provider directories")]);
  });

  test.each([
    ["node:net", 'import { isIP } from "node:net";', "Node built-in"],
    ["a bare built-in", 'import fs from "fs";', "Node built-in"],
    [
      "the Bolt directory by alias",
      'import { createBoltClient } from "@/lib/db/graph/bolt/bolt-client";',
      "server-only",
    ],
    ["the Bolt directory by path", 'import type { GraphClient } from "../bolt/client";', "server-only"],
    ["the base provider", 'import { GraphBaseProvider } from "../graph-base-provider";', "server-only"],
  ])("the pure set importing %s", (_, text, phrase) => {
    expect(violations(pure, text)).toEqual([expect.stringContaining(phrase)]);
  });

  test("the Bolt directory may import Node built-ins, and the base provider the Bolt client interface", () => {
    expect(
      violations(bolt, 'import { createHash } from "node:crypto";\nimport type { GraphClient } from "./client";'),
    ).toEqual([]);
    expect(violations(BASE_PROVIDER, 'import { GraphClient } from "./bolt/client";')).toEqual([]);
  });

  test.each([
    ["the driver-backed client", 'import { createBoltClient } from "./bolt/bolt-client";', "./bolt/bolt-client"],
    [
      "the URI builder by alias",
      'import { boltEndpointOf } from "@/lib/db/graph/bolt/uri";',
      "@/lib/db/graph/bolt/uri",
    ],
    ["the record conversion", 'import type { x } from "./bolt/record-values";', "./bolt/record-values"],
  ])("the base provider importing %s", (_, text, specifier) => {
    expect(violations(BASE_PROVIDER, text)).toEqual([
      expect.stringContaining(`imports ${specifier}; the base provider may import only bolt/client`),
    ]);
  });

  test.each([
    ["the catalog", `${NEO4J}/profile.ts`, 'import { neo4jCatalog } from "./catalog";', "not a profile module"],
    ["the error table", `${NEO4J}/profile.ts`, 'import { mapNeo4jError } from "./errors";', "not a profile module"],
    [
      "the provider",
      POLICY_PROFILES,
      'import { Neo4jProvider } from "@/lib/db/providers/graph/neo4j";',
      "not a profile module",
    ],
    ["a Node built-in", `${NEO4J}/profile.ts`, 'import { readFileSync } from "node:fs";', "Node built-in"],
    [
      "the Bolt directory",
      POLICY_PROFILES,
      'import type { GraphClient } from "@/lib/db/graph/bolt/client";',
      "server-only",
    ],
    [
      "the base provider",
      `${NEO4J}/profile.ts`,
      'import type { GraphEngineProfile } from "@/lib/db/graph/graph-base-provider";',
      "server-only",
    ],
  ])("the browser-shipped set importing %s", (_, file, text, phrase) => {
    expect(violations(file, text)).toEqual([expect.stringContaining(phrase)]);
  });

  test("the browser-shipped set may import a profile module and the pure graph layer", () => {
    expect(
      violations(
        POLICY_PROFILES,
        'import { NEO4J_POLICY_PROFILE } from "@/lib/db/providers/graph/neo4j/profile";\nimport type { GraphPolicyProfile } from "@/lib/db/graph/profile";',
      ),
    ).toEqual([]);
    expect(violations(`${NEO4J}/catalog.ts`, 'import { boltEndpointOf } from "@/lib/db/graph/bolt/uri";')).toEqual([]);
  });

  test("the Neo4j provider importing another provider", () => {
    expect(violations(provider, 'import { x } from "../../stream/kafka/client";')).toEqual([
      expect.stringContaining("another provider directory"),
    ]);
    expect(violations(provider, 'import { x } from "@/lib/db/providers/base-provider";')).toEqual([
      expect.stringContaining("another provider directory"),
    ]);
    expect(violations(provider, 'import { x } from "./profile";\nimport { y } from "@/lib/db/graph/values";')).toEqual(
      [],
    );
  });

  test("a module name that is not a plain string", () => {
    expect(violations(provider, "const m = await import(name);")).toEqual([
      expect.stringContaining("not a plain string"),
    ]);
    expect(violations(provider, "const m = require(`neo4j-${x}`);")).toEqual([
      expect.stringContaining("not a plain string"),
    ]);
  });

  test.each([
    ["executeQuery", "driver.executeQuery(text);"],
    ["executeRead", "session.executeRead(work);"],
    ["executeWrite", "const { executeWrite } = session;"],
    ["beginTransaction", 'session["beginTransaction"]();'],
    ["logging", "neo4j.driver(uri, auth, { logging: neo4j.logging.console('debug') });"],
    ["resolver", "const config = { resolver: (a: string) => [a] };"],
  ])("the driver importers naming %s", (name, text) => {
    for (const file of [bolt, records]) {
      expect(violations(file, text).some((found) => found.endsWith(`names ${name}`))).toBe(true);
    }
  });

  test("a banned name in a comment is not a violation, and other files may say it", () => {
    expect(violations(bolt, "// never executeQuery\n/* nor beginTransaction */\nconst a = 1;")).toEqual([]);
    expect(violations(pure, 'const word = "executeQuery";')).toEqual([]);
  });
});
