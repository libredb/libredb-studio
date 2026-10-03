/**
 * The Qdrant surface captures (vector-family spec 6.3, 6.8, 7.3): what the seeded `qdrant` service of
 * docker/qdrant/README.md answers to the reads only the provider's object surface and monitoring make. The list of
 * collections, and for every seeded collection its aliases, its snapshot list, its optimizations, its cluster
 * information and its payload sample, the scroll of 1,000 points without vectors that `describeObject` and the
 * Source send. The description of each collection, `GET /` and `GET /aliases` are tests/fixtures/vector/qdrant/'s,
 * captured from the same service and seed by tests/live/vector-evidence.ts, and this run stops when a description
 * no longer reports the point count that fixture records.
 *
 * Each capture calls one surface and records the image, its digest, the server version, the date and the runtime,
 * in the encoding tests/fixtures/vector/README.md describes. It reads over node:http and imports no provider code,
 * so the request each capture records is written here and tests/unit/db/qdrant/sample.test.ts holds the provider's
 * own request equal to it. The service has no key, so no credential is sent and none can be written. Every request
 * is a read: nothing is created, changed or recovered, and no snapshot is downloaded.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/):
 *   bun tests/live/qdrant-surface-evidence.ts
 * It replaces tests/fixtures/qdrant-surface/*.json whole, and writes nothing when any answer is not a 200.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { serialiseFixture } from "./vector-evidence-derive";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "tests/fixtures/qdrant-surface");
const DESCRIBED = path.join(ROOT, "tests/fixtures/vector/qdrant");
const ENDPOINT = { host: "127.0.0.1", port: 6333, container: "libredb-qdrant" };
const RUNTIME = typeof Bun === "undefined" ? `node ${process.versions.node}` : `bun ${Bun.version}`;
const REQUEST_TIMEOUT_MS = 30_000;
/** The collections docker/qdrant/seed.py creates, in the order `GET /collections` lists them. */
const SEEDED = ["docs", "edge_values", "empty_novec", "payload_spread", "plain", "scratch", "small_dtypes"];
/** The payload sample's size (spec 6.3). */
const SAMPLE_POINTS = 1000;

interface Answer {
  readonly status: number;
  readonly bodyBytes: number;
  readonly body: string;
}

interface Capture {
  readonly name: string;
  readonly surface: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: string;
}

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function requireHealthy(container: string): void {
  const state = docker([
    "inspect",
    "--format",
    "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
    container,
  ]);
  if (state !== "running healthy") {
    throw new Error(`${container} is "${state}", not "running healthy": bring it up as its README says; no retry`);
  }
}

function pinnedImage(container: string): { image: string; digest: string } {
  const configured = docker(["inspect", "--format", "{{.Config.Image}}", container]);
  const [image, digest] = configured.split("@");
  if (digest === undefined) throw new Error(`${container} runs ${configured}, which is not pinned by digest`);
  return { image, digest };
}

function send(method: string, requestPath: string, body: string | undefined): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: ENDPOINT.host, port: ENDPOINT.port, method, path: requestPath, headers, timeout: REQUEST_TIMEOUT_MS },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({ status: response.statusCode ?? 0, bodyBytes: bytes.length, body: bytes.toString("utf8") });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error(`${method} ${requestPath} answered nothing in 30 s`)));
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function resultOf(method: string, requestPath: string): Promise<unknown> {
  const answer = await send(method, requestPath, undefined);
  if (answer.status !== 200) throw new Error(`${method} ${requestPath} answered HTTP ${answer.status}`);
  return (JSON.parse(answer.body) as { readonly result?: unknown }).result;
}

/** The point count the committed description of a collection records. */
function describedPoints(collection: string): number {
  const file = path.join(DESCRIBED, `describe-${collection}.json`);
  const recorded = JSON.parse(readFileSync(file, "utf8")) as { readonly payload: { readonly body: string } };
  return (JSON.parse(recorded.payload.body) as { readonly result: { readonly points_count: number } }).result
    .points_count;
}

/**
 * The payload sample of a collection of `points` points: one scroll of 1,000 points with payloads and no vectors,
 * through slice 0 of ceil(points / 1,000), which is uniform over ids. A collection with no points is not sampled.
 */
