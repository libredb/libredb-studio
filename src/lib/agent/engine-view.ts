/**
 * What an agent run reads of its engine's declarations: the object model its grounding walks, the language its prose
 * names, and the noun its inventory rows go by, for any engine the server serves, legacy or package alike.
 *
 * The agent owns this view, rather than taking a legacy provider's `ProviderCapabilities` and `ProviderLabels`,
 * because a provider package's engine has no legacy provider: what it states is its admitted declaration, read here
 * from the record's package (`servedPackage`), and Studio never builds a `ProviderCapabilities` for it. Every member
 * of the view is one `ProviderCapabilities` or `ProviderLabels` states, under the same type, so a legacy provider's own
 * objects are views as they are and are handed on unchanged: a legacy run reads exactly what its provider declared.
 *
 * Server tier: it reads the provider factory and the record's package, so no client module imports it.
 */
import type { EngineDeclaration, ObjectModel } from "@libredb/provider-sdk/manifest";
import type { ProviderExecutionContext } from "@/lib/db/types";
import { readProviderDeclarations } from "@/lib/db";
import { QUERY_LANGUAGE_TAB_TYPES } from "@/lib/db/engine-catalog/projection";
import type { ObjectModelView } from "@/lib/db/object-kinds";
import { type EngineConnection, type EngineRecord, legacyConnection, servedPackage } from "@/lib/db/server-catalog";
import type { ProviderCapabilities, ProviderLabels } from "@/lib/db/types";
import { quoteTypeId } from "@/lib/db/type-id";
import { EXPLAIN_FORMATS } from "@/lib/explain";

/**
 * The engine facts an agent run reads: the object model the grounding walk reads, and beside it the members of
 * `ProviderCapabilities` the agent reads, each under that interface's type. A legacy provider's capabilities are one as
 * they are.
 */
export interface AgentEngineCapabilities extends ObjectModelView {
  readonly queryLanguage: ProviderCapabilities["queryLanguage"];
  readonly explainFormat?: ProviderCapabilities["explainFormat"];
  /** Read by the policy's capability stage for the estimating explain (`requiredCapabilities` of its descriptor). */
  readonly supportsExplain?: ProviderCapabilities["supportsExplain"];
  readonly queryDialect?: ProviderCapabilities["queryDialect"];
  readonly tablesAreDerivedGroupings?: boolean;
  readonly declaresForeignKeys?: boolean;
  readonly agentWalkScope?: ProviderCapabilities["agentWalkScope"];
}

/** The words an agent run's prose names the engine's objects by; a legacy provider's labels are one as they are. */
export interface AgentEngineLabels {
  readonly entityName: string;
  readonly entityNamePlural: string;
  readonly statementLanguage?: ProviderLabels["statementLanguage"];
  readonly tableStatsCaption?: ProviderLabels["tableStatsCaption"];
}

/** An agent run's engine facts and words, read once when its drive builds the run's context. */
export interface AgentEngineDeclarations {
  readonly capabilities: AgentEngineCapabilities;
  readonly labels: AgentEngineLabels;
}

/** The noun of the inventory rows of a package model that states no relation kind. */
const OBJECT_NOUN: AgentEngineLabels = Object.freeze({ entityName: "Object", entityNamePlural: "Objects" });

/**
 * The declarations of `connection`'s engine, `engine`, as an agent run reads them:
 *
 * - a record that offers a legacy provider: its provider's own capabilities and labels, the very objects
 *   `readProviderDeclarations` answers, read under `execution` without connecting;
 * - any other record: its package's admitted declaration of the engine. The object model's members where it states
 *   one (none where it states none, so the grounding walk finds no kind to read); the query language and the explain
 *   format of its editor facts; the noun of its first relation kind as the inventory's words, and "Object" where its
 *   model states no relation kind. It states no query dialect in Studio's registry form, no foreign key declaration
 *   and no statement language or statistics caption, so those are absent, the reading a reader has for an unknown.
 *
 * @throws {Error} A host defect: when the record's package declares no engine of the record's id, when its query
 * language is one Studio holds no tab type for, or when its explain format is one Studio holds no strategy for, each of
 * which admission refuses.
 */
