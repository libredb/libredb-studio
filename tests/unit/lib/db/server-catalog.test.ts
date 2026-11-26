/**
 * The server's engine catalog (src/lib/db/server-catalog.ts) and its composition (src/lib/db/server-catalog-compose.ts):
 * one engine record for every engine, the legacy adapter's records of Studio's bundled engines beside the records of
 * the admitted provider packages' engines, composed once at boot, read through one accessor keyed by one Map, with the
 * set rules over the whole set refusing every admitted claimant whatever the order.
 *
 * Every package here is built in memory (tests/helpers/package-catalog.ts): no file is written and nothing is imported,
 * so each case installs a catalog of its own and forgets it after.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { connectionFieldRefusal } from "@/lib/db/connection-field-rules";
import { BUNDLED_FENCE_ALIASES } from "@/lib/db/engine-catalog/editor.generated";
import {
  DatabaseConfigError,
  PackageEngineUnsupportedError,
  ProviderUnavailableError,
  UnknownProviderError,
} from "@/lib/db/errors";
import {
  assertLegacyProvider,
  type EngineRecord,
  forgetServerCatalog,
  installServerCatalog,
  legacyProviderRefusal,
  serverCatalogInstalled,
  servedPackage,
  serverEngine,
} from "@/lib/db/server-catalog";
import {
  type AdmittedForCatalog,
  catalogConflicts,
  composeServerCatalog,
  type RefusedForCatalog,
} from "@/lib/db/server-catalog-compose";
import { assertDatabaseType, isDatabaseType, typeIdRefusal } from "@/lib/db/type-id";
import { catalogConflictRefusal } from "@/lib/provider-host/provider-refusals";
import type { DatabaseConnection } from "@/lib/types";
import type { GrammarFacts } from "@libredb/provider-sdk/manifest";
import { grammarFromFacts } from "@/lib/db/sql-grammar";
import ts from "typescript";
import {
  admittedFor,
  admittedManifest,
  type EditableEngine,
  withFieldRules,
  withLegacyProviderOffers,
} from "../../../helpers/package-catalog";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");

/** Every member of an engine record, legacy or package. */
const RECORD_KEYS = ["catalog", "connection", "fieldRules", "grants", "id", "offers", "source", "statementGrammar"];

/** Every offer of an engine record. */
const OFFER_KEYS = [
  "catalog",
  "consoleTextBound",
  "database",
  "explain",
  "hostFiles",
  "legacyProvider",
  "ownWords",
  "queryEventText",
  "sshTunnel",
  "testCautions",
  "unboundedPage",
];

/** The ids of Studio's committed declarations, read from their files. */
function declaredIds(): string[] {
  return readdirSync(path.join(ROOT, "src/lib/db/engine-declarations"))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

/** The root package.json's version, read from the file. */
function rootVersion(): string {
  return (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
}

/** The names `module` (repository-relative) imports by value from `specifier`, read with the TypeScript compiler. */
function valueNamesImported(module: string, specifier: string): string[] {
  const file = path.join(ROOT, module);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== specifier) continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) throw new Error(`${module} imports ${specifier} whole`);
    for (const element of bindings.elements) if (!element.isTypeOnly) names.push(element.name.text);
  }
  return names.sort();
}

afterEach(() => {
  forgetServerCatalog();
});

/** The sentence a field rule naming a check answers for a field holding a value. */
const unboundCheck = (field: string): string =>
  `This LibreDB Studio cannot run the check the provider package declares for the field ${field}, so it does not send this connection.`;

/** A connection of type `type` with `fields`. */
function connectionOf(type: string, fields: Record<string, unknown>): DatabaseConnection {
  return { id: randomUUID(), name: "c", type, ...fields } as unknown as DatabaseConnection;
}

