/**
 * A package's entry default-exports the record `defineProvider` returns, and `checkProviderModule` refuses any other
 * value by a named rule (docs/providers/CONTRACT.md, clauses C-1, C-3 and C-4).
 *
 * Each case starts from a manifest and an implementation that match, changes one thing, and asserts the exact refusal
 * list. Every pointer is a JSON Pointer into the module record, `{ contract, manifest, impl }`, so a refusal of the
 * manifest's `contract` and one of the record's own are told apart.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  checkProviderModule,
  DEFINITION_REFUSAL_RULES,
  type DefinitionRefusal,
  type DefinitionRefusalRule,
  defineProvider,
  definitionRefusalSentence,
  ProviderDefinitionError,
  type ProviderImpl,
} from "@libredb/provider-sdk/calls";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a draft manifest each case bends into a shape the check refuses.
type Json = Record<string, any>;

/** The manifest schema, whose list bounds the check mirrors. */
const SCHEMA: Json = JSON.parse(
  readFileSync(path.join(import.meta.dir, "../../src/manifest/manifest.schema.json"), "utf8"),
);

/** A manifest offering cancel and not endScope, honouring params, with no engine facet offered. */
function manifest(change: (draft: Json) => void = () => {}): Json {
  const draft = JSON.parse(readFileSync(path.join(import.meta.dir, "../fixtures/minimal-manifest.json"), "utf8"));
  draft.calls.console.cancel = "offered";
  draft.calls.console.execute.honours = ["params"];
  draft.engines[0].facets.monitoring.overview = "not-offered";
  change(draft);
  return draft;
}

interface Handle {
  readonly id: string;
}

/** An implementation of open, close, console.execute and console.cancel, changed by `change`. */
function impl(change: (draft: Json) => void = () => {}): ProviderImpl<Handle> {
  const draft: Json = {
    open: async () => ({ handle: { id: "session" } }),
    close: async () => {},
    console: {
      execute: async () => ({ results: [], warnings: [], executionTimeMs: 0, pageApplied: false }),
      cancel: async () => ({ cancelled: false }),
    },
  };
  change(draft);
  return draft as ProviderImpl<Handle>;
}

function record(change: (draft: Json) => void = () => {}): Json {
  const draft: Json = { contract: "0.1", manifest: manifest(), impl: impl() };
  change(draft);
  return draft;
}

function refusal(
  rule: DefinitionRefusalRule,
  pointer: string,
  extra: { key?: string; name?: string; contract?: string } = {},
): DefinitionRefusal {
  return { rule, pointer, ...extra };
}

describe("defineProvider", () => {
  test("a provider whose implementation matches its declared calls is defined, and its record is frozen", () => {
    const implementation = impl();
    const defined = defineProvider(manifest(), implementation);

    expect(Object.keys(defined)).toEqual(["contract", "manifest", "impl"]);
    expect(defined.contract).toBe("0.1");
    expect(defined.impl).toBe(implementation);
    expect(Object.isFrozen(defined)).toBe(true);
    expect(Object.isFrozen(defined.impl)).toBe(true);
    expect(Object.isFrozen(defined.impl.console)).toBe(true);
    expect(checkProviderModule(defined)).toEqual([]);
  });

  test("the manifest in the record is a deep-frozen copy, and the package's own object is left as it was", () => {
    const source = manifest();
    const defined = defineProvider(source, impl());
    const copy = defined.manifest as Json;

    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.engines)).toBe(true);
    expect(Object.isFrozen(copy.engines[0].connection.fields)).toBe(true);
    expect(Object.isFrozen(copy.calls.console.execute.honours)).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(source.engines[0])).toBe(false);

    source.engines[0].displayName = "Changed";
    source.calls.console.cancel = "not-offered";

    expect(copy.engines[0].displayName).toBe("ExampleDB");
    expect(copy.calls.console.cancel).toBe("offered");
  });

  test("a manifest holding a value JSON cannot hold is not cloned, and defineProvider throws the clone's error", () => {
    const source = manifest((m) => (m.vendor = { hook: () => undefined }));

    expect(() => defineProvider(source, impl())).toThrow(expect.objectContaining({ name: "DataCloneError" }));
  });

  test("defineProvider throws a ProviderDefinitionError carrying every refusal", () => {
    let thrown: unknown;
    try {
      defineProvider(
        manifest((m) => (m.calls.console.endScope = "offered")),
        impl((i) => delete i.open),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toBeInstanceOf(ProviderDefinitionError);
    const error = thrown as ProviderDefinitionError;
    const expected = [
      refusal("call-missing", "/impl/open", { name: "open" }),
      refusal("facet-unimplemented", "/impl/console/endScope", { name: "console.endScope" }),
    ];
    expect(error.name).toBe("ProviderDefinitionError");
    expect(error.refusals).toEqual(expected);
    expect(Object.isFrozen(error.refusals)).toBe(true);
    expect(error.message).toBe(expected.map(definitionRefusalSentence).join(" "));
  });
});

