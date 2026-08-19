/**
 * Driving a model that cannot emit `tool_calls`.
 *
 * Some capable models do not speak the OpenAI tool-call format at all. Measured on a
 * local Ollama endpoint, every `deepseek-r1` distill — 7b, 8b, 14b, 32b — is handed
 * tools, reasons about the question, and answers in prose without ever emitting a
 * `tool_calls` array. The capability gate reads that correctly and refuses the run,
 * which is right when there is nothing else to try, and wasteful when there is: the
 * same models, asked in prose for a single JSON object, produced the correct call with
 * the correct argument **15 times out of 15** across those three sizes.
 *
 * So this module is the second way to ask. The tools are described in text derived from
 * the tool definitions themselves, and the model's ordinary reply is read back for one
 * action. What it deliberately does NOT do is create a second, weaker execution path:
 * the action it returns carries a tool name and an unvalidated input, and the caller
 * puts both through the same `AGENT_TOOL_DEFINITIONS` schema and the same audited
 * pipeline a native tool call goes through. Nothing here decides that a call is
 * allowed; it only recovers what the model was trying to say.
 *
 * Neither half is reachable for a model whose tool calling works — see the branch in
 * `investigation.ts`. That is the property that keeps this from changing a single byte
 * of what a working model is sent, which matters more than it looks: these models are
 * sensitive enough to their prompt that adding a paragraph for everyone measurably
 * moved timings and outcomes on models that had been passing.
 */

import { z } from "zod";
import type { AgentToolDefinition } from "./tools";

/** What a prompted turn yields: a tool name and the input the caller must still validate. */
export interface PromptedAction {
  readonly name: string;
  readonly input: unknown;
}

/**
 * The protocol, stated once. One object, one line, nothing else — the narrowest thing a
 * model can be asked for that still carries a name and arguments, and the shape all
 * three measured sizes produced without coaxing.
 */
const PROTOCOL = [
  "You cannot call tools directly here. To act, reply with NOTHING but a single JSON object:",
  '{"action": "<tool name>", "arguments": { ... }}',
  "No prose before or after it, and no markdown fence. That object IS the call: it is the only way anything happens.",
  "To say something without acting, reply with prose and no object.",
].join(" ");

/**
 * The protocol restated, for a server notice sent mid-run.
 *
 * Every notice this runtime sends is written for a model holding tools: "call
 * compose_report now" names an act a native model can simply perform. A prompted model
 * has no tool to call — for it, calling one means emitting the object — so the same
 * sentence tells it WHAT to do and not HOW.
 *
 * Measured: `deepseek-r1:7b` took a reading and then narrated, was reminded to report,
 * and narrated again, ending `no-report` three times out of three. The instruction had
 * landed; the format had not.
 */
export const PROMPTED_PROTOCOL_REMINDER =
  'Remember: to call a tool here, reply with NOTHING but {"action": "<tool name>", "arguments": { ... }}.';

/**
 * The tools, in prose, for a model that cannot be handed them as tools.
 *
 * The argument shapes are JSON Schema generated from each tool's own zod schema rather
 * than written out here, so the text cannot drift from what the tool accepts — a
 * hand-written contract that says one thing while the schema enforces another is the
 * #350 failure in a new place.
 *
 * @returns the contract, or null when the run holds no tools and there is nothing to say
 */
export function promptedToolContract(tools: readonly AgentToolDefinition[]): string | null {
  if (tools.length === 0) return null;

  const described = tools.map((definition) => {
    const shape = JSON.stringify(z.toJSONSchema(definition.inputSchema as z.ZodType));
    return `- ${definition.name}: ${definition.description}\n  arguments: ${shape}`;
  });

  return `${PROTOCOL}\n\nThe tools you have in this run:\n${described.join("\n")}`;
}

/**
 * Every `{...}` in the text, whole, with nesting kept.
 *
 * Scanned by depth rather than matched by a regular expression because the arguments
 * nest — a chart spec inside a presentation inside the arguments — and a non-greedy
 * pattern stops at the first inner brace, which would deliver a truncated call. String
 * literals are tracked so a brace inside a SQL statement cannot close the object.
 */
function objectsIn(text: string): string[] {
  const found: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) found.push(text.slice(start, i + 1));
    }
  }

  return found;
}

