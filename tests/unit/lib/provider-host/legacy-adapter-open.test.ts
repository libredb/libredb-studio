/**
 * The legacy adapter's open (src/lib/provider-host/legacy-adapter/open.ts): the one core module that constructs a
 * legacy provider class, each of the 43 with the arguments it was constructed with before it moved here.
 *
 * The open module is read with the TypeScript parser into its cases, each with the modules it imports and the names it
 * takes from them; every such module is replaced by a module of recording classes (and, for the OPC UA library, a
 * recording `openLibrarySession`), so a case reads which class was constructed and with what, and no driver loads.
 * Each record opens the census connection of its engine (tests/helpers/census-connection.ts). The core scan lists files
 * with git and parses each candidate, so a `new` of a legacy class anywhere in core outside the open module fails here.
 * No file mode, link or line ending is relied on: the same step is reached on every platform.
 */
// oxlint-disable no-await-in-loop -- each open is read from the constructions it alone recorded, so the opens run one at a time.
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";
import { admittedFor, admittedManifest } from "../../../helpers/package-catalog";
import { isCorePath, isProviderPath, isSourcePath, resolveSpecifier, SCANNED_ROOTS } from "../db/provider-imports/scan";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
const OPEN_MODULE = "src/lib/provider-host/legacy-adapter/open.ts";

/** One case of the open module's switch: its engine id, and each module it imports with the names it takes. */
interface OpenCase {
  readonly id: string;
  readonly imports: readonly { readonly specifier: string; readonly names: readonly string[] }[];
}

/** The cases of the switch in `text`, in source order, read with the TypeScript parser. */
function casesOf(text: string): OpenCase[] {
  const file = ts.createSourceFile(OPEN_MODULE, text, ts.ScriptTarget.Latest, true);
  const cases: OpenCase[] = [];
  const importsIn = (node: ts.Node, found: { specifier: string; names: string[] }[]): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      ts.isAwaitExpression(node.initializer) &&
      ts.isCallExpression(node.initializer.expression) &&
      node.initializer.expression.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.initializer.expression.arguments;
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        found.push({
          specifier: argument.text,
          names: node.name.elements.map((element) => (element.name as ts.Identifier).text),
        });
      }
    }
    ts.forEachChild(node, (child) => importsIn(child, found));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
      const imports: { specifier: string; names: string[] }[] = [];
      importsIn(node, imports);
      cases.push({ id: node.expression.text, imports });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return cases;
}

const CASES = casesOf(readFileSync(path.join(ROOT, OPEN_MODULE), "utf8"));

/** A construction a recording class saw: its class's name, its arguments and the instance. */
interface Construction {
  readonly name: string;
  readonly args: readonly unknown[];
  readonly instance: object;
}

const constructions: Construction[] = [];
const librarySessions: unknown[] = [];

/** A class named `name` that records every construction. */
function recordingClass(name: string): new (...args: unknown[]) => object {
  return {
    [name]: class {
      constructor(...args: unknown[]) {
        constructions.push({ name, args, instance: this });
      }
    },
  }[name] as new (
    ...args: unknown[]
  ) => object;
}

/** The OPC UA library's session opener, recorded. */
const LIBRARY_SESSION = Object.freeze({ library: "session" });
function openLibrarySession(read: unknown): unknown {
  librarySessions.push(read);
  return LIBRARY_SESSION;
}

const namesBySpecifier = new Map<string, Set<string>>();
for (const { imports } of CASES) {
  for (const { specifier, names } of imports) {
    const set = namesBySpecifier.get(specifier) ?? new Set<string>();
    for (const name of names) set.add(name);
    namesBySpecifier.set(specifier, set);
  }
}
for (const [specifier, names] of namesBySpecifier) {
  mock.module(specifier, () =>
    Object.fromEntries(
      [...names].map((name) => [name, name === "openLibrarySession" ? openLibrarySession : recordingClass(name)]),
    ),
  );
}

const { openLegacyEngine } = await import("@/lib/provider-host/legacy-adapter/open");
const { LEGACY_ENGINES } = await import("@/lib/provider-host/legacy-adapter/records");
const { LEGACY_ENGINE_IDS } = await import("@/lib/provider-host/legacy-adapter/identity");
const { egressDecision } = await import("@/lib/db/egress-decision");
const { trustMaterial } = await import("@/lib/db/trust-material");
const { opcuaPkiRoot } = await import("@/lib/db/provider-files");
const { composeServerCatalog } = await import("@/lib/db/server-catalog-compose");
const { quoteTypeId } = await import("@/lib/db/type-id");
type EngineRecord = import("@/lib/db/server-catalog").EngineRecord;
type DatabaseConnection = import("@/lib/types").DatabaseConnection;
type DatabaseType = import("@/lib/types").DatabaseType;

/** The class each case constructs: the first name it takes from its first import, the provider module. */
const CLASS_OF = new Map(CASES.map((entry) => [entry.id, entry.imports[0]?.names[0] as string]));

/**
 * Where each constructor takes the build context, by the engines whose arguments differ from the
 * `(connection, options, context)` every other case passes: Spark takes no context, Kubernetes takes an empty
 * dependency object before it, and OPC UA takes its library loader and its PKI root after it.
 */
const ARGUMENT_COUNT: Readonly<Record<string, number>> = { spark: 2, kubernetes: 4, opcua: 5 };
const CONTEXT_AT: Readonly<Record<string, number | null>> = { spark: null, kubernetes: 3 };