/** The error `run` throws. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("nothing was thrown");
}

/** The record `serverEngine` answers for `id`, which must be served. */
function servedRecord(id: string): EngineRecord {
  const answer = serverEngine(id);
  if (answer.kind !== "served") throw new Error(`answered ${answer.kind}`);
  return answer.engine;
}

describe("the accessor", () => {
  test("an admitted engine is a known type to the server and its connection fields come from its declaration", () => {
    const manifest = admittedManifest("acmeserved", withFieldRules);
    const pkg = admittedFor("acme-served", manifest);
    installServerCatalog(composeServerCatalog([pkg], []));

    const engine = servedRecord("acmeserved");
    expect<string>(engine.id).toBe("acmeserved");
    expect([engine.source.name, engine.source.version]).toEqual(["acme-served", "1.0.0"]);
    expect(servedPackage(engine)).toMatchObject({ name: "acme-served", version: "1.0.0", directory: pkg.directory });
    expect(servedPackage(engine).manifest).toBe(manifest);
    expect(servedPackage(engine).record).toBe(pkg.record);
    expect(engine.catalog).toEqual({ location: "external", connectBudgetMs: null });
    expect(engine.connection.fields).toEqual(["host", "port", "user", "password", "database"]);
    // The field rules are the declaration's, in its field order, each pattern compiled once.
    expect(engine.fieldRules.connectionFields).toEqual(["host", "user", "password", "database"]);
    expect(engine.fieldRules.fieldShownWhen).toEqual({ database: { field: "user", equals: "reader" } });
    expect(engine.fieldRules.fieldDefaults).toEqual({ user: "reader" });
    const rules = engine.fieldRules;
    const refuse = (fields: Record<string, unknown>) =>
      connectionFieldRefusal(rules, connectionOf("acmeserved", fields));
    expect(refuse({ database: "d" })).toBe("Enter the host. Nothing was sent.");
    expect(refuse({ host: "Bad Host", database: "d" })).toBe("Host is letters, digits, dots and hyphens.");
    expect(refuse({ host: "db.local", user: "ab" })).toBe("User is 3 to 16 characters.");
    expect(refuse({ host: "db.local" })).toBe("Enter the database. Nothing was sent.");
    // A user other than reader hides the database, so its rule is not read.
    expect(refuse({ host: "db.local", user: "writer" })).toBeUndefined();
    expect(refuse({ host: "db.local", user: "reader", database: "d" })).toBeUndefined();
    // The engine's record offers no legacy provider: the server-side check refuses it on a route that does not serve it,
    // by name.
    const route = thrown(() => assertLegacyProvider("acmeserved", "route"));
    expect(route).toBeInstanceOf(PackageEngineUnsupportedError);
    expect((route as Error).message).toBe(
      "This request is served for an engine of a provider package only by Test Connection and the query route in this LibreDB Studio, and this is another request.",
    );
    const open = thrown(() => assertLegacyProvider("acmeserved", "open"));
    expect((open as Error).message).toBe(
      "LibreDB Studio's provider factory builds no provider for an engine of a provider package; that engine's session opens through its package, and this caller does not serve one.",
    );
    expect((open as PackageEngineUnsupportedError).code).toBe("PACKAGE_ENGINE_UNSUPPORTED");
    expect((open as PackageEngineUnsupportedError).typeId).toBe("acmeserved");
    expect(open).not.toBeInstanceOf(DatabaseConfigError);
  });

  test("the library's DatabaseType guard is unchanged", () => {
    installServerCatalog(composeServerCatalog([admittedFor("acme-guard", admittedManifest("acmeguard"))], []));
    expect(isDatabaseType("acmeguard")).toBe(false);
    expect(typeIdRefusal("acmeguard")).toEqual({
      reason: "unknown",
      typeId: "acmeguard",
      sentence: 'No provider for the connection type "acmeguard" is installed in this LibreDB Studio.',
    });
    expect(() => assertDatabaseType("acmeguard")).toThrow(UnknownProviderError);
    forgetServerCatalog();

    // With nothing installed, the server-side check answers every value that is no type id exactly as the guard does.
    for (const value of [undefined, null, "", 7, ["postgres"], "acmenone", "Postgres", " postgres"]) {
      const expected = thrown(() => assertDatabaseType(value)) as UnknownProviderError;
      for (const need of ["route", "open"] as const) {
        const actual = thrown(() => assertLegacyProvider(value, need)) as UnknownProviderError;
        expect(actual).toBeInstanceOf(UnknownProviderError);
        expect([actual.name, actual.message, actual.code, actual.reason, actual.typeId]).toEqual([
          expected.name,
          expected.message,
          expected.code,
          expected.reason,
          expected.typeId,
        ]);
      }
    }
    for (const id of SHIPPED_DATABASE_TYPES) {
      expect(servedRecord(id).id as string).toBe(id);
      expect(() => assertLegacyProvider(id, "open")).not.toThrow();
    }
  });

  test("a refused package's engine is unavailable naming every code that refused it, and a bundled id stays bundled", () => {
    const bundled = SHIPPED_DATABASE_TYPES[0] as string;
    const refused: RefusedForCatalog[] = [
      { name: "acme-two", version: "2.0.0", engines: ["acmegone", "acmelost"], code: "PROVIDER_LOAD_FAILED" },
      { name: "acme-one", version: "1.0.0", engines: ["acmegone", bundled], code: "PROVIDER_DIGEST_MISMATCH" },
      { name: "acme-three", version: "1.0.0", engines: ["acmegone"], code: "PROVIDER_LOAD_FAILED" },
    ];
    installServerCatalog(composeServerCatalog([], refused));

    expect<unknown>(serverEngine("acmegone")).toEqual({
      kind: "unavailable",
      id: "acmegone",
      codes: ["PROVIDER_DIGEST_MISMATCH", "PROVIDER_LOAD_FAILED"],
    });
    expect<unknown>(serverEngine("acmelost")).toEqual({
      kind: "unavailable",
      id: "acmelost",
      codes: ["PROVIDER_LOAD_FAILED"],
    });
    expect(servedRecord(bundled).source.package).toBeNull();
    expect<unknown>(serverEngine("acmeunnamed")).toEqual({ kind: "refused", refusal: typeIdRefusal("acmeunnamed") });

    const error = thrown(() => assertLegacyProvider("acmegone", "route")) as ProviderUnavailableError;
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect([error.code, error.typeId, error.codes]).toEqual([
      "PROVIDER_UNAVAILABLE",
      "acmegone",
      ["PROVIDER_DIGEST_MISMATCH", "PROVIDER_LOAD_FAILED"],
    ]);
    expect(error.message).toBe(
      'The connection type "acmegone" is served by a provider package this LibreDB Studio refused when it started (PROVIDER_DIGEST_MISMATCH, PROVIDER_LOAD_FAILED), so no provider can open it; the server\'s log names the package and why.',
    );
    // Never the package's name or version: a user who is not the operator learns neither.
    expect(error.message).not.toContain("acme-");
  });

  test("a type a client sends that is an Object.prototype key is unknown, never an inherited member", () => {
    installServerCatalog(
      composeServerCatalog(
        [admittedFor("acme-proto", admittedManifest("acmeproto"))],
        [{ name: "acme-gone", version: "1.0.0", engines: ["acmegoneproto"], code: "PROVIDER_LOAD_FAILED" }],
      ),
    );
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect<unknown>(serverEngine(key)).toEqual({ kind: "refused", refusal: typeIdRefusal(key) });
      expect(thrown(() => assertLegacyProvider(key, "route"))).toBeInstanceOf(UnknownProviderError);
    }
  });

  test("the catalog composes once: a second install is refused by name, and nothing installed answers the bundled catalog", () => {
    expect(serverCatalogInstalled()).toBe(false);
    expect<unknown>(serverEngine("acmeonce")).toEqual({ kind: "refused", refusal: typeIdRefusal("acmeonce") });
    const first = composeServerCatalog([admittedFor("acme-once", admittedManifest("acmeonce"))], []);
    installServerCatalog(first);
    expect(serverCatalogInstalled()).toBe(true);
    expect(() => installServerCatalog(composeServerCatalog([], []))).toThrow(
      "The server's engine catalog is already installed in this process: boot composes it once.",
    );
    expect<unknown>(serverEngine("acmeonce").kind).toBe("served");
    forgetServerCatalog();
    expect(serverCatalogInstalled()).toBe(false);
    expect<unknown>(serverEngine("acmeonce").kind).toBe("refused");
  });
});

