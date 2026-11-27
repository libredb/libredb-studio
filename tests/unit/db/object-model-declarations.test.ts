/**
 * The census of the object model (docs/providers/CONTRACT.md, clause M-89): the SDK's `objects` member states every
 * object model Studio ships.
 *
 * The legacy providers stay the runtime source of their model until each engine moves into its package, so no legacy
 * declaration states one and nothing here compares a committed copy. Instead every shipped provider is built through
 * the real `createDatabaseProvider`, unconnected, its `getCapabilities()` model is projected into the declaration's form
 * by `declaredObjectModel` (src/lib/provider-host/legacy-object-model.ts), and its committed declaration with that model
 * added is held to the SDK's schema and every object model rule through `validateEngine`. So an engine's model, its
 * maintenance kinds and its catalog capture kind words are read against one another as a package's would be. The legacy
 * bridge's session of each provider states that same projection, the model the host core holds its tree calls to.
 *
 * A provider whose model depends on its connection is projected under every variant this census can reach without a
 * server: the census connection, the same connection naming no database and no connection string (a server-level
 * connection, whose catalog level some engines add), and the agent execution profile (`readOnly`, under which some
 * engines draw no tree). A variant an engine refuses to build, by a `DatabaseConfigError` naming the connection it does
 * not open, is not one it serves, and is left out; any other failure fails the census. Which engines' models differ
 * between variants, and which engines each variant skips, are pinned by engine id, so a variant that drops out of reach
 * fails by name rather than silently. Two variants are measured only at connect, so no census reaches them: the
 * routine kinds' source edits postgres grants once its routine guard is measured, and the two kinds mysql adds once a
 * server is measured as MariaDB; each is a flag or a kind of the shapes the reached variants already state.
 *
 * It needs the real factory, which every file under `tests/api/` mocks; the runner gives each test file a process of
 * its own.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  compileManifestValidator,
  type EngineDeclaration,
  type ObjectModel,
  type SchemaRefusal,
} from "@libredb/provider-sdk/manifest";
import { checkTreeRequest } from "@libredb/provider-sdk/calls";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { DatabaseConfigError } from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import {
  acceptedContainerShapes,
  activationRowActionForKind,
  assertContainerPathShape,
  assertObjectPathShape,
  containerDepth,
  declaredKinds,
  declaredLevels,
  enumerableKinds,
  findKind,
  kindAcceptsRowWrites,
  kindAcceptsSourceEdits,
  kindCountIsListing,
  kindGroup,
  kindHasColumns,
  kindHasSource,
  kindNamesWithheld,
  kindsForContainer,
  keyBrowserKind,
  type ObjectModelView,
  relationKindIds,
  requireEditableKind,
  requireSourceKind,
  rowActionsForKind,
} from "@/lib/db/object-kinds";
import type {
  DatabaseConnection,
  DatabaseProvider,
  ProviderCapabilities,
  ProviderExecutionContext,
} from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { bridgedConsole, bridgedObjectModel } from "@/lib/provider-host/legacy-bridge";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";
import {
  CAPABILITY_MODEL_MEMBERS,
  declaredObjectModel,
  OBJECT_KIND_MEMBERS,
  OBJECT_MODEL_MEMBERS,
} from "@/lib/provider-host/legacy-object-model";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SCHEMA_BYTES = readFileSync(path.join(ROOT, "packages/provider-sdk/src/manifest/manifest.schema.json"));
const SCHEMA = JSON.parse(SCHEMA_BYTES.toString("utf8")) as {
  $defs: Record<string, { properties?: Record<string, unknown> }>;
};
const VALIDATOR = compileManifestValidator(SCHEMA_BYTES);

/** The committed declaration of `type`, read once per call. */
function declarationOf(type: DatabaseType): EngineDeclaration {
  return JSON.parse(
    readFileSync(path.join(ROOT, "src/lib/db/engine-declarations", `${type}.json`), "utf8"),
  ) as EngineDeclaration;
}

/** The SDK's minimal manifest, the smallest a package writes. */
function minimalManifest(): Record<string, unknown> & { engines: unknown[]; compatibility: { engine: string }[] } {
  return JSON.parse(
    readFileSync(path.join(ROOT, "packages/provider-sdk/tests/fixtures/minimal-manifest.json"), "utf8"),
  ) as Record<string, unknown> & { engines: unknown[]; compatibility: { engine: string }[] };
}

/** A connection variant: the connection and execution context a provider is built with. */
type Variant = (type: DatabaseType) => { connection: DatabaseConnection; execution: ProviderExecutionContext };

