/**
 * Capability probe for the agent runtime (#329, epic #325).
 *
 * An agent run needs three things from its model: it must call tools, its tool
 * arguments must satisfy the schema they are declared against, and it must
 * stream. A model that cannot do those is not a slower agent — it is a run that
 * would stall, or worse, one that answers in prose the run loop then treats as a
 * plan. So the run service asks this module first, and a model that fails is
 * refused with a message naming the capabilities the probe could not establish
 * and the one action that answers them: configure a different model.
 *
 * The probe establishes capabilities POSITIVELY. There is no capability table
 * keyed on model names: for the `ollama` and `custom` kinds the model is whatever
 * the operator is serving, and a table would be claiming knowledge it cannot
 * have. So the probe asks the configured model to call one trivial tool and
 * reports only what it observed on the wire. Anything it did not observe is
 * reported as not established, together with the endpoint's own words when it
 * refused — never as a diagnosis the probe invented.
 *
 * Three deliberate boundaries:
 *
 *  - **A failure that says nothing about the model reaches no verdict.** A bad
 *    key, a quota, an unpaid account, a wrong model id, a 5xx, a dropped socket
 *    and an abort all THROW (in this repository's `LLMError` vocabulary) rather
 *    than returning a refusal — none of them is evidence about the MODEL, and a
 *    refusal here says "configure a different model", which is the one change that
 *    would not have helped. Only a completed answer that fell short, or one of the
 *    `REQUEST_REFUSED_STATUSES` below, produces a verdict. Same discipline as the
 *    deadline's two deny codes: separate causes get separate vocabularies.
 *  - **One round trip, no retries.** A preflight that costs several calls is a
 *    preflight users turn off. `maxRetries: 0`; a transient failure surfaces as
 *    inconclusive and it is the caller's call whether to start the run later.
 *  - **The SDK's own error logging is silenced.** `streamText`'s default
 *    `onError` writes the raw provider error to the console, and an `APICallError`
 *    carries `requestBodyValues` — the entire prompt. Agent prompts carry database
 *    content (labeled and quoted, but still), so that default would copy user data
 *    into the server log on every failure. The probe collects the error part from
 *    the stream instead and reports through its own vocabulary.
 *
 * What `structuredOutput` means here is narrow and worth saying out loud: schema-
 * valid TOOL INPUT, which is the mechanism the SDK's own object generation uses in
 * its tool mode. A pass is not evidence about a native JSON-schema response format,
 * so a run loop that later reaches for one has to establish that separately.
 *
 * What the probe does NOT decide: which capabilities a given run MODE needs.
 * Planning mode is toolless by contract (`types.ts`), so a run service may
 * reasonably probe only before an agent-mode run; that choice belongs to the run
 * service, not here. This module answers one question — what can this model
 * actually do — and refuses to guess at the rest.
 */

import { APICallError, streamText, tool } from "ai";
import { z } from "zod";
import { type LLMProviderType, LLMError, LLMStreamError } from "@/lib/llm/types";
import { type AgentModel, mapAgentModelError } from "./model-adapter";

/** What one probe established. Every field is an observation, not a vendor claim. */
export interface AgentModelCapabilities {
  /** The model asked for the tool it was given. */
  readonly toolCalling: boolean;
  /** Its tool arguments validated against the schema they were declared against. */
  readonly structuredOutput: boolean;
  /** The endpoint answered with an event stream rather than one buffered body. */
  readonly streaming: boolean;
}

export type AgentModelCapability = keyof AgentModelCapabilities;

/**
 * Why this model cannot drive a run.
 *
 * `detail` is a sentence the PROBE wrote, which quotes untrusted text inside
 * itself — the endpoint's own error message, or a tool name the model made up,
 * each collapsed and clipped first. It is deliberately not the raw text: the
 * sentence is what carries the provenance, so that whatever composes it into a
 * longer message cannot re-attribute it (see `refusalMessage`).
 */
