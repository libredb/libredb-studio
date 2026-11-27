/**
 * The legacy bridge's projection of a legacy provider's object model into the form an engine declaration states it
 * (docs/providers/CONTRACT.md, clause M-89): `declaredObjectModel` reads the model members of a built provider's
 * `ProviderCapabilities` and writes every member of the SDK's `ObjectModel` out. An absent list is written as an empty
 * one, an absent flag as false, an absent path shape as `exact` and every other absent member as null, which is the
 * reading Studio's object kind readers give each absence (src/lib/db/object-kinds.ts: `acceptedContainerShapes` reads
 * an absent path shape as exact, and every flag is read as `=== true`).
 *
 * The legacy providers stay the runtime source of their model until each engine moves into its package, so no legacy
 * declaration states one. The legacy bridge (src/lib/provider-host/legacy-bridge.ts, `bridgedObjectModel`) reads a
 * provider's model through this function for the session it builds, which the host core holds every tree call to, and
 * the census (tests/unit/db/object-model-declarations.test.ts) projects every shipped provider's model through it and
 * holds each projection to the SDK's schema and rules, which proves the schema states every model Studio ships. It
 * leaves with the bridge.
 *
 * The member lists below are the members this projection reads, in the order the SDK's schema states them; the census
 * holds each list equal to its schema definition's properties, and every member a provider answers to one the
 * projection reads or classifies, so a member added on either side without the other fails there.
 */
import type {
  AgentWalkScope,
  ContainerLevel,
  ObjectKind,
  ObjectModel,
  KindRowAction as DeclaredRowAction,
} from "@libredb/provider-sdk/manifest";
import type { ContainerLevelSpec, KindRowAction, ObjectKindSpec, ProviderCapabilities } from "@/lib/db/types";

/** The members of `ObjectModel`, each read from the `ProviderCapabilities` member of the same name but the last. */
export const OBJECT_MODEL_MEMBERS = Object.freeze([
  "containerLevels",
  "containerPathShapes",
  "containerNameSpelling",
  "objectKinds",
  "rowActions",
  "containersNameKinds",
  "tablesNeedContainer",
  "tablesAreDerivedGroupings",
  "agentWalkScope",
  "schemaDiffScope",
  "maskedNameKinds",
] as const satisfies readonly (keyof ObjectModel)[]);

/**
 * The `ProviderCapabilities` members the projection reads: one per member of `OBJECT_MODEL_MEMBERS`, in its order, with
 * `machineRedaction` for `maskedNameKinds`.
 */
export const CAPABILITY_MODEL_MEMBERS = Object.freeze([
  "containerLevels",
  "containerPathShapes",
  "containerNameSpelling",
  "objectKinds",
  "rowActions",
  "containersNameKinds",
  "tablesNeedContainer",
  "tablesAreDerivedGroupings",
  "agentWalkScope",
  "schemaDiffScope",
  "machineRedaction",
] as const satisfies readonly (keyof ProviderCapabilities)[]);

/** The members of `ObjectKind`, each read from the `ObjectKindSpec` member of the same name. */
export const OBJECT_KIND_MEMBERS = Object.freeze([
  "id",
  "role",
  "label",
  "labelPlural",
  "hasSource",
  "sourceLanguage",
  "hasColumns",
  "acceptsSourceEdits",
  "childKinds",
  "attachedTo",
  "acceptsRowWrites",
  "enumeratedBy",
  "countIsListing",
  "machineNames",
  "group",
] as const satisfies readonly (keyof ObjectKindSpec)[]);

function level(spec: ContainerLevelSpec): ContainerLevel {
  return { id: spec.id, label: spec.label, labelPlural: spec.labelPlural };
}

function kind(spec: ObjectKindSpec): ObjectKind {
  return {
    id: spec.id,
    role: spec.role,
    label: spec.label,
    labelPlural: spec.labelPlural,
    hasSource: spec.hasSource === true,
    sourceLanguage: spec.sourceLanguage ?? null,
    hasColumns: spec.hasColumns === true,
    acceptsSourceEdits: spec.acceptsSourceEdits === true,
    childKinds: [...(spec.childKinds ?? [])],
    attachedTo: spec.attachedTo ?? null,
    acceptsRowWrites: spec.acceptsRowWrites === true,
    enumeratedBy: spec.enumeratedBy ?? null,
    countIsListing: spec.countIsListing === true,
    machineNames: spec.machineNames ?? null,
    group: spec.group === undefined ? null : { id: spec.group.id, label: spec.group.label },
  };
}

function rowAction(action: KindRowAction): DeclaredRowAction {
  return { id: action.id, label: action.label, kinds: [...action.kinds], activates: action.activates === true };
}

function walkScope(scope: NonNullable<ProviderCapabilities["agentWalkScope"]>): AgentWalkScope {
  const { whenNoDefault } = scope;
  return {
    mode: scope.mode,
    alsoWalk: (scope.alsoWalk ?? []).map((path) => Array.from(path)),
    whenNoDefault:
      whenNoDefault === undefined ? null : { walk: whenNoDefault.walk, skip: [...(whenNoDefault.skip ?? [])] },
  };
}

/** The object model `capabilities` answer, in the declaration's form, every member written out. */
export function declaredObjectModel(capabilities: ProviderCapabilities): ObjectModel {
  return {
    containerLevels: (capabilities.containerLevels ?? []).map(level),
    containerPathShapes: capabilities.containerPathShapes ?? "exact",
    containerNameSpelling: capabilities.containerNameSpelling ?? null,
    objectKinds: (capabilities.objectKinds ?? []).map(kind),
    rowActions: (capabilities.rowActions ?? []).map(rowAction),
    containersNameKinds: capabilities.containersNameKinds === true,
    tablesNeedContainer: capabilities.tablesNeedContainer === true,
    tablesAreDerivedGroupings: capabilities.tablesAreDerivedGroupings === true,
    agentWalkScope: capabilities.agentWalkScope === undefined ? null : walkScope(capabilities.agentWalkScope),
    schemaDiffScope: capabilities.schemaDiffScope ?? null,
    maskedNameKinds: [...(capabilities.machineRedaction?.maskedNameKinds ?? [])],
  };
}
