/**
 * The stand-in model endpoint of the out-of-tree acceptance's agent leg (scripts/out-of-tree-acceptance.ts): an
 * OpenAI-compatible chat completions endpoint, the shape Studio's `custom` model provider speaks, that answers each
 * request with the next prose of a script the leg wrote, and records every request it was asked.
 *
 * It runs in the acceptance's own process with Bun.serve on 127.0.0.1, on a port the system hands out, so the leg needs
 * no model credential and no network, and the server it drives reaches it on the loopback address alone. The step that
 * starts it stops it in its `finally`, once the server stopped, so it never outlives its step; an interrupted run exits
 * the process, which ends it. It holds no timer. A request body over `MAX_REQUEST_BYTES` is answered 413 by Bun itself
 * (`maxRequestBodySize`) before the handler reads it.
 *
 * Each prose is answered with the frames of `chatTextStream` in tests/isolated/fixtures/agent-transport.ts, the frames
 * the AI SDK's OpenAI-compatible provider parses, with this endpoint's model name in place of the fixture's: a script
 * imports no test file, so the frames are copied here, and tests/unit/scripts/out-of-tree-acceptance.test.ts holds the
 * copy equal to the original. A request the script does not answer (another path or method, a body that is not a JSON
 * object, or a request past the script's end) is answered with an error in the `{error: {message}}` shape the same
 * fixture's `endpointError` names, and recorded as unscripted, so `endpointRequestProblems` names it.
 */

/** The model name the endpoint answers as, and the one the server is configured with. */
export const STAND_IN_MODEL = "stand-in";
/** The one route the endpoint answers, under its base URL's `/v1`. */
export const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
/** The largest request body the endpoint reads; a larger one is answered 413 by Bun before the handler runs. */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/** One request the endpoint was asked: its method and path, whether it asked for a stream or offered tools, and whether the script answered it. */
export interface EndpointRequest {
  readonly method: string;
  readonly path: string;
  readonly stream: boolean;
  readonly offersTools: boolean;
  readonly scripted: boolean;
}

/** A started endpoint: its base URL (`http://127.0.0.1:<port>/v1`), the requests it recorded, in order, and its stop. */
export interface ModelEndpoint {
  readonly url: string;
  readonly requests: readonly EndpointRequest[];
  stop(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** One chat completion chunk, as agent-transport.ts's `chatChunk` writes it, answered as `model`. */
function chatChunk(
  delta: Record<string, unknown>,
  finishReason: string | null,
  model: string,
): Record<string, unknown> {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** The event stream answering `prose` as `model`: the frames of agent-transport.ts's `chatTextStream(prose)`. */
export function chatTextFrames(prose: string, model: string): string {
  const events: unknown[] = [
    chatChunk({ role: "assistant", content: "" }, null, model),
    chatChunk({ content: prose }, null, model),
    chatChunk({}, "stop", model),
    "[DONE]",
  ];
  return events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
}

/** An error answer in the shape agent-transport.ts's `endpointError` names. */
function errorAnswer(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `count` of `noun`, with an s past one. */
const counted = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Parses `text` as JSON, answering undefined for text that is not JSON. */
function parsedOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Starts the endpoint on 127.0.0.1, on a port the system hands out, answering the first chat completions request with
 * `script[0]`, the next with `script[1]`, and every request past the script's end with an error.
 */
export function startModelEndpoint(script: readonly string[]): ModelEndpoint {
  const requests: EndpointRequest[] = [];
  let answered = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: MAX_REQUEST_BYTES,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const body = parsedOrUndefined(await request.text());
      const record = (scripted: boolean): number =>
        requests.push({
          method: request.method,
          path: pathname,
          stream: isRecord(body) && body.stream === true,
          offersTools: isRecord(body) && body.tools !== undefined,
          scripted,
        });
      if (request.method !== "POST" || pathname !== CHAT_COMPLETIONS_PATH) {
        record(false);
        return errorAnswer(
          404,
          `The stand-in model endpoint answers only POST ${CHAT_COMPLETIONS_PATH}, not ${request.method}${pathname === CHAT_COMPLETIONS_PATH ? "" : ` ${pathname}`}.`,
        );
      }
      if (!isRecord(body)) {
        record(false);
        return errorAnswer(400, "The stand-in model endpoint takes a JSON object as a request's body.");
      }
      const prose = script[answered];
      if (prose === undefined) {
        const number = record(false);
        return errorAnswer(
          500,
          `The stand-in model endpoint's script of ${counted(script.length, "answer")} is spent: request ${number} has no answer.`,
        );
      }
      answered += 1;
      record(true);
      return new Response(chatTextFrames(prose, STAND_IN_MODEL), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}

/**
 * The problems with the requests the endpoint recorded, for a leg that scripted `scripted` answers: a request the
 * script did not answer, a count of requests other than the script's, a scripted request not streamed (Studio's agent
 * streams every turn), and one offering the model tools (a plan-mode run offers none).
 */
export function endpointRequestProblems(requests: readonly EndpointRequest[], scripted: number): string[] {
  const problems: string[] = [];
  requests.forEach((request, index) => {
    const number = index + 1;
    if (!request.scripted) {
      problems.push(`request ${number}, ${request.method} ${request.path}, is not one the script answers`);
      return;
    }
    if (!request.stream) problems.push(`request ${number} was not streamed`);
    if (request.offersTools)
      problems.push(`request ${number} offered the model tools, which a plan-mode run never does`);
  });
  if (requests.length !== scripted) {
    problems.push(
      `the model endpoint was asked ${counted(requests.length, "request")} for ${counted(scripted, "scripted answer")}`,
    );
  }
  return problems;
}
