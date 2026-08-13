import type { AgentModelCapability } from "./capability-probe";

/**
 * What each probed capability is called in front of a user (#331 T4).
 *
 * It lives apart from `capability-probe.ts` because both ends of a refusal need these
 * words and only one end can import that module: the probe runs the AI SDK, and the
 * rail is a client component, so importing the probe from the browser would ship `ai`
 * and the provider packages into the page. The type import above is erased, so nothing
 * of the probe reaches a bundle through this file.
 *
 * One map, two readers: the sentence the server writes into the `422` and the list the
 * rail composes from `missing` name the same three things by construction rather than by
 * two authors happening to agree.
 *
 * The field names are this repository's own identifiers. Reading `structuredOutput` back
 * to someone leaks our vocabulary into their error message, and "schema-valid tool
 * arguments" is also the more accurate claim — it is precisely what the probe measured.
 */
const CAPABILITY_LABELS: Readonly<Record<AgentModelCapability, string>> = Object.freeze({
  toolCalling: "tool calling",
  structuredOutput: "schema-valid tool arguments",
  streaming: "streaming",
});

export function describeAgentCapability(capability: AgentModelCapability): string {
  return CAPABILITY_LABELS[capability];
}

/**
 * Whether a name that arrived over the wire is one this build has words for.
 *
 * A server newer than the page it is serving may probe a capability this bundle has
 * never heard of. Rendering that identifier raw is exactly the leak the labels exist to
 * prevent, so the browser drops what it cannot name rather than inventing a label for it.
 */
export function isAgentModelCapability(value: unknown): value is AgentModelCapability {
  return typeof value === "string" && Object.hasOwn(CAPABILITY_LABELS, value);
}