/** An object shaped like an action: a non-empty name, and arguments that are an object. */
const actionSchema = z.object({
  action: z.string().min(1),
  arguments: z.looseObject({}).optional(),
});

/**
 * The same shape, offered for the ENDPOINT to enforce rather than the prompt to request.
 *
 * Probed directly against Ollama's OpenAI-compatible endpoint: given this schema as
 * `response_format: json_schema`, the reply comes back conforming. That turns the protocol
 * from something a model may fumble into something it cannot — which matters here more than
 * anywhere, because on this path a malformed reply is a pure loss: there is no `tool_calls`
 * field to fall back on, only prose to parse.
 *
 * `arguments` is REQUIRED here while the parser above keeps it optional, and the difference
 * is deliberate. A constraint is a demand the server makes of a model that can satisfy it; a
 * parser is a reading of whatever arrived, including from an endpoint that ignored the
 * constraint entirely. Loosening the parser to match the constraint would remove the
 * tolerance that made the prompted path work at all.
 */
export const PROMPTED_ACTION_SHAPE = z.object({
  action: z.string().min(1).describe("The exact name of one tool this run holds"),
  arguments: z.looseObject({}).describe("The arguments for that tool, as an object"),
});

/**
 * The action a prompted turn settled on, or null if the reply was prose.
 *
 * Reads the LAST action-shaped object in the text, and that direction is the point: a
 * reasoning model rehearses candidate calls inside its thinking and then commits to one.
 * Taking the first would run a call it had talked itself out of.
 *
 * A missing `arguments` reads as `{}` rather than as a refusal, so a tool that takes no
 * argument still dispatches. Everything past this point is the caller's to validate.
 */
export function readPromptedAction(text: string): PromptedAction | null {
  for (const candidate of objectsIn(text).reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const action = actionSchema.safeParse(parsed);
    if (!action.success) continue;
    return { name: action.data.action, input: action.data.arguments ?? {} };
  }
  return null;
}

/**
 * A tool call the model wrote as its PAYLOAD, with no envelope naming the tool.
 *
 * The largest loss measured across 25 local models on six surfaces was `no-report` — 37 of
 * 66 failing cells, on every surface. Reading 36 of those ledgers, SEVEN had written a
 * complete `compose_report` payload into their closing prose, fenced as JSON, instead of
 * calling the tool. Seven different families, native tool callers among them; one appended
 * "(The compose_report tool was successfully used with the required structure, producing
 * the above report.)" and plainly believed it had. Their work was done and the run scored
 * as having established nothing.
 *
 * `readPromptedAction` cannot reach that: it looks for an `{"action", "arguments"}`
 * envelope and these models wrote the bare arguments. What identifies the tool instead is
 * the SCHEMA — a payload is matched against the input schema of each tool the run actually
 * holds — which is the only way to name the tool without guessing at it.
 *
 * Two refusals matter more than the recovery, and both are asserted:
 *
 *  - **Ambiguity is not resolved.** A payload satisfying two held tools recovers nothing,
 *    because choosing between them would be this reader inventing an intent the model
 *    never expressed.
 *  - **Recovery grants no authority.** What comes back is a name and an unvalidated input,
 *    put through the same `AGENT_TOOL_DEFINITIONS` schema and the same audited pipeline as
 *    a native call. A recovered report citing an id the run never produced is refused by the
 *    citation contract exactly as it would be — recovery reads intent, it does not confer
 *    trust. That is what bounds the injection case too: a hostile row value the model has
 *    quoted back can be recovered as a call, and it then meets every check a call meets,
 *    including the one that refuses evidence this run did not produce.
 *
 * The LAST fitting object wins, for the reason `readPromptedAction` reads backwards: a
 * reasoning model rehearses payloads inside its thinking before committing to one.
 */
export function readPromptedPayload(text: string, tools: readonly AgentToolDefinition[]): PromptedAction | null {
  if (tools.length === 0) return null;
  for (const candidate of objectsIn(text).reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const fits = tools.filter((definition) => (definition.inputSchema as z.ZodType).safeParse(parsed).success);
    // Exactly one, or nothing. A schema loose enough to accept two tools' payloads is a
    // fact about the tools, and the reader's job is to notice it rather than pick.
    const only = fits.length === 1 ? fits[0] : undefined;
    if (only !== undefined) return { name: only.name, input: parsed };
  }
  return null;
}
