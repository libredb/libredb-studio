/**
 * The census of the connection fields provider modules read (FND-2 slice 6): each engine declares, as data, the fields
 * its provider receives (`providerFields` in src/lib/db/provider-connection.ts, composed from the contract rows), and
 * this file holds the provider modules to that declaration in both directions.
 *
 * HOW IT READS. One TypeScript program over the provider layer of every type-id's value-import closure (the modules
 * under the roots the slice 5b tunnel scan names), built once and shared by the tests below. A read is any property
 * access, element access, destructuring or `in` test whose property the type checker resolves to a member of
 * `DatabaseConnection` (src/lib/types.ts), through `getRootSymbols`, so a read through a `Pick`, a spread or an
 * intersection counts and a field of the same name on another type (a tunnel's `host`) does not. A comment or a
 * sentence naming a field is no read. Code whose reads the checker cannot name is reported as an escape: a dynamic key
 * typed as text, a connection handed to code declared outside the repository or to a parameter that is not a
 * connection, a `for-in` over one, or a cast of one to a type that holds no connection field.
 *
 * WHICH ENGINE A MODULE SERVES. A module is attributed to every type-id whose factory entry module reaches it by value
 * import, except that the two provider directories serving two type-ids are split by `PROVIDER_DIRECTORY_MAP`
 * (tests/helpers/provider-directory-map.ts). A module reached from several type-ids is held to the union of their
 * received fields: it cannot tell which engine it serves without a type branch, and a field it reads for one engine
 * answers undefined for another, as for a record that never set it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { CONNECTION_STRING_ACCEPTED, SHIPPED_DATABASE_TYPES, SSH_TUNNEL_REFUSAL } from "@/lib/db/compatibility";
import { CONNECTION_FIELDS, REFUSED_CONNECTION_FIELDS, SEED_ONLY_FIELDS } from "@/lib/db/connection-fields";
import { offersSslPanel } from "@/lib/db/connection-form";
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { UnknownProviderError } from "@/lib/db/errors";
import { PROVIDER_CORE_FIELDS, providerFields } from "@/lib/db/provider-connection";
import type { DatabaseType } from "@/lib/types";
import { typeIdsOfProviderFile } from "../../../helpers/provider-directory-map";
import { valueImportClosure } from "../../../helpers/value-import-closure";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const FACTORY = "src/lib/db/factory.ts";
const TYPES_MODULE = "src/lib/types.ts";

/**
 * A file's path relative to the repository root with `/` between its names, the form the census keys modules by, or
 * `undefined` for a file outside the root. The compiler names files with `/` on every platform and Node's path
 * functions use the platform's separator, so the two are compared through `relative`, never as strings.
 */
function repositoryModulePath(fileName: string): string | undefined {
  const within = relative(ROOT, resolve(fileName));
  return within === "" || within.startsWith("..") || isAbsolute(within) ? undefined : within.split(sep).join("/");
}

/** The provider layer: the roots the slice 5b tunnel scan names (tests/unit/lib/db/provider-environment-scan.test.ts). */
const PROVIDER_LAYER = [
  "src/lib/db/providers/",
  "src/lib/db/http/",
  "src/lib/db/grpc/",
  "src/lib/db/graph/",
  "src/lib/db/utils/",
  "src/lib/db/auth/",
  "src/lib/db/vector/",
  "src/lib/db/base-provider.ts",
];

/**
 * The declared fields no module of the engine's provider layer reads, pinned by name (BACKLOG D494): SQLite, DuckDB
 * and LibreDB leave `showSslPanel` unset in their form entries, so their declaration takes TLS settings their
 * providers never read. Fixing the form entries is a dialog change of its own.
 */
const DECLARED_AND_UNREAD: Readonly<Partial<Record<DatabaseType, readonly string[]>>> = Object.freeze({
  duckdb: ["ssl"],
  libredb: ["ssl"],
  sqlite: ["ssl"],
});

/** Every test that builds or reads the program takes this timeout: the program takes seconds on a slow runner. */
const PROGRAM_TIMEOUT_MS = 60_000;

// ============================================================================
// The factory's entry modules and the population
// ============================================================================