describe("checkProviderModule", () => {
  test("an offered facet the implementation lacks is refused as facet-unimplemented", () => {
    const lacking = record((r) => delete r.impl.console.cancel);
    const notAFunction = record((r) => (r.impl.console.cancel = "cancel"));

    expect(checkProviderModule(lacking)).toEqual([
      refusal("facet-unimplemented", "/impl/console/cancel", { name: "console.cancel" }),
    ]);
    expect(checkProviderModule(notAFunction)).toEqual([
      refusal("facet-unimplemented", "/impl/console/cancel", { name: "console.cancel" }),
    ]);
  });

  test("an implemented facet the manifest does not offer is refused as facet-undeclared", () => {
    const changed = record((r) => (r.impl.console.endScope = async () => ({ openTransaction: "none" })));
    const undefinedKey = record((r) => (r.impl.console.endScope = undefined));
    const expected = refusal("facet-undeclared", "/impl/console/endScope", { name: "console.endScope" });

    expect(checkProviderModule(changed)).toEqual([expected]);
    expect(checkProviderModule(undefinedKey)).toEqual([expected]);
    expect(definitionRefusalSentence(expected)).toBe(
      'The implementation has the key console.endScope at "/impl/console/endScope", a console facet the manifest declares not-offered.',
    );
  });

  test("the transaction facet is declared and implemented both ways, like every console facet", () => {
    const transaction = async () => ({ sessionState: "not-in-transaction" as const });
    const offered = manifest((m) => (m.calls.console.transaction = "offered"));
    const implemented = impl((i) => (i.console.transaction = transaction));
    const name = "console.transaction";

    expect(defineProvider(offered, implemented).impl.console.transaction).toBe(transaction);
    expect(checkProviderModule(record((r) => (r.manifest = offered)))).toEqual([
      refusal("facet-unimplemented", "/impl/console/transaction", { name }),
    ]);
    expect(checkProviderModule(record((r) => (r.impl = implemented)))).toEqual([
      refusal("facet-undeclared", "/impl/console/transaction", { name }),
    ]);
  });

  test("an honours item that is no request field, or one listed twice, is refused as manifest-unreadable", () => {
    const cases: [unknown[], string[]][] = [
      [[1, "params"], ["/0"]],
      [["params", "params"], ["/1"]],
      [["rows", "offset"], ["/0"]],
      [
        ["rows", 1],
        ["/0", "/1"],
      ],
    ];
    const both = record((r) => (r.manifest.calls.console.execute.honours = ["params", "offset"]));
    const none = record((r) => (r.manifest.calls.console.execute.honours = []));

    for (const [honours, pointers] of cases) {
      expect(checkProviderModule(record((r) => (r.manifest.calls.console.execute.honours = honours)))).toEqual(
        pointers.map((at) => refusal("manifest-unreadable", `/manifest/calls/console/execute/honours${at}`)),
      );
    }
    expect(checkProviderModule(both)).toEqual([]);
    expect(checkProviderModule(none)).toEqual([]);
  });

  test("an honours list longer than the request fields is refused as manifest-unreadable at the list, and no item is read", () => {
    let reads = 0;
    const counted = (items: unknown[]): unknown[] =>
      Object.defineProperty(items, "0", {
        enumerable: true,
        get() {
          reads += 1;
          return "params";
        },
      });

    for (const honours of [
      counted(["params", "offset", "params"]),
      counted([1, 2, 3, 4, 5]),
      ["params", "offset", "rows"],
    ]) {
      expect(checkProviderModule(record((r) => (r.manifest.calls.console.execute.honours = honours)))).toEqual([
        refusal("manifest-unreadable", "/manifest/calls/console/execute/honours"),
      ]);
    }
    expect(reads).toBe(0);
  });

  test("an engine list longer than the schema's maxItems is refused as manifest-unreadable at the list, and no engine is read", () => {
    const longest = SCHEMA.properties.engines.maxItems;
    const engines = (length: number): Json[] =>
      Array.from({ length }, (_, index) => {
        const engine = structuredClone(manifest().engines[0]);
        engine.id = `db${index}`;
        engine.facets.maintenance = ["vacuum"];
        return engine;
      });
    let reads = 0;
    const planted = Object.defineProperty(engines(longest + 1), "0", {
      enumerable: true,
      get() {
        reads += 1;
        return manifest().engines[0];
      },
    });

    expect(longest).toBe(64);
    expect(checkProviderModule(record((r) => (r.manifest.engines = engines(longest))))).toEqual(
      Array.from({ length: longest }, (_, index) =>
        refusal("engine-facet-without-call", `/manifest/engines/${index}/facets/maintenance/0`),
      ),
    );
    expect(checkProviderModule(record((r) => (r.manifest.engines = planted)))).toEqual([
      refusal("manifest-unreadable", "/manifest/engines"),
    ]);
    expect(reads).toBe(0);
  });

  test("a maintenance or agent readings list longer than the schema's maxItems is refused as manifest-unreadable at the list, and no item is read", () => {
    const vocabularies = { maintenance: "maintenanceOperation", agentReadings: "agentReading" } as const;
    let reads = 0;
    for (const [list, vocabulary] of Object.entries(vocabularies)) {
      const longest = SCHEMA.$defs.facets.properties[list].maxItems;
      const items = [...(SCHEMA.$defs[vocabulary].enum as string[])];
      const pointer = `/manifest/engines/0/facets/${list}`;
      const planted = Object.defineProperty([...items, items[0]], "0", {
        enumerable: true,
        get() {
          reads += 1;
          return items[0];
        },
      });

      expect(items).toHaveLength(longest);
      expect(checkProviderModule(record((r) => (r.manifest.engines[0].facets[list] = items)))).toEqual(
        items.map((_, index) => refusal("engine-facet-without-call", `${pointer}/${index}`)),
      );
      expect(checkProviderModule(record((r) => (r.manifest.engines[0].facets[list] = planted)))).toEqual([
        refusal("manifest-unreadable", pointer),
      ]);
    }
    expect(reads).toBe(0);
  });

  test("an accessor the check would read is refused as property-not-data, and its getter is never called", () => {
    let calls = 0;
    // A getter that counts its calls and throws, so a read of it both shows and stops the check.
    const accessor = (target: object, key: string): void => {
      Object.defineProperty(target, key, {
        enumerable: true,
        configurable: true,
        get() {
          calls += 1;
          throw new Error(`the getter of ${key} was called`);
        },
      });
    };
    const cases: [(r: Json) => void, string][] = [
      [(r) => accessor(r.impl, "open"), "/impl/open"],
      [(r) => accessor(r.impl, "console"), "/impl/console"],
      [(r) => accessor(r.impl.console, "cancel"), "/impl/console/cancel"],
      [(r) => accessor(r.impl.console, "execute"), "/impl/console/execute"],
      [(r) => accessor(r.manifest, "calls"), "/manifest/calls"],
      [(r) => accessor(r.manifest.calls.console.execute, "honours"), "/manifest/calls/console/execute/honours"],
      [(r) => accessor(r.manifest.calls.console.execute.honours, "0"), "/manifest/calls/console/execute/honours/0"],
      [(r) => accessor(r.manifest.engines, "0"), "/manifest/engines/0"],
      [
        (r) => accessor(r.manifest.engines[0].facets.monitoring, "storage"),
        "/manifest/engines/0/facets/monitoring/storage",
      ],
    ];

    for (const [change, pointer] of cases) {
      const changed = record(change);
      expect(checkProviderModule(changed)).toEqual([refusal("property-not-data", pointer)]);

      let thrown: unknown;
      try {
        defineProvider(changed.manifest, changed.impl);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProviderDefinitionError);
      expect((thrown as ProviderDefinitionError).refusals).toEqual([refusal("property-not-data", pointer)]);
    }
    const recordKeys: [string, string][] = [
      ["impl", "/impl"],
      ["manifest", "/manifest"],
      ["contract", "/contract"],
    ];
    for (const [key, pointer] of recordKeys) {
      const changed = record((r) => accessor(r, key));
      expect(checkProviderModule(changed)).toEqual([refusal("property-not-data", pointer)]);
    }
    const manifestContract = record((r) => accessor(r.manifest, "contract"));
    expect(checkProviderModule(manifestContract)).toEqual([refusal("property-not-data", "/manifest/contract")]);
    expect(calls).toBe(0);
  });

  test("a mandatory call that is missing or no function is refused as call-missing", () => {
    const changed = record((r) => {
      delete r.impl.open;
      r.impl.console.execute = "select 1";
    });
    const noConsole = record((r) => delete r.impl.console);
    const noImpl = record((r) => (r.impl = null));

    expect(checkProviderModule(changed)).toEqual([
      refusal("call-missing", "/impl/open", { name: "open" }),
      refusal("call-missing", "/impl/console/execute", { name: "console.execute" }),
    ]);
    expect(checkProviderModule(noConsole)).toEqual([
      refusal("call-missing", "/impl/console/execute", { name: "console.execute" }),
      refusal("facet-unimplemented", "/impl/console/cancel", { name: "console.cancel" }),
    ]);
    expect(checkProviderModule(noImpl)).toEqual([
      refusal("call-missing", "/impl/open", { name: "open" }),
      refusal("call-missing", "/impl/close", { name: "close" }),
      refusal("call-missing", "/impl/console/execute", { name: "console.execute" }),
      refusal("facet-unimplemented", "/impl/console/cancel", { name: "console.cancel" }),
    ]);
  });

  test("a call inherited from a prototype is not read, so a class instance is refused as call-missing", () => {
    class Implementation {
      async open() {
        return { handle: {} };
      }
    }
    const changed = record((r) => (r.impl = Object.assign(new Implementation(), { close: r.impl.close })));

    expect(checkProviderModule(changed)).toEqual([
      refusal("call-missing", "/impl/open", { name: "open" }),
      refusal("call-missing", "/impl/console/execute", { name: "console.execute" }),
      refusal("facet-unimplemented", "/impl/console/cancel", { name: "console.cancel" }),
    ]);
  });

  test("an implementation key the contract does not define is refused as impl-key-unknown", () => {
    const changed = record((r) => {
      r.impl.health = async () => ({});
      r.impl.console.explain = async () => ({});
    });

    expect(checkProviderModule(changed)).toEqual([
      refusal("impl-key-unknown", "/impl/health", { key: "health" }),
      refusal("impl-key-unknown", "/impl/console/explain", { key: "explain" }),
    ]);
  });

  test("an engine facet this contract has no call for is refused as engine-facet-without-call", () => {
    const changed = record((r) => {
      r.manifest.engines[0].facets.monitoring.overview = "offered";
      r.manifest.engines[0].facets.monitoring.storage = "offered";
      r.manifest.engines[0].facets.maintenance = ["vacuum", "analyze"];
      r.manifest.engines[0].facets.agentReadings = ["sessions"];
    });

    expect(checkProviderModule(changed)).toEqual([
      refusal("engine-facet-without-call", "/manifest/engines/0/facets/monitoring/overview"),
      refusal("engine-facet-without-call", "/manifest/engines/0/facets/monitoring/storage"),
      refusal("engine-facet-without-call", "/manifest/engines/0/facets/maintenance/0"),
      refusal("engine-facet-without-call", "/manifest/engines/0/facets/maintenance/1"),
      refusal("engine-facet-without-call", "/manifest/engines/0/facets/agentReadings/0"),
    ]);
  });

  test("a manifest or record built against another contract is refused as contract-not-served", () => {
    const manifestContract = record((r) => (r.manifest.contract = "0.2"));
    const recordContract = record((r) => (r.contract = "1.0"));
    const notAContract = record((r) => {
      r.contract = 1;
      r.manifest.contract = "latest";
    });

    expect(checkProviderModule(manifestContract)).toEqual([
      refusal("contract-not-served", "/manifest/contract", { contract: "0.2" }),
    ]);
    expect(checkProviderModule(recordContract)).toEqual([
      refusal("contract-not-served", "/contract", { contract: "1.0" }),
    ]);
    expect(checkProviderModule(notAContract)).toEqual([
      refusal("contract-not-served", "/contract"),
      refusal("contract-not-served", "/manifest/contract"),
    ]);
  });

  test("a manifest key defineProvider reads that is missing or of the wrong type is refused as manifest-unreadable", () => {
    const cases: [(r: Json) => void, string][] = [
      [(r) => (r.manifest = "manifest"), "/manifest"],
      [(r) => delete r.manifest.contract, "/manifest/contract"],
      [(r) => delete r.manifest.calls, "/manifest/calls"],
      [(r) => (r.manifest.calls.console = []), "/manifest/calls/console"],
      [(r) => delete r.manifest.calls.console.execute, "/manifest/calls/console/execute"],
      [(r) => (r.manifest.calls.console.execute.honours = "params"), "/manifest/calls/console/execute/honours"],
      [(r) => (r.manifest.calls.console.cancel = true), "/manifest/calls/console/cancel"],
      [(r) => delete r.manifest.calls.console.endScope, "/manifest/calls/console/endScope"],
      [(r) => (r.manifest.engines = { exampledb: {} }), "/manifest/engines"],
      [(r) => (r.manifest.engines[0] = null), "/manifest/engines/0"],
      [(r) => delete r.manifest.engines[0].facets, "/manifest/engines/0/facets"],
      [(r) => (r.manifest.engines[0].facets.monitoring = null), "/manifest/engines/0/facets/monitoring"],
      [(r) => (r.manifest.engines[0].facets.monitoring.tables = 1), "/manifest/engines/0/facets/monitoring/tables"],
      [(r) => (r.manifest.engines[0].facets.maintenance = "vacuum"), "/manifest/engines/0/facets/maintenance"],
      [(r) => delete r.manifest.engines[0].facets.agentReadings, "/manifest/engines/0/facets/agentReadings"],
    ];

    for (const [change, pointer] of cases) {
      expect(checkProviderModule(record(change))).toEqual([refusal("manifest-unreadable", pointer)]);
    }
  });

  test("a value that is not a provider module record is refused as module-not-a-record", () => {
    class ModuleRecord {
      contract = "0.1";
      manifest = manifest();
      impl = impl();
    }

    for (const value of [null, undefined, "module", [record()], new ModuleRecord()]) {
      expect(checkProviderModule(value)).toEqual([refusal("module-not-a-record", "")]);
    }
    expect(checkProviderModule(record((r) => (r.default = r.impl)))).toEqual([
      refusal("module-not-a-record", "", { key: "default" }),
    ]);
    expect(checkProviderModule(record((r) => delete r.impl))).toEqual([
      refusal("module-not-a-record", "", { key: "impl" }),
    ]);
    expect(checkProviderModule(Object.assign(Object.create(null), record()))).toEqual([]);
  });

  test("no refusal and no message carries a value of the manifest or the implementation", () => {
    const planted = `planted-${randomUUID()}`;
    const plant = (value: unknown): unknown => {
      if (typeof value === "string") return planted;
      if (Array.isArray(value)) return value.map(plant);
      if (typeof value === "object" && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plant(item)]));
      }
      return value;
    };
    // Every string of the manifest planted, so every read of an offer, a contract or a list fails on it, and an extra
    // function whose name and source text are it.
    const extra = Object.defineProperties(async () => planted, {
      name: { value: planted },
      toString: { value: () => planted },
    });
    const changed = record((r) => {
      r.manifest = plant(r.manifest);
      r.impl.console.explain = extra;
    });
    const contractKept = record((r) => {
      r.manifest = { ...(plant(r.manifest) as Json), contract: "0.1" };
      r.impl.console.explain = extra;
    });

    const refusals = [...checkProviderModule(changed), ...checkProviderModule(contractKept)];
    let thrown: unknown;
    try {
      defineProvider(contractKept.manifest, contractKept.impl);
    } catch (error) {
      thrown = error;
    }

    expect(refusals.length).toBeGreaterThan(5);
    expect(JSON.stringify(refusals)).not.toContain(planted);
    for (const item of refusals) expect(definitionRefusalSentence(item)).not.toContain(planted);
    expect(thrown).toBeInstanceOf(ProviderDefinitionError);
    expect((thrown as ProviderDefinitionError).message).not.toContain(planted);
  });
});

