/**
 * One server engine catalog across two bundles of one process (docs/providers/CONTRACT.md, clause C-106), in the test
 * process.
 *
 * Next.js loads instrumentation, which composes and installs the catalog at boot, and each route handler, which reads
 * it, as separate module instances, each with its own copy of Studio's error classes. This file reproduces that with
 * two `Bun.build` bundles of Studio's source, as tests/unit/lib/provider-host/cross-bundle.test.ts does: `boot.mjs`,
 * which composes the catalog and installs it, and `route.mjs`, which reads it through `serverEngine` and
 * `assertLegacyProvider` and checks a connection against an engine's field rules. Both load into this process with
 * `import()`. A bundle is named `.mjs`: written as `.js` beside its `.ts` entry, bun imports the `.ts` source instead,
 * and the two "bundles" would be one module instance.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AdmittedForCatalog, RefusedForCatalog } from "@/lib/db/server-catalog-compose";
import type { DatabaseConnection } from "@/lib/types";
import { admittedFor, admittedManifest, withFieldRules } from "../../../helpers/package-catalog";

const SOURCE = path.resolve(import.meta.dir, "..", "..", "..", "..", "src");
const source = (...parts: string[]): string => JSON.stringify(path.join(SOURCE, ...parts));

/** What a bundle answers for a connection's type, typed loosely, since each bundle has its own copy. */
type EngineAnswer = {
  readonly kind: string;
  readonly engine?: { readonly fieldRules: object; readonly statementGrammar: object };
};

/** What the boot bundle exports: the composition, the install and its own copy of the errors. */
interface BootBundle {
  composeServerCatalog(admitted: readonly AdmittedForCatalog[], refused: readonly RefusedForCatalog[]): object;
  installServerCatalog(catalog: object): void;
  forgetServerCatalog(): void;
  ProviderUnavailableError: new (...args: never[]) => Error;
}

/**
 * What the route bundle exports: the accessor, the server-side check, the field rules' readers, the grammar table and its
 * own errors.
 */
interface RouteBundle {
  serverEngine(value: unknown): EngineAnswer;
  assertLegacyProvider(value: unknown, need: "route" | "open"): void;
  serverCatalogInstalled(): boolean;
  connectionFieldRefusal(rules: object, connection: DatabaseConnection): string | undefined;
  fieldRuleRefusal(type: string, connection: DatabaseConnection): string | undefined;
  sqlGrammarFor(type: string): { readonly grammar: object };
  ProviderUnavailableError: new (...args: never[]) => Error;
  PackageEngineUnsupportedError: new (...args: never[]) => Error;
}

const directory = mkdtempSync(path.join(tmpdir(), "studio-catalog-cross-bundle-"));
let boot: BootBundle;
let route: RouteBundle;

/** Bundles `entry` (its text) on its own into `<directory>/<name>/bundle.mjs` and imports it. */
async function bundled<T>(name: string, entry: string[]): Promise<T> {
  const folder = path.join(directory, name);
  const file = path.join(folder, "entry.ts");
  await Bun.write(file, entry.join("\n"));
  const build = await Bun.build({ entrypoints: [file], outdir: folder, naming: "bundle.mjs", target: "node" });
  if (!build.success) throw new Error(`Bun.build could not bundle ${name}: ${build.logs.join("\n")}`);
  return (await import(pathToFileURL(path.join(folder, "bundle.mjs")).href)) as T;
}

beforeAll(async () => {
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
  boot = await bundled<BootBundle>("boot", [
    `export { composeServerCatalog } from ${source("lib", "db", "server-catalog-compose.ts")};`,
    `export { forgetServerCatalog, installServerCatalog } from ${source("lib", "db", "server-catalog.ts")};`,
    `export { ProviderUnavailableError } from ${source("lib", "db", "errors.ts")};`,
    "",
  ]);
  route = await bundled<RouteBundle>("route", [
    `export { assertLegacyProvider, serverCatalogInstalled, serverEngine } from ${source("lib", "db", "server-catalog.ts")};`,
    `export { connectionFieldRefusal, fieldRuleRefusal } from ${source("lib", "db", "connection-field-rules.ts")};`,
    `export { sqlGrammarFor } from ${source("lib", "db", "sql-grammar", "index.ts")};`,
    `export { PackageEngineUnsupportedError, ProviderUnavailableError } from ${source("lib", "db", "errors.ts")};`,
    "",
  ]);
});

