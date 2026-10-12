/**
 * Replay of the Firestore captures under tests/fixtures/firestore/: the integration test hands `replayTransport` to the
 * provider at its `createTransport` seam, and the end-to-end stub server answers its sockets with `replayAnswer`.
 *
 * Every transport the provider creates is recorded as a lane: its kind, its origin, the names of its connection
 * headers, the class of its `authorization` (`Bearer owner` verbatim, any other bearer value as `Bearer <token>`),
 * and whether it refuses link-local addresses. A request is matched per lane: the API and emulator lanes on the method,
 * the path, the query with its pairs sorted and the body; the token lane on the method, the path and `grant_type`,
 * because its form carries the assertion or the refresh token and is never recorded; the metadata lane on the method,
 * the path and the sorted query. One key recorded more than once answers in recorded order and then repeats its last
 * answer; a request nobody recorded answers a `text/plain` 404, so a replay never invents an answer.
 *
 * `recordingTransport` is the other half: it wraps a real transport factory and keeps each lane and exchange in the
 * shape a capture holds, for tests/live/firestore-evidence.ts. Nothing here imports a provider module at run time,
 * so the Playwright process can load it.
 */
import { readFileSync } from "node:fs";
import type { NodeRequest, NodeResponse, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import type { LaneKind } from "@/lib/db/providers/document/firestore/seams";

export type AuthorizationClass = "Bearer owner" | "Bearer <token>" | null;

export interface FirestoreLane {
  readonly lane: LaneKind;
  readonly origin: string;
  readonly headerNames: readonly string[];
  readonly authorization: AuthorizationClass;
  readonly refusesLinkLocal: boolean;
}

export interface RecordedRequest {
  readonly method: "GET" | "POST";
  /** The path and query, without the origin. */
  readonly path: string;
  /** Absent on the token lane, whose form is never recorded. */
  readonly body?: string;
  /** The token lane's `grant_type`. */
  readonly grantType?: string;
  /** The names of this request's own headers, sorted and lower-cased. */
  readonly headerNames?: readonly string[];
  readonly maxResponseBytes: number;
}

export interface RecordedResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly retryAfter: string | null;
  readonly text: string;
}

export interface FirestoreExchange {
  readonly lane: LaneKind;
  readonly request: RecordedRequest;
  readonly response: RecordedResponse;
}

export interface FirestoreCapture {
  readonly scenario: string;
  readonly lanes: readonly FirestoreLane[];
  readonly exchanges: readonly FirestoreExchange[];
}

export interface CaptureSink {
  readonly lanes: FirestoreLane[];
  readonly exchanges: FirestoreExchange[];
}

/** `FirestoreSeams["createTransport"]`, spelled out so this module needs no value import from the provider. */
export type CreateTransport = (options: NodeTransportOptions, lane: LaneKind) => NodeTransport;

export interface ReplayTransport {
  readonly createTransport: CreateTransport;
  readonly lanes: FirestoreLane[];
  readonly asked: string[];
  readonly missed: string[];
  readonly sent: { readonly lane: LaneKind; readonly request: NodeRequest }[];
}

/** The answer to a request nobody recorded. */
export const UNRECORDED_ANSWER: NodeResponse = Object.freeze({
  status: 404,
  contentType: "text/plain; charset=utf-8",
  retryAfter: null,
  text: "404 page not found\n",
});

export function authorizationClass(value: string | undefined): AuthorizationClass {
  if (value === undefined) return null;
  if (value === "Bearer owner") return "Bearer owner";
  if (value.startsWith("Bearer ")) return "Bearer <token>";
  throw new Error("the lane carries an authorization header that is not a bearer value");
}

const lowerKeys = (headers: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));

export function laneRecord(options: NodeTransportOptions, lane: LaneKind): FirestoreLane {
  const headers = lowerKeys(options.headers);
  return {
    lane,
    origin: `${options.origin.scheme}://${options.origin.host}:${options.origin.port}`,
    headerNames: Object.keys(headers).sort(),
    authorization: authorizationClass(headers.authorization),
    refusesLinkLocal: options.refusesLinkLocal === true,
  };
}

export function recordedRequest(lane: LaneKind, request: NodeRequest): RecordedRequest {
  const url = new URL(request.url);
  return {
    method: request.method,
    path: `${url.pathname}${url.search}`,
    ...(lane === "token" || request.body === undefined ? {} : { body: request.body }),
    ...(request.form?.grant_type === undefined ? {} : { grantType: request.form.grant_type }),
    ...(request.headers === undefined ? {} : { headerNames: Object.keys(lowerKeys(request.headers)).sort() }),
    maxResponseBytes: request.maxResponseBytes,
  };
}