/** Every variant the census reaches without a server, by name; `census` first, which every engine builds. */
const VARIANTS: Readonly<Record<string, Variant>> = Object.freeze({
  census: (type) => ({ connection: CENSUS_CONNECTION[type], execution: {} }),
  "server level": (type) => ({
    connection: { ...CENSUS_CONNECTION[type], database: undefined, connectionString: undefined },
    execution: {},
  }),
  "agent profile": (type) => ({ connection: CENSUS_CONNECTION[type], execution: { readOnly: true } }),
});

/**
 * One projected model: the engine, the variant it was built under, the provider built, and the model its capabilities
 * answer.
 */
interface Projection {
  readonly type: DatabaseType;
  readonly variant: string;
  readonly provider: DatabaseProvider;
  readonly capabilities: ProviderCapabilities;
  readonly model: ObjectModel;
}

/** A variant an engine refuses to build: the engine and the variant. */
interface Skipped {
  readonly type: DatabaseType;
  readonly variant: string;
}

/** `type`'s model under `variant`, or the skip where the engine refuses to build that variant's connection. */
async function project(type: DatabaseType, variant: string, of: Variant): Promise<Projection | Skipped> {
  const { connection, execution } = of(type);
  let provider: DatabaseProvider;
  try {
    provider = await createDatabaseProvider(connection, {}, execution);
  } catch (error) {
    if (variant === "census" || !(error instanceof DatabaseConfigError)) throw error;
    return { type, variant };
  }
  const capabilities = provider.getCapabilities();
  return { type, variant, provider, capabilities, model: declaredObjectModel(capabilities) };
}

/** Every engine under every variant: the projections it builds, and the variants it refuses. */
const reached = await Promise.all(
  SHIPPED_DATABASE_TYPES.flatMap((type) => Object.entries(VARIANTS).map(([variant, of]) => project(type, variant, of))),
);
const projections: Projection[] = reached.filter((item): item is Projection => "model" in item);
const skipped: Skipped[] = reached.filter((item) => !("model" in item));

/** The refusals of `type`'s committed declaration stating `model`, as `<rule> at <pointer>`. */
function refusalsOf(type: DatabaseType, model: ObjectModel): string[] {
  const verdict = VALIDATOR.validateEngine({ ...declarationOf(type), objects: model });
  return verdict.admitted ? [] : verdict.refusals.map((refusal) => `${refusal.rule} at ${refusal.pointer}`);
}

/** A deep copy of `model`, so a plant changes no projection. */
function copy(model: ObjectModel): { -readonly [K in keyof ObjectModel]: ObjectModel[K] } {
  return structuredClone(model) as { -readonly [K in keyof ObjectModel]: ObjectModel[K] };
}