/** The repository module a factory `import()` specifier names, relative to src/lib/db/. */
function factoryModule(specifier: string): string {
  const base = posix.join("src/lib/db", specifier);
  const found = [`${base}.ts`, posix.join(base, "index.ts")].find((candidate) => existsSync(join(ROOT, candidate)));
  if (found === undefined) throw new Error(`the factory imports ${specifier}, which no module answers`);
  return found;
}

/**
 * Each type-id's provider modules, read from the `case` clauses of the switch in the factory's `buildProvider`: every
 * module the clause imports, its entry module first (OPC UA's clause also imports the module that opens its library
 * session at connect).
 */
function factoryEntries(): Map<DatabaseType, string[]> {
  const file = ts.createSourceFile(FACTORY, readFileSync(join(ROOT, FACTORY), "utf8"), ts.ScriptTarget.Latest, true);
  const entries = new Map<DatabaseType, string[]>();
  const visit = (node: ts.Node, label: string | undefined): void => {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
      const caseLabel = node.expression.text;
      for (const statement of node.statements) visit(statement, caseLabel);
      return;
    }
    if (
      label !== undefined &&
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const type = label as DatabaseType;
      entries.set(type, [...(entries.get(type) ?? []), factoryModule(node.arguments[0].text)]);
    }
    ts.forEachChild(node, (child) => visit(child, label));
  };
  visit(file, undefined);
  return entries;
}

function inProviderLayer(modulePath: string): boolean {
  return PROVIDER_LAYER.some((root) => modulePath === root || (root.endsWith("/") && modulePath.startsWith(root)));
}

/** The provider-layer modules each type-id's entry module reaches, with the shared directories split. */
function layerClosures(entries: Map<DatabaseType, string[]>): Map<DatabaseType, string[]> {
  const closures = new Map<DatabaseType, string[]>();
  for (const [type, roots] of entries) {
    const reached = new Set(roots.flatMap((root) => valueImportClosure(root).modules));
    const modules = [...reached].sort().filter((modulePath) => {
      if (!inProviderLayer(modulePath)) return false;
      const served = typeIdsOfProviderFile(join(ROOT, modulePath));
      return served === null || served.includes(type);
    });
    closures.set(type, modules);
  }
  return closures;
}

// ============================================================================
// The detector
// ============================================================================

interface Finding {
  /** Repository-relative module. */
  readonly module: string;
  readonly line: number;
  /** The field read, or for an escape the shape the census could not read through. */
  readonly what: string;
}

interface ModuleScan {
  readonly reads: Finding[];
  readonly escapes: Finding[];
}

/** The `DatabaseConnection` interface declaration of src/lib/types.ts in `program`. */
function connectionInterface(program: ts.Program): ts.InterfaceDeclaration {
  const file = program.getSourceFile(join(ROOT, TYPES_MODULE));
  if (file === undefined) throw new Error(`${TYPES_MODULE} is not in the program`);
  const found = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "DatabaseConnection",
  );
  if (found === undefined) throw new Error(`${TYPES_MODULE} declares no DatabaseConnection interface`);
  return found;
}

/**
 * Scans `file` for reads of `DatabaseConnection` fields and for escapes. Repository-relative names are taken against
 * the repository root; a file outside it (a planted source) keeps its own name.
 */