/** The path with its query pairs sorted by name, then by value. */
function sortedPath(path: string): string {
  const at = path.indexOf("?");
  if (at === -1) return path;
  const pairs = [...new URLSearchParams(path.slice(at + 1))].sort(([a, x], [b, y]) =>
    a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1,
  );
  return `${path.slice(0, at)}?${new URLSearchParams(pairs).toString()}`;
}

export function replayKey(
  lane: LaneKind,
  request: Pick<RecordedRequest, "method" | "path" | "body" | "grantType">,
): string {
  switch (lane) {
    case "token":
      return `token ${request.method} ${request.path.split("?")[0]} grant_type=${request.grantType ?? ""}`;
    case "metadata":
      return `metadata ${request.method} ${sortedPath(request.path)}`;
    case "api":
    case "emulator": {
      const line = `${lane} ${request.method} ${sortedPath(request.path)}`;
      return request.method === "POST" && request.body !== undefined ? `${line} ${request.body}` : line;
    }
  }
}

export function replayAnswer(
  exchanges: readonly FirestoreExchange[],
): (lane: LaneKind, request: Pick<RecordedRequest, "method" | "path" | "body" | "grantType">) => NodeResponse {
  const queues = new Map<string, FirestoreExchange[]>();
  for (const exchange of exchanges) {
    const key = replayKey(exchange.lane, exchange.request);
    queues.set(key, [...(queues.get(key) ?? []), exchange]);
  }
  const served = new Map<string, number>();
  return (lane, request) => {
    const key = replayKey(lane, request);
    const queue = queues.get(key);
    if (queue === undefined) return UNRECORDED_ANSWER;
    const index = served.get(key) ?? 0;
    served.set(key, index + 1);
    return queue[Math.min(index, queue.length - 1)].response;
  };
}

/** A transport factory answering through `answer`, keeping the lanes, the keys asked and missed, and every request. */
function answeringTransport(
  answer: (lane: LaneKind, request: NodeRequest, options: NodeTransportOptions) => NodeResponse | Promise<NodeResponse>,
): ReplayTransport {
  const lanes: FirestoreLane[] = [];
  const asked: string[] = [];
  const missed: string[] = [];
  const sent: { lane: LaneKind; request: NodeRequest }[] = [];
  const createTransport: CreateTransport = (options, lane) => {
    lanes.push(laneRecord(options, lane));
    return {
      async request(request: NodeRequest) {
        const key = replayKey(lane, recordedRequest(lane, request));
        asked.push(key);
        sent.push({ lane, request });
        const response = await answer(lane, request, options);
        if (response === UNRECORDED_ANSWER) missed.push(key);
        return response;
      },
      close() {},
    };
  };
  return { createTransport, lanes, asked, missed, sent };
}

export function replayTransport(exchanges: readonly FirestoreExchange[]): ReplayTransport {
  const answer = replayAnswer(exchanges);
  return answeringTransport((lane, request) => answer(lane, recordedRequest(lane, request)));
}

export function scriptedTransport(
  answer: (lane: LaneKind, request: NodeRequest, options: NodeTransportOptions) => NodeResponse | Promise<NodeResponse>,
): ReplayTransport {
  return answeringTransport(answer);
}

export function recordingTransport(
  inner: (options: NodeTransportOptions) => NodeTransport,
  sink: CaptureSink,
): CreateTransport {
  return (options, lane) => {
    sink.lanes.push(laneRecord(options, lane));
    const transport = inner(options);
    return {
      async request(request: NodeRequest) {
        const response = await transport.request(request);
        sink.exchanges.push({
          lane,
          request: recordedRequest(lane, request),
          response: {
            status: response.status,
            contentType: response.contentType,
            retryAfter: response.retryAfter,
            text: response.text,
          },
        });
        return response;
      },
      close() {
        transport.close();
      },
    };
  };
}

export function readCapture(file: string): FirestoreCapture {
  return JSON.parse(readFileSync(file, "utf8")) as FirestoreCapture;
}

export function jsonAnswer(json: unknown, status = 200, retryAfter: string | null = null): NodeResponse {
  return { status, contentType: "application/json", retryAfter, text: JSON.stringify(json) };
}