describe("the object model of every shipped engine", () => {
  test("each legacy provider's object model, projected into its declaration, is admitted by the SDK's schema and every object model rule, under each connection variant reachable without a server", () => {
    const refused = projections.flatMap(({ type, variant, model }) =>
      refusalsOf(type, model).map((refusal) => `${type} ${variant}: ${refusal}`),
    );
    const differing = projections.filter(
      ({ type, variant, model }) =>
        variant !== "census" &&
        !Bun.deepEquals(model, projections.find((p) => p.type === type && p.variant === "census")?.model),
    );

    expect(refused).toEqual([]);
    expect(projections.filter(({ variant }) => variant === "census").map(({ type }) => type)).toEqual([
      ...SHIPPED_DATABASE_TYPES,
    ]);
    expect(SHIPPED_DATABASE_TYPES.length).toBeGreaterThan(40);
    // Vacuity: the variants reach a model the census connection does not answer, so they are read, not repeated, and
    // every variant is built by some engine.
    expect(differing.length).toBeGreaterThan(0);
    for (const variant of Object.keys(VARIANTS)) expect(projections.some((p) => p.variant === variant)).toBe(true);
    // Vacuity: the shipped models state every container level list the level order rule admits, each one admitted.
    const levelLists = new Set(projections.map(({ model }) => model.containerLevels.map((level) => level.id).join(",")));
    expect([...levelLists].sort()).toEqual(["", "catalog", "catalog,schema", "schema"]);
  });

  test("the variants reach exactly the engines whose model depends on the connection, and skip exactly the engines that refuse a variant's connection", () => {
    const census = (type: DatabaseType) => projections.find((p) => p.type === type && p.variant === "census")?.model;
    const differing = Object.fromEntries(
      Object.keys(VARIANTS)
        .filter((variant) => variant !== "census")
        .map((variant) => [
          variant,
          projections
            .filter((p) => p.variant === variant && !Bun.deepEquals(p.model, census(p.type)))
            .map((p) => p.type),
        ]),
    );
    const refused = Object.fromEntries(
      Object.keys(VARIANTS).map((variant) => [
        variant,
        skipped.filter((item) => item.variant === variant).map((item) => item.type),
      ]),
    );

    // A variant that drops out of reach, or an engine whose model starts or stops depending on its connection, fails
    // here by name, so the census never reads fewer models than it says.
    expect(differing).toEqual({ "server level": ["postgres"], "agent profile": ["sparkplug"] });
    expect(refused).toEqual({
      census: [],
      "server level": ["bigquery", "couchbase", "db2", "duckdb", "mssql", "mysql", "sqlite"],
      "agent profile": [],
    });
  });

  test("each shipped provider's bridged session states the projection of its capabilities' object model, under each connection variant", () => {
    const differing = projections.filter(({ provider, model }) => {
      const { session } = bridgedConsole(provider, {});
      return !Bun.deepEquals(session.objectModel, model) || !Bun.deepEquals(bridgedObjectModel(provider), model);
    });

    expect(differing.map(({ type, variant }) => `${type} ${variant}`)).toEqual([]);
    expect(projections.length).toBeGreaterThan(SHIPPED_DATABASE_TYPES.length * 2);
  });

  test("every object kind reader answers the same over each projected model as over its provider's capabilities", () => {
    const differing = projections.filter(
      ({ capabilities, model }) => !Bun.deepEquals(readerAnswers(model), readerAnswers(capabilities)),
    );

    expect(differing.map(({ type, variant }) => `${type} ${variant}`)).toEqual([]);
    // Vacuity: the readers met kinds, levels and row actions across the census.
    expect(projections.some(({ model }) => model.objectKinds.length > 0)).toBe(true);
    expect(projections.some(({ model }) => model.containerLevels.length === 2)).toBe(true);
    expect(projections.some(({ model }) => model.rowActions.length > 0)).toBe(true);
  });

  test("the host's tree request check admits exactly the levels and kinds the object kind readers admit, over every projected model", () => {
    const disagreeing = projections.flatMap(({ type, variant, model }) => {
      const at = `${type} ${variant}`;
      const lines: string[] = [];
      const kinds = [...model.objectKinds.map((kind) => kind.id), UNSTATED_KIND];
      for (const length of LENGTHS) {
        const path = Array.from({ length }, (_, index) => `segment${index}`);
        const shapes = acceptedContainerShapes(model).some((shape) => shape.length === length);
        const counted = checkTreeRequest(model, { action: "count", container: path }).length === 0;
        if (counted !== shapes) lines.push(`${at}: count of ${length} segments`);
        const parent = checkTreeRequest(model, { action: "containers", parent: path }).length === 0;
        if (parent !== length <= containerDepth(model)) lines.push(`${at}: parent of ${length} segments`);
      }
      for (const kind of kinds) {
        const named = checkTreeRequest(model, { action: "describe", path: [], kind }).length === 0;
        if (named !== (findKind(model, kind) !== undefined)) lines.push(`${at}: kind ${kind}`);
      }
      return lines;
    });

    expect(disagreeing).toEqual([]);
  });

  test("a planted projection fails each object model rule by name at its pointer", () => {
    const planted = projections.find(
      ({ variant, model }) =>
        variant === "census" && model.containerLevels.length === 1 && model.objectKinds.length > 0,
    );
    if (planted === undefined) throw new Error("no shipped engine states one container level and an object kind");
    const { type, model } = planted;
    const kinds = model.objectKinds.length;
    const stated = new Set(model.objectKinds.map((kind) => kind.id));
    const unstated = ["unstated", "unstated-kind", "unstated-object-kind"].find((id) => !stated.has(id));

    const levels = copy(model);
    levels.containerLevels = [model.containerLevels[0], model.containerLevels[0]] as ObjectModel["containerLevels"];
    const repeated = copy(model);
    repeated.objectKinds = [...model.objectKinds, model.objectKinds[0]] as ObjectModel["objectKinds"];
    const masked = copy(model);
    masked.maskedNameKinds = [unstated as string];
    const activating = copy(model);
    const activation = { id: "planted", label: "Planted", kinds: [model.objectKinds[0].id], activates: true };
    activating.rowActions = [...model.rowActions, activation, { ...activation, id: "replanted" }];

    expect(refusalsOf(type, model)).toEqual([]);
    expect(refusalsOf(type, levels)).toEqual(["object-level-duplicate at /objects/containerLevels/1/id"]);
    expect(refusalsOf(type, repeated)).toEqual([`object-kind-duplicate at /objects/objectKinds/${kinds}/id`]);
    expect(refusalsOf(type, masked)).toEqual(["object-kind-unstated at /objects/maskedNameKinds/0"]);
    expect(refusalsOf(type, activating)).toEqual([
      `object-row-activation-duplicate at /objects/rowActions/${model.rowActions.length + 1}/activates`,
    ]);
    // The level order rule, planted by reversing a shipped two-level model: the schema then the catalog.
    const twoLevels = projections.find(({ variant, model }) => variant === "census" && model.containerLevels.length === 2);
    if (twoLevels === undefined) throw new Error("no shipped engine states two container levels");
    const reversed = copy(twoLevels.model);
    reversed.containerLevels = [...twoLevels.model.containerLevels].reverse() as ObjectModel["containerLevels"];
    expect(refusalsOf(twoLevels.type, twoLevels.model)).toEqual([]);
    expect(refusalsOf(twoLevels.type, reversed)).toEqual(["object-level-order at /objects/containerLevels"]);

    // In a manifest whose package offers objects.tree, the declaration is admitted with its model and refused without.
    const manifest = (objects: ObjectModel | undefined) => {
      const draft = minimalManifest();
      const declaration: Record<string, unknown> = { ...declarationOf(type) };
      if (objects !== undefined) declaration.objects = objects;
      draft.engines = [declaration];
      (draft.compatibility[0] as { engine: string }).engine = type;
      (draft.calls as { objects: { tree: string } }).objects.tree = "offered";
      const verdict = VALIDATOR.validate(draft);
      return verdict.admitted ? [] : (verdict.refusals as SchemaRefusal[]).map((r) => `${r.rule} at ${r.pointer}`);
    };
    expect(manifest(model)).toEqual([]);
    expect(manifest(undefined)).toEqual(["object-model-missing at /engines/0"]);
  });

  test("the projection reads every member of the schema's object model and of each kind, and every member a provider answers is read or classified", () => {
    const defs = SCHEMA.$defs;
    const answered = new Set(projections.flatMap(({ capabilities }) => Object.keys(capabilities)));
    const kindMembers = new Set(
      projections.flatMap(({ capabilities }) => (capabilities.objectKinds ?? []).flatMap((kind) => Object.keys(kind))),
    );

    expect(Object.keys(defs.objectModel?.properties ?? {})).toEqual([...OBJECT_MODEL_MEMBERS]);
    expect(Object.keys(defs.objectKind?.properties ?? {})).toEqual([...OBJECT_KIND_MEMBERS]);
    for (const { model } of projections) {
      expect(Object.keys(model)).toEqual([...OBJECT_MODEL_MEMBERS]);
      for (const kind of model.objectKinds) expect(Object.keys(kind)).toEqual([...OBJECT_KIND_MEMBERS]);
    }
    expect(CAPABILITY_MODEL_MEMBERS).toHaveLength(OBJECT_MODEL_MEMBERS.length);
    expect([...kindMembers].filter((member) => !(OBJECT_KIND_MEMBERS as readonly string[]).includes(member))).toEqual(
      [],
    );
    expect(
      [...answered].filter(
        (member) =>
          !(CAPABILITY_MODEL_MEMBERS as readonly string[]).includes(member) &&
          !Object.hasOwn(NOT_THE_OBJECT_MODEL, member),
      ),
    ).toEqual([]);
    expect(
      Object.keys(NOT_THE_OBJECT_MODEL).filter((member) =>
        (CAPABILITY_MODEL_MEMBERS as readonly string[]).includes(member),
      ),
    ).toEqual([]);
  });
});

