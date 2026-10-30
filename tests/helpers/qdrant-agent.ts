/**
 * The Qdrant agent boundary captures (tests/fixtures/qdrant/1.19.1/agent-boundary/, written by its run.sh): one file
 * per request a 1.19.1 server was sent raw, with the principal it was sent as and what the server answered.
 */
import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import type { NodeResponse } from "@/lib/db/http/node-transport";
import type { QdrantAnswer } from "@/lib/db/providers/vector/qdrant/client";
import type { RecordedAnswer } from "./qdrant-transport";

export const QDRANT_AGENT_CAPTURES = posix.join(
  import.meta.dir.replaceAll("\\", "/"),
  "..",
  "fixtures",
  "qdrant",
  "1.19.1",
  "agent-boundary",
);

export interface QdrantAgentCapture {
  readonly version: string;
  readonly name: string;
  readonly image: string;
  readonly capturedAt: string;
  readonly principal: string;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly auth: "api-key" | "none";
    readonly body?: unknown;
  };
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
  readonly egressRequests?: number;
}

/** One capture by its file name, without `.json`. */
export function agentCapture(name: string): QdrantAgentCapture {
  return JSON.parse(readFileSync(posix.join(QDRANT_AGENT_CAPTURES, `${name}.json`), "utf8")) as QdrantAgentCapture;
}

/** Every capture's file name, without `.json`. */
export function agentCaptureNames(): readonly string[] {
  return readdirSync(QDRANT_AGENT_CAPTURES)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

/** A capture's answer as it crosses the client seam. */
export function agentAnswer(name: string): QdrantAnswer {
  const capture = agentCapture(name);
  return { status: capture.status, contentType: capture.contentType, retryAfter: null, text: capture.body };
}

const asResponse = (answer: QdrantAnswer): NodeResponse => ({ ...answer });

/** A capture's request line as the recording transport names it: the method, the path and its query. */
const lineOf = (capture: QdrantAgentCapture): string => `${capture.request.method} ${capture.request.path}`;

/**
 * A recording transport's answers for `principal` (`read-only`, `full`, ...): each request is answered with the
 * capture of the same request line sent as that principal (`<name>-<principal>.json`); `overrides` answers a request
 * line otherwise. A line no capture holds throws by name.
 */
export function agentServer(
  principal: string,
  overrides: Readonly<Record<string, QdrantAnswer | (() => QdrantAnswer)>> = {},
): RecordedAnswer {
  const byLine = new Map<string, QdrantAnswer>();
  for (const name of agentCaptureNames()) {
    if (!name.endsWith(`-${principal}`)) continue;
    // A capture of another principal whose name ends the same way (`jwt-read` and `read`) is not this one's.
    const capture = agentCapture(name);
    if (!capture.principal.startsWith(`${principal}: `)) continue;
    byLine.set(lineOf(capture), agentAnswer(name));
  }
  return (_request, line) => {
    const override = overrides[line];
    if (override !== undefined) return asResponse(typeof override === "function" ? override() : override);
    const found = byLine.get(line);
    if (found === undefined) throw new Error(`no ${principal} capture answers ${line}`);
    return asResponse(found);
  };
}
