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

function readsTheSetting(source: string, fileName = "probe.ts", variable = VARIABLE): boolean {
  // The script kind follows the extension: parsed as TSX, a generic arrow or an angle-bracket assertion in a .ts file
  // opens a JSX element, and a read after it would never be visited.
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node) && node.name.text === variable) found = true;
    else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === variable)
      found = true;
    else if (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(file) === variable) found = true;
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

  test("the modules that import src/lib/db/egress-decision.ts are the provider factory and the boot preflight", () => {
    expect(importersOfTheReader()).toEqual([BOOT_PREFLIGHT, FACTORY].sort());
  });

  test("no module under src/lib/db/providers/ reaches src/lib/db/egress-decision.ts through its imports", () => {
    const reaching = providerModules().filter((name) => valueImportClosure(name).modules.includes(READER));
    expect(reaching).toEqual([]);
  });

  test("no module under src/lib/db/providers/ reaches the provider factory or the boot preflight through its imports", () => {
    const reaching = providerModules().filter((name) => {
      const { modules } = valueImportClosure(name);
      return modules.includes(FACTORY) || modules.includes(BOOT_PREFLIGHT);
    });
    expect(reaching).toEqual([]);
  });
});

// The operator's CA bundle is core's to read too (FND-2 slice 4, the provider plugins design section 0.1):
// `src/lib/db/trust-material.ts` reads the file NODE_EXTRA_CA_CERTS names once per process, and the factory hands its
// certificates to the providers whose TLS library does not read Node's store, so no provider reads the variable or
// reaches a module that does. Sign-in's token trust (`src/lib/openshift-auth/http.ts`) reads it on every token call by
// design; it is core code, not a provider, and no provider reaches it either.
const CA_VARIABLE = "NODE_EXTRA_CA_CERTS";
const TRUST_READER = "src/lib/db/trust-material.ts";
const TOKEN_TRUST_READER = "src/lib/openshift-auth/http.ts";
const CA_PREFLIGHT = "src/lib/config/ca-bundle-preflight.ts";

describe("the operator's CA bundle is read by core alone, and no provider reaches a module that reads it (FND-2 slice 4)", () => {
  test("the read detector finds NODE_EXTRA_CA_CERTS in a property, an element, a destructuring and the name as a string literal, and ignores a sentence that names it", () => {
    expect(readsTheSetting("const a = process.env.NODE_EXTRA_CA_CERTS;", "probe.ts", CA_VARIABLE)).toBe(true);
    expect(readsTheSetting('const a = process.env["NODE_EXTRA_CA_CERTS"];', "probe.ts", CA_VARIABLE)).toBe(true);
    expect(readsTheSetting("const a = process.env['NODE_EXTRA_CA_CERTS'];", "probe.ts", CA_VARIABLE)).toBe(true);
    expect(readsTheSetting("const a = process.env[`NODE_EXTRA_CA_CERTS`];", "probe.ts", CA_VARIABLE)).toBe(true);
    expect(readsTheSetting("const { NODE_EXTRA_CA_CERTS } = process.env;", "probe.ts", CA_VARIABLE)).toBe(true);
    expect(readsTheSetting("const { NODE_EXTRA_CA_CERTS: bundle = '' } = process.env;", "probe.ts", CA_VARIABLE)).toBe(
      true,
    );
    expect(readsTheSetting('const KEY = "NODE_EXTRA_CA_CERTS";', "probe.ts", CA_VARIABLE)).toBe(true);
    expect(readsTheSetting("// process.env.NODE_EXTRA_CA_CERTS", "probe.ts", CA_VARIABLE)).toBe(false);
    expect(
      readsTheSetting('const SENTENCE = "Point NODE_EXTRA_CA_CERTS at a PEM file";', "probe.ts", CA_VARIABLE),
    ).toBe(false);
    // The default variable is the egress one, so a read of another is not a read of it.
    expect(readsTheSetting("const a = process.env.NODE_EXTRA_CA_CERTS;")).toBe(false);
  });

  test("the modules under src/ and vscode-extension/src/ that read NODE_EXTRA_CA_CERTS are src/lib/db/trust-material.ts and src/lib/openshift-auth/http.ts", () => {
    // Each read shape spells the name, so only a file whose text names the variable is parsed.
    const readers = trackedSources("src", "vscode-extension/src").filter((name) => {
      const source = readFileSync(join(process.cwd(), name), "utf8");
      return source.includes(CA_VARIABLE) && readsTheSetting(source, name, CA_VARIABLE);
    });
    expect(readers.sort()).toEqual([TRUST_READER, TOKEN_TRUST_READER].sort());
  });

  test("src/lib/db/trust-material.ts reads it", () => {
    const source = readFileSync(join(process.cwd(), TRUST_READER), "utf8");
    expect(readsTheSetting(source, TRUST_READER, CA_VARIABLE)).toBe(true);
  });

  const importersOfTheTrustReader = (): string[] =>
    trackedSources("src")
      .filter((name) => /\.tsx?$/.test(name) && valueImportsOf(name).includes(TRUST_READER))
      .sort();

  test("no module under src/lib/db/providers/ imports src/lib/db/trust-material.ts", () => {
    expect(importersOfTheTrustReader().filter((name) => name.startsWith(PROVIDERS))).toEqual([]);
  });

  test("the modules that import src/lib/db/trust-material.ts are the provider factory and the CA bundle preflight", () => {
    expect(importersOfTheTrustReader()).toEqual([CA_PREFLIGHT, FACTORY].sort());
  });

  test("no module under src/lib/db/providers/ reaches a module that reads NODE_EXTRA_CA_CERTS, or the CA bundle preflight, through its imports", () => {
    const reaching = providerModules().filter((name) => {
      const { modules } = valueImportClosure(name);
      return [TRUST_READER, TOKEN_TRUST_READER, CA_PREFLIGHT].some((module) => modules.includes(module));
    });
    expect(reaching).toEqual([]);
  });
});