function sampleBody(points: number): string | undefined {
  if (points === 0) return undefined;
  const total = Math.ceil(points / SAMPLE_POINTS);
  return `{"filter":{"must":[{"slice":{"index":0,"total":${total}}}]},"limit":${SAMPLE_POINTS},"with_payload":true,"with_vector":false}`;
}

function capturesOf(collection: string, points: number): Capture[] {
  const base = `/collections/${collection}`;
  const reads: Capture[] = [
    { name: `aliases-${collection}`, surface: `GET ${base}/aliases`, method: "GET", path: `${base}/aliases` },
    { name: `snapshots-${collection}`, surface: `GET ${base}/snapshots`, method: "GET", path: `${base}/snapshots` },
    {
      name: `optimizations-${collection}`,
      surface: `GET ${base}/optimizations`,
      method: "GET",
      path: `${base}/optimizations`,
    },
    { name: `cluster-${collection}`, surface: `GET ${base}/cluster`, method: "GET", path: `${base}/cluster` },
  ];
  const body = sampleBody(points);
  if (body !== undefined) {
    reads.push({
      name: `sample-${collection}`,
      surface: `points/scroll of ${collection}, the payload sample: ${SAMPLE_POINTS} points, no vectors`,
      method: "POST",
      path: `${base}/points/scroll`,
      body,
    });
  }
  return reads;
}

async function main(): Promise<void> {
  requireHealthy(ENDPOINT.container);
  const pinned = pinnedImage(ENDPOINT.container);
  const root = JSON.parse((await send("GET", "/", undefined)).body) as { readonly version?: unknown };
  if (typeof root.version !== "string") throw new Error("GET / reports no version: nothing written");

  const listed = (
    (await resultOf("GET", "/collections")) as { readonly collections: readonly { readonly name: string }[] }
  ).collections.map((entry) => entry.name);
  if (JSON.stringify([...listed].sort()) !== JSON.stringify(SEEDED)) {
    throw new Error(
      `GET /collections lists ${JSON.stringify(listed)}, not the seeded collections: reset and seed the service as docker/qdrant/README.md says; nothing written`,
    );
  }

  const captures: Capture[] = [
    { name: "collections", surface: "GET /collections", method: "GET", path: "/collections" },
  ];
  for (const collection of SEEDED) {
    // oxlint-disable-next-line no-await-in-loop -- one request at a time, in catalog order.
    const live = (await resultOf("GET", `/collections/${collection}`)) as { readonly points_count: number };
    const described = describedPoints(collection);
    if (live.points_count !== described) {
      throw new Error(
        `${collection} reports ${live.points_count} points and tests/fixtures/vector/qdrant/describe-${collection}.json records ${described}: reset and seed the service; nothing written`,
      );
    }
    captures.push(...capturesOf(collection, described));
  }

  const files = new Map<string, string>();
  for (const capture of captures) {
    const date = new Date().toISOString();
    // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each date says when it was answered.
    const answer = await send(capture.method, capture.path, capture.body);
    if (answer.status !== 200) {
      throw new Error(`${capture.name}: HTTP ${answer.status} ${answer.body.slice(0, 500)}; nothing written`);
    }
    files.set(
      `${capture.name}.json`,
      serialiseFixture({
        $captured: {
          engine: "qdrant",
          image: pinned.image,
          digest: pinned.digest,
          version: root.version,
          date,
          runtime: RUNTIME,
          surface: capture.surface,
          request: { method: capture.method, path: capture.path, headers: {}, body: capture.body ?? null },
        },
        outcome: "pass",
        payload: { status: answer.status, bodyBytes: answer.bodyBytes, body: answer.body },
      }),
    );
  }

  mkdirSync(OUT, { recursive: true });
  for (const file of readdirSync(OUT)) if (file.endsWith(".json")) rmSync(path.join(OUT, file));
  for (const [file, text] of files) writeFileSync(path.join(OUT, file), text);
  console.error(`wrote ${files.size} captures into ${path.relative(ROOT, OUT)}`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