/** The container and object path lengths the reader censuses read. */
const LENGTHS = [0, 1, 2, 3, 4] as const;

/** A kind id no shipped engine states. */
const UNSTATED_KIND = "census-unstated-kind";

/** What `run` answers, or the message it throws. */
function outcome(run: () => unknown): unknown {
  try {
    return { answered: run() };
  } catch (error) {
    return { threw: (error as Error).message };
  }
}

/** Every object kind reader's answer over `model`, for every stated kind, one unstated kind and each length. */
function readerAnswers(model: ObjectModelView) {
  const engine = { code: "postgres", label: "A census", attachedSegment: "required" } as const;
  const display = { displayName: "Census", type: "postgres" } as const;
  const ids = [...declaredKinds(model).map((kind) => kind.id), UNSTATED_KIND];
  const pathOf = (length: number) => Array.from({ length }, (_, index) => `segment${index}`);
  return {
    depth: containerDepth(model),
    declared: declaredKinds(model).map((kind) => kind.id),
    enumerable: enumerableKinds(model).map((kind) => kind.id),
    forContainer: kindsForContainer(model, ids.slice(0, 1)).map((kind) => kind.id),
    keyBrowser: keyBrowserKind(model)?.id,
    levels: declaredLevels(model).map((level) => [level.id, level.label]),
    shapes: acceptedContainerShapes(model).map((shape) => shape.length),
    containers: LENGTHS.map((length) =>
      outcome(() => assertContainerPathShape(model, pathOf(length), { ...engine, shapeNames: "label" })),
    ),
    relations: outcome(() => relationKindIds(model)),
    kinds: ids.map((id) => {
      const spec = findKind(model, id);
      return {
        found: spec?.id,
        rowActions: rowActionsForKind(model, id).map((action) => action.id),
        activation: outcome(() => activationRowActionForKind(model, id)?.id),
        rowWrites: kindAcceptsRowWrites(model, id),
        countIsListing: kindCountIsListing(model, id),
        source: kindHasSource(model, id),
        edits: kindAcceptsSourceEdits(model, id),
        group: spec === undefined ? undefined : kindGroup(spec),
        columns: kindHasColumns(spec),
        withheld: kindNamesWithheld(spec),
        requireSource: outcome(() => requireSourceKind(model, id, display).sourceLanguage),
        requireEditable: outcome(() => requireEditableKind(model, id, display).sourceLanguage),
        paths:
          spec === undefined
            ? []
            : LENGTHS.map((length) => outcome(() => assertObjectPathShape(model, spec, id, pathOf(length), engine))),
      };
    }),
  };
}