export interface AgentCapabilityRefusal {
  readonly provider: LLMProviderType;
  readonly modelId: string;
  /** Everything the probe managed to establish, so a caller can log the whole picture. */
  readonly capabilities: AgentModelCapabilities;
  /**
   * At least one capability, always. The shortfall path reaches a refusal only
   * after finding one unestablished, and on the endpoint-refusal path the status
   * precedes the body, so a refused request has established nothing at all.
   */
  readonly missing: readonly AgentModelCapability[];
  readonly detail?: string;
  /** User-facing: what could not be established, and that another model is the way forward. */
  readonly message: string;
}

export type AgentCapabilityProbeResult =
  | { readonly supported: true; readonly capabilities: AgentModelCapabilities }
  | { readonly supported: false; readonly refusal: AgentCapabilityRefusal };

export interface AgentCapabilityProbeOptions {
  /** Bounds the probe; a run-level deadline is the intended source. */
  readonly abortSignal?: AbortSignal;
}

/**
 * The one tool the probe offers. Prefixed and specific so that a model calling
 * something else is visibly calling something else, and so this name cannot
 * collide with a real agent tool in a transcript.
 */
export const PROBE_TOOL_NAME = "libredb_capability_probe";

const PROBE_TOOL = tool({
  description: "Acknowledge that you can call a tool. Call this once and answer nothing else.",
  inputSchema: z.object({ acknowledged: z.boolean() }),
});

const PROBE_PROMPT = `Call the ${PROBE_TOOL_NAME} tool once with acknowledged set to true. Do not answer in prose.`;

/** Order is the order a refusal lists them in, so the message reads the same way twice. */
const REQUIRED_CAPABILITIES: readonly AgentModelCapability[] = ["toolCalling", "structuredOutput", "streaming"];

/**
 * What each capability is called in front of a user. The field names are this
 * module's own identifiers; reading `structuredOutput` back to someone is leaking
 * our vocabulary into their error message, and "schema-valid tool arguments" is
 * also the more accurate claim — that is precisely what the probe measured.
 */
const CAPABILITY_LABELS: Readonly<Record<AgentModelCapability, string>> = Object.freeze({
  toolCalling: "tool calling",
  structuredOutput: "schema-valid tool arguments",
  streaming: "streaming",
});

/** How much untrusted text may reach a user-facing message. */
const DETAIL_LIMIT = 200;

// Messages are built on one line each: bun's line coverage under-counts the
// continuation lines of multi-line string concatenation.
//
// A `detail` is always a whole sentence that names its OWN source, because the two
// sources are not interchangeable: one is the endpoint's words, the other is the
// probe's observation of what the model did. A single "the endpoint reported"
// prefix over both would hand a model's invented tool name — attacker-controlled
// text — the authority of the server.
//
// The message names the shortfall and ONE action, and no other surface (#331 T2).
// It used to send the user to the NL2SQL panel and the AI Assistant as toolless
// alternatives. That is the wrong advice independently of which of those surfaces
// still ships: the user asked for an agent run, and a toolless surface cannot
// answer that question - it has no way to reach the database at all. A refusal
// that redirects to a surface which cannot do the refused thing turns one clear
// failure into a second, slower one. What remains is the true half: the probe
// could not establish these capabilities, and a different model is the way forward.
const refusalMessage = (
  provider: LLMProviderType,
  modelId: string,
  missing: readonly AgentModelCapability[],
  detail?: string,
): string => {
  const shortfall = missing.map((capability) => CAPABILITY_LABELS[capability]).join(", ");
  // Its own statement rather than a template inside the template below: a nested one
  // reads as part of the sentence while being a separate expression, which is why the
  // rule against them exists.
  const detailClause = detail ? `${detail} ` : "";
  return `The model "${modelId}" (${provider}) cannot drive an agent run: the capability probe could not establish ${shortfall}. ${detailClause}Configure a different model and start the run again.`;
};

