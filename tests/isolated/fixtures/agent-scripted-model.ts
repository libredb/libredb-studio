/**
 * The deterministic model the agent run loop is driven by in tests and evals
 * (#330 T1).
 *
 * There is ONE of these, and that is the point. `tests/isolated/agent-investigation.test.ts`
 * grew the technique first; the eval suites need exactly it, and a second mock model
 * would be a second answer to "what does a model turn look like on the wire" — the
 * two would drift, and the one that drifted would be the one whose passing tests
 * meant nothing.
 *
 * Three properties are load-bearing:
 *
 *  - **It is the REAL ratified provider package over a scripted `fetch`.** Not a
 *    stubbed `AgentModel`. A stub proves the loop calls what it calls; it cannot
 *    prove that the transcript the loop builds is one an SDK will actually send,
 *    which is precisely what a resumed run rebuilds and what a real endpoint answers
 *    with a 400 when it is wrong.
 *  - **Every turn is a function of what was actually sent.** A script step receives
 *    the request body and the transcript, so a fixture can cite a correlation id the
 *    run genuinely minted rather than one the test invented.
 *  - **`turn.signal` is honoured.** A real `fetch` rejects when its signal fires. A
 *    fixture that ignores the signal tests a transport nobody ships, and hangs the
 *    test instead of failing it — which reads as "the ceiling does not work"
 *    whatever the code does.
 *
 * Nothing here registers a `mock.module`, and nothing here imports a module another
 * suite stubs process-wide except `@/lib/agent/provider-registry` (through
 * `modelOver`). That import is why a group whose files stub the provider registry or
 * the model adapter must not also import this file.
 */

import type { AgentModel } from "@/lib/agent/model-adapter";
import { resolveAgentProviderAdapter } from "@/lib/agent/provider-registry";
import { type FetchDouble, chatTextStream, chatToolCallStream } from "./agent-transport";

/** One request the loop made, as the transport saw it. */
export interface Turn {
  readonly body: Record<string, unknown>;
  readonly transcript: string;
  /**
   * The signal the SDK handed the transport. Present so a fixture can end a
   * response the way a real `fetch` does; verified against the installed package,
   * which forwards its `abortSignal` here rather than only watching it itself.
   */
  readonly signal: AbortSignal | null | undefined;
}

/** One scripted move. May answer asynchronously, so a fixture can act mid-turn. */
export type ScriptedTurn = (turn: Turn) => Response | Promise<Response>;

export interface ScriptedModel {
  readonly fetch: FetchDouble;
  /** Every request the loop made, in order. Grows as the run drives. */
  readonly turns: Turn[];
}

/**
 * A call that never answers, and ends the only way a real one can: when the
 * transport is aborted.
 *
 * A promise that simply never settles would be an unfaithful double — a real
 * `fetch` rejects when its signal fires — and it would hang the test rather than
 * failing it.
 */
export const unansweredCall = (turn: Turn): Promise<Response> =>
  new Promise((_resolve, reject) => {
    turn.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
  });

/**
 * A model whose every turn is a function of what it was actually sent.
 *
 * Running out of scripted turns IS the simulated process death: the driving
 * process stops answering, exactly as it would if it had been killed.
 */
export function scriptedModel(...turns: readonly ScriptedTurn[]): ScriptedModel {
  const seen: Turn[] = [];
  const fetchImpl: FetchDouble = async (_input, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const turn: Turn = { body, transcript: JSON.stringify(body.messages ?? []), signal: init?.signal };
    seen.push(turn);
    const next = turns[seen.length - 1];
    if (!next) throw new TypeError(`the driving process died before turn ${seen.length}`);
    return next(turn);
  };
  return { fetch: fetchImpl, turns: seen };
}

/**
 * The ratified OpenAI adapter over a scripted transport.
 *
 * The model NAME is settable because the drive reads settings per model now
 * (`src/lib/agent/models/`), and a fixture that could only ever be `gpt-4o-mini` could only
 * ever exercise the defaults — every override would be reachable in a resolver unit test and
 * nowhere in a run.
 */
export async function modelOver(
  fetchImpl: FetchDouble,
  apiUrl = "https://api.openai.com/v1",
  modelName = "gpt-4o-mini",
): Promise<AgentModel> {
  const config = { provider: "openai", apiKey: "sk-test", model: modelName, apiUrl } as const;
  return {
    provider: "openai",
    modelId: config.model,
    model: await resolveAgentProviderAdapter("openai").createModel(config, fetchImpl),
  };
}

