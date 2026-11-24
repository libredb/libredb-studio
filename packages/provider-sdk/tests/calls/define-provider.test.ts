/**
 * A package's entry default-exports the record `defineProvider` returns, and `checkProviderModule` refuses any other
 * value by a named rule (docs/providers/CONTRACT.md, clauses C-1, C-3, C-4, C-67 and C-71).
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

/** A manifest offering cancel and not endScope, honouring params, with no monitoring facet and no engine facet offered. */
function manifest(change: (draft: Json) => void = () => {}): Json {
  const draft = JSON.parse(readFileSync(path.join(import.meta.dir, "../fixtures/minimal-manifest.json"), "utf8"));
  draft.calls.console.cancel = "offered";
  draft.calls.console.execute.honours = ["params"];
  draft.calls.monitoring.panel = "not-offered";
  draft.engines[0].facets.monitoring.overview = "not-offered";
  change(draft);
  return draft;
}

interface Handle {
  readonly id: string;
}

/** An implementation of open, close, health, console.execute and console.cancel, changed by `change`. */
function impl(change: (draft: Json) => void = () => {}): ProviderImpl<Handle> {
  const draft: Json = {
    open: async () => ({ handle: { id: "session" } }),
    close: async () => {},
    health: async () => ({ databaseSize: "0 B", cacheHitRatio: "100%", slowQueries: [], activeSessions: [] }),
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
      'The implementation has the key console.endScope at "/impl/console/endScope", a facet the manifest declares not-offered.',
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

  test("the objects tree facet is declared and implemented both ways, like every console facet", () => {
    const tree = async () => ({ containers: [] });
    const offered = manifest((m) => (m.calls.objects.tree = "offered"));
    const implemented = impl((i) => (i.objects = { tree }));
    const name = "objects.tree";
    const defined = defineProvider(offered, implemented);

    expect(defined.impl.objects?.tree).toBe(tree);
    expect(Object.isFrozen(defined.impl.objects)).toBe(true);
    expect(checkProviderModule(record((r) => (r.manifest = offered)))).toEqual([
      refusal("facet-unimplemented", "/impl/objects/tree", { name }),
    ]);
    expect(
      checkProviderModule(
        record((r) => {
          r.manifest = offered;
          r.impl.objects = { tree: "tree" };
        }),
      ),
    ).toEqual([refusal("facet-unimplemented", "/impl/objects/tree", { name })]);
    expect(
      checkProviderModule(
        record((r) => {
          r.manifest = offered;
          r.impl.objects = {};
        }),
      ),
    ).toEqual([refusal("facet-unimplemented", "/impl/objects/tree", { name })]);
    expect(checkProviderModule(record((r) => (r.impl = implemented)))).toEqual([
      refusal("facet-undeclared", "/impl/objects/tree", { name }),
    ]);
    expect(checkProviderModule(record((r) => (r.impl.objects = { tree: undefined })))).toEqual([
      refusal("facet-undeclared", "/impl/objects/tree", { name }),
    ]);
    expect(checkProviderModule(record((r) => (r.impl.objects = {})))).toEqual([]);
    expect(
      Object.isFrozen(
        defineProvider(
          manifest(),
          impl((i) => (i.objects = {})),
        ).impl.objects,
      ),
    ).toBe(true);
    expect(definitionRefusalSentence(refusal("facet-unimplemented", "/impl/objects/tree", { name }))).toBe(
      'The manifest offers the facet objects.tree, for which the implementation has no function of its own at "/impl/objects/tree".',
    );
  });

  test("the maintenance facets are declared and implemented both ways, like every console facet", () => {
    const run = async () => ({ success: true, executionTime: 0, message: "done" });
    const preview = async () => ({ summary: "nothing", facts: [] });
    const offered = manifest((m) => (m.calls.maintenance = { run: "offered", preview: "offered" }));
    const implemented = impl((i) => (i.maintenance = { run, preview }));
    const defined = defineProvider(offered, implemented);

    expect(defined.impl.maintenance?.run).toBe(run);
    expect(defined.impl.maintenance?.preview).toBe(preview);
    expect(Object.isFrozen(defined.impl.maintenance)).toBe(true);
    for (const facet of ["run", "preview"]) {
      const name = `maintenance.${facet}`;
      const pointer = `/impl/maintenance/${facet}`;
      const offersOne = manifest((m) => (m.calls.maintenance[facet] = "offered"));
      const implementsOne = impl((i) => (i.maintenance = { [facet]: facet === "run" ? run : preview }));

      expect(checkProviderModule(record((r) => (r.manifest = offersOne)))).toEqual([
        refusal("facet-unimplemented", pointer, { name }),
      ]);
      expect(
        checkProviderModule(
          record((r) => {
            r.manifest = offersOne;
            r.impl.maintenance = { [facet]: facet };
          }),
        ),
      ).toEqual([refusal("facet-unimplemented", pointer, { name })]);
      expect(checkProviderModule(record((r) => (r.impl = implementsOne)))).toEqual([
        refusal("facet-undeclared", pointer, { name }),
      ]);
      expect(checkProviderModule(record((r) => (r.impl.maintenance = { [facet]: undefined })))).toEqual([
        refusal("facet-undeclared", pointer, { name }),
      ]);
      expect(
        checkProviderModule(
          record((r) => {
            r.manifest = offersOne;
            r.impl = implementsOne;
          }),
        ),
      ).toEqual([]);
    }
    expect(checkProviderModule(record((r) => (r.manifest = offered)))).toEqual([
      refusal("facet-unimplemented", "/impl/maintenance/run", { name: "maintenance.run" }),
      refusal("facet-unimplemented", "/impl/maintenance/preview", { name: "maintenance.preview" }),
    ]);
    expect(checkProviderModule(record((r) => (r.impl.maintenance = {})))).toEqual([]);
    expect(
      Object.isFrozen(
        defineProvider(
          manifest(),
          impl((i) => (i.maintenance = {})),
        ).impl.maintenance,
      ),
    ).toBe(true);
  });

  test("an engine's maintenance is admitted where the package offers maintenance.run, and refused by name as engine-facet-call-not-offered where it does not", () => {
    const listing = (offer: string, implemented: boolean): Json =>
      record((r) => {
        r.manifest.calls.maintenance.run = offer;
        r.manifest.engines[0].facets.maintenance = ["vacuum", "analyze"];
        if (implemented) r.impl.maintenance = { run: async () => ({ success: true, executionTime: 0, message: "" }) };
      });
    const pointer = "/manifest/engines/0/facets/maintenance";
    const name = "maintenance.run";

    expect(checkProviderModule(listing("offered", true))).toEqual([]);
    expect(checkProviderModule(listing("not-offered", false))).toEqual([
      refusal("engine-facet-call-not-offered", `${pointer}/0`, { name }),
      refusal("engine-facet-call-not-offered", `${pointer}/1`, { name }),
    ]);
    // An offer that cannot be read is refused at the offer alone: the engine's list is not refused again for it.
    expect(checkProviderModule(listing("maybe", false))).toEqual([
      refusal("manifest-unreadable", "/manifest/calls/maintenance/run"),
    ]);
    // An offered run that no engine's list uses is admitted.
    expect(
      checkProviderModule(
        record((r) => {
          r.manifest.calls.maintenance.run = "offered";
          r.impl.maintenance = { run: async () => ({ success: true, executionTime: 0, message: "" }) };
        }),
      ),
    ).toEqual([]);
    expect(
      definitionRefusalSentence(refusal("engine-facet-call-not-offered", `${pointer}/0`, { name: "maintenance.run" })),
    ).toBe(
      'The engine facet at "/manifest/engines/0/facets/maintenance/0" is offered, and the manifest does not offer the call maintenance.run that serves it.',
    );
  });

  test("a maintenance spec that previews is admitted where the package offers maintenance.preview, and refused by name where it does not", () => {
    const spec = (operation: string, preview: unknown): Json => ({
      operation,
      label: operation,
      perEntity: true,
      global: false,
      title: null,
      description: null,
      confirmation: null,
      preview,
      kinds: null,
    });
    const run = async () => ({ success: true, executionTime: 0, message: "" });
    const preview = async () => ({ summary: "", facts: [] });
    const specs = (offer: string, previews: readonly unknown[]): Json =>
      record((r) => {
        r.manifest.calls.maintenance = { run: "offered", preview: offer };
        r.impl.maintenance = offer === "offered" ? { run, preview } : { run };
        r.manifest.engines[0].facets.maintenance = ["load", "release"].slice(0, previews.length);
        r.manifest.engines[0].facets.maintenanceSpecs = previews.map((item, index) =>
          spec(["load", "release"][index] as string, item),
        );
      });
    const pointer = "/manifest/engines/0/facets/maintenanceSpecs";
    const name = "maintenance.preview";

    expect(checkProviderModule(specs("offered", [true, false]))).toEqual([]);
    expect(checkProviderModule(specs("not-offered", [false, true]))).toEqual([
      refusal("engine-facet-call-not-offered", `${pointer}/1/preview`, { name }),
    ]);
    expect(checkProviderModule(specs("not-offered", [true, true]))).toEqual([
      refusal("engine-facet-call-not-offered", `${pointer}/0/preview`, { name }),
      refusal("engine-facet-call-not-offered", `${pointer}/1/preview`, { name }),
    ]);
    expect(checkProviderModule(specs("not-offered", [false, false]))).toEqual([]);
    expect(checkProviderModule(specs("not-offered", ["yes", 1]))).toEqual([
      refusal("manifest-unreadable", `${pointer}/0/preview`),
      refusal("manifest-unreadable", `${pointer}/1/preview`),
    ]);
    expect(
      checkProviderModule(
        record((r) => {
          r.manifest.engines[0].facets.maintenanceSpecs = [null, "spec", [spec("load", true)]];
        }),
      ),
    ).toEqual([
      refusal("manifest-unreadable", `${pointer}/0`),
      refusal("manifest-unreadable", `${pointer}/1`),
      refusal("manifest-unreadable", `${pointer}/2`),
    ]);
    expect(
      checkProviderModule(
        record((r) => {
          const missing = spec("load", true);
          delete missing.preview;
          r.manifest.engines[0].facets.maintenanceSpecs = [missing];
        }),
      ),
    ).toEqual([refusal("manifest-unreadable", `${pointer}/0/preview`)]);
  });

  test("the monitoring facets are declared and implemented both ways, like every console facet", () => {
    const panel = async () => ({ storage: [] });
    const poolStats = async () => ({ total: 0, idle: 0, active: 0, waiting: 0 });
    const functions: Json = { panel, poolStats };
    const offered = manifest((m) => (m.calls.monitoring = { panel: "offered", poolStats: "offered" }));
    const implemented = impl((i) => (i.monitoring = { panel, poolStats }));
    const defined = defineProvider(offered, implemented);

    expect(defined.impl.monitoring?.panel).toBe(panel);
    expect(defined.impl.monitoring?.poolStats).toBe(poolStats);
    expect(Object.isFrozen(defined.impl.monitoring)).toBe(true);
    for (const facet of ["panel", "poolStats"]) {
      const name = `monitoring.${facet}`;
      const pointer = `/impl/monitoring/${facet}`;
      const offersOne = manifest((m) => (m.calls.monitoring[facet] = "offered"));
      const implementsOne = impl((i) => (i.monitoring = { [facet]: functions[facet] }));

      expect(checkProviderModule(record((r) => (r.manifest = offersOne)))).toEqual([
        refusal("facet-unimplemented", pointer, { name }),
      ]);
      expect(
        checkProviderModule(
          record((r) => {
            r.manifest = offersOne;
            r.impl.monitoring = { [facet]: facet };
          }),
        ),
      ).toEqual([refusal("facet-unimplemented", pointer, { name })]);
      expect(checkProviderModule(record((r) => (r.impl = implementsOne)))).toEqual([
        refusal("facet-undeclared", pointer, { name }),
      ]);
      expect(checkProviderModule(record((r) => (r.impl.monitoring = { [facet]: undefined })))).toEqual([
        refusal("facet-undeclared", pointer, { name }),
      ]);
      expect(
        checkProviderModule(
          record((r) => {
            r.manifest = offersOne;
            r.impl = implementsOne;
          }),
        ),
      ).toEqual([]);
    }
    expect(checkProviderModule(record((r) => (r.manifest = offered)))).toEqual([
      refusal("facet-unimplemented", "/impl/monitoring/panel", { name: "monitoring.panel" }),
      refusal("facet-unimplemented", "/impl/monitoring/poolStats", { name: "monitoring.poolStats" }),
    ]);
    expect(checkProviderModule(record((r) => (r.impl.monitoring = {})))).toEqual([]);
    expect(
      Object.isFrozen(
        defineProvider(
          manifest(),
          impl((i) => (i.monitoring = {})),
        ).impl.monitoring,
      ),
    ).toBe(true);
  });

  test("an engine's offered monitoring panel is admitted where the package offers monitoring.panel, and refused by name as engine-facet-call-not-offered where it does not", () => {
    const panel = async () => ({
      overview: { version: "", uptime: "", maxConnections: 0, databaseSize: "", tableCount: 0, indexCount: 0 },
    });
    const offering = (offer: unknown, implemented: boolean, change: (m: Json) => void = () => {}): Json =>
      record((r) => {
        r.manifest.calls.monitoring.panel = offer;
        r.manifest.engines[0].facets.monitoring.overview = "offered";
        r.manifest.engines[0].facets.monitoring.tables = "offered";
        if (implemented) r.impl.monitoring = { panel };
        change(r.manifest);
      });
    const pointer = "/manifest/engines/0/facets/monitoring";
    const name = "monitoring.panel";

    expect(checkProviderModule(offering("offered", true))).toEqual([]);
    expect(checkProviderModule(offering("not-offered", false))).toEqual([
      refusal("engine-facet-call-not-offered", `${pointer}/overview`, { name }),
      refusal("engine-facet-call-not-offered", `${pointer}/tables`, { name }),
    ]);
    // A panel the engine declares not-offered refuses nothing, whether or not the package offers monitoring.panel.
    const noPanel = (m: Json) => {
      m.engines[0].facets.monitoring.overview = "not-offered";
      m.engines[0].facets.monitoring.tables = "not-offered";
    };
    expect(checkProviderModule(offering("offered", true, noPanel))).toEqual([]);
    expect(checkProviderModule(offering("not-offered", false, noPanel))).toEqual([]);
    // Two engines: only the panels of the one that offers panels are refused.
    const twoEngines = offering("not-offered", false, (m) => {
      const second = structuredClone(m.engines[0]);
      second.id = "otherdb";
      for (const key of Object.keys(second.facets.monitoring)) second.facets.monitoring[key] = "not-offered";
      m.engines.push(second);
    });
    expect(checkProviderModule(twoEngines)).toEqual([
      refusal("engine-facet-call-not-offered", `${pointer}/overview`, { name }),
      refusal("engine-facet-call-not-offered", `${pointer}/tables`, { name }),
    ]);
    // An offer that cannot be read is refused at the offer alone: the engine's panels are not refused again for it.
    expect(checkProviderModule(offering("maybe", false))).toEqual([
      refusal("manifest-unreadable", "/manifest/calls/monitoring/panel"),
    ]);
    // A panel value that is no facet offer stays manifest-unreadable at its pointer, either way.
    for (const [offer, implemented] of [
      ["offered", true],
      ["not-offered", false],
    ] as const) {
      expect(
        checkProviderModule(offering(offer, implemented, (m) => (m.engines[0].facets.monitoring.tables = true))),
      ).toEqual(
        offer === "offered"
          ? [refusal("manifest-unreadable", `${pointer}/tables`)]
          : [
              refusal("engine-facet-call-not-offered", `${pointer}/overview`, { name }),
              refusal("manifest-unreadable", `${pointer}/tables`),
            ],
      );
    }
    // A panel reading of the agent is refused beside the panels where monitoring.panel is not offered, and admitted
    // where it is.
    expect(
      checkProviderModule(offering("not-offered", false, (m) => (m.engines[0].facets.agentReadings = ["sessions"]))),
    ).toEqual([
      refusal("engine-facet-call-not-offered", `${pointer}/overview`, { name }),
      refusal("engine-facet-call-not-offered", `${pointer}/tables`, { name }),
      refusal("engine-facet-call-not-offered", "/manifest/engines/0/facets/agentReadings/0", { name }),
    ]);
    expect(
      checkProviderModule(offering("offered", true, (m) => (m.engines[0].facets.agentReadings = ["sessions"]))),
    ).toEqual([]);
    // An offered monitoring.panel that no engine's panel uses, and an offered monitoring.poolStats, are admitted.
    expect(
      checkProviderModule(
        record((r) => {
          r.manifest.calls.monitoring = { panel: "offered", poolStats: "offered" };
          r.impl.monitoring = { panel, poolStats: async () => ({ total: 0, idle: 0, active: 0, waiting: 0 }) };
        }),
      ),
    ).toEqual([]);
    expect(definitionRefusalSentence(refusal("engine-facet-call-not-offered", `${pointer}/overview`, { name }))).toBe(
      'The engine facet at "/manifest/engines/0/facets/monitoring/overview" is offered, and the manifest does not offer the call monitoring.panel that serves it.',
    );
  });

  test("a maintenance specs list longer than the schema's maxItems is refused as manifest-unreadable at the list, and no item is read", () => {
    const longest = SCHEMA.$defs.facets.properties.maintenanceSpecs.maxItems;
    const pointer = "/manifest/engines/0/facets/maintenanceSpecs";
    const operations = SCHEMA.$defs.maintenanceOperation.enum as string[];
    const specs = operations.map((operation) => ({
      operation,
      label: operation,
      perEntity: true,
      global: true,
      title: null,
      description: null,
      confirmation: null,
      preview: false,
      kinds: null,
    }));
    let reads = 0;
    const planted = Object.defineProperty([...specs, specs[0]], "0", {
      enumerable: true,
      get() {
        reads += 1;
        return specs[0];
      },
    });

    expect(longest).toBe(11);
    expect(specs).toHaveLength(longest);
    expect(checkProviderModule(record((r) => (r.manifest.engines[0].facets.maintenanceSpecs = specs)))).toEqual([]);
    for (const value of [planted, "specs", null]) {
      expect(checkProviderModule(record((r) => (r.manifest.engines[0].facets.maintenanceSpecs = value)))).toEqual([
        refusal("manifest-unreadable", pointer),
      ]);
    }
    expect(reads).toBe(0);
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
        refusal("engine-facet-call-not-offered", `/manifest/engines/${index}/facets/maintenance/0`, {
          name: "maintenance.run",
        }),
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
      // The base manifest offers neither maintenance.run nor monitoring.panel, so every operation and every panel
      // reading is refused by name, and health, which the mandatory health call serves, is not.
      const named = list === "maintenance" ? "maintenance.run" : "monitoring.panel";
      expect(checkProviderModule(record((r) => (r.manifest.engines[0].facets[list] = items)))).toEqual(
        items
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => item !== "health")
          .map(({ index }) => refusal("engine-facet-call-not-offered", `${pointer}/${index}`, { name: named })),
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
      [(r) => accessor(r.impl, "health"), "/impl/health"],
      [(r) => accessor(r.impl, "console"), "/impl/console"],
      [(r) => accessor(r.impl.console, "cancel"), "/impl/console/cancel"],
      [(r) => accessor(r.impl.console, "execute"), "/impl/console/execute"],
      [(r) => accessor(r.impl, "objects"), "/impl/objects"],
      [
        (r) => {
          r.impl.objects = {};
          accessor(r.impl.objects, "tree");
        },
        "/impl/objects/tree",
      ],
      [(r) => accessor(r.impl, "maintenance"), "/impl/maintenance"],
      [
        (r) => {
          r.impl.maintenance = {};
          accessor(r.impl.maintenance, "run");
        },
        "/impl/maintenance/run",
      ],
      [(r) => accessor(r.impl, "monitoring"), "/impl/monitoring"],
      [
        (r) => {
          r.impl.monitoring = {};
          accessor(r.impl.monitoring, "panel");
        },
        "/impl/monitoring/panel",
      ],
      [(r) => accessor(r.manifest.calls, "monitoring"), "/manifest/calls/monitoring"],
      [(r) => accessor(r.manifest.calls.monitoring, "poolStats"), "/manifest/calls/monitoring/poolStats"],
      [(r) => accessor(r.manifest.calls, "maintenance"), "/manifest/calls/maintenance"],
      [(r) => accessor(r.manifest.calls.maintenance, "preview"), "/manifest/calls/maintenance/preview"],
      [
        (r) => accessor(r.manifest.engines[0].facets, "maintenanceSpecs"),
        "/manifest/engines/0/facets/maintenanceSpecs",
      ],
      [
        (r) => {
          r.manifest.engines[0].facets.maintenanceSpecs = [{}];
          accessor(r.manifest.engines[0].facets.maintenanceSpecs, "0");
        },
        "/manifest/engines/0/facets/maintenanceSpecs/0",
      ],
      [
        (r) => {
          r.manifest.engines[0].facets.maintenanceSpecs = [{}];
          accessor(r.manifest.engines[0].facets.maintenanceSpecs[0], "preview");
        },
        "/manifest/engines/0/facets/maintenanceSpecs/0/preview",
      ],
      [(r) => accessor(r.manifest.calls, "objects"), "/manifest/calls/objects"],
      [(r) => accessor(r.manifest.calls.objects, "tree"), "/manifest/calls/objects/tree"],
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
    const noHealth = record((r) => delete r.impl.health);
    const healthNotAFunction = record((r) => (r.impl.health = { databaseSize: "0 B" }));

    expect(checkProviderModule(changed)).toEqual([
      refusal("call-missing", "/impl/open", { name: "open" }),
      refusal("call-missing", "/impl/console/execute", { name: "console.execute" }),
    ]);
    expect(checkProviderModule(noConsole)).toEqual([
      refusal("call-missing", "/impl/console/execute", { name: "console.execute" }),
      refusal("facet-unimplemented", "/impl/console/cancel", { name: "console.cancel" }),
    ]);
    expect(checkProviderModule(noHealth)).toEqual([refusal("call-missing", "/impl/health", { name: "health" })]);
    expect(checkProviderModule(healthNotAFunction)).toEqual([
      refusal("call-missing", "/impl/health", { name: "health" }),
    ]);
    expect(checkProviderModule(noImpl)).toEqual([
      refusal("call-missing", "/impl/open", { name: "open" }),
      refusal("call-missing", "/impl/close", { name: "close" }),
      refusal("call-missing", "/impl/health", { name: "health" }),
      refusal("call-missing", "/impl/console/execute", { name: "console.execute" }),
      refusal("facet-unimplemented", "/impl/console/cancel", { name: "console.cancel" }),
    ]);
  });

  test("a calls segment of the implementation that is not a record is refused as impl-segment-not-a-record, and nothing under it is read", () => {
    const offered = manifest((m) => (m.calls.objects.tree = "offered"));
    // The tree the offering manifest leaves unimplemented, refused in the order the segments are read: after the
    // console, which is read before the objects, and before the maintenance and the monitoring, which are read after them.
    const tree = refusal("facet-unimplemented", "/impl/objects/tree", { name: "objects.tree" });
    const segments: [string, (expected: DefinitionRefusal[]) => DefinitionRefusal[]][] = [
      ["console", (expected) => [...expected, tree]],
      ["objects", (expected) => expected],
      ["maintenance", (expected) => [tree, ...expected]],
      ["monitoring", (expected) => [tree, ...expected]],
    ];
    for (const [segment, withTree] of segments) {
      for (const shape of [null, "calls", [async () => ({})]]) {
        const pointer = `/impl/${segment}`;
        const expected = [refusal("impl-segment-not-a-record", pointer, { key: segment })];

        expect(checkProviderModule(record((r) => (r.impl[segment] = shape)))).toEqual(expected);
        expect(
          checkProviderModule(
            record((r) => {
              r.manifest = offered;
              r.impl[segment] = shape;
            }),
          ),
        ).toEqual(withTree(expected));
      }
    }
    expect(checkProviderModule(record((r) => (r.impl.objects = undefined)))).toEqual([]);
    expect(checkProviderModule(record((r) => (r.impl.maintenance = undefined)))).toEqual([]);
    expect(checkProviderModule(record((r) => (r.impl.monitoring = undefined)))).toEqual([]);
    expect(definitionRefusalSentence(refusal("impl-segment-not-a-record", "/impl/objects", { key: "objects" }))).toBe(
      'The implementation segment "objects" at "/impl/objects" is not a record of its calls, an object that is not an array, so nothing under it was read.',
    );
  });

  test("a call inherited from a prototype is not read, so a class instance is refused as call-missing", () => {
    class Implementation {
      async open() {
        return { handle: {} };
      }

      async health() {
        return { databaseSize: "0 B", cacheHitRatio: "100%", slowQueries: [], activeSessions: [] };
      }
    }
    const changed = record((r) => (r.impl = Object.assign(new Implementation(), { close: r.impl.close })));

    expect(checkProviderModule(changed)).toEqual([
      refusal("call-missing", "/impl/open", { name: "open" }),
      refusal("call-missing", "/impl/health", { name: "health" }),
      refusal("call-missing", "/impl/console/execute", { name: "console.execute" }),
      refusal("facet-unimplemented", "/impl/console/cancel", { name: "console.cancel" }),
    ]);
  });

  test("an implementation key the contract does not define is refused as impl-key-unknown", () => {
    const changed = record((r) => {
      r.impl.ping = async () => ({});
      r.impl.console.explain = async () => ({});
      r.impl.objects = { source: async () => ({}) };
      r.impl.maintenance = { explain: async () => ({}) };
      r.impl.monitoring = { sessions: async () => ({}) };
    });

    expect(checkProviderModule(changed)).toEqual([
      refusal("impl-key-unknown", "/impl/ping", { key: "ping" }),
      refusal("impl-key-unknown", "/impl/console/explain", { key: "explain" }),
      refusal("impl-key-unknown", "/impl/objects/source", { key: "source" }),
      refusal("impl-key-unknown", "/impl/maintenance/explain", { key: "explain" }),
      refusal("impl-key-unknown", "/impl/monitoring/sessions", { key: "sessions" }),
    ]);
  });

  test("an agent reading is admitted where the call that serves it is offered: a panel reading where the package offers monitoring.panel, and health on every package", () => {
    const panel = async () => ({ activeSessions: [] });
    const readings = ["sessions", "table-stats", "health"];
    const offering = record((r) => {
      r.manifest.calls.monitoring.panel = "offered";
      r.manifest.engines[0].facets.monitoring.activeSessions = "offered";
      r.manifest.engines[0].facets.monitoring.tables = "offered";
      r.manifest.engines[0].facets.agentReadings = readings;
      r.impl.monitoring = { panel };
    });

    expect(checkProviderModule(offering)).toEqual([]);
    expect((defineProvider(offering.manifest, offering.impl).manifest as Json).engines[0].facets.agentReadings).toEqual(
      readings,
    );
    expect(checkProviderModule(record((r) => (r.manifest.engines[0].facets.agentReadings = ["health"])))).toEqual([]);
  });

  test("a panel reading is refused by name as engine-facet-call-not-offered, naming monitoring.panel, where the package does not offer it", () => {
    const pointer = "/manifest/engines/0/facets/agentReadings";
    const name = "monitoring.panel";
    const changed = record((r) => {
      r.manifest.engines[0].facets.maintenance = ["vacuum"];
      r.manifest.engines[0].facets.agentReadings = ["sessions", "health", "storage"];
    });

    expect(checkProviderModule(changed)).toEqual([
      refusal("engine-facet-call-not-offered", "/manifest/engines/0/facets/maintenance/0", { name: "maintenance.run" }),
      refusal("engine-facet-call-not-offered", `${pointer}/0`, { name }),
      refusal("engine-facet-call-not-offered", `${pointer}/2`, { name }),
    ]);
    // An item outside the readings vocabulary is the validator's: the check refuses nothing for it.
    expect(
      checkProviderModule(record((r) => (r.manifest.engines[0].facets.agentReadings = ["toString", "__proto__", 7]))),
    ).toEqual([]);
    // An offer that cannot be read is refused at the offer alone: the readings are not refused again for it.
    expect(
      checkProviderModule(
        record((r) => {
          r.manifest.calls.monitoring.panel = "maybe";
          r.manifest.engines[0].facets.agentReadings = ["sessions"];
        }),
      ),
    ).toEqual([refusal("manifest-unreadable", "/manifest/calls/monitoring/panel")]);
    // An item the check reads that is an accessor is refused as property-not-data, and its getter is never called.
    let reads = 0;
    const planted = Object.defineProperty(["health"], "0", {
      enumerable: true,
      get() {
        reads += 1;
        return "sessions";
      },
    });
    expect(checkProviderModule(record((r) => (r.manifest.engines[0].facets.agentReadings = planted)))).toEqual([
      refusal("property-not-data", `${pointer}/0`),
    ]);
    expect(reads).toBe(0);
  });

  test("no definition check answers engine-facet-without-call, which left the vocabulary with the agent readings' calls", () => {
    expect<readonly string[]>(DEFINITION_REFUSAL_RULES).not.toContain("engine-facet-without-call");
    expect(DEFINITION_REFUSAL_RULES).toContain("engine-facet-call-not-offered");
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
      [(r) => delete r.manifest.calls.objects, "/manifest/calls/objects"],
      [(r) => (r.manifest.calls.objects = "tree"), "/manifest/calls/objects"],
      [(r) => (r.manifest.calls.objects.tree = "maybe"), "/manifest/calls/objects/tree"],
      [(r) => delete r.manifest.calls.objects.tree, "/manifest/calls/objects/tree"],
      [(r) => delete r.manifest.calls.maintenance, "/manifest/calls/maintenance"],
      [(r) => (r.manifest.calls.maintenance = ["run"]), "/manifest/calls/maintenance"],
      [(r) => (r.manifest.calls.maintenance.run = true), "/manifest/calls/maintenance/run"],
      [(r) => delete r.manifest.calls.maintenance.preview, "/manifest/calls/maintenance/preview"],
      [(r) => delete r.manifest.calls.monitoring, "/manifest/calls/monitoring"],
      [(r) => (r.manifest.calls.monitoring = "panel"), "/manifest/calls/monitoring"],
      [(r) => (r.manifest.calls.monitoring.panel = true), "/manifest/calls/monitoring/panel"],
      [(r) => delete r.manifest.calls.monitoring.poolStats, "/manifest/calls/monitoring/poolStats"],
      [(r) => (r.manifest.engines = { exampledb: {} }), "/manifest/engines"],
      [(r) => (r.manifest.engines[0] = null), "/manifest/engines/0"],
      [(r) => delete r.manifest.engines[0].facets, "/manifest/engines/0/facets"],
      [(r) => (r.manifest.engines[0].facets.monitoring = null), "/manifest/engines/0/facets/monitoring"],
      [(r) => (r.manifest.engines[0].facets.monitoring.tables = 1), "/manifest/engines/0/facets/monitoring/tables"],
      [(r) => (r.manifest.engines[0].facets.maintenance = "vacuum"), "/manifest/engines/0/facets/maintenance"],
      [(r) => delete r.manifest.engines[0].facets.agentReadings, "/manifest/engines/0/facets/agentReadings"],
      [(r) => delete r.manifest.engines[0].facets.maintenanceSpecs, "/manifest/engines/0/facets/maintenanceSpecs"],
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
