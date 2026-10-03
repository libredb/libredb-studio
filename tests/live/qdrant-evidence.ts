/**
 * The Qdrant provider's evidence harness (vector-family spec 7.3, QE21). It captures what Qdrant 1.19.1 answers over
 * `node:http(s)`, with no provider import, from the `qdrant`, `qdrant-auth`, `qdrant-tls` and `qdrant-mtls` services
 * of docker/qdrant/README.md, and writes tests/fixtures/qdrant/<service>/<name>.json, the files
 * tests/live/qdrant-evidence-catalog.ts lists: the 17 routes on every seeded collection, the credential matrix,
 * the alias matrix, the timeout shapes, the strict-mode texts, the error rows, the filter answers and the TLS rows.
 *
 * Each capture calls one surface and records the image, its digest, the server version, the date and the runtime,
 * and a pass or the verbatim failure, the etcd and Kafka shape (tests/live/etcd-evidence.ts). An answer whose status
 * is not the one its capture declares stops the run before anything is written; nothing is retried, except a
 * capture that declares `attempts` because its shape depends on a timer race on the server.
 *
 * It reads the seeded collections and writes only what it owns: two collections under `qdrant_evidence_`, created
 * and removed by a setup client that `guardMutations` holds to that prefix. It sends no snapshot route and no PATCH.
 *
 * No key, token or JWT segment is written: the credential header is recorded as "<api-key>" or "<token>", and every
 * file is checked for every key and every JWT this run sent before anything is written. Every JWT is minted at run
 * time from the admin key and is never written anywhere.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/):
 *   bun tests/live/qdrant-evidence.ts --keys <dir> --report <file> [--only <group,...>]
 *   bun tests/live/qdrant-evidence.ts --openapi <openapi.json at tag v1.19.1>
 * <dir> is a copy of the keys volume (`docker cp libredb-qdrant-keys:/keys <dir>`) and <file> the run's report,
 * both outside the repository. The second form writes tests/fixtures/qdrant/openapi-extract.json from the pinned
 * OpenAPI document, which it refuses when its sha256 is not the pinned one.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";
import {
  assertNoSecret,
  CAPTURE_GROUPS,
  type CaptureGroup,
  type CapturePayload,
  type CaptureProvenance,
  captureProblem,
  captureRecord,
  type CaptureSpec,
  type CredentialName,
  type FixtureRoute,
  HARNESS_PREFIX,
  JWT_CLAIMS,
  mintJwt,
  QDRANT_SERVICES,
  type QdrantService,
  qdrantCatalog,
  RATE_COLLECTION,
  routeCaptures,
  STRICT_COLLECTION,
} from "./qdrant-evidence-catalog";
import { QDRANT_OPENAPI_SHA256, qdrantOpenApiExtract } from "./qdrant-openapi-extract";
import { guardMutations } from "./support/mutation-guard";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "tests/fixtures/qdrant");
const ROUTES = path.join(ROOT, "tests/fixtures/vector/routes/qdrant-v1.json");
const BY = "tests/live/qdrant-evidence.ts";
const RUNTIME = typeof Bun === "undefined" ? `node ${process.versions.node}` : `bun ${Bun.version}`;
const REQUEST_TIMEOUT_MS = 30_000;
/** Stand-ins, never realistic values: the key no server holds, and the secret the wrongly signed JWT is signed with. */
const TEST_PASSWORD = "password";
const TEST_PASSWORD_SECOND = "password-second";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} <value> is required`);
  return value;
}

// -- the servers --------------------------------------------------------------------------------------------------

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function pinnedImage(container: string): { readonly image: string; readonly digest: string } {
  const state = docker([
    "inspect",
    "--format",
    "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
    container,
  ]);
  if (state !== "running healthy") {
    throw new Error(`${container} is "${state}", not "running healthy": bring it up as docker/qdrant/README.md says`);
  }
  const configured = docker(["inspect", "--format", "{{.Config.Image}}", container]);
  const [image, digest] = configured.split("@");
  if (digest === undefined) throw new Error(`${container} runs ${configured}, which is not pinned by digest`);
  return { image, digest };
}

// -- the credentials ----------------------------------------------------------------------------------------------

interface Keys {
  readonly dir: string;
  readonly ca: string;
  readonly clientCert: string;
  readonly clientKey: string;
  /** The value each credential name stands for, per service that has keys. */
  readonly values: Readonly<Record<string, Readonly<Partial<Record<CredentialName, string>>>>>;
  /** Every key read and every JWT minted: none may appear in a written file. */
  readonly secrets: readonly string[];
}

function readKeys(dir: string): Keys {
  const read = (file: string) => readFileSync(path.join(dir, file), "utf8").trim();
  const keyed = (folder: string) => ({
    "admin-key": read(`${folder}/admin.key`),
    "read-only-key": read(`${folder}/read-only.key`),
  });
  const auth = keyed("auth");
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const jwts = Object.fromEntries(
    Object.entries(JWT_CLAIMS).map(([name, claims]) => [
      name,
      mintJwt({ exp: expires, ...claims }, name === "jwt-bad-signature" ? TEST_PASSWORD_SECOND : auth["admin-key"]),
    ]),
  );
  const tls = keyed("tls");
  const mtls = keyed("mtls");
  return {
    dir,
    ca: read("ca.pem"),
    clientCert: read("client.pem"),
    clientKey: read("client.key"),
    values: {
      qdrant: {},
      "qdrant-auth": { ...auth, ...jwts, "wrong-key": TEST_PASSWORD },
      "qdrant-tls": { ...tls, "wrong-key": TEST_PASSWORD },
      "qdrant-mtls": { ...mtls, "wrong-key": TEST_PASSWORD },
    },
    secrets: [...Object.values(auth), ...Object.values(tls), ...Object.values(mtls), ...Object.values(jwts)],
  };
}

// -- requests -----------------------------------------------------------------------------------------------------

interface Wire {
  readonly service: QdrantService;
  readonly method: string;
  readonly path: string;
  readonly body?: string;
  readonly secret?: string;
  readonly tls?: CaptureSpec["tls"];
}

function send(wire: Wire, keys: Keys): Promise<CapturePayload> {
  const service = QDRANT_SERVICES[wire.service];
  const secure = service.tls && wire.tls?.plaintext !== true;
  const tls = wire.tls ?? { host: "localhost", ca: true, clientCertificate: wire.service === "qdrant-mtls" };
  const headers: Record<string, string> = {};
  if (wire.secret !== undefined) headers["api-key"] = wire.secret;
  if (wire.body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(wire.body));
  }
  const options = {
    host: service.tls ? tls.host : "127.0.0.1",
    port: service.port,
    method: wire.method,
    path: wire.path,
    headers,
    timeout: REQUEST_TIMEOUT_MS,
    agent: false as const,
    ...(secure
      ? {
          ...(tls.ca ? { ca: keys.ca } : {}),
          ...(tls.clientCertificate ? { cert: keys.clientCert, key: keys.clientKey } : {}),
        }
      : {}),
  };
  return new Promise((resolve) => {
    const failed = (error: Error & { code?: string }) =>
      resolve({ error: { code: typeof error.code === "string" ? error.code : null, message: error.message } });
    const request = (secure ? https : http).request(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", failed);
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const retryAfter = response.headers["retry-after"];
        resolve({
          status: response.statusCode ?? 0,
          contentType: response.headers["content-type"] ?? null,
          retryAfter: retryAfter === undefined ? null : retryAfter,
          bodyBytes: bytes.length,
          body: bytes.toString("utf8"),
        });
      });
    });
    request.on("timeout", () => request.destroy(new Error(`${wire.method} ${wire.path} answered nothing in 30 s`)));
    request.on("error", failed);
    if (wire.body !== undefined) request.write(wire.body);
    request.end();
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function provenanceOf(service: QdrantService, keys: Keys): Promise<CaptureProvenance> {
  const pinned = pinnedImage(QDRANT_SERVICES[service].container);
  const root = await send({ service, method: "GET", path: "/" }, keys);
  if ("error" in root || root.status !== 200)
    throw new Error(`${service} did not answer GET /: ${JSON.stringify(root)}`);
  const version = (JSON.parse(root.body) as { version?: unknown }).version;
  if (typeof version !== "string") throw new Error(`${service} reported no version`);
  return { ...pinned, version };
}

// -- the harness's own collections ---------------------------------------------------------------------------------

/** The only client that writes: every mutation's target must start with HARNESS_PREFIX, or it throws before the wire. */
function setupClient(keys: Keys) {
  const call = async (method: string, requestPath: string, body?: string): Promise<CapturePayload> =>
    send({ service: "qdrant", method, path: requestPath, ...(body === undefined ? {} : { body }) }, keys);
  const expect = async (what: string, answer: Promise<CapturePayload>): Promise<void> => {
    const payload = await answer;
    if ("error" in payload || payload.status !== 200)
      throw new Error(`${what} failed: ${JSON.stringify(payload).slice(0, 400)}`);
  };
  return guardMutations(
    {
      async collectionExists(name: string): Promise<boolean> {
        const payload = await call("GET", `/collections/${name}/exists`);
        if ("error" in payload || payload.status !== 200)
          throw new Error(`exists ${name} failed: ${JSON.stringify(payload)}`);
        return (JSON.parse(payload.body) as { result: { exists: boolean } }).result.exists;
      },
      createCollection(name: string, body: string): Promise<void> {
        return expect(`create ${name}`, call("PUT", `/collections/${name}`, body));
      },
      upsertPoints(name: string, body: string): Promise<void> {
        return expect(`upsert into ${name}`, call("PUT", `/collections/${name}/points?wait=true`, body));
      },
      deleteCollection(name: string): Promise<void> {
        return expect(`delete ${name}`, call("DELETE", `/collections/${name}`));
      },
    },
    {
      prefix: HARNESS_PREFIX,
      reads: ["collectionExists"],
      mutating: ["createCollection", "upsertPoints", "deleteCollection"],
      targetsOf: (_method, args) => [String(args[0])],
    },
  );
}

const STRICT_CONFIG =
  '{"vectors":{"size":4,"distance":"Dot"},"strict_mode_config":{"enabled":true,"max_query_limit":5,"unindexed_filtering_retrieve":false,"search_allow_exact":false}}';
const RATE_CONFIG = '{"vectors":{"size":4,"distance":"Dot"},"strict_mode_config":{"enabled":true,"read_rate_limit":2}}';
const OWN_POINTS =
  '{"points":[{"id":1,"vector":[1.0,0.0,0.0,0.0],"payload":{"label":"a"}},{"id":2,"vector":[0.0,1.0,0.0,0.0],"payload":{"label":"b"}},{"id":3,"vector":[0.0,0.0,1.0,0.0],"payload":{"label":"c"}}]}';

async function removeOwn(setup: ReturnType<typeof setupClient>): Promise<void> {
  for (const name of [STRICT_COLLECTION, RATE_COLLECTION]) {
    // oxlint-disable-next-line no-await-in-loop -- one collection at a time.
    if (await setup.collectionExists(name)) await setup.deleteCollection(name);
  }
}

async function createOwn(setup: ReturnType<typeof setupClient>): Promise<void> {
  await removeOwn(setup);
  await setup.createCollection(STRICT_COLLECTION, STRICT_CONFIG);
  await setup.upsertPoints(STRICT_COLLECTION, OWN_POINTS);
  await setup.createCollection(RATE_COLLECTION, RATE_CONFIG);
  await setup.upsertPoints(RATE_COLLECTION, OWN_POINTS);
}

// -- the run ------------------------------------------------------------------------------------------------------

interface Captured {
  readonly spec: CaptureSpec;
  readonly payload: CapturePayload;
  readonly date: string;
  readonly attempts: number;
}

async function capture(spec: CaptureSpec, keys: Keys): Promise<Captured> {
  const secret = spec.credential === "none" ? undefined : keys.values[spec.service][spec.credential];
  if (spec.credential !== "none" && secret === undefined) {
    throw new Error(
      `${spec.service}/${spec.name} names the credential ${spec.credential}, which ${spec.service} does not have`,
    );
  }
  const wire: Wire = {
    service: spec.service,
    method: spec.method,
    path: spec.path,
    ...(spec.body === undefined ? {} : { body: spec.body }),
    ...(secret === undefined ? {} : { secret }),
    ...(spec.tls === undefined ? {} : { tls: spec.tls }),
  };
  const limit = spec.attempts ?? 1;
  for (let attempt = 1; ; attempt++) {
    const date = new Date().toISOString();
    // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each date says when it was answered.
    const payload = await send(wire, keys);
    if (attempt >= limit || captureProblem(spec, payload) === null) return { spec, payload, date, attempts: attempt };
    // A raced shape: give the server's work from the last attempt a moment to stop before asking again.
    // oxlint-disable-next-line no-await-in-loop -- the pause between two attempts.
    await sleep(1500);
  }
}

/** The JSON tokens of the first ids of a scroll answer: a bare integer with its exact digits, or a quoted UUID. */
function idTokens(body: string): string[] {
  const answer = JSON.parse(quoteUnsafeIntegers(body)) as { result?: { points?: { id: number | string }[] } };
  return (answer.result?.points ?? []).map(({ id }) =>
    typeof id === "number" || /^\d+$/.test(id) ? String(id) : JSON.stringify(id),
  );
}

interface RunReport {
  readonly runtime: string;
  readonly provenance: Readonly<Partial<Record<QdrantService, CaptureProvenance>>>;
  readonly groups: readonly CaptureGroup[];
  readonly written: readonly string[];
  readonly attempts: Readonly<Record<string, number>>;
}

async function captureRun(): Promise<number> {
  const keys = readKeys(argument("--keys"));
  const reportFile = argument("--report");
  const groups = process.argv.includes("--only")
    ? argument("--only")
        .split(",")
        .map((group) => {
          if (!CAPTURE_GROUPS.includes(group as CaptureGroup)) throw new Error(`--only names no group ${group}`);
          return group as CaptureGroup;
        })
    : CAPTURE_GROUPS;
  const routes = (JSON.parse(readFileSync(ROUTES, "utf8")) as { routes: FixtureRoute[] }).routes;
  const wanted = (spec: CaptureSpec) => groups.includes(spec.group);

  const services = [
    ...new Set(
      qdrantCatalog(routes)
        .filter(wanted)
        .map((spec) => spec.service),
    ),
  ];
  const provenance: Partial<Record<QdrantService, CaptureProvenance>> = {};
  for (const service of services) {
    // oxlint-disable-next-line no-await-in-loop -- one service at a time.
    provenance[service] = await provenanceOf(service, keys);
  }

  const captured: Captured[] = [];
  const ids: Record<string, string[]> = {};
  if (groups.includes("routes")) {
    // The scrolls go first: the ids the two retrieve routes ask for come from their answers.
    for (const spec of routeCaptures(routes).filter((entry) => entry.op === "scroll_points")) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time.
      const scrolled = await capture(spec, keys);
      captured.push(scrolled);
      const collection = spec.name.slice("scroll-points-".length);
      ids[collection] = "error" in scrolled.payload ? [] : idTokens(scrolled.payload.body);
    }
  }
  const setup = setupClient(keys);
  if (groups.includes("strict")) await createOwn(setup);
  try {
    for (const spec of qdrantCatalog(routes, ids).filter(wanted)) {
      if (captured.some((done) => done.spec.service === spec.service && done.spec.name === spec.name)) continue;
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in catalog order.
      const done = await capture(spec, keys);
      captured.push(done);
      console.error(`${"error" in done.payload ? "ERR" : done.payload.status} ${spec.service}/${spec.name}`);
      // A timed-out exact count keeps one core busy until it completes: let it finish before the next shape.
      // oxlint-disable-next-line no-await-in-loop -- the pause after a timeout shape.
      if (spec.group === "timeouts") await sleep(3000);
    }
  } finally {
    if (groups.includes("strict")) await removeOwn(setup);
  }

  const problems = captured.flatMap(({ spec, payload }) => captureProblem(spec, payload) ?? []);
  if (problems.length > 0) throw new Error(`Nothing written:\n${problems.join("\n")}`);

  const files = new Map<string, string>(
    captured.map(({ spec, payload, date, attempts }): [string, string] => [
      `${spec.service}/${spec.name}.json`,
      `${JSON.stringify(captureRecord(spec, provenance[spec.service] as CaptureProvenance, { date, runtime: RUNTIME, attempts }, payload), null, 2)}\n`,
    ]),
  );
  for (const [name, text] of files) assertNoSecret(name, text, keys.secrets);
  if (groups === CAPTURE_GROUPS) {
    for (const service of Object.keys(QDRANT_SERVICES))
      rmSync(path.join(OUT, service), { recursive: true, force: true });
  }
  for (const [name, text] of files) {
    const file = path.join(OUT, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const report: RunReport = {
    runtime: RUNTIME,
    provenance,
    groups,
    written: [...files.keys()].sort(),
    attempts: Object.fromEntries(
      captured
        .filter(({ spec }) => spec.attempts !== undefined)
        .map(({ spec, attempts }) => [`${spec.service}/${spec.name}`, attempts]),
    ),
  };
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`wrote ${files.size} captures under tests/fixtures/qdrant; 0 problems`);
  return 0;
}

function openApiRun(): number {
  const file = argument("--openapi");
  const text = readFileSync(file, "utf8");
  const found = createHash("sha256").update(text).digest("hex");
  if (found !== QDRANT_OPENAPI_SHA256) {
    throw new Error(`${file} has the sha256 ${found}, not the pinned ${QDRANT_OPENAPI_SHA256}: nothing written`);
  }
  const extract = qdrantOpenApiExtract(JSON.parse(text) as unknown, BY);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "openapi-extract.json"), `${JSON.stringify(extract, null, 2)}\n`);
  console.error(
    `wrote ${extract.operations.length} operations and ${Object.keys(extract.schemas).length} schemas to tests/fixtures/qdrant/openapi-extract.json`,
  );
  return 0;
}

async function main(): Promise<number> {
  if (process.argv.includes("--openapi")) return openApiRun();
  return captureRun();
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