describe("definitionRefusalSentence", () => {
  test("every definition rule is worded in one sentence", () => {
    for (const rule of DEFINITION_REFUSAL_RULES) {
      const forms = [
        refusal(rule, "/impl/console/cancel"),
        refusal(rule, "/impl/console/cancel", { key: 'a"\nb', name: "console.cancel", contract: "0.2" }),
      ];
      for (const item of forms) {
        const sentence = definitionRefusalSentence(item);

        expect(sentence).toMatch(/^[A-Z][^\n]*\.$/);
        expect(sentence).not.toMatch(/\. [A-Z]/);
        expect(sentence).toContain('"/impl/console/cancel"');
      }
    }
  });

  test("quotes the pointer as a JSON string, so a key with a line break stays on one line", () => {
    const [unknownKey] = checkProviderModule(record((r) => (r.impl["a\nb"] = async () => ({}))));

    expect(unknownKey).toEqual(refusal("impl-key-unknown", "/impl/a\nb", { key: "a\nb" }));
    const sentence = definitionRefusalSentence(unknownKey);
    expect(sentence).not.toContain("\n");
    expect(sentence).toBe(
      'The implementation has the key "a\\nb" at "/impl/a\\nb", for which the provider contract defines no call.',
    );
  });

  test("names the top level for an empty pointer, and quotes a key as a JSON string", () => {
    expect(definitionRefusalSentence(refusal("module-not-a-record", ""))).toBe(
      "The value at the top level is not a provider module record, a plain object with exactly the keys contract, manifest and impl.",
    );
    expect(definitionRefusalSentence(refusal("module-not-a-record", "", { key: "a\nb" }))).toBe(
      'The key "a\\nb" is missing from the provider module record at the top level, or is not one of its keys contract, manifest and impl.',
    );
  });

  test("names the contract a record or manifest was built against, where it has the form of one", () => {
    expect(definitionRefusalSentence(refusal("contract-not-served", "/manifest/contract", { contract: "0.2" }))).toBe(
      'The value at "/manifest/contract" names provider contract 0.2, which this SDK does not serve.',
    );
    expect(definitionRefusalSentence(refusal("contract-not-served", "/contract"))).toBe(
      'The value at "/contract" is not the provider contract this SDK serves.',
    );
  });
});