describe("one engine record for every engine", () => {
  test("with nothing installed, serverEngine answers a served record for each of the 43 declared ids, each with the legacy identity @libredb/studio at the root package.json's version", () => {
    expect(serverCatalogInstalled()).toBe(false);
    const ids = declaredIds();
    expect(ids).toHaveLength(43);
    const version = rootVersion();
    for (const id of ids) {
      const engine = servedRecord(id);
      expect(engine.id as string).toBe(id);
      expect(engine.source).toEqual({ name: "@libredb/studio", version, package: null });
    }
  });

  test("a legacy engine and an admitted package's engine answer the same record shape, told apart by no kind", () => {
    installServerCatalog(composeServerCatalog([admittedFor("acme-shape", admittedManifest("acmeshape"))], []));
    const legacy = serverEngine(SHIPPED_DATABASE_TYPES[0]);
    const packaged = serverEngine("acmeshape");
    expect([legacy.kind, packaged.kind]).toEqual(["served", "served"]);
    if (legacy.kind !== "served" || packaged.kind !== "served") throw new Error("not served");
    expect(Object.keys(legacy.engine).sort()).toEqual(RECORD_KEYS);
    expect(Object.keys(packaged.engine).sort()).toEqual(RECORD_KEYS);
    expect(Object.keys(legacy.engine.offers).sort()).toEqual(OFFER_KEYS);
    expect(Object.keys(packaged.engine.offers).sort()).toEqual(OFFER_KEYS);
    expect(Object.keys(legacy.engine.source).sort()).toEqual(Object.keys(packaged.engine.source).sort());
  });

  test("serverEngine reads no isDatabaseType: an id outside the catalog's map is refused with typeIdRefusal's answer, unchanged", () => {
    expect(valueNamesImported("src/lib/db/server-catalog.ts", "./type-id")).toEqual(["quoteTypeId", "typeIdRefusal"]);
    const values: unknown[] = [undefined, null, "", 5, ["postgres"], "constructor", "__proto__", "acmenosuch"];
    for (const value of values) {
      expect<unknown>(serverEngine(value)).toEqual({ kind: "refused", refusal: typeIdRefusal(value) });
    }
    // The check reads the record's offer, never the id's membership: a crafted catalog whose legacy record offers no
    // legacy provider is refused as a package's engine is, and a package record that offers one passes.
    const legacyId = SHIPPED_DATABASE_TYPES[0] as string;
    installServerCatalog(
      withLegacyProviderOffers(composeServerCatalog([admittedFor("acme-offer", admittedManifest("acmeoffer"))], []), {
        [legacyId]: false,
        acmeoffer: true,
      }),
    );
    const refused = thrown(() => assertLegacyProvider(legacyId, "open")) as PackageEngineUnsupportedError;
    expect(refused).toBeInstanceOf(PackageEngineUnsupportedError);
    expect([refused.code, refused.typeId]).toEqual(["PACKAGE_ENGINE_UNSUPPORTED", legacyId]);
    expect(refused.message).toBe(
      "LibreDB Studio's provider factory builds no provider for an engine of a provider package; that engine's session opens through its package, and this caller does not serve one.",
    );
    expect(legacyProviderRefusal("acmeoffer", "route")).toBeNull();
  });

  test("a legacy record offers the legacy provider surface, explain, database, catalog and unbounded pages, and a package record offers none of them", () => {
    installServerCatalog(composeServerCatalog([admittedFor("acme-offers", admittedManifest("acmeoffers"))], []));
    const surface = (engine: EngineRecord) => {
      const { legacyProvider, explain, database, catalog, unboundedPage } = engine.offers;
      return { legacyProvider, explain, database, catalog, unboundedPage };
    };
    for (const id of SHIPPED_DATABASE_TYPES) {
      expect(surface(servedRecord(id))).toEqual({
        legacyProvider: true,
        explain: true,
        database: true,
        catalog: true,
        unboundedPage: true,
      });
    }
    expect(surface(servedRecord("acmeoffers"))).toEqual({
      legacyProvider: false,
      explain: false,
      database: false,
      catalog: false,
      unboundedPage: false,
    });
  });

  test("the composed catalog holds every legacy record by identity, then the admitted engines", () => {
    const pkg = admittedFor("acme-order", admittedManifest("acmeorder"));
    const composed = composeServerCatalog([pkg], []);
    const nothingInstalled = SHIPPED_DATABASE_TYPES.map((id) => servedRecord(id));
    expect([...composed.engines.keys()]).toEqual([...SHIPPED_DATABASE_TYPES, "acmeorder"]);
    SHIPPED_DATABASE_TYPES.forEach((id, index) => {
      expect(composed.engines.get(id)).toBe(nothingInstalled[index] as EngineRecord);
    });
    installServerCatalog(composed);
    for (const id of SHIPPED_DATABASE_TYPES) expect(servedRecord(id)).toBe(composed.engines.get(id) as EngineRecord);
  });

  test("installing a catalog that lacks a legacy engine's record is a host defect, named", () => {
    const composed = composeServerCatalog([], []);
    const missing = SHIPPED_DATABASE_TYPES[1] as string;
    const engines = new Map(composed.engines);
    engines.delete(missing);
    expect(() => installServerCatalog({ engines, unavailable: composed.unavailable })).toThrow(
      `The server's engine catalog holds no record of the legacy engine ${JSON.stringify(missing)}: every composed catalog holds every legacy record.`,
    );
    expect(serverCatalogInstalled()).toBe(false);
  });

  test("servedPackage answers a package record's package with its declared session, and a legacy record's is a host defect", () => {
    const manifest = admittedManifest("acmesession");
    installServerCatalog(composeServerCatalog([admittedFor("acme-session", manifest)], []));
    const served = servedPackage(servedRecord("acmesession"));
    expect(served.session.calls).toBe(manifest.calls);
    expect(served.session.panels).toBe(manifest.engines[0]?.facets.monitoring as never);
    const legacyId = SHIPPED_DATABASE_TYPES[0] as string;
    expect(() => servedPackage(servedRecord(legacyId))).toThrow(
      `The engine ${JSON.stringify(legacyId)} is served by LibreDB Studio's legacy adapter, which serves no provider package: a caller that reads a package of it is a host defect.`,
    );
  });
});