function scanModule(program: ts.Program, file: ts.SourceFile): ModuleScan {
  const checker = program.getTypeChecker();
  const declaration = connectionInterface(program);
  const modulePath = repositoryModulePath(file.fileName) ?? file.fileName;
  const reads: Finding[] = [];
  const escapes: Finding[] = [];
  const at = (node: ts.Node): number => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

  /** The field a property symbol is, when it or one of its root symbols is declared in `DatabaseConnection`. */
  const fieldOf = (symbol: ts.Symbol | undefined): string | undefined => {
    if (symbol === undefined) return undefined;
    for (const candidate of [symbol, ...checker.getRootSymbols(symbol)]) {
      if ((candidate.declarations ?? []).some((node) => node.parent === declaration)) return candidate.name;
    }
    return undefined;
  };

  /** Whether a value of `type` holds a connection field: a connection, a part of one, or a union or copy of one. */
  const holdsConnection = (type: ts.Type): boolean => {
    if (type.isUnion()) return type.types.some(holdsConnection);
    return checker.getPropertiesOfType(type).some((property) => fieldOf(property) !== undefined);
  };

  /**
   * Reads of `object[key]`: each string literal the key's type admits. A key that is one of core's markers (a unique
   * symbol, `TUNNEL_FAR_END` and its kin in src/lib/types.ts) names no field; any other key is an escape.
   */
  const keyedRead = (objectType: ts.Type, keyType: ts.Type, node: ts.Node): void => {
    if (!holdsConnection(objectType)) return;
    const literals = keyType.isUnion() ? keyType.types : [keyType];
    const named = (literal: ts.Type): boolean =>
      literal.isStringLiteral() || literal.isNumberLiteral() || (literal.flags & ts.TypeFlags.UniqueESSymbol) !== 0;
    if (!literals.every(named)) {
      escapes.push({ module: modulePath, line: at(node), what: `a key typed ${checker.typeToString(keyType)}` });
      return;
    }
    for (const literal of literals) {
      if (!literal.isStringLiteral()) continue;
      const field = fieldOf(checker.getPropertyOfType(objectType, literal.value));
      if (field !== undefined) reads.push({ module: modulePath, line: at(node), what: field });
    }
  };

  /**
   * Whether a value of `type` carries only core's markers: an object type with at least one property, every one keyed
   * by a unique symbol (`WithAdmittedFile` and its kin in src/lib/types.ts), so no field can be read through it.
   */
  const carriesOnlyMarkers = (type: ts.Type): boolean => {
    const properties = checker.getPropertiesOfType(type);
    return (
      (type.flags & ts.TypeFlags.Object) !== 0 &&
      checker.getIndexInfosOfType(type).length === 0 &&
      properties.length > 0 &&
      properties.every((property) => property.escapedName.toString().startsWith("__@"))
    );
  };

  /** Whether a call's callee is declared in this repository's own source. */
  const declaredInRepository = (call: ts.CallExpression | ts.NewExpression): boolean => {
    const signature = checker.getResolvedSignature(call);
    const callee = signature?.getDeclaration();
    if (callee === undefined) return false;
    return repositoryModulePath(callee.getSourceFile().fileName)?.startsWith("src/") ?? false;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const field = fieldOf(checker.getSymbolAtLocation(node.name));
      if (field !== undefined) reads.push({ module: modulePath, line: at(node), what: field });
    } else if (ts.isElementAccessExpression(node)) {
      keyedRead(checker.getTypeAtLocation(node.expression), checker.getTypeAtLocation(node.argumentExpression), node);
    } else if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      node.dotDotDotToken === undefined
    ) {
      const patternType = checker.getTypeAtLocation(node.parent);
      const name = node.propertyName ?? node.name;
      if (ts.isComputedPropertyName(name)) {
        keyedRead(patternType, checker.getTypeAtLocation(name.expression), node);
      } else if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
        const field = fieldOf(checker.getPropertyOfType(patternType, name.text));
        if (field !== undefined) reads.push({ module: modulePath, line: at(node), what: field });
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      keyedRead(checker.getTypeAtLocation(node.right), checker.getTypeAtLocation(node.left), node);
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const signature = checker.getResolvedSignature(node);
      for (const [index, argument] of (node.arguments ?? []).entries()) {
        if (!holdsConnection(checker.getTypeAtLocation(argument))) continue;
        if (!declaredInRepository(node)) {
          escapes.push({ module: modulePath, line: at(argument), what: `handed to ${node.expression.getText(file)}` });
          continue;
        }
        const parameterType = signature === undefined ? undefined : checker.getContextualType(argument);
        if (parameterType === undefined || !holdsConnection(parameterType)) {
          escapes.push({
            module: modulePath,
            line: at(argument),
            what: `handed to ${node.expression.getText(file)} as ${index}`,
          });
        }
      }
    } else if (ts.isForInStatement(node) && holdsConnection(checker.getTypeAtLocation(node.expression))) {
      escapes.push({ module: modulePath, line: at(node), what: "a for-in over a connection" });
    } else if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      holdsConnection(checker.getTypeAtLocation(node.expression)) &&
      !holdsConnection(checker.getTypeAtLocation(node.type)) &&
      !carriesOnlyMarkers(checker.getTypeAtLocation(node.type))
    ) {
      escapes.push({ module: modulePath, line: at(node), what: `a cast to ${node.type.getText(file)}` });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { reads, escapes };
}

