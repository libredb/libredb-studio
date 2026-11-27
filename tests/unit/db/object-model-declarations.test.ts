/**
 * The census of the object model (docs/providers/CONTRACT.md, clause M-89): the SDK's `objects` member states every
 * object model Studio ships.
 *
 * The legacy providers stay the runtime source of their model until each engine moves into its package, so no legacy
 * declaration states one and nothing here compares a committed copy. Instead every shipped provider is built through
 * the real `createDatabaseProvider`, unconnected, its `getCapabilities()` model is projected into the declaration's form
 * by `declaredObjectModel` (tests/helpers/object-model.ts), and its committed declaration with that model added is held
 * to the SDK's schema and every object model rule through `validateEngine`. So an engine's model, its maintenance
 * kinds and its catalog capture kind words are read against one another as a package's would be.
 *
 * A provider whose model depends on its connection is projected under every variant this census can reach without a
 * server: the census connection, the same connection naming no database and no connection string (a server-level
 * connection, whose catalog level some engines add), and the agent execution profile (`readOnly`, under which some
 * engines draw no tree). A variant an engine refuses to build, by a `DatabaseConfigError` naming the connection it does
 * not open, is not one it serves, and is left out; any other failure fails the census. Two variants are measured only
 * at connect, so no census reaches them: the routine kinds' source edits postgres grants once its routine guard is
 * measured, and the two kinds mysql adds once a server is measured as MariaDB; each is a flag or a kind of the shapes
 * the reached variants already state.
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
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { DatabaseConfigError } from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { DatabaseConnection, ProviderCapabilities, ProviderExecutionContext } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";
import {
  CAPABILITY_MODEL_MEMBERS,
  declaredObjectModel,
  OBJECT_KIND_MEMBERS,
  OBJECT_MODEL_MEMBERS,
} from "../../helpers/object-model";

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

/** One projected model: the engine, the variant it was built under and the model its capabilities answer. */
interface Projection {
  readonly type: DatabaseType;
  readonly variant: string;
  readonly capabilities: ProviderCapabilities;
  readonly model: ObjectModel;
}

/** `type`'s model under `variant`, or null where the engine refuses to build that variant's connection. */
async function project(type: DatabaseType, variant: string, of: Variant): Promise<Projection | null> {
  const { connection, execution } = of(type);
  let capabilities: ProviderCapabilities;
  try {
    capabilities = (await createDatabaseProvider(connection, {}, execution)).getCapabilities();
  } catch (error) {
    if (variant === "census" || !(error instanceof DatabaseConfigError)) throw error;
    return null;
  }
  return { type, variant, capabilities, model: declaredObjectModel(capabilities) };
}

/** Every engine's model under every variant it builds. */
const projections: Projection[] = (
  await Promise.all(
    SHIPPED_DATABASE_TYPES.flatMap((type) =>
      Object.entries(VARIANTS).map(([variant, of]) => project(type, variant, of)),
    ),
  )
).filter((projection): projection is Projection => projection !== null);

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
