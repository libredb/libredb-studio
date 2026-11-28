/**
 * The client facet of a statement language an engine declares as data (`statementLanguageData.agent` of its
 * declaration), composed from the language's declared text, so the language needs no module of its own under
 * `languages/<id>/`. Its server facet is `declared-server.ts`'s and its MCP facet `declared-mcp.ts`'s; the registries
 * in `client.ts`, `server.ts` and `index.ts` hold the first two, and `mcp.ts` the third, beside the module languages.
 *
 * Client-safe: it imports the SDK's types only, never its validator, the leaf `workflow-tool-sets.ts` and types.
 *
 * Studio fixes everything a declared JSON request language's client facet holds besides its words: its argument is
 * `statement`; it has no advice keys; its variants are `investigation`, offered `run_read_query` and `compose_report`,
 * with no narrowed extras, the SQL variant's plan deliverable, no auto-execute, no requirement and the verifier
 * `agent-investigation.1`, and `operations` (`OPERATIONS_VARIANT`); it has no plan estimate, evidence event, shortfall,
 * reading refusal or requirement of its own; and its posture has the reads arm and the hand-over terms, no widened arm
 * and no plan arm. A language that needs more stays a module until its engine's wave.
 *
 * Each text is written as declared: a string as it stands, and a list of parts joined with nothing between them, each
 * fill replaced by the value Studio hands for that text. The values each text takes are the SDK's `AGENT_TEXT_FILLS`,
 * which the types below read, so a text the SDK fills and this module does not hand a value for does not compile:
 * rows, the most rows a read answers; seconds, the most seconds a read runs; noun, the inventory's word for one of its
 * objects; allowed, the most rows a refused read may ask for.
 */
import type {
  AGENT_TEXT_FILLS,
  AgentLanguageText,
  AgentText,
  StatementLanguageAgent,
  StatementLanguageData,
} from "@libredb/provider-sdk/manifest";
import type { AgentDeclaredLanguageId, AgentVariantRequirement } from "../agent-manifest";
import type { AgentToolName } from "../tools";
import { OPERATIONS_VARIANT } from "../workflow-tool-sets";
import type { AgentLanguageClientPack, AgentPostureCopy, StatementBudgets } from "./pack";

/** The texts of an agent text, by group and name, with the names of the values Studio fills into each. */
type AgentTextFills = typeof AGENT_TEXT_FILLS;

/** The values text `Name` of group `Group` is filled with: exactly the names the SDK lists for it, each a string. */
type AgentTextFillValues<Group extends keyof AgentTextFills, Name extends keyof AgentTextFills[Group]> = {
  readonly [Fill in AgentTextFills[Group][Name] extends readonly (infer Each extends string)[] ? Each : never]: string;
};

/** A statement language an engine's declaration states agent data for: its branded name and its agent part. */
export interface DeclaredAgentLanguage {
  readonly id: AgentDeclaredLanguageId;
  readonly agent: NonNullable<StatementLanguageAgent>;
}

/**
 * The statement languages `declared` states an agent part for, in its order, each with its name branded as a declared
 * language: data with no agent part is no agent language and is left out. Read through `composeDeclaredLanguages` in
 * `client.ts`: by the browser once, at load, on the bundled declarations' data, and by the server's registries once
 * per installed catalog, on the data that catalog grants its served engines.
 *
 * @throws {Error} Naming the language, where a declared name is one of `modules`, the module languages this build
 * holds (a language whose module was not deleted when its data was written), or where two data state one name. Each is
 * a host defect, never a precedence.
 */
export function declaredAgentLanguages(
  declared: readonly NonNullable<StatementLanguageData>[],
  modules: readonly string[],
): readonly DeclaredAgentLanguage[] {
  const languages: DeclaredAgentLanguage[] = [];
  for (const { name, agent } of declared) {
    if (agent === null) continue;
    const named = JSON.stringify(name);
    if (modules.includes(name)) {
      throw new Error(
        `The statement language ${named} is declared as data and is also a module language of this build.`,
      );
    }
    if (languages.some(({ id }) => id === name))
      throw new Error(`The statement language ${named} is declared as data twice.`);
    languages.push(Object.freeze({ id: name as AgentDeclaredLanguageId, agent }));
  }
  return Object.freeze(languages);
}

/**
 * `text` written out: a string as it stands, and parts joined with nothing between them, each fill replaced by its
 * value in `values`.
 *
 * @throws {Error} Naming the fill, where a part names a value `values` does not hold. Validated data never does, since
 * the manifest validator refuses a fill its text does not take, so this is a host defect and never an empty string.
 */
export function fillAgentText(text: AgentText, values: Readonly<Record<string, string>>): string {
  if (typeof text === "string") return text;
  return text
    .map((part) => {
      if (typeof part === "string") return part;
      if (!Object.hasOwn(values, part.fill)) {
        throw new Error(
          `The agent text names the fill ${JSON.stringify(part.fill)}, which Studio was not handed for it.`,
        );
      }
      return values[part.fill] as string;
    })
    .join("");
}

/** Text `name` of group `group` of `text`, filled with `values`, the values the SDK lists for that text. */
export function filledText<Group extends keyof AgentTextFills, Name extends keyof AgentTextFills[Group]>(
  text: AgentLanguageText,
  group: Group,
  name: Name,
  values: AgentTextFillValues<Group, Name>,
): string {
  const texts = text[group] as unknown as Readonly<Record<Name, AgentText>>;
  return fillAgentText(texts[name], values);
}

/** The values the posture's texts are filled with: the run's rows and seconds per read. */
function budgetValues(bounds: StatementBudgets): AgentTextFillValues<"posture", "body"> {
  return { rows: String(bounds.maxResultRows), seconds: String(bounds.statementTimeoutMs / 1000) };
}

/** The client facet of a declared language whose text is `text`, frozen. */
export function composeDeclaredClientPack(text: AgentLanguageText): AgentLanguageClientPack {
  const reads = (bounds: StatementBudgets): AgentPostureCopy => {
    const values = budgetValues(bounds);
    return {
      qualifier: filledText(text, "posture", "qualifier", values),
      title: filledText(text, "posture", "title", values),
      body: filledText(text, "posture", "body", values),
    };
  };
  return Object.freeze({
    copy: Object.freeze({
      subject: filledText(text, "copy", "subject", {}),
      noun: filledText(text, "copy", "noun", {}),
      argument: "statement",
      writes: filledText(text, "copy", "writes", {}),
      reached: filledText(text, "copy", "reached", {}),
      defect: filledText(text, "copy", "defect", {}),
      adviceKeys: Object.freeze([]),
    }),
    variants: Object.freeze({
      investigation: Object.freeze({
        tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
        narrowedExtras: Object.freeze<AgentToolName[]>([]),
        classifierDescription: filledText(text, "investigation", "classifierDescription", {}),
        objective: filledText(text, "investigation", "objective", {}),
        planDeliverable: "inherits",
        canAutoExecute: false,
        requires: Object.freeze<AgentVariantRequirement[]>([]),
        verifier: "agent-investigation.1",
      }),
      operations: OPERATIONS_VARIANT,
    }),
    planEstimateOperation: null,
    evidenceEvents: Object.freeze({}),
    shortfallSentences: Object.freeze({}),
    readingRefusalHeadlines: Object.freeze({}),
    requirements: Object.freeze({}),
    posture: Object.freeze({
      reads,
      handoverTerms: (bounds: StatementBudgets) => filledText(text, "posture", "handover", budgetValues(bounds)),
    }),
  } satisfies AgentLanguageClientPack);
}
