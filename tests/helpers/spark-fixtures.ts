/**
 * The recorded transport of the Spark integration replay: a SparkWireTransport that answers each call from the
 * captures of tests/fixtures/spark/<version>/, never from an invented answer. A call is matched by its RPC and its
 * request: the provider's request and each capture's both pass through the provider's own codec (requestDeserialize of
 * requestSerialize, SPARK_LOADER_OPTIONS), then the client-chosen ids are masked and the observed server id dropped on
 * both sides.
 *
 * The answer gets the request's own ids written into its echo fields, and one server-side session id per session, the
 * one BUILT step every case shares. A request no capture matches fails the call, naming the RPC and the request, and is
 * kept in `missed`: the provider swallows some failed calls, so the replay holds that list empty at the end of every
 * case. `served` lists the captures that answered, in order, and `sessions` the session id each of those requests
 * carried, which the match masks.
 */
import {
  sparkDefinition,
  type SparkWireChannel,
  type SparkWireTransport,
} from "@/lib/db/providers/sql/spark/grpc-client";
import type { SparkCaptureName } from "../live/spark-evidence-plan";
import { captureBytes, readSparkCapture, type SparkCapture, type SparkCaptureVersion } from "./spark-captures";

const SERVICE = "spark.connect.SparkConnectService";
const MASKS: Readonly<Record<string, string>> = {
  session_id: "<session>",
  operation_id: "<operation>",
  operation_tag: "<tag>",
};
/** The observed server id the provider sends once it has seen one, and the oneof name `oneofs: true` adds beside it. */
const DROPPED = new Set(["client_observed_server_side_session_id", "_client_observed_server_side_session_id"]);

interface Codec {
  requestSerialize(value: object): Buffer;
  requestDeserialize(bytes: Buffer): object;
  responseSerialize(value: object): Buffer;
}

function codec(rpc: string): Codec {
  return (sparkDefinition()[SERVICE] as unknown as Record<string, Codec>)[rpc];
}

/** A request as the provider's codec reads it back, as tests/live/spark-evidence.ts stores every captured request. */
function roundTrip(rpc: string, request: object): object {
  return codec(rpc).requestDeserialize(codec(rpc).requestSerialize(request));
}

/** A stored value with every {"$bytes": "<base64>"} as a Buffer. */
function withBuffers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withBuffers);
  if (typeof value !== "object" || value === null) return value;
  if ("$bytes" in value) return Buffer.from(captureBytes(value));
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, withBuffers(inner)]));
}

/** A value with the client-chosen ids replaced by the captures' placeholders and the observed server id dropped. */
function masked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(masked);
  if (typeof value !== "object" || value === null || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !DROPPED.has(key))
      .map(([key, inner]) => [
        key,
        key === "tags" && Array.isArray(inner) ? inner.map(() => "<tag>") : (MASKS[key] ?? masked(inner)),
      ]),
  );
}

/** The matching key of a request on either side: the codec's round trip, masked, as a stable text. */
function keyOf(rpc: string, request: object): string {
  return canonical(masked(roundTrip(rpc, request)));
}

/** A stable text of a decoded value, keys sorted, bytes as base64, for matching. */
function canonical(value: unknown): string {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return JSON.stringify({ $bytes: Buffer.from(value).toString("base64") });
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The captured answer with its $bytes as Buffers, its id placeholders as the request's own ids, and its
 * server-side session id as the one the replay's server keeps for the request's session (`serverId`).
 */
function answered(value: unknown, request: Record<string, unknown>, serverId: (captured: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => answered(item, request, serverId));
  if (typeof value === "object" && value !== null) {
    if ("$bytes" in value) return Buffer.from(captureBytes(value));
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        key === "server_side_session_id" && typeof inner === "string" && inner !== ""
          ? serverId(inner)
          : answered(inner, request, serverId),
      ]),
    );
  }
  if (value === "<session>") return request.session_id;
  if (value === "<operation>") return request.operation_id;
  if (value === "<tag>") return (request.tags as string[] | undefined)?.[0];
  return value;
}