afterEach(() => {
  boot.forgetServerCatalog();
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** The error `run` throws. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("nothing was thrown");
}

describe("one server engine catalog across two bundles", () => {
  test("the two bundles hold two copies of Studio's errors, as instrumentation and a route do", () => {
    expect(boot.ProviderUnavailableError).not.toBe(route.ProviderUnavailableError);
  });

  test("a catalog installed by the boot bundle is the one a route bundle reads", () => {
    expect(route.serverCatalogInstalled()).toBe(false);
    expect(route.serverEngine("acmecrossserved").kind).toBe("refused");
    expect(route.serverEngine("snowflake").kind).toBe("served");

    boot.installServerCatalog(
      boot.composeServerCatalog(
        [admittedFor("acme-cross-served", admittedManifest("acmecrossserved", withFieldRules))],
        [{ name: "acme-cross-gone", version: "1.0.0", engines: ["acmecrossgone"], code: "PROVIDER_LOAD_FAILED" }],
      ),
    );

    expect(route.serverCatalogInstalled()).toBe(true);
    const served = route.serverEngine("acmecrossserved");
    expect(served.kind).toBe("served");
    // The field rules' compiled patterns and closures, built in the boot bundle, run in the route bundle.
    const rules = served.engine?.fieldRules as object;
    const connection = (fields: Record<string, unknown>) =>
      ({ id: "c", name: "c", type: "acmecrossserved", ...fields }) as unknown as DatabaseConnection;
    expect(route.connectionFieldRefusal(rules, connection({ host: "Bad Host" }))).toBe(
      "Host is letters, digits, dots and hyphens.",
    );
    expect(route.connectionFieldRefusal(rules, connection({ host: "db.local", user: "writer" }))).toBeUndefined();

    // The refusals are the route bundle's own classes.
    const unsupported = thrown(() => route.assertLegacyProvider("acmecrossserved", "route"));
    expect(unsupported).toBeInstanceOf(route.PackageEngineUnsupportedError);
    expect(route.serverEngine("acmecrossgone").kind).toBe("unavailable");
    const unavailable = thrown(() => route.assertLegacyProvider("acmecrossgone", "route"));
    expect(unavailable).toBeInstanceOf(route.ProviderUnavailableError);
    expect(unavailable).not.toBeInstanceOf(boot.ProviderUnavailableError);
    expect((unavailable as Error).message).toContain("PROVIDER_LOAD_FAILED");

    boot.forgetServerCatalog();
    expect(route.serverCatalogInstalled()).toBe(false);
    expect(route.serverEngine("acmecrossgone").kind).toBe("refused");
  });

  test("a legacy record installed by the boot bundle answers the route bundle as the route's own tables do", () => {
    boot.installServerCatalog(boot.composeServerCatalog([], []));
    // Snowflake's Account rule binds Studio's own check, a closure the boot bundle composed.
    const answer = route.serverEngine("snowflake");
    if (answer.kind !== "served" || answer.engine === undefined) throw new Error(`answered ${answer.kind}`);
    const rules = answer.engine.fieldRules;
    const connection = (fields: Record<string, unknown>) =>
      ({ id: "c", name: "c", type: "snowflake", ...fields }) as unknown as DatabaseConnection;
    for (const fields of [
      {},
      { host: "not an account" },
      { host: "https://xy12345.snowflakecomputing.com" },
      { host: "xy12345" },
    ]) {
      expect(route.connectionFieldRefusal(rules, connection(fields))).toBe(
        route.fieldRuleRefusal("snowflake", connection(fields)),
      );
    }
    // The grammar the boot bundle's record holds reads as the route bundle's own row of it.
    expect(answer.engine.statementGrammar).toEqual(route.sqlGrammarFor("snowflake").grammar);
    expect(() => route.assertLegacyProvider("snowflake", "open")).not.toThrow();
  });
});