/**
 * Every `ProviderCapabilities` member that is not part of the object model, with where it is stated instead. A
 * `Record` over the type's keys, so a member added to the interface is a compile error here until it is classified.
 */
const NOT_THE_OBJECT_MODEL: Readonly<
  Record<Exclude<keyof ProviderCapabilities, (typeof CAPABILITY_MODEL_MEMBERS)[number]>, string>
> = Object.freeze({
  catalogSessions: "a claim: granted through the record's serverLevelAtCatalogChoice grant (M-57)",
  keyScan: "parked with the key scan route",
  supportsInlineRowEdit: "an editor gate, read by the browser",
  supportsTestDataGeneration: "an editor gate, read by the browser",
  supportsColumnProfiling: "an editor gate, read by the browser",
  supportsSqlFormat: "an editor gate, read by the browser",
  supportsResultPagination: "an editor gate, read by the browser",
  declaresForeignKeys: "an editor gate, read by the browser",
  previewProjection: "an editor gate, read by the browser",
  previewTimeWindow: "an editor gate, read by the browser",
  schemaRefreshPattern: "an editor gate, read by the browser",
  queryLanguage: "the declaration's editor member",
  queryDialect: "the declaration's editor member",
  supportsExplain: "the declaration's editor member",
  explainFormat: "the declaration's editor member",
  supportsConnectionString: "the declaration's connection member",
  defaultPort: "the declaration's connection member",
  supportsMaintenance: "the declaration's facets member",
  maintenanceOperations: "the declaration's facets member",
  maintenanceOperationSpecs: "the declaration's facets member",
  agentReadings: "the declaration's facets member",
  writeReach: "the declaration's safeguards member and policy claim",
  metadataOnly: "the declaration's safeguards member",
  inlineEditRefusedColumns: "the declaration's safeguards member",
  maskingExemptColumns: "a policy claim",
  agentCredential: "a policy claim",
  singleWriterFile: "a policy claim",
  readsFileAccessPosture: "a policy claim",
  resumesBilledCompute: "a per-connection console fact",
  createTable: "an SQL writing fact",
  identifierQuoting: "an SQL writing fact",
  maxIdentifierBytes: "an SQL writing fact",
  statementTerminator: "an SQL writing fact",
  supportsConstantPredicate: "an SQL writing fact",
  supportsMultiRowInsert: "an SQL writing fact",
  implicitCommitStatements: "a statement fact",
  implicitCommitExceptions: "a statement fact",
  supportsExternalQueryLimiting: "a console fact",
  supportsTransactions: "a console fact",
  supportsQueryCancel: "a console fact",
  blocksServerWhileRunning: "a console fact",
});