afterEach(() => {
  constructions.length = 0;
  librarySessions.length = 0;
});

describe("the legacy adapter's open", () => {
  test("the open module constructs each of the 43 legacy classes with today's arguments, and no other core module constructs one", async () => {
    expect(CASES.map((entry) => entry.id).sort()).toEqual([...LEGACY_ENGINE_IDS].sort());
    expect(new Set(CASES.map((entry) => entry.id)).size).toBe(CASES.length);
    expect(new Set(CLASS_OF.values()).size).toBe(43);

    for (const [id, engine] of LEGACY_ENGINES) {
      for (const owner of [undefined, "owner-a"]) {
        constructions.length = 0;
        librarySessions.length = 0;
        const connection = { ...CENSUS_CONNECTION[id as DatabaseType], queryTimeout: 4321 } as DatabaseConnection;
        const execution = {
          allowExternalFileAccess: true,
          readOnly: false,
          ...(owner !== undefined && { owner, ownerPoolMax: 2 }),
        };
        const options = { pool: { min: 1, max: 9 } };
        const provider = await openLegacyEngine(engine, connection, execution, options);

        expect(constructions.map((built) => built.name)).toEqual([CLASS_OF.get(id) as string]);
        const [built] = constructions as [Construction];
        expect(provider).toBe(built.instance as never);
        expect(built.args).toHaveLength(ARGUMENT_COUNT[id] ?? 3);
        const copy = built.args[0] as DatabaseConnection;
        expect(copy).not.toBe(connection);
        expect([copy.id, copy.type, copy.queryTimeout]).toEqual([connection.id, connection.type, 4321]);
        expect(built.args[1]).toEqual({
          pool: owner === undefined ? { min: 1, max: 9 } : { min: 0, max: 2 },
          queryTimeout: 4321,
        });
        const at = id in CONTEXT_AT ? CONTEXT_AT[id] : 2;
        if (at === null) continue;
        const context = built.args[at] as Record<string, unknown>;
        expect(context).not.toBe(execution);
        expect(Object.keys(context).sort()).toEqual([...Object.keys(execution), "egress", "trust"].sort());
        expect(context).toMatchObject(execution);
        expect(context.egress).toBe(egressDecision());
        expect(context.trust).toBe(engine.connection.readsTrustMaterial ? trustMaterial() : undefined);
        if (id === "kubernetes") expect(built.args[2]).toEqual({});
        if (id === "opcua") {
          const read = { read: randomUUID() };
          expect(await (built.args[3] as (read: unknown) => Promise<unknown>)(read)).toBe(LIBRARY_SESSION);
          expect(librarySessions).toEqual([read]);
          expect(built.args[4]).toBe(opcuaPkiRoot("opcua"));
        }
      }
    }

    const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\0")
      .filter((file) => file !== "" && existsSync(path.join(ROOT, file)));

    // Every module a case imports is a file under the provider directory: the mocks above stand in for each specifier
    // the open module names, so a specifier that resolved to no file would pass every case above unseen.
    const resolved = [...namesBySpecifier.keys()].map((specifier) =>
      resolveSpecifier(OPEN_MODULE, specifier, new Set(tracked)),
    );
    expect(resolved.filter((resolution) => resolution.kind !== "file" || !isProviderPath(resolution.path))).toEqual([]);

    // No other core module constructs one of the 43 classes.
    const names = [...CLASS_OF.values()];
    const named = new RegExp(`\\bnew (${names.join("|")})\\b`);
    const listed = tracked.filter(
      (file) => isSourcePath(file) && isCorePath(file) && SCANNED_ROOTS.some((root) => file.startsWith(`${root}/`)),
    );
    const constructing = new Set<string>();
    for (const file of listed) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      if (!named.test(text)) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && names.includes(node.expression.text)) {
          constructing.add(file);
        }
        ts.forEachChild(node, visit);
      };
      visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
    }
    expect([...constructing]).toEqual([OPEN_MODULE]);
  });

  test("the legacy adapter's open refuses, as a host defect, a record that offers no legacy provider and a connection whose type is not the record's id, before anything is built", async () => {
    const log = spyOn(console, "log");
    try {
      const pkg = composeServerCatalog(
        [admittedFor("acme-legacy-open", admittedManifest("acmelegacyopen"))],
        [],
      ).engines.get("acmelegacyopen") as EngineRecord;
      const packageConnection = { id: "p", name: "p", type: "acmelegacyopen" } as never;
      const noProvider = await openLegacyEngine(pkg, packageConnection, {}, {}).catch((error: unknown) => error);
      expect((noProvider as Error).constructor).toBe(Error);
      expect((noProvider as Error).message).toContain(quoteTypeId("acmelegacyopen"));

      const [first, second] = [...LEGACY_ENGINES.values()] as [EngineRecord, EngineRecord];
      const other = { ...CENSUS_CONNECTION[second.id as string as DatabaseType] };
      const mismatch = await openLegacyEngine(first, other, {}, {}).catch((error: unknown) => error);
      expect((mismatch as Error).constructor).toBe(Error);
      expect((mismatch as Error).message).toContain(quoteTypeId(first.id));
      expect((mismatch as Error).message).toContain(quoteTypeId(second.id));

      expect(constructions).toEqual([]);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