// ─── script steps ───────────────────────────────────────────────────────────

export const callsTool =
  (name: string, input: unknown, callId = "call_1"): ScriptedTurn =>
  (): Response =>
    chatToolCallStream(name, JSON.stringify(input), callId);

export const answersProse =
  (...deltas: string[]): ScriptedTurn =>
  (): Response =>
    chatTextStream(...deltas);

/**
 * The correlation id of a read this run performed, taken from the transcript the
 * way a model would have to take it: `executeAuditedOperation` mints a plain UUID,
 * and it reaches the transcript either in a fenced result's header or in the
 * prior-progress summary a resumed run is given.
 */
export function correlationIdIn(transcript: string): string {
  const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(transcript);
  if (!match) throw new Error(`no artifact reference in the transcript: ${transcript.slice(0, 400)}`);
  return match[0];
}

/**
 * Every DISTINCT correlation id in the transcript, oldest first.
 *
 * Deduplicated here rather than at each call site (#350). One artifact now reaches
 * the model three times in one handover — in the fence header, in "Stored as
 * artifact …", and inside the citation object — so occurrences stopped being ids the
 * moment the handover text was added, and a caller that destructures `[before,
 * after]` would silently get one artifact twice. Both call sites already wanted a
 * set and wrapped this in `new Set`; making that the function's contract removes the
 * trap rather than leaving it for the next caller to step in.
 */
export function correlationIdsIn(transcript: string): string[] {
  return [
    ...new Set(
      [...transcript.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].map(
        (match) => match[0],
      ),
    ),
  ];
}

/** A report citing the FIRST result this run produced. */
export const reportOn =
  (claim = "The orders report scans the whole table."): ScriptedTurn =>
  (turn: Turn): Response =>
    chatToolCallStream(
      "compose_report",
      JSON.stringify({
        claims: [{ claim, evidence: [{ source: "artifact", correlationId: correlationIdIn(turn.transcript) }] }],
      }),
      "call_report",
    );

/**
 * The prompt as prose: every message's text, in order.
 *
 * `turn.transcript` is the messages JSON-encoded, so a JSON object embedded in a
 * message's text appears there escaped and cannot be lifted back out. This is what
 * the MODEL reads.
 */
export function promptText(turn: Turn): string {
  const messages = (turn.body.messages ?? []) as { content?: unknown }[];
  return messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
}

/**
 * Every evidence object the SERVER offered in this prompt, lifted verbatim (#350).
 *
 * The regex matches canonical JSON with no spaces, which is what `JSON.stringify`
 * produces in `tools.ts` — deliberately coupled, so a citation the server renders
 * some other way stops being found here rather than being silently tolerated.
 */
export function offeredCitationsIn(turn: Turn): unknown[] {
  return [...promptText(turn).matchAll(/\{"source":"[a-z-]+","[A-Za-z]+":"[^"]*"\}/g)]
    .map((match) => JSON.parse(match[0]) as { correlationId?: string; fingerprint?: string })
    .filter((citation) => !(citation.correlationId ?? citation.fingerprint ?? "").startsWith("<"));
}

/**
 * A report that cites ONLY what the prompt offered, copied exactly as offered.
 *
 * The regression guard for #350: it asks nothing of the model's understanding, only
 * that the object the server put in front of it is one the server will then accept.
 * If the description, the rules, the handover text and `evidenceSchema` ever drift
 * apart, this fixture composes a report the tool refuses.
 */
export const reportCitingWhatWasOffered =
  (claim: string): ScriptedTurn =>
  (turn: Turn): Response => {
    const evidence = offeredCitationsIn(turn);
    if (evidence.length === 0) throw new Error(`the prompt offered no citation: ${promptText(turn).slice(0, 600)}`);
    return chatToolCallStream("compose_report", JSON.stringify({ claims: [{ claim, evidence }] }), "call_report");
  };

/** A report citing EVERY result this run produced, which is what an empty-evidence fixture needs. */
export const reportOnAll =
  (claim: string): ScriptedTurn =>
  (turn: Turn): Response => {
    const ids = correlationIdsIn(turn.transcript);
    if (ids.length === 0) throw new Error(`no artifact reference in the transcript: ${turn.transcript.slice(0, 400)}`);
    return chatToolCallStream(
      "compose_report",
      JSON.stringify({
        claims: [{ claim, evidence: ids.map((correlationId) => ({ source: "artifact", correlationId })) }],
      }),
      "call_report",
    );
  };