// Core owns Studio's storage location and OPC UA's PKI root the same way (FND-2 slice 3, the provider plugins design
// section 0.1): `src/lib/data-dir.ts` reads STORAGE_SQLITE_PATH, `src/lib/db/provider-files.ts` reads
// LIBREDB_OPCUA_PKI_ROOT, and the factory hands a provider the file it admitted and the root it decided, so no provider
// reads either setting or reaches the module that keeps Studio's own files.
const STORAGE_VARIABLE = "STORAGE_SQLITE_PATH";
const STORAGE_READER = "src/lib/data-dir.ts";
const PKI_VARIABLE = "LIBREDB_OPCUA_PKI_ROOT";
const PKI_READER = "src/lib/db/provider-files.ts";

/** The tracked sources under `src/` and `vscode-extension/src/`, other than `reader`, that read `variable`. */
function readersOtherThan(reader: string, variable: string): string[] {
  // Each read shape spells the name, so only a file whose text names the variable is parsed.
  return trackedSources("src", "vscode-extension/src").filter((name) => {
    if (name === reader) return false;
    const source = readFileSync(join(process.cwd(), name), "utf8");
    return source.includes(variable) && readsTheSetting(source, name, variable);
  });
}

describe("Studio's storage location and OPC UA's PKI root are read by core alone, and no provider reaches the module that reads them (FND-2 slice 3)", () => {
  test("the read detector finds STORAGE_SQLITE_PATH and LIBREDB_OPCUA_PKI_ROOT in a property, an element, a destructuring and the name as a string literal, and ignores a sentence that names them", () => {
    for (const variable of [STORAGE_VARIABLE, PKI_VARIABLE]) {
      expect(readsTheSetting(`const a = process.env.${variable};`, "probe.ts", variable)).toBe(true);
      expect(readsTheSetting(`const a = process.env["${variable}"];`, "probe.ts", variable)).toBe(true);
      expect(readsTheSetting(`const { ${variable} } = process.env;`, "probe.ts", variable)).toBe(true);
      expect(readsTheSetting(`const { ${variable}: value = "x" } = process.env;`, "probe.ts", variable)).toBe(true);
      expect(readsTheSetting(`const KEY = "${variable}";`, "probe.ts", variable)).toBe(true);
      expect(readsTheSetting(`// process.env.${variable}`, "probe.ts", variable)).toBe(false);
      expect(readsTheSetting(`const SENTENCE = "Point ${variable} at a directory";`, "probe.ts", variable)).toBe(false);
      // The default variable is the egress one, so a read of another is not a read of it.
      expect(readsTheSetting(`const a = process.env.${variable};`)).toBe(false);
    }
  });

  test("no source file under src/ or vscode-extension/src/ other than src/lib/data-dir.ts reads STORAGE_SQLITE_PATH", () => {
    expect(readersOtherThan(STORAGE_READER, STORAGE_VARIABLE)).toEqual([]);
  });

  test("src/lib/data-dir.ts reads STORAGE_SQLITE_PATH", () => {
    const source = readFileSync(join(process.cwd(), STORAGE_READER), "utf8");
    expect(readsTheSetting(source, STORAGE_READER, STORAGE_VARIABLE)).toBe(true);
  });

  test("no source file under src/ or vscode-extension/src/ other than src/lib/db/provider-files.ts reads LIBREDB_OPCUA_PKI_ROOT", () => {
    expect(readersOtherThan(PKI_READER, PKI_VARIABLE)).toEqual([]);
  });

  test("src/lib/db/provider-files.ts reads LIBREDB_OPCUA_PKI_ROOT", () => {
    const source = readFileSync(join(process.cwd(), PKI_READER), "utf8");
    expect(readsTheSetting(source, PKI_READER, PKI_VARIABLE)).toBe(true);
  });

  test("no module under src/lib/db/providers/ reaches src/lib/data-dir.ts through its imports", () => {
    const reaching = providerModules().filter((name) => valueImportClosure(name).modules.includes(STORAGE_READER));
    expect(reaching).toEqual([]);
  });
});