describe("what the catalog composes", () => {
  test("the composed catalog holds no engine knowledge the declaration did not state: no SQL writing, connection form, connection string, grammar, migration DDL or generator row", () => {
    installServerCatalog(composeServerCatalog([admittedFor("acme-keys", admittedManifest("acmekeys"))], []));
    const engine = servedRecord("acmekeys");
    expect(Object.keys(engine).sort()).toEqual(RECORD_KEYS);
    expect(Object.keys(engine.fieldRules).sort()).toEqual(["connectionFields"]);
    expect(Object.keys(engine.connection).sort()).toEqual([
      "connectionStringAccepted",
      "credentialWarnings",
      "dialogOffersUri",
      "fields",
      "readsTrustMaterial",
      "refused",
      "seedOnly",
      "tlsModes",
    ]);
    expect(Object.keys(engine.source).sort()).toEqual(["name", "package", "version"]);
    const served = servedPackage(engine);
    expect(Object.keys(served).sort()).toEqual(["directory", "manifest", "name", "record", "session", "version"]);
    for (const value of [
      engine,
      engine.source,
      served,
      engine.catalog,
      engine.connection,
      engine.fieldRules,
      engine.grants,
      engine.offers,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  test("a package engine's statement grammar is its declaration's facts, composed once, each trailing clause compiled once", () => {
    const manifest = admittedManifest("acmegrammar", (engine) => {
      const grammar = (engine.sqlText as { grammar: Record<string, unknown> }).grammar;
      grammar.trailingLimitClauses = [{ source: "\\s+FORMAT\\s+\\w+\\s*$", flags: "i" }];
      grammar.confirmExemptForms = [["ALTER", "SESSION", "SET"]];
      grammar.dollarTags = false;
    });
    installServerCatalog(composeServerCatalog([admittedFor("acme-grammar", manifest)], []));
    const { statementGrammar } = servedRecord("acmegrammar");
    const declared = (manifest.engines[0] as { sqlText: { grammar: GrammarFacts } }).sqlText.grammar;
    // The same record Studio composes its own engines' grammars with, from the package's facts as declared: the gate
    // drops the exempt forms when it reads them (packageStatementAsks), so the record keeps them as data.
    expect(statementGrammar).toEqual(grammarFromFacts(declared));
    expect(statementGrammar.confirmExemptForms).toEqual([["ALTER", "SESSION", "SET"]]);
    expect(statementGrammar.dollarTags).toBe(false);
    expect(Object.isFrozen(statementGrammar)).toBe(true);
    // Compiled at composition, once: every read of the record answers the same expression.
    const [clause] = statementGrammar.trailingLimitClauses ?? [];
    expect(clause).toBeInstanceOf(RegExp);
    expect([clause?.source, clause?.flags]).toEqual(["\\s+FORMAT\\s+\\w+\\s*$", "i"]);
    expect(servedRecord("acmegrammar").statementGrammar.trailingLimitClauses?.[0]).toBe(clause as RegExp);
  });

  test("composing a set that still conflicts, or an engine both served and unavailable, is a host defect", () => {
    const one = admittedFor("acme-dup-a", admittedManifest("acmedup"));
    const two = admittedFor("acme-dup-b", admittedManifest("acmedup"));
    expect(() => composeServerCatalog([one, two], [])).toThrow(
      "composeServerCatalog: the admitted packages still conflict (acme-dup-a 1.0.0 engine-id, acme-dup-b 1.0.0 engine-id): boot refuses every claimant before it composes",
    );
    expect(() =>
      composeServerCatalog(
        [one],
        [{ name: "acme-x", version: "1.0.0", engines: ["acmedup"], code: "PROVIDER_LOAD_FAILED" }],
      ),
    ).toThrow("composeServerCatalog: an engine of an admitted package is also named by a refused package's lock entry");
  });

  test("a field rule naming a check refuses a value with core's sentence naming the field, and passes an empty field", () => {
    installServerCatalog(
      composeServerCatalog([admittedFor("acme-check", admittedManifest("acmecheck", withFieldRules))], []),
    );
    const rules = servedRecord("acmecheck").fieldRules;
    const base = { host: "db.local", user: "writer" };
    expect(connectionFieldRefusal(rules, connectionOf("acmecheck", { ...base, password: randomUUID() }))).toBe(
      unboundCheck("password"),
    );
    for (const password of [undefined, null, ""]) {
      expect(connectionFieldRefusal(rules, connectionOf("acmecheck", { ...base, password }))).toBeUndefined();
    }
  });
});

describe("the set rules", () => {
  /** Every order of `items`. */
  function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, index) =>
      permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item].concat(rest)),
    );
  }

  /** `name version rule` of each conflict. */
  const named = (packages: readonly AdmittedForCatalog[]) =>
    catalogConflicts(packages).map(({ name, version, rule }) => `${name} ${version} ${rule}`);

  test("a fence alias or an engine id two claimants state refuses every admitted claimant, whatever their order", () => {
    const bundledAlias = admittedFor(
      "acme-alias-bundled",
      admittedManifest("acmealiasa", (engine) => {
        (engine.editor as Record<string, unknown>).fenceAliases = [SHIPPED_DATABASE_TYPES[0]];
      }),
    );
    const sharedA = admittedFor(
      "acme-alias-shared-a",
      admittedManifest("acmealiasb", (engine) => {
        (engine.editor as Record<string, unknown>).fenceAliases = ["acmeshared"];
      }),
    );
    const sharedB = admittedFor(
      "acme-alias-shared-b",
      admittedManifest("acmealiasc", (engine) => {
        (engine.editor as Record<string, unknown>).fenceAliases = ["acmeshared"];
      }),
    );
    const namesOther = admittedFor(
      "acme-alias-names",
      admittedManifest("acmealiasd", (engine) => {
        (engine.editor as Record<string, unknown>).fenceAliases = ["acmealiase"];
      }),
    );
    const named_ = admittedFor("acme-alias-named", admittedManifest("acmealiase"));
    const sameId = admittedFor("acme-same-id", admittedManifest("acmealiasa"));
    const quiet = admittedFor("acme-quiet", admittedManifest("acmequiet"));
    const expected = [
      "acme-alias-bundled 1.0.0 engine-id",
      "acme-alias-bundled 1.0.0 fence-alias",
      "acme-alias-named 1.0.0 fence-alias",
      "acme-alias-names 1.0.0 fence-alias",
      "acme-alias-shared-a 1.0.0 fence-alias",
      "acme-alias-shared-b 1.0.0 fence-alias",
      "acme-same-id 1.0.0 engine-id",
    ];
    const all = [bundledAlias, sharedA, sharedB, namesOther, named_, sameId, quiet];
    expect(named(all)).toEqual(expected);
    for (const order of permutations([sharedA, sharedB, sameId])) {
      expect(named([...order, bundledAlias, namesOther, named_, quiet])).toEqual(expected);
    }
    for (const order of permutations([bundledAlias, namesOther, named_])) {
      expect(named([...order, sharedA, sharedB, sameId, quiet])).toEqual(expected);
    }
    // An alias that is a bundled engine id refuses the package, and so does a bundled alias.
    const bundledAliasOnly = admittedFor(
      "acme-bundled-alias",
      admittedManifest("acmebundledalias", (engine) => {
        (engine.editor as Record<string, unknown>).fenceAliases = ["tsql"];
      }),
    );
    expect(named([bundledAliasOnly, quiet])).toEqual(["acme-bundled-alias 1.0.0 fence-alias"]);
    expect(named([quiet])).toEqual([]);
  });

  test("an engine id that is a bundled fence alias refuses the admitted claimant, so no fence tag names two engines", () => {
    const quiet = admittedFor("acme-quiet", admittedManifest("acmequiet"));
    const aliases = Object.keys(BUNDLED_FENCE_ALIASES);
    expect(aliases.length).toBeGreaterThan(0);
    for (const alias of aliases) {
      const claimant = admittedFor("acme-alias-id", admittedManifest(alias));
      expect(named([claimant, quiet])).toEqual(["acme-alias-id 1.0.0 engine-id"]);
      expect(() => composeServerCatalog([claimant], [])).toThrow("the admitted packages still conflict");
    }
  });

  test("an editor fact stated otherwise than Studio's catalog refuses the admitted claimant, and one two packages state differently refuses both", () => {
    const language = (monacoId: string, accent: string) => (engine: EditableEngine) => {
      (engine.editor as Record<string, unknown>).language = {
        queryLanguage: "sql",
        monacoId,
        accent,
        console: false,
      };
    };
    // The sql tab type renders in Monaco's sql in Studio's catalog; sql's accent is blue there.
    const otherTab = admittedFor("acme-tab", admittedManifest("acmetab", language("json", "border-hue-cyan/40")));
    const otherAccent = admittedFor(
      "acme-accent",
      admittedManifest("acmeaccent", language("sql", "border-hue-red/40")),
    );
    const same = admittedFor("acme-same", admittedManifest("acmesame", language("sql", "border-hue-blue/40")));
    expect(named([otherTab, otherAccent, same])).toEqual([
      "acme-accent 1.0.0 editor-language",
      "acme-tab 1.0.0 tab-type",
    ]);
    // A dialect Studio's catalog states is read against its row there: a package stating it with another row is
    // refused, and one stating Studio's row is not, whatever another package states. Every dialect of the closed
    // vocabulary is one Studio's catalog states, so Studio's row is always the reference.
    const redis = (offersCountQuery: boolean) => (engine: EditableEngine) => {
      (engine.editor as Record<string, unknown>).dialect = {
        name: "redis",
        offersColumnProfiling: false,
        offersCodeGeneration: true,
        offersCountQuery,
        offersSqlExport: true,
        historyMask: null,
      };
      (engine.editor as Record<string, unknown>).language = {
        queryLanguage: "sql",
        monacoId: "redis",
        accent: "border-hue-fuchsia/40",
        console: false,
      };
    };
    const studioRow = admittedFor("acme-dialect-a", admittedManifest("acmedialecta", redis(false)));
    const otherRow = admittedFor("acme-dialect-b", admittedManifest("acmedialectb", redis(true)));
    const otherRowToo = admittedFor("acme-dialect-c", admittedManifest("acmedialectc", redis(true)));
    expect(named([studioRow, otherRow, otherRowToo])).toEqual([
      "acme-dialect-b 1.0.0 query-dialect",
      "acme-dialect-c 1.0.0 query-dialect",
    ]);
    expect(named([studioRow])).toEqual([]);
  });

  test("a set rule refusal carries the package's name, version and rule and no value of its declaration", () => {
    const marker = "acmemarkerfence";
    const pkg = admittedFor(
      "acme-marked",
      admittedManifest("acmemarked", (engine) => {
        (engine.editor as Record<string, unknown>).fenceAliases = [marker];
        (engine.editor as Record<string, unknown>).language = {
          queryLanguage: "sql",
          monacoId: "sql",
          accent: "border-hue-red/40",
          console: false,
        };
      }),
    );
    const other = admittedFor(
      "acme-marked-other",
      admittedManifest("acmemarkedother", (engine) => {
        (engine.editor as Record<string, unknown>).fenceAliases = [marker];
      }),
    );
    const conflicts = catalogConflicts([pkg, other]);
    expect(conflicts.length).toBeGreaterThan(0);
    for (const conflict of conflicts) {
      expect(Object.keys(conflict).sort()).toEqual(["name", "rule", "version"]);
      const refusal = catalogConflictRefusal(conflict, conflict.rule);
      expect([refusal.code, refusal.rule, refusal.name, refusal.version]).toEqual([
        "PROVIDER_CATALOG_CONFLICT",
        conflict.rule,
        conflict.name,
        "1.0.0",
      ]);
      expect(refusal.sentence.startsWith(`PROVIDER_CATALOG_CONFLICT: ${conflict.name} 1.0.0: it `)).toBe(true);
      const text = `${JSON.stringify(conflict)} ${refusal.sentence}`;
      for (const value of [marker, 'acmemarked"', "border-hue-red", 'acmemarkedother"']) {
        expect(text).not.toContain(value);
      }
    }
  });
});