/** A failed capture as the error grpc-js raises: code, details and the trailing metadata, binary values as Buffers. */
function failure(capture: Extract<SparkCapture, { outcome: "error" }>): Error {
  const entries = Object.entries(capture.metadata).map(
    ([key, value]) => [key, answered(value, {}, (captured) => captured)] as const,
  );
  const metadata = {
    get: (key: string) =>
      entries.filter(([name]) => name === key).flatMap(([, value]) => (Array.isArray(value) ? value : [value])),
    getMap: () => Object.fromEntries(entries),
  };
  return Object.assign(new Error(`${capture.code} ${capture.details}`), {
    code: capture.code,
    details: capture.details,
    metadata,
  });
}

export interface RecordedSparkTransport extends SparkWireTransport {
  /** The captures that answered, in order. */
  readonly served: readonly SparkCaptureName[];
  /**
   * The session id each request `served` lists carried, in the same order, as the provider chose it. The match masks
   * it, so this list is how a case tells which of the provider's sessions sent a request.
   */
  readonly sessions: readonly unknown[];
  /**
   * Every request no capture answered, as its RPC and its masked request, in order. A provider that swallows a failed
   * call, as it does a failed Interrupt or FetchErrorDetails, leaves the case green, so a case reads this list too.
   */
  readonly missed: readonly string[];
}

export function recordedSparkTransport(
  version: SparkCaptureVersion,
  names: readonly SparkCaptureName[],
  options: {
    /** Captures that answer one request each: the next request they match goes to the next capture that matches it. */
    readonly once?: readonly SparkCaptureName[];
  } = {},
): RecordedSparkTransport {
  const captures = names.map((name) => {
    const capture = readSparkCapture(version, name);
    const rpc = capture.$captured.rpc.slice("SparkConnectService/".length);
    return { name, capture, rpc, key: keyOf(rpc, withBuffers(capture.$captured.request) as object) };
  });
  const served: SparkCaptureName[] = [];
  const sessions: unknown[] = [];
  const missed: string[] = [];
  const spent = new Set<(typeof captures)[number]>();
  // Each capture comes from its own run, so each holds another server-side id; one server keeps one id per session
  // for the session's life, and the provider reads a changed id as a restarted server. The replay therefore answers
  // a session's every call with the first server-side id it served that session (BUILT, with the client ids).
  const serverIds = new Map<unknown, string>();
  const serverIdOf = (request: object) => (captured: string) => {
    const session = (request as Record<string, unknown>).session_id;
    const kept = serverIds.get(session) ?? captured;
    serverIds.set(session, kept);
    return kept;
  };
  const find = (rpc: string, request: object) => {
    const key = keyOf(rpc, request);
    const found = captures.find((candidate) => candidate.rpc === rpc && candidate.key === key && !spent.has(candidate));
    if (found === undefined) {
      missed.push(`${rpc} ${key}`);
      throw new Error(`No ${version} capture of [${names.join(", ")}] answers ${rpc} ${key}`);
    }
    if (options.once?.includes(found.name)) spent.add(found);
    served.push(found.name);
    sessions.push((request as Record<string, unknown>).session_id);
    return found.capture;
  };
  const transport: SparkWireTransport = () => {
    const channel: SparkWireChannel = {
      unary: async (rpc, request) => {
        const capture = find(rpc, request);
        if (capture.outcome === "error") throw failure(capture);
        return answered(capture.payload, request as Record<string, unknown>, serverIdOf(request)) as object;
      },
      executePlan: (request) => {
        let capture: SparkCapture;
        try {
          capture = find("ExecutePlan", request);
        } catch (error) {
          return { read: () => Promise.reject(error), receivedBytes: 0, truncated: false, cancel: () => undefined };
        }
        const responses =
          capture.outcome === "pass"
            ? (answered(capture.payload, request as Record<string, unknown>, serverIdOf(request)) as object[])
            : [];
        let next = 0;
        let received = 0;
        return {
          read: async () => {
            if (next < responses.length) {
              const response = responses[next++];
              received += codec("ExecutePlan").responseSerialize(response).byteLength;
              return response;
            }
            if (capture.outcome === "error") throw failure(capture);
            return undefined;
          },
          get receivedBytes() {
            return received;
          },
          truncated: false,
          cancel: () => undefined,
        };
      },
      close: () => undefined,
    };
    return channel;
  };
  return Object.assign(transport, { served, sessions, missed });
}