export async function agentEngineDeclarations(
  engine: EngineRecord,
  connection: EngineConnection,
  execution: ProviderExecutionContext,
): Promise<AgentEngineDeclarations> {
  if (engine.offers.legacyProvider) {
    const { capabilities, labels } = await readProviderDeclarations(legacyConnection(engine, connection), execution);
    return { capabilities, labels };
  }
  const declaration = servedPackage(engine).manifest.engines.find((declared) => declared.id === engine.id);
  if (declaration === undefined) {
    throw new Error(
      `The provider package ${engine.source.name} serving the engine ${quoteTypeId(engine.id)} declares no engine of that id: a host defect.`,
    );
  }
  const model = declaration.objects;
  const explainFormat = heldExplainFormat(engine, declaration.editor.explainFormat);
  return {
    capabilities: {
      ...(model === undefined ? {} : modelMembers(model)),
      queryLanguage: heldQueryLanguage(engine, declaration.editor.language.queryLanguage),
      ...(explainFormat === undefined ? {} : { explainFormat }),
    },
    labels: relationNoun(model),
  };
}

/**
 * The members of a declared object model the agent reads, its walk scope in Studio's form: absent where the model
 * states none, and `whenNoDefault` absent where it states none, as a legacy provider leaves them.
 */
function modelMembers(model: ObjectModel): Omit<AgentEngineCapabilities, "queryLanguage"> {
  const scope = model.agentWalkScope;
  return {
    containerLevels: model.containerLevels,
    containerPathShapes: model.containerPathShapes,
    objectKinds: model.objectKinds,
    rowActions: model.rowActions,
    containersNameKinds: model.containersNameKinds,
    tablesAreDerivedGroupings: model.tablesAreDerivedGroupings,
    ...(scope === null
      ? {}
      : {
          agentWalkScope: {
            mode: scope.mode,
            alsoWalk: scope.alsoWalk,
            ...(scope.whenNoDefault === null ? {} : { whenNoDefault: scope.whenNoDefault }),
          },
        }),
  };
}

/** The words of the first relation kind `model` states, or "Object" where it states none. */
function relationNoun(model: ObjectModel | undefined): AgentEngineLabels {
  const relation = model?.objectKinds.find((kind) => kind.role === "relation");
  return relation === undefined ? OBJECT_NOUN : { entityName: relation.label, entityNamePlural: relation.labelPlural };
}

/** Whether `language` is a query language Studio holds a tab type for. */
function isHeldQueryLanguage(language: string): language is ProviderCapabilities["queryLanguage"] {
  return Object.hasOwn(QUERY_LANGUAGE_TAB_TYPES, language);
}

/**
 * `language` as Studio's query language.
 *
 * @throws {Error} A host defect, naming the engine and the language, when Studio holds no tab type for it.
 */
function heldQueryLanguage(
  engine: EngineRecord,
  language: EngineDeclaration["editor"]["language"]["queryLanguage"],
): ProviderCapabilities["queryLanguage"] {
  if (isHeldQueryLanguage(language)) return language;
  throw new Error(
    `The engine ${quoteTypeId(engine.id)} declares the query language ${JSON.stringify(language)}, which LibreDB Studio holds no tab type for and admission refuses: a host defect.`,
  );
}

/**
 * `format` as Studio's explain format, or undefined where the engine declares none.
 *
 * @throws {Error} A host defect, naming the engine and the format, when Studio holds no explain strategy for it.
 */
function heldExplainFormat(
  engine: EngineRecord,
  format: EngineDeclaration["editor"]["explainFormat"],
): ProviderCapabilities["explainFormat"] {
  if (format === null) return undefined;
  const held = EXPLAIN_FORMATS.find((candidate) => candidate === format);
  if (held !== undefined) return held;
  throw new Error(
    `The engine ${quoteTypeId(engine.id)} declares the explain format ${JSON.stringify(format)}, which LibreDB Studio holds no explain strategy for and admission refuses: a host defect.`,
  );
}
