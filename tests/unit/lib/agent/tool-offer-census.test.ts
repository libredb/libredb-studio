/**
 * What a run is offered against what it is held to, over every statement language at once.
 *
 * Each language registers its own records (its pack's server adapter, tool overrides and tool arms, under
 * `src/lib/agent/languages/`, and the tool rules), and nothing in any one of them can see the others. So the agreements
 * between them are asserted here, as censuses over the language ids rather than as cases per language: a language added
 * later joins every one of these by being registered, and fails the one it does not keep.
 */
import { describe, expect, test } from "bun:test";
import {
  AGENT_LANGUAGE_COPY,
  AGENT_WORKFLOW_VARIANTS,
  type AgentStatementLanguageId,
} from "@/lib/agent/agent-manifest";
import { languageToolArms } from "@/lib/agent/languages/index";
import { languageServer, workflowToolRules } from "@/lib/agent/languages/server";
import { type AgentToolName, agentToolDefinition } from "@/lib/agent/tools";
import type { AgentRunWorkflowType } from "@/lib/agent/types";
import { createCanonicalOperationRegistry, isStatementReadOperation } from "@/lib/db/operations/descriptors";
import { toolsNamedIn } from "../../../helpers/agent-tool-rules";

const LANGUAGES = Object.keys(AGENT_LANGUAGE_COPY) as AgentStatementLanguageId[];

/** Every workflow a language has a variant of, with that variant. */
const variantsOf = (language: AgentStatementLanguageId) =>
  Object.entries(AGENT_WORKFLOW_VARIANTS[language]).flatMap(([workflow, variant]) =>
    variant === undefined ? [] : [{ workflow: workflow as AgentRunWorkflowType, variant }],
  );

describe("the tools a run is offered", () => {
  test("are parsed by the very schema they are offered with, on every language that has an arm for them", () => {
    // An arm that parsed a schema of its own would refuse what the model was offered, or accept what it was not:
    // MongoDB's profile was offered `fromColumn` and `distribution` and refused both.
    let checked = 0;
    for (const language of LANGUAGES) {
      const arms: Partial<Record<AgentToolName, { readonly inputSchema: unknown }>> = languageToolArms()[language];
      for (const { workflow, variant } of variantsOf(language)) {
        for (const tool of variant.tools) {
          const arm = arms[tool];
          if (arm === undefined) continue;
          checked += 1;
          expect(arm.inputSchema, `${language} ${workflow} ${tool}`).toBe(
            agentToolDefinition(language, workflow, tool).inputSchema,
          );
        }
      }
    }
    // The census is not vacuous: the SQL and MongoDB arms are all offered somewhere.
    expect(checked).toBeGreaterThan(0);
  });

  test("an offered tool with an arm in one language has one wherever it is offered in that language", () => {
    for (const language of LANGUAGES) {
      const arms: Partial<Record<AgentToolName, unknown>> = languageToolArms()[language];
      for (const { workflow, variant } of variantsOf(language)) {
        for (const tool of ["inspect_schema", "inspect_plan", "profile_table"] as const) {
          if (!variant.tools.includes(tool)) continue;
          expect(arms[tool], `${language} ${workflow} offers ${tool}`).toBeDefined();
        }
      }
    }
  });
});

describe("the tool rules a run is told", () => {
  test("name only tools the run's own variant offers, on every language and workflow", () => {
    // A rule naming a tool the run does not hold is answered "there is no tool called ..." and costs the run a turn
    // (#350): measured on a MongoDB optimization run told to compare_plans, which its variant does not offer.
    for (const language of LANGUAGES) {
      const rules: Partial<Record<AgentRunWorkflowType, string>> = workflowToolRules()[language];
      for (const { workflow, variant } of variantsOf(language)) {
        const text = rules[workflow];
        if (text === undefined) throw new Error(`${language} has a ${workflow} variant and no rules for it`);
        for (const tool of toolsNamedIn(text)) {
          expect(variant.tools, `${language} ${workflow} names ${tool}`).toContain(tool);
        }
      }
    }
  });
});

describe("the statement reads", () => {
  test("are exactly the read operation each language's model-written statements are evaluated under", () => {
    // `present_answer` and the auto-execute gate count a result as the model's own read by this one predicate, so a
    // plan or a profile that answered true here would be presentable as an answer (#373).
    const registered = createCanonicalOperationRegistry().registeredIds().filter(isStatementReadOperation);
    const languages = LANGUAGES.map((language) => languageServer(language).readOperation);
    expect(new Set(registered)).toEqual(new Set(languages));
    expect(registered).toHaveLength(languages.length);
  });
});