// The SSH tunnel is core's (FND-2 slice 5b, docs/SECURITY.md control 3.41): core decides and opens it, and builds every
// provider from a copy of the connection without `sshTunnel`, the tunnel's local endpoint in `host` and `port`, its far
// end under `TUNNEL_FAR_END` and its route under `TUNNEL_ROUTE`. So no provider module, and no shared module a provider
// is built on, reads `sshTunnel`, with no exception. The scan is of direct reads and does not follow imports: core
// modules a provider imports (`src/lib/db/connection-fingerprint.ts`, which frames a record's tunnel on the record side
// of the edit-plan seal) read the field by design.
const TUNNEL_FIELD = "sshTunnel";
const TUNNEL_SCAN_ROOTS = [
  PROVIDERS,
  "src/lib/db/http/",
  "src/lib/db/grpc/",
  "src/lib/db/graph/",
  "src/lib/db/utils/",
  "src/lib/db/auth/",
  "src/lib/db/vector/",
  "src/lib/db/base-provider.ts",
];

/** Every tracked module under the roots the tunnel scan names. */
function tunnelScanPopulation(): string[] {
  return trackedSources(...TUNNEL_SCAN_ROOTS).filter((name) => /\.tsx?$/.test(name));
}

describe("no provider module reads sshTunnel: core hands the tunnel's outcome under its markers (FND-2 slice 5b)", () => {
  test("the read detector finds sshTunnel in a property, an optional chain, an element, a destructuring and the name as a string literal, and ignores a comment and a sentence that names it", () => {
    const reads = (source: string): boolean => readsTheSetting(source, "probe.ts", TUNNEL_FIELD);
    expect(reads("const tunnel = config.sshTunnel;")).toBe(true);
    expect(reads("const enabled = config?.sshTunnel?.enabled;")).toBe(true);
    expect(reads('const tunnel = config["sshTunnel"];')).toBe(true);
    expect(reads("const tunnel = config[`sshTunnel`];")).toBe(true);
    expect(reads("const { sshTunnel } = config;")).toBe(true);
    expect(reads("const { sshTunnel: tunnel } = config;")).toBe(true);
    expect(reads('const present = Object.hasOwn(config, "sshTunnel");')).toBe(true);
    expect(reads("// config.sshTunnel\n/* const { sshTunnel } = config; */")).toBe(false);
    expect(reads('const SENTENCE = "Studio reads the sshTunnel before it builds a provider";')).toBe(false);
    // The default variable is the egress one, so a read of the tunnel is not a read of it.
    expect(readsTheSetting("const tunnel = config.sshTunnel;")).toBe(false);
  });

  test("no provider module, and no shared provider module, reads sshTunnel", () => {
    // Each read shape spells the name, so only a file whose text names the field is parsed.
    const readers = tunnelScanPopulation().filter((name) => {
      const source = readFileSync(join(process.cwd(), name), "utf8");
      return source.includes(TUNNEL_FIELD) && readsTheSetting(source, name, TUNNEL_FIELD);
    });
    expect(readers).toEqual([]);
  });

  test("the scanned population holds a tracked module under each directory it names", () => {
    const population = tunnelScanPopulation();
    for (const root of TUNNEL_SCAN_ROOTS) {
      expect(
        population.some((name) => name.startsWith(root)),
        root,
      ).toBe(true);
    }
  });
});