// ============================================================================
// The census, built once
// ============================================================================

function compilerOptions(): ts.CompilerOptions {
  const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  return { ...parsed.options, noEmit: true, incremental: false };
}

interface Census {
  readonly entries: Map<DatabaseType, string[]>;
  readonly closures: Map<DatabaseType, string[]>;
  /** Each population module's scan. */
  readonly scans: Map<string, ModuleScan>;
  /** Each population module's type-ids. */
  readonly servedBy: Map<string, DatabaseType[]>;
}

let census: Census | undefined;

function theCensus(): Census {
  if (census !== undefined) return census;
  const entries = factoryEntries();
  const closures = layerClosures(entries);
  const servedBy = new Map<string, DatabaseType[]>();
  for (const [type, modules] of closures) {
    for (const modulePath of modules) servedBy.set(modulePath, [...(servedBy.get(modulePath) ?? []), type]);
  }
  const program = ts.createProgram({
    rootNames: [...servedBy.keys(), TYPES_MODULE].map((modulePath) => join(ROOT, modulePath)),
    options: compilerOptions(),
  });
  const scans = new Map<string, ModuleScan>();
  for (const modulePath of servedBy.keys()) {
    const file = program.getSourceFile(join(ROOT, modulePath));
    if (file === undefined) throw new Error(`${modulePath} is not in the program`);
    scans.set(modulePath, scanModule(program, file));
  }
  census = { entries, closures, scans, servedBy };
  return census;
}

/** The fields the type-ids serving a module receive, together. */
function receivedByAll(types: readonly DatabaseType[]): Set<string> {
  return new Set(types.flatMap((type) => providerFields(type)));
}

// ============================================================================
// Planted sources, compiled against the real src/lib/types.ts
// ============================================================================

const PLANTED_DIRECTORY = join(ROOT, "src/lib/db/providers/__census_planted__");

/**
 * The repository's own source files, parsed once and shared by every planted program: the files do not change while
 * the tests run, and parsing src/lib/types.ts and what it imports again for each planted source would cost seconds.
 */
const parsedFiles = new Map<string, ts.SourceFile | undefined>();

/** Scans one planted source, a virtual module placed among the providers and compiled against the real types. */
function scanPlanted(source: string): ModuleScan {
  const fileName = join(PLANTED_DIRECTORY, "planted.ts");
  const options = compilerOptions();
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  const planted = (name: string): boolean => resolve(name) === resolve(fileName);
  host.readFile = (name) => (planted(name) ? source : readFile(name));
  host.fileExists = (name) => planted(name) || fileExists(name);
  host.getSourceFile = (name, language, onError, shouldCreate) => {
    if (planted(name)) return ts.createSourceFile(name, source, language, true);
    if (!parsedFiles.has(name)) parsedFiles.set(name, getSourceFile(name, language, onError, shouldCreate));
    return parsedFiles.get(name);
  };
  const program = ts.createProgram({ rootNames: [fileName], options, host });
  const file = program.getSourceFile(fileName);
  if (file === undefined) throw new Error("the planted source is not in its program");
  return scanModule(program, file);
}

const PLANTED_HEADER =
  'import type { DatabaseConnection } from "@/lib/types";\ndeclare const config: DatabaseConnection;\n';
const readsOf = (body: string): string[] => scanPlanted(PLANTED_HEADER + body).reads.map((read) => read.what);
const escapesOf = (body: string): string[] => scanPlanted(PLANTED_HEADER + body).escapes.map((escape) => escape.what);

// ============================================================================
// Tests
// ============================================================================

