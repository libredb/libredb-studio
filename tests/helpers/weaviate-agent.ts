/**
 * The Weaviate agent boundary captures (tests/fixtures/weaviate/1.40.2/agent-boundary/, written by its run.sh): one
 * file per request a 1.40.2 server was sent raw, with the principal it was sent as and what the server answered.
 */
import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import type { NodeResponse } from "@/lib/db/http/node-transport";
import type { WeaviateAnswer } from "@/lib/db/providers/vector/weaviate/client";
import type { RecordedAnswer } from "./weaviate-wire";

const DIRECTORY = posix.join(
  import.meta.dir.replaceAll("\\", "/"),
  "..",
  "fixtures",
  "weaviate",
  "1.40.2",
  "agent-boundary",
);

export interface WeaviateAgentCapture {
  readonly name: string;
  readonly principal: string;
  readonly request: { readonly method: string; readonly path: string; readonly body?: unknown };
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
  readonly egressRequests?: number;
}

/** One capture by its file name, without `.json`. */
export function agentCapture(name: string): WeaviateAgentCapture {
  return JSON.parse(readFileSync(posix.join(DIRECTORY, `${name}.json`), "utf8")) as WeaviateAgentCapture;
}

/** Every capture's file name, without `.json`. */
export function agentCaptureNames(): readonly string[] {
  return readdirSync(DIRECTORY)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length));
}

/** A capture's answer as it crosses the client seam. */
export function agentAnswer(name: string): WeaviateAnswer {
  const capture = agentCapture(name);
  return { status: capture.status, contentType: capture.contentType, retryAfter: null, text: capture.body };
}

const asResponse = (answer: WeaviateAnswer): NodeResponse => ({ ...answer });

/**
 * A recording transport's answers for `principal` (`viewer`, `root`, ...): each request is answered with the capture
 * of the same request line sent as that principal (`<op>-<principal>.json`), its own record with
 * `own-info-<principal>.json`; `overrides` answers a request line otherwise. A line no capture holds throws by name.
 */
export function agentServer(
  principal: string,
  overrides: Readonly<Record<string, WeaviateAnswer | (() => WeaviateAnswer)>> = {},
): RecordedAnswer {
  const byLine = new Map<string, WeaviateAnswer>();
  for (const name of agentCaptureNames()) {
    if (!name.endsWith(`-${principal}`)) continue;
    const capture = agentCapture(name);
    byLine.set(`${capture.request.method} ${capture.request.path}`, agentAnswer(name));
  }
  return (_request, line) => {
    const override = overrides[line];
    if (override !== undefined) return asResponse(typeof override === "function" ? override() : override);
    const found = byLine.get(line);
    if (found === undefined) throw new Error(`no ${principal} capture answers ${line}`);
    return asResponse(found);
  };
}

/** The definition of one collection, as `GET /v1/schema/{collection}` answers it, read out of the schema capture. */
export function agentCollectionAnswer(collection: string, principal = "viewer"): WeaviateAnswer {
  const schema = JSON.parse(agentCapture(`schema-${principal}`).body) as { classes: { class: string }[] };
  const found = schema.classes.find((entry) => entry.class === collection);
  if (found === undefined) throw new Error(`the schema capture holds no ${collection}`);
  return { status: 200, contentType: "application/json", retryAfter: null, text: JSON.stringify(found) };
}