const unknownToolDetail = (toolName: string): string =>
  `The model called a tool that was not offered: "${clip(toolName)}".`;

const endpointRefusalDetail = (status: number, message: string): string =>
  asSentence(`The endpoint refused the tool request with HTTP ${status}: ${clip(message) || "no message given"}`);

const abortedMessage = (modelId: string): string =>
  `The capability probe for "${modelId}" was aborted before it reached a verdict.`;

/**
 * One sentence, with no doubled full stop when the text it quotes ended in one.
 *
 * Strips at most ONE period, not a run of them: `clip` marks a truncated quote
 * with a trailing ellipsis, and swallowing that would hide from the reader that
 * there was more.
 */
const asSentence = (text: string): string => `${text.replace(/\.$/, "")}.`;

/** Collapses whitespace and bounds length: this text comes from outside. */
function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= DETAIL_LIMIT) return collapsed;
  return `${collapsed.slice(0, DETAIL_LIMIT)}...`;
}

interface ProbeObservation {
  /** At least one incremental part arrived, so the endpoint really streamed. */
  streamed: boolean;
  calledProbeTool: boolean;
  argumentsValidated: boolean;
  /** A tool call naming something the probe never offered, if one arrived. */
  unknownToolName?: string;
  aborted: boolean;
  failure?: unknown;
}

/**
 * Yields a stream's parts, translating a throw into this module's vocabulary.
 *
 * Every failure the installed providers produce arrives as an `error` PART rather
 * than a throw — verified across 400/401/402/404/408/429/500/503, a rejected
 * fetch, and a socket break mid-stream. A model whose returned stream errors
 * directly does throw, though (verified with a stub model), and a raw
 * `APICallError` escaping here would carry `requestBodyValues`: the prompt this
 * module silences `onError` to keep out of logs. So the one escape hatch is closed
 * rather than left to a future SDK version to open.
 */
async function* streamParts<T>(parts: AsyncIterable<T>, provider: LLMProviderType): AsyncGenerator<T> {
  try {
    for await (const part of parts) yield part;
  } catch (error) {
    throw mapAgentModelError(error, provider);
  }
}

/**
 * Runs the probe request and records what came back.
 *
 * Reads the stream rather than awaiting the result promises on purpose: after a
 * failed request those promises reject with the SDK's own `NoOutputGeneratedError`,
 * which hides the `APICallError` this module has to classify.
 */
async function observeProbe(agentModel: AgentModel, abortSignal?: AbortSignal): Promise<ProbeObservation> {
  const observation: ProbeObservation = {
    streamed: false,
    calledProbeTool: false,
    argumentsValidated: false,
    aborted: false,
  };

  const stream = streamText({
    model: agentModel.model,
    tools: { [PROBE_TOOL_NAME]: PROBE_TOOL },
    toolChoice: "required",
    prompt: PROBE_PROMPT,
    maxRetries: 0,
    abortSignal,
    onError: () => {
      // Silenced deliberately; see the header. The error part is read below.
    },
  });

  for await (const part of streamParts(stream.fullStream, agentModel.provider)) {
    switch (part.type) {
      case "text-delta":
      case "tool-input-delta":
      case "tool-input-start":
        // A server that ignores `stream: true` and answers with one buffered body
        // produces none of these, which is exactly how the probe sees the
        // difference. `tool-input-start` is in the set because
        // `@ai-sdk/google` emits a complete no-argument function call with no
        // delta at all, and that is still a streamed answer.
        observation.streamed = true;
        break;
      case "tool-call":
        if (part.toolName === PROBE_TOOL_NAME) {
          observation.calledProbeTool = true;
          // The SDK flags a call it could not parse or validate against the
          // schema; an unparsable one arrives with its raw text as the input.
          observation.argumentsValidated = part.invalid !== true;
        } else {
          observation.unknownToolName = part.toolName;
        }
        break;
      case "error":
        // First failure wins: later parts describe the aftermath, not the cause.
        observation.failure = observation.failure ?? part.error;
        break;
      case "abort":
        observation.aborted = true;
        break;
      default:
        break;
    }
  }

  return observation;
}