describe("a provider module reads only the connection fields its engine declares, and every declared field is read (FND-2 slice 6)", () => {
  test(
    "the census's population holds every factory entry module and every type-id",
    () => {
      const { entries, closures, scans } = theCensus();
      expect([...entries.keys()].sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
      for (const [type, modules] of entries) {
        expect(modules.length).toBeGreaterThan(0);
        for (const entry of modules) {
          expect({ type, entry, inLayer: inProviderLayer(entry) }).toEqual({ type, entry, inLayer: true });
          expect(closures.get(type)).toContain(entry);
          expect(scans.has(entry)).toBe(true);
        }
      }
      expect(scans.size).toBeGreaterThan(entries.size);
    },
    PROGRAM_TIMEOUT_MS,
  );

  test("providerFields is the union of the declaration rows, for every type-id", () => {
    for (const type of SHIPPED_DATABASE_TYPES) {
      const expected = new Set<string>([
        ...CONNECTION_FIELDS[type],
        ...(SEED_ONLY_FIELDS[type]?.fields ?? []),
        ...(CONNECTION_STRING_ACCEPTED[type] ? ["connectionString"] : []),
        ...(offersSslPanel(type) ? ["ssl"] : []),
        ...(SSH_TUNNEL_REFUSAL[type] === null ? ["host", "port"] : []),
        ...PROVIDER_CORE_FIELDS,
      ]);
      const fields: readonly string[] = providerFields(type);
      expect({ type, fields: [...fields].sort() }).toEqual({ type, fields: [...expected].sort() });
      expect(new Set(fields).size).toBe(fields.length);
      expect(Object.isFrozen(fields)).toBe(true);
    }
    expect([...PROVIDER_CORE_FIELDS]).toEqual(["id", "name", "type", "queryTimeout", "readOnly", "managed", "seedId"]);
    expect(Object.isFrozen(PROVIDER_CORE_FIELDS)).toBe(true);
  });

  test("no engine receives a field its engine refuses", () => {
    for (const type of SHIPPED_DATABASE_TYPES) {
      const fields: readonly string[] = providerFields(type);
      const received = Object.keys(REFUSED_CONNECTION_FIELDS[type]).filter((field) => fields.includes(field));
      expect({ type, received }).toEqual({ type, received: [] });
    }
  });

  test("providerFields refuses a type that names no provider, by name", () => {
    expect(() => providerFields("not-an-engine" as DatabaseType)).toThrow(UnknownProviderError);
    expect(() => providerFields("constructor" as DatabaseType)).toThrow(UnknownProviderError);
  });

  test(
    "no provider module reads a connection field the engines reaching it do not declare",
    () => {
      const { scans, servedBy } = theCensus();
      const undeclared: string[] = [];
      for (const [modulePath, scan] of scans) {
        const types = servedBy.get(modulePath) ?? [];
        const received = receivedByAll(types);
        for (const read of scan.reads) {
          if (!received.has(read.what)) undeclared.push(`${read.what} @ ${modulePath} [${types.join(",")}]`);
        }
      }
      expect([...new Set(undeclared)].sort()).toEqual([]);
    },
    PROGRAM_TIMEOUT_MS,
  );

  test(
    "no provider module hands a connection to code the census cannot read",
    () => {
      const { scans } = theCensus();
      const escapes = [...scans.values()].flatMap((scan) =>
        scan.escapes.map((escape) => `${escape.what} @ ${escape.module}:${escape.line}`),
      );
      expect(escapes).toEqual([]);
    },
    PROGRAM_TIMEOUT_MS,
  );

  test(
    "the declared fields no provider module reads are exactly the named ones",
    () => {
      const { closures, scans } = theCensus();
      const unread: Record<string, string[]> = {};
      for (const [type, modules] of closures) {
        const read = new Set(
          modules.flatMap((modulePath) => (scans.get(modulePath)?.reads ?? []).map((entry) => entry.what)),
        );
        const core: readonly string[] = PROVIDER_CORE_FIELDS;
        const missing = providerFields(type).filter((field) => !core.includes(field) && !read.has(field));
        if (missing.length > 0) unread[type] = [...missing].sort();
      }
      expect(unread).toEqual(DECLARED_AND_UNREAD as Record<string, string[]>);
    },
    PROGRAM_TIMEOUT_MS,
  );

  test(
    "the base provider every engine extends reads only Studio's own fields",
    () => {
      const { scans } = theCensus();
      const scan = scans.get("src/lib/db/base-provider.ts");
      expect(scan).toBeDefined();
      const core: readonly string[] = PROVIDER_CORE_FIELDS;
      const reads = [...new Set((scan?.reads ?? []).map((read) => read.what))].sort();
      expect(reads.filter((field) => !core.includes(field))).toEqual([]);
      const prototype = BaseDatabaseProvider.prototype as unknown as Record<string, unknown>;
      expect("getSafeConfig" in prototype).toBe(false);
      expect("getConnectionInfo" in prototype).toBe(false);
    },
    PROGRAM_TIMEOUT_MS,
  );

  test(
    "the detector reads real code: MSSQL's own modules read no connection string, and OPC UA's read the port core writes for a tunnel",
    () => {
      const { closures, scans, servedBy } = theCensus();
      // The reads of the modules that serve this type-id alone: base-provider.ts and the shared helpers are held to the
      // union of every engine reaching them.
      const ownReads = (type: DatabaseType): Set<string> =>
        new Set(
          (closures.get(type) ?? [])
            .filter((modulePath) => servedBy.get(modulePath)?.length === 1)
            .flatMap((modulePath) => (scans.get(modulePath)?.reads ?? []).map((read) => read.what)),
        );
      expect(ownReads("mssql").has("connectionString")).toBe(false);
      expect(ownReads("mssql").has("host")).toBe(true);
      expect(ownReads("opcua").has("port")).toBe(true);
      expect(ownReads("opcua").has("securityMode")).toBe(true);
    },
    PROGRAM_TIMEOUT_MS,
  );

  describe("the detector, on planted sources compiled against the real src/lib/types.ts", () => {
    test(
      "finds a property read, a string-literal element read, a destructuring, an in test and a dynamic key typed as a union of field names",
      () => {
        expect(readsOf("export const a = config.host;")).toEqual(["host"]);
        expect(readsOf("export const a = config?.port;")).toEqual(["port"]);
        expect(readsOf('export const a = config["database"];')).toEqual(["database"]);
        expect(readsOf("export const { user, password: secret } = config;")).toEqual(["user", "password"]);
        expect(readsOf('export const a = "schema" in config;')).toEqual(["schema"]);
        expect(
          readsOf(
            'declare const key: "clientCertificatePath" | "clientPrivateKeyPath";\nexport const a = config[key];',
          ),
        ).toEqual(["clientCertificatePath", "clientPrivateKeyPath"]);
        expect(
          readsOf(
            'export const pick = (c: Pick<DatabaseConnection, "region">) => c.region;\nexport const a = pick(config);',
          ),
        ).toEqual(["region"]);
        expect(readsOf("export const copy = { ...config };\nexport const a = copy.warehouse;")).toEqual(["warehouse"]);
      },
      PROGRAM_TIMEOUT_MS,
    );

    test(
      "reports a dynamic key typed as text, a call into a package or the standard library, a for-in and a cast to a shape without a connection field as escapes",
      () => {
        expect(
          escapesOf(
            "declare const key: string;\nexport const a = (config as DatabaseConnection & Record<string, unknown>)[key];",
          ),
        ).toEqual(["a key typed string"]);
        expect(
          escapesOf("declare const key: string;\nexport const a = (config as Record<string, unknown>)[key];"),
        ).toEqual(["a cast to Record<string, unknown>"]);
        expect(escapesOf("export const a = JSON.stringify(config);")).toEqual(["handed to JSON.stringify"]);
        expect(escapesOf("export const a = Object.keys(config);")).toEqual(["handed to Object.keys"]);
        expect(escapesOf("export const a = Object.assign({}, config);")).toEqual(["handed to Object.assign"]);
        expect(escapesOf('import { format } from "node:util";\nexport const a = format("%o", config);')).toEqual([
          "handed to format",
        ]);
        expect(escapesOf("export const a: string[] = [];\nfor (const key in config) a.push(key);")).toEqual([
          "a for-in over a connection",
        ]);
        expect(escapesOf("export const a = config as unknown;")).toEqual(["a cast to unknown"]);
        expect(
          escapesOf("const describe = (value: unknown): string => String(value);\nexport const a = describe(config);"),
        ).toEqual(["handed to describe as 0"]);
      },
      PROGRAM_TIMEOUT_MS,
    );

    test(
      "counts no comment and no sentence that names a field, and no field of the same name on another type",
      () => {
        expect(readsOf("// config.agentPassword\n/* const { agentUser } = config; */\nexport const a = 1;")).toEqual(
          [],
        );
        expect(readsOf('export const SENTENCE = "Studio reads config.agentPassword";')).toEqual([]);
        expect(readsOf("declare const tunnel: { host: string };\nexport const a = tunnel.host;")).toEqual([]);
      },
      PROGRAM_TIMEOUT_MS,
    );
  });
});
