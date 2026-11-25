/**
 * The server's engine catalog (src/lib/db/server-catalog.ts) and its composition (src/lib/db/server-catalog-compose.ts):
 * Studio's bundled catalog plus the engines of the admitted provider packages, composed once at boot, read through one
 * accessor keyed by Maps, with the set rules over the whole set refusing every admitted claimant whatever the order.
 *
 * Every package here is built in memory (tests/helpers/package-catalog.ts): no file is written and nothing is imported,
 * so each case installs a catalog of its own and forgets it after.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
  assertBundledEngine,
  forgetServerCatalog,
  installServerCatalog,
  serverCatalogInstalled,
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
import { admittedFor, admittedManifest, type EditableEngine, withFieldRules } from "../../../helpers/package-catalog";

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

describe("the accessor", () => {
  test("an admitted engine is a known type to the server and its connection fields come from its declaration", () => {
    const manifest = admittedManifest("acmeserved", withFieldRules);
    const pkg = admittedFor("acme-served", manifest);
    installServerCatalog(composeServerCatalog([pkg], []));

    const answer = serverEngine("acmeserved");
    if (answer.kind !== "package") throw new Error(`answered ${answer.kind}`);
    const { engine } = answer;
    expect<string>(engine.id).toBe("acmeserved");
    expect(engine.package).toMatchObject({ name: "acme-served", version: "1.0.0", directory: pkg.directory });
    expect(engine.package.manifest).toBe(manifest);
    expect(engine.package.record).toBe(pkg.record);
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
    // The engine is no bundled type: the server-side check refuses it on a route that does not serve it, by name.
    const route = thrown(() => assertBundledEngine("acmeserved", "route"));
    expect(route).toBeInstanceOf(PackageEngineUnsupportedError);
    expect((route as Error).message).toBe(
      "This request is served for an engine of a provider package only by Test Connection in this LibreDB Studio, and this is another request.",
    );
    const open = thrown(() => assertBundledEngine("acmeserved", "open"));
    expect((open as Error).message).toBe(
      "This LibreDB Studio opens no session on an engine of a provider package yet.",
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
        const actual = thrown(() => assertBundledEngine(value, need)) as UnknownProviderError;
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
      expect<unknown>(serverEngine(id)).toEqual({ kind: "bundled", id });
      expect(() => assertBundledEngine(id, "open")).not.toThrow();
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
    expect<unknown>(serverEngine(bundled)).toEqual({ kind: "bundled", id: bundled });
    expect<unknown>(serverEngine("acmeunnamed")).toEqual({ kind: "refused", refusal: typeIdRefusal("acmeunnamed") });

    const error = thrown(() => assertBundledEngine("acmegone", "route")) as ProviderUnavailableError;
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
      expect(thrown(() => assertBundledEngine(key, "route"))).toBeInstanceOf(UnknownProviderError);
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
    expect<unknown>(serverEngine("acmeonce").kind).toBe("package");
    forgetServerCatalog();
    expect(serverCatalogInstalled()).toBe(false);
    expect<unknown>(serverEngine("acmeonce").kind).toBe("refused");
  });
});

describe("what the catalog composes", () => {
  test("the composed catalog holds no engine knowledge the declaration did not state: no SQL writing, connection form, connection string, grammar, migration DDL or generator row", () => {
    installServerCatalog(composeServerCatalog([admittedFor("acme-keys", admittedManifest("acmekeys"))], []));
    const answer = serverEngine("acmekeys");
    if (answer.kind !== "package") throw new Error(`answered ${answer.kind}`);
    const { engine } = answer;
    expect(Object.keys(engine).sort()).toEqual(["catalog", "connection", "fieldRules", "grants", "id", "package"]);
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
    expect(Object.keys(engine.package).sort()).toEqual(["directory", "manifest", "name", "record", "version"]);
    for (const value of [engine, engine.package, engine.catalog, engine.connection, engine.fieldRules, engine.grants]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
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
    const answer = serverEngine("acmecheck");
    if (answer.kind !== "package") throw new Error(`answered ${answer.kind}`);
    const rules = answer.engine.fieldRules;
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
