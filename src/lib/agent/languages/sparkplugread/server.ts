/**
 * What the server does for the sparkplugread request language, assembled from the language's server modules.
 */
import { SPARKPLUG_COMPLETENESS } from "@/lib/db/providers/industrial/sparkplug/agent-read";
import { SPARKPLUG_IDS_WITHHELD_SENTENCE } from "@/lib/db/providers/industrial/sparkplug/agent-surface";
import type { AgentInventoryNoun } from "../../inventory-noun";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { SPARKPLUGREAD_ADAPTER } from "./adapter";
import { SPARKPLUGREAD_TOOL_OVERRIDES } from "./definitions";

/** Why no id is listed for a run, the same words in the rule, the grounding advice and the ungrounded note. */
const NOT_LISTED =
  "No group, edge node or device is listed for the run, and none ever will be: Sparkplug has no command that lists them, and their ids are withheld from agent mode in any case.";

/** How to read what a question names without a whole-plant read first. */
const READ_WHAT_IS_NAMED =
  'When the question names a group, an edge node or a device in full, read it directly with {"read": "group", "group": "<group>"}, {"read": "edgeNode", "group": "<group>", "edgeNode": "<edge node>"} or {"read": "device", "group": "<group>", "edgeNode": "<edge node>", "device": "<device>"}, each id exactly as the question writes it; read the window, {"read": "window"}, only for the plant\'s totals, never to look for an id.';

const SPARKPLUGREAD_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    'Read the plant with run_read_query, one JSON request at a time: {"read": "window"} for the totals of one window over the whole namespace (or, when the connection names one group, that group alone), and the group, edgeNode and device reads for one object named in full.',
    NOT_LISTED,
    READ_WHAT_IS_NAMED,
    "Never write an id the question does not name, and never derive one from another: a guessed id not seen tells you nothing.",
    SPARKPLUG_IDS_WITHHELD_SENTENCE,
    `Report each answer with the window it listened for and its stop reason. ${SPARKPLUG_COMPLETENESS} So report an object not seen as not seen in that window, never as absent or offline, a birth or a death as one the window saw, and a count as a count of that window, never of the plant.`,
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
});

/**
 * No `inspect_schema` is offered, and an agent-mode handle declares no container level and no kind for the grounding
 * walk, so a run is always ungrounded and the note says why and how the plant is read. `relations` is false: a broker declares no
 * relation the inventory draws. No `planningRules`: they reach plan mode alone, whose statement form is the provider's
 * `statementLanguage` label, so the rules of the agent's reader are never told to it; a plan on this engine is prose
 * (`client.ts`).
 */
const SPARKPLUGREAD_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice: `${NOT_LISTED} ${SPARKPLUG_IDS_WITHHELD_SENTENCE} ${READ_WHAT_IS_NAMED} ${SPARKPLUG_COMPLETENESS}`,
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this plant has been established for you: not one ${noun.singular} name. ${NOT_LISTED} ${SPARKPLUG_IDS_WITHHELD_SENTENCE} ${READ_WHAT_IS_NAMED} ${SPARKPLUG_COMPLETENESS}`,
});

export const SPARKPLUGREAD_SERVER_PACK = Object.freeze({
  adapter: SPARKPLUGREAD_ADAPTER,
  toolOverrides: SPARKPLUGREAD_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: SPARKPLUGREAD_GROUNDING,
  workflowToolRules: SPARKPLUGREAD_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