type ProbeFailureVerdict =
  | { readonly conclusive: true; readonly detail: string }
  | { readonly conclusive: false; readonly error: LLMError };

/**
 * The statuses that mean "this endpoint will not serve THIS request" — what a
 * server answers when the model behind it cannot take the tool it was handed.
 *
 * Every other status is about the reach rather than the model: 401/403 a
 * credential, 429 a quota, 402 an unpaid account, 404 a wrong model id or base
 * URL, 405/408 a wrong endpoint or a timeout, 5xx an outage. Every one of those
 * would answer the same way for any other model behind the same configuration, so
 * answering them with a refusal that says "configure a different model" would send
 * the user to change the one thing that is not at fault. They get no verdict.
 */
const REQUEST_REFUSED_STATUSES: readonly number[] = [400, 422];

/** Decides whether a failed probe request says anything about the MODEL. */
function classifyProbeFailure(failure: unknown, provider: LLMProviderType): ProbeFailureVerdict {
  const mapped = mapAgentModelError(failure, provider);
  if (!APICallError.isInstance(failure)) return { conclusive: false, error: mapped };

  const status = failure.statusCode ?? 0;
  if (!REQUEST_REFUSED_STATUSES.includes(status)) return { conclusive: false, error: mapped };
  // The status is part of the detail because the message may be empty — an HTML
  // error page or a bare body leaves the SDK nothing to extract.
  return { conclusive: true, detail: endpointRefusalDetail(status, failure.message) };
}

function refuse(
  agentModel: AgentModel,
  capabilities: AgentModelCapabilities,
  detail?: string,
): AgentCapabilityProbeResult {
  const missing = REQUIRED_CAPABILITIES.filter((capability) => !capabilities[capability]);

  return {
    supported: false,
    refusal: {
      provider: agentModel.provider,
      modelId: agentModel.modelId,
      capabilities,
      missing,
      detail,
      message: refusalMessage(agentModel.provider, agentModel.modelId, missing, detail),
    },
  };
}

/**
 * Ask a configured model to demonstrate what an agent run needs.
 *
 * @returns a verdict: the established capabilities, or a refusal naming what the
 *          probe could not establish. A `supported: false` result carries no model
 *          and no continuation — there is nothing for a caller to run with.
 * @throws LLMError when the probe could not reach a verdict at all (auth, quota,
 *         a server failure, a broken stream, an abort). Inconclusive is not a
 *         refusal: the model may be perfectly capable.
 */
export async function probeAgentModel(
  agentModel: AgentModel,
  options: AgentCapabilityProbeOptions = {},
): Promise<AgentCapabilityProbeResult> {
  const observation = await observeProbe(agentModel, options.abortSignal);

  if (observation.aborted) throw new LLMStreamError(abortedMessage(agentModel.modelId), agentModel.provider);

  const capabilities: AgentModelCapabilities = {
    toolCalling: observation.calledProbeTool,
    structuredOutput: observation.calledProbeTool && observation.argumentsValidated,
    streaming: observation.streamed,
  };

  if (observation.failure !== undefined) {
    const verdict = classifyProbeFailure(observation.failure, agentModel.provider);
    // A stream that broke after a complete tool call is still inconclusive: the
    // transport just failed, and starting a run on it would fail next.
    if (!verdict.conclusive) throw verdict.error;
    return refuse(agentModel, capabilities, verdict.detail);
  }

  if (capabilities.toolCalling && capabilities.structuredOutput && capabilities.streaming) {
    return { supported: true, capabilities };
  }

  const detail = observation.unknownToolName === undefined ? undefined : unknownToolDetail(observation.unknownToolName);
  return refuse(agentModel, capabilities, detail);
}
