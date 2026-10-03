/**
 * The one reader of tests/fixtures/qdrant/ (vector-family spec 7.3): what Qdrant 1.19.1 answered over `node:http(s)`
 * before any provider code ran, one surface per file, captured by tests/live/qdrant-evidence.ts, and the extract of
 * the pinned OpenAPI document. A missing or malformed file fails the suite that reads it; nothing here falls back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeResponse } from "@/lib/db/http/node-transport";
import { type CaptureRecord, type FixtureRoute, qdrantCatalog } from "../live/qdrant-evidence-catalog";
import type { QdrantOpenApiExtract } from "../live/qdrant-openapi-extract";
import { QDRANT_ROUTE_FIXTURE } from "./qdrant-routes";
import type { RecordedAnswer } from "./qdrant-transport";

export const QDRANT_FIXTURES_DIR = join(import.meta.dir, "..", "fixtures", "qdrant");

/** Every capture the harness writes, as it lists them, by `<service>/<name>`. */
export const QDRANT_CAPTURE_SPECS = qdrantCatalog(QDRANT_ROUTE_FIXTURE.routes as readonly FixtureRoute[]);

/** Every capture as "<service>/<name>", sorted; the harness writes exactly these. */
export const QDRANT_FIXTURE_NAMES: readonly string[] = QDRANT_CAPTURE_SPECS.map(
  (spec) => `${spec.service}/${spec.name}`,
).sort();

export function qdrantCapture(name: string): CaptureRecord {
  if (!QDRANT_FIXTURE_NAMES.includes(name)) throw new Error(`${name} is not a capture the harness writes`);
  return JSON.parse(readFileSync(join(QDRANT_FIXTURES_DIR, `${name}.json`), "utf8")) as CaptureRecord;
}

/** A capture's answer as the shared transport hands one over. A capture that holds no HTTP answer throws. */
export function capturedAnswer(capture: CaptureRecord): NodeResponse {
  const { payload } = capture;
  if ("error" in payload) throw new Error(`${capture.$captured.surface} holds no HTTP answer`);
  return {
    status: payload.status,
    contentType: payload.contentType,
    retryAfter: payload.retryAfter,
    text: payload.body,
  };
}

export function qdrantOpenApiExtractFixture(): QdrantOpenApiExtract {
  return JSON.parse(readFileSync(join(QDRANT_FIXTURES_DIR, "openapi-extract.json"), "utf8")) as QdrantOpenApiExtract;
}

/**
 * What a recording transport answers from the captures of the 17 routes on the seeded collections: the answer the
 * open service gave to the same method and path. The query string is not compared, and neither is the body, so a
 * request with another body gets the captured request's answer. A request line no capture holds throws by name.
 */
export function replayQdrantRoutes(): RecordedAnswer {
  const byLine = new Map<string, NodeResponse>();
  for (const spec of QDRANT_CAPTURE_SPECS) {
    if (spec.group !== "routes") continue;
    const capture = qdrantCapture(`${spec.service}/${spec.name}`);
    byLine.set(`${capture.$captured.request.method} ${capture.$captured.request.path}`, capturedAnswer(capture));
  }
  return (_request, line) => {
    const answer = byLine.get(line.split("?")[0]);
    if (answer === undefined) throw new Error(`no capture answers ${line}`);
    return answer;
  };
}
