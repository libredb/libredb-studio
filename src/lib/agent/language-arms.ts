/**
 * What each statement language does when a run calls one of the tools whose execution differs by language:
 * `inspect_schema`, `inspect_plan` and `profile_table`.
 *
 * The execution half of what `TOOL_OVERRIDES` (`tools.ts`) is for the offer, keyed the same way, by language: a run
 * is offered a language's definition of a tool and executed by that language's arm of it, so the two cannot come to
 * disagree, and nothing anywhere tests a language id to choose between them. Each arm declares as its input the
 * exported schema its tool parses with, and `tests/unit/lib/agent/tool-offer-census.test.ts` holds that declaration
 * equal to the schema the definition offers, so what a run is offered is what it is held to. The operation a step is
 * recorded under is the definition's own (`agentToolDefinition`), as it is for every database tool, so an arm does
 * not declare a second one.
 *
 * Total over `AgentStatementLanguageId`, so a later language does not compile until it says which arms it has. A
 * language that offers none of these tools has none (kubectl, whose variants offer reads and curated readings only);
 * the run loop treats a tool it is asked to execute with no arm as its own fault, never as a reason to fall back to SQL's.
 *
 * Imported by the run loop (`investigation.ts`) alone: it reaches both `tools.ts` and `mongo-tools.ts`, and
 * `mongo-tools.ts` imports `tools.ts`, so a registry anywhere below the loop would be a cycle.
 */
import type { z } from "zod";
import type { AgentStatementLanguageId } from "./agent-manifest";
import { mongoInspectPlanTool, mongoInspectSchemaTool, planMongoProfile, runMongoProfile } from "./mongo-tools";
import type { AgentProfileDepth } from "./table-profile";
import {
  type AgentTableProfileOutcome,
  type AgentToolContext,
  type AgentToolOutcome,
  catalogSelectorSchema,
  inspectPlanTool,
  inspectSchemaTool,
  mongoPlanCommandSchema,
  mongoProfileSelectorSchema,
  planStatementSchema,
  planTableProfile,
  profileSelectorSchema,
  profileTableTool,
} from "./tools";
import type { AgentContextSnapshot, AgentRunRecord } from "./types";

/** A catalog arm: the selector it parses, and the read. `snapshot` is the inventory this run captured, or null. */
export interface InspectSchemaArm {
  readonly inputSchema: z.ZodType<unknown>;
  run(context: AgentToolContext, input: unknown, snapshot: AgentContextSnapshot | null): Promise<AgentToolOutcome>;
}

/** A plan arm: the statement it parses, and the estimating plan of it. */
export interface InspectPlanArm {
  readonly inputSchema: z.ZodType<unknown>;
  run(context: AgentToolContext, input: unknown): Promise<AgentToolOutcome>;
}

/**
 * What every language's planned profile carries for the step it settles as: the target the spelling RESOLVED to, the
 * depth, and where in the object's columns the batch starts. Two requests naming one object at one depth and one
 * batch are one step, whatever spelling reached it.
 */
export interface ProfileArmPlan {
  readonly target: { readonly schema?: string; readonly table: string };
  readonly depth: AgentProfileDepth;
  readonly from: number;
}

/**
 * A profile arm: the selector its planning step parses, the planning step that resolves and composes and reaches
 * nothing, and the read of what it planned. `run` is only ever handed the plan its own `plan` produced, which is what
 * lets each language's plan carry what that language's read needs.
 */
export interface ProfileArm<Plan extends ProfileArmPlan = ProfileArmPlan> {
  readonly inputSchema: z.ZodType<unknown>;
  plan(
    context: AgentToolContext,
    run: Pick<AgentRunRecord, "runId" | "events">,
    input: unknown,
  ): { readonly kind: "planned"; readonly plan: Plan } | (AgentToolOutcome & { readonly kind: "unavailable" });
  run(context: AgentToolContext, plan: Plan): Promise<AgentTableProfileOutcome>;
}

/** The arms one language has. A language offering none of the three tools has none. */
export interface LanguageToolArms {
  readonly inspect_schema?: InspectSchemaArm;
  readonly inspect_plan?: InspectPlanArm;
  readonly profile_table?: ProfileArm;
}

export const LANGUAGE_TOOL_ARMS: Readonly<Record<AgentStatementLanguageId, LanguageToolArms>> = Object.freeze({
  sql: Object.freeze({
    inspect_schema: Object.freeze({
      inputSchema: catalogSelectorSchema,
      run: (context: AgentToolContext, input: unknown) =>
        inspectSchemaTool(context, input as { schema?: string; table?: string }),
    }),
    inspect_plan: Object.freeze({
      inputSchema: planStatementSchema,
      run: (context: AgentToolContext, input: unknown) => inspectPlanTool(context, input as { sql: string }),
    }),
    profile_table: Object.freeze({
      inputSchema: profileSelectorSchema,
      plan: planTableProfile,
      run: profileTableTool,
    }),
  }),
  kubectl: Object.freeze({}),
  mongo: Object.freeze({
    inspect_schema: Object.freeze({ inputSchema: catalogSelectorSchema, run: mongoInspectSchemaTool }),
    inspect_plan: Object.freeze({ inputSchema: mongoPlanCommandSchema, run: mongoInspectPlanTool }),
    profile_table: Object.freeze({
      inputSchema: mongoProfileSelectorSchema,
      plan: planMongoProfile,
      run: runMongoProfile,
    }),
  }),
} satisfies Record<AgentStatementLanguageId, LanguageToolArms>);

/** The arms of `language`, or a named error when the id is not a language this server knows. */
export function languageArms(language: AgentStatementLanguageId): LanguageToolArms {
  const arms = Object.hasOwn(LANGUAGE_TOOL_ARMS, language) ? LANGUAGE_TOOL_ARMS[language] : undefined;
  if (arms === undefined) throw new Error(`no tool arms for ${language}`);
  return arms;
}
