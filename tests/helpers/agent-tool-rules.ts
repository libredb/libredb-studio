import { agentToolsNamedIn } from "@libredb/provider-sdk/manifest";
import type { AgentToolName } from "@/lib/agent/tools";

/**
 * The tools a rule text tells the model to use: every tool name it contains, except one written as an absence
 * ("there is no inspect_schema"), which is the operations rules saying what the run does not hold.
 *
 * The SDK's reading (`agentToolsNamedIn`), the one its validator refuses a declared tool rule by, so a rule is read the
 * same way here and at admission; tests/unit/lib/agent/tool-offer-census.test.ts holds the SDK's tool names equal to
 * `AGENT_TOOL_DEFINITIONS`' names, which makes each answer an `AgentToolName`.
 *
 * Shared by the per-language census in `tests/unit/lib/agent/tool-offer-census.test.ts` and the per-engine contract in
 * `tests/unit/lib/agent/engine-pack-contract.test.ts`, so the two read a rule text the same way.
 */
export const toolsNamedIn = (rules: string): AgentToolName[] => agentToolsNamedIn(rules);
