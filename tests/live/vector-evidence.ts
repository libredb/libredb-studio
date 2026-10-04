/**
 * The vector family's evidence harness (vector-family spec 7.3). It captures, over each engine's REST API and before
 * any vector provider client exists, what tests/fixtures/vector/README.md catalogs, from the `milvus` and `qdrant`
 * services of docker/milvus/README.md and docker/qdrant/README.md.
 *
 * Each capture calls one surface and records the image, its digest, the server version, the date and the runtime,
 * and a pass or the verbatim failure, the etcd and Kafka shape (tests/live/etcd-evidence.ts). Beside the captures it
 * writes each seed's manifest as the seed printed it, and what tests/live/vector-evidence-derive.ts derives from the
 * manifests: the expected VectorFieldInfo[] per collection, the expected cells in Studio's cell form, and the
 * expected non-finite scores. Every derived cell is compared with its REST cell as float32 where the two have the
 * same shape. An answer with an outcome its capture does not declare, a claim a capture states that the answer does
 * not hold, or a derived cell that differs from REST stops the run before anything is written.
 *
 * No password, key or token is written: the Milvus request header is recorded as "<token>", and every file is
 * checked for each form of the credential this run sends before anything is written.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/):
 *   bun tests/live/vector-evidence.ts --report <file>             capture both engines and write the fixtures
 *   bun tests/live/vector-evidence.ts --engine <engine> --report <file>
 *                                                                 capture one engine and write its fixtures alone
 *   bun tests/live/vector-evidence.ts --readme --report <file>    render tests/fixtures/vector/README.md
 * <file> is outside the repository. A one-engine run replaces that engine's directory and its entry of
 * expected-scores.json, and keeps the other engine's files, its entry and its README lines as they are.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";
import {
  compareCell,
  type ExpectedCell,
  expectedMilvusCells,
  expectedMilvusFields,
  expectedQdrantCells,
  expectedQdrantFields,
  type MilvusManifest,
  manifestProvenance,
  milvusNonFiniteScore,
  type QdrantHnswConfig,
  type QdrantManifest,
  serialiseFixture,
} from "./vector-evidence-derive";

type Engine = "milvus" | "qdrant";
type Outcome = "pass" | "fail" | "empty-body";

const ENGINES: readonly Engine[] = ["milvus", "qdrant"];
const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "tests/fixtures/vector");
const COMPOSE = ["compose", "-p", "libredb-studio", "-f", path.join(ROOT, "database-compose.yml")];
const ENDPOINTS: Readonly<
  Record<Engine, { readonly host: string; readonly port: number; readonly container: string }>
> = {
  milvus: { host: "127.0.0.1", port: 19530, container: "libredb-milvus" },
  qdrant: { host: "127.0.0.1", port: 6333, container: "libredb-qdrant" },
};
const SEED_ARGS: Readonly<Record<Engine, readonly string[]>> = {
  milvus: ["milvus-seed", "--uri", "http://milvus:19530", "--manifest"],
  qdrant: ["qdrant-seed", "--url", "http://qdrant:6333", "--manifest"],
};
/** Milvus's documented default root credential: the server's built-in default, which the fixture keeps (spec 7). */
const MILVUS_ROOT_TOKEN = "root:Milvus";
/** Every form of the credential this run sends; none may appear in a written file. */
const SECRET_FORMS = [MILVUS_ROOT_TOKEN, Buffer.from(MILVUS_ROOT_TOKEN).toString("base64")];
const RUNTIME = typeof Bun === "undefined" ? `node ${process.versions.node}` : `bun ${Bun.version}`;
const REQUEST_TIMEOUT_MS = 30_000;
const DERIVED = { by: "tests/live/vector-evidence-derive.ts", from: "manifest.json" };

const parse = (text: string): unknown => JSON.parse(quoteUnsafeIntegers(text));

// -- the servers --------------------------------------------------------------------------------------------------

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
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

interface Provenance {
  readonly image: string;
  readonly digest: string;
  readonly version: string;
}

function pinnedImage(container: string): { image: string; digest: string } {
  const configured = docker(["inspect", "--format", "{{.Config.Image}}", container]);
  const [image, digest] = configured.split("@");
  if (digest === undefined) throw new Error(`${container} runs ${configured}, which is not pinned by digest`);
  return { image, digest };
}

/**
 * The seed's manifest, printed by its one-shot run with --manifest, which records the server's pinned image, its
 * digest and the date beside what the seed inserted; pip's output goes to stderr.
 */
function seedManifest(engine: Engine, pinned: { image: string; digest: string }): string {
  const image = `${pinned.image}@${pinned.digest}`;
  return `${docker([...COMPOSE, "run", "--rm", "--no-deps", "-T", ...SEED_ARGS[engine], "--image", image])}\n`;
}

// -- requests -----------------------------------------------------------------------------------------------------

interface Answer {
  readonly status: number;
  readonly bodyBytes: number;
  readonly body: string;
}

function send(engine: Engine, method: string, requestPath: string, body: string | undefined): Promise<Answer> {
  const { host, port } = ENDPOINTS[engine];
  const headers: Record<string, string> = {};
  if (engine === "milvus") headers.authorization = `Bearer ${MILVUS_ROOT_TOKEN}`;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host, port, method, path: requestPath, headers, timeout: REQUEST_TIMEOUT_MS },
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

/** Qdrant reads a two-row array of integers as a sparse pair, so every vector number is written as a double. */
const INTEGER_KEYS = new Set(["limit", "has_id", "indices", "ids"]);

function qdrantJson(value: unknown, integer = false): string {
  if (typeof value === "number") {
    return integer || !Number.isInteger(value) || Math.abs(value) >= 1e21 ? JSON.stringify(value) : `${value}.0`;
  }
  if (Array.isArray(value)) return `[${value.map((item) => qdrantJson(item, integer)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(
      ([key, item]) => `${JSON.stringify(key)}:${qdrantJson(item, integer || INTEGER_KEYS.has(key))}`,
    );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

// -- the captures -------------------------------------------------------------------------------------------------

interface Capture {
  readonly engine: Engine;
  /** The file under tests/fixtures/vector/<engine>/, without .json. */
  readonly name: string;
  readonly surface: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: string;
  readonly expect: Outcome;
  /** A measured claim the answer must hold: null when it holds, else why not. */
  readonly check?: (answer: unknown) => string | null;
}

function outcomeOf(engine: Engine, answer: Answer): Outcome {
  if (answer.status !== 200) return "fail";
  if (answer.bodyBytes === 0) return "empty-body";
  const parsed = parse(answer.body) as { code?: unknown; status?: unknown; version?: unknown };
  // Qdrant's root answers its version with no status; every other Qdrant answer carries "status": "ok".
  const passed = engine === "milvus" ? parsed.code === 0 : parsed.status === "ok" || typeof parsed.version === "string";
  return passed ? "pass" : "fail";
}

function milvusPost(name: string, surface: string, route: string, body: object, extra: Partial<Capture> = {}): Capture {
  return {
    engine: "milvus",
    name,
    surface,
    method: "POST",
    path: `/v2/vectordb/${route}`,
    body: JSON.stringify(body),
    expect: "pass",
    ...extra,
  };
}

function milvusValues(manifest: MilvusManifest, collection: string, key: string | number): Record<string, unknown> {
  const row = manifest.databases.default?.[collection]?.sample.find((entry) => (entry.key ?? entry.seq) === key);
  if (row === undefined) throw new Error(`the Milvus manifest has no sample row ${key} of ${collection}`);
  return row.values;
}

/** A struct array's elements as the embedding list of one vector subfield. */
function embeddingListOf(elements: unknown, subfield: string): unknown[] {
  if (!Array.isArray(elements)) throw new Error(`the manifest holds no struct array with ${subfield}`);
  return elements.map((element) => (element as Record<string, unknown>)[subfield]);
}

const firstHit = (answer: unknown): Record<string, unknown> | undefined =>
  ((answer as { data?: Record<string, unknown>[] }).data ?? [])[0];

function milvusCaptures(manifest: MilvusManifest): Capture[] {
  const describe = Object.entries(manifest.databases).flatMap(([database, collections]) =>
    Object.keys(collections)
      .sort()
      .map((name) =>
        milvusPost(
          `describe-${database}-${name}`,
          `collections/describe of ${database}.${name}`,
          "collections/describe",
          {
            dbName: database,
            collectionName: name,
          },
        ),
      ),
  );
  const varchar = milvusValues(manifest, "docs_varchar", "vc-0000");
  const search = (
    name: string,
    surface: string,
    collectionName: string,
    annsField: string,
    data: unknown,
    outputField: string,
  ) =>
    milvusPost(name, surface, "entities/search", {
      collectionName,
      annsField,
      data: [data],
      outputFields: [outputField],
      limit: 3,
    });
  return [
    ...describe,
    milvusPost("query-docs_int64", "entities/query of docs_int64 seq 0 to 4 with vec", "entities/query", {
      collectionName: "docs_int64",
      filter: "seq < 5",
      outputFields: ["seq", "vec"],
      limit: 5,
    }),
    milvusPost(
      "query-docs_varchar",
      "entities/query of docs_varchar vc-0000 to vc-0004 with every vector field",
      "entities/query",
      {
        collectionName: "docs_varchar",
        filter: 'pk in ["vc-0000", "vc-0001", "vc-0002", "vc-0003", "vc-0004"]',
        outputFields: ["pk", "f16", "bf16", "bin", "sparse", "i8"],
        limit: 5,
      },
    ),
    milvusPost(
      "query-edge_values",
      "entities/query of every edge_values row with every vector field",
      "entities/query",
      {
        collectionName: "edge_values",
        filter: "id >= 1",
        outputFields: ["id", "label", "f32", "f16", "bf16", "bin", "i8", "sp"],
        limit: 10,
      },
    ),
    search(
      "search-cosine",
      "entities/search, COSINE, docs_int64.vec, the vector of seq 0",
      "docs_int64",
      "vec",
      milvusValues(manifest, "docs_int64", 0).vec,
      "seq",
    ),
    search(
      "search-l2-float16",
      "entities/search, L2, docs_varchar.f16, the vector of vc-0000",
      "docs_varchar",
      "f16",
      varchar.f16,
      "pk",
    ),
    search(
      "search-ip-bfloat16",
      "entities/search, IP, docs_varchar.bf16, the vector of vc-0000",
      "docs_varchar",
      "bf16",
      varchar.bf16,
      "pk",
    ),
    search(
      "search-hamming-binary",
      "entities/search, HAMMING, docs_varchar.bin, the bytes of vc-0000",
      "docs_varchar",
      "bin",
      varchar.bin,
      "pk",
    ),
    search(
      "search-l2-int8",
      "entities/search, L2, docs_varchar.i8, the vector of vc-0000",
      "docs_varchar",
      "i8",
      varchar.i8,
      "pk",
    ),
    search(
      "search-ip-sparse",
      "entities/search, IP, docs_varchar.sparse, the vector of vc-0000",
      "docs_varchar",
      "sparse",
      varchar.sparse,
      "pk",
    ),
    search(
      "search-bm25",
      "entities/search, BM25, fts.text_sparse, the text vector index",
      "fts",
      "text_sparse",
      "vector index",
      "id",
    ),
    milvusPost(
      "search-l2-origin",
      "entities/search, L2, edge_values.f32, (3,4) of the metric-probe row against the origin",
      "entities/search",
      {
        collectionName: "edge_values",
        annsField: "f32",
        data: [[0, 0, 0, 0]],
        filter: "id == 5",
        outputFields: ["id"],
        limit: 1,
      },
      {
        check: (answer) =>
          firstHit(answer)?.distance === 25 ? null : `answered ${JSON.stringify(firstHit(answer))}, not distance 25`,
      },
    ),
    milvusPost(
      "query-emb_list",
      "entities/query of every emb_list row with vec and its embedding list",
      "entities/query",
      {
        collectionName: "emb_list",
        filter: "id >= 1",
        outputFields: ["id", "vec", "chunks"],
        limit: 10,
      },
    ),
    milvusPost(
      "search-max-sim",
      "entities/search, MAX_SIM_COSINE, emb_list.chunks[emb], the embedding list of id 3",
      "entities/search",
      {
        collectionName: "emb_list",
        annsField: "chunks[emb]",
        data: [embeddingListOf(milvusValues(manifest, "emb_list", 3).chunks, "emb")],
        outputFields: ["id"],
        limit: 3,
      },
      {
        check: (answer) =>
          String(firstHit(answer)?.id) === "3" ? null : `answered ${JSON.stringify(firstHit(answer))}, not id 3 first`,
      },
    ),
    milvusPost(
      "search-non-finite",
      "entities/search, IP, edge_values.sp, the self-search of the 3.4e38 row",
      "entities/search",
      {
        collectionName: "edge_values",
        annsField: "sp",
        data: [milvusValues(manifest, "edge_values", 3).sp],
        filter: "id == 3",
        outputFields: ["id"],
        limit: 1,
      },
      { expect: "empty-body" },
    ),
  ];
}

function qdrantRequest(
  name: string,
  surface: string,
  method: "GET" | "POST",
  requestPath: string,
  body?: unknown,
  extra: Partial<Capture> = {},
): Capture {
  return {
    engine: "qdrant",
    name,
    surface,
    method,
    path: requestPath,
    ...(body === undefined ? {} : { body: qdrantJson(body) }),
    expect: "pass",
    ...extra,
  };
}

function qdrantVectors(manifest: QdrantManifest, collection: string, id: number): Readonly<Record<string, unknown>> {
  const point = manifest.collections[collection]?.sample.find((entry) => String(entry.id) === String(id));
  if (point === undefined) throw new Error(`the Qdrant manifest has no sample point ${id} of ${collection}`);
  return point.vectors;
}

const firstPoint = (answer: unknown): Record<string, unknown> | undefined =>
  ((answer as { result?: { points?: Record<string, unknown>[] } }).result?.points ?? [])[0];

function qdrantCaptures(manifest: QdrantManifest): Capture[] {
  const docs = qdrantVectors(manifest, "docs", 0);
  const query = (name: string, surface: string, collection: string, body: object, extra: Partial<Capture> = {}) =>
    qdrantRequest(name, surface, "POST", `/collections/${collection}/points/query`, body, extra);
  const retrieve = (collection: string, ids: readonly number[]) =>
    qdrantRequest(
      `retrieve-${collection}`,
      `POST /collections/${collection}/points, ids ${ids.join(", ")}, with every vector`,
      "POST",
      `/collections/${collection}/points`,
      { ids, with_payload: true, with_vector: true },
    );
  return [
    qdrantRequest("root", "GET /, the server's version", "GET", "/"),
    qdrantRequest("aliases", "GET /aliases", "GET", "/aliases"),
    ...Object.keys(manifest.collections)
      .sort()
      .map((name) => qdrantRequest(`describe-${name}`, `GET /collections/${name}`, "GET", `/collections/${name}`)),
    qdrantRequest(
      "scroll-docs",
      "points/scroll of docs seq 0 to 4 with every vector",
      "POST",
      "/collections/docs/points/scroll",
      {
        filter: { must: [{ key: "seq", range: { lt: 5 } }] },
        limit: 5,
        with_payload: ["seq"],
        with_vector: true,
      },
    ),
    retrieve("small_dtypes", [0, 1, 2, 3, 4]),
    retrieve("plain", [1, 2, 3, 4, 5]),
    retrieve("edge_values", [1, 2, 3]),
    query("search-cosine", "points/query, Cosine, docs.text, the dense probe vector", "docs", {
      query: Array.from({ length: 384 }, () => Math.fround(1 / Math.sqrt(384))),
      using: "text",
      limit: 3,
      with_payload: ["seq"],
    }),
    query("search-euclid", "points/query, Euclid, docs.image, the vector of id 0", "docs", {
      query: docs.image,
      using: "image",
      limit: 3,
      with_payload: ["seq"],
    }),
    query("search-dot", "points/query, Dot, plain, the vector of id 1", "plain", {
      query: qdrantVectors(manifest, "plain", 1)[""],
      limit: 3,
    }),
    query("search-manhattan", "points/query, Manhattan, small_dtypes.manhattan, the vector of id 0", "small_dtypes", {
      query: qdrantVectors(manifest, "small_dtypes", 0).manhattan,
      using: "manhattan",
      limit: 3,
    }),
    query("search-multivector", "points/query, Dot max_sim, docs.colbert, the multivector of id 0", "docs", {
      query: docs.colbert,
      using: "colbert",
      limit: 3,
      with_payload: ["seq"],
    }),
    query("search-sparse", "points/query, sparse, docs.keywords, the sparse vector of id 0", "docs", {
      query: docs.keywords,
      using: "keywords",
      limit: 3,
      with_payload: ["seq"],
    }),
    query(
      "search-euclid-origin",
      "points/query, Euclid, edge_values.f32, (3,4) of the metric-probe point against the origin",
      "edge_values",
      { query: [0, 0, 0, 0], using: "f32", filter: { must: [{ has_id: [3] }] }, limit: 1 },
      {
        check: (answer) =>
          firstPoint(answer)?.score === 5 ? null : `answered ${JSON.stringify(firstPoint(answer))}, not score 5`,
      },
    ),
    query(
      "search-non-finite",
      "points/query, sparse, edge_values.sp, the self-search of the 3.4e38 point",
      "edge_values",
      { query: { indices: [7], values: [3.4e38] }, using: "sp", filter: { must: [{ has_id: [2] }] }, limit: 1 },
      {
        check: (answer) =>
          firstPoint(answer)?.score === null
            ? null
            : `answered ${JSON.stringify(firstPoint(answer))}, not the score null`,
      },
    ),
  ];
}

// -- the run ------------------------------------------------------------------------------------------------------

interface Recorded {
  readonly capture: Capture;
  readonly answer: Answer;
  readonly outcome: Outcome;
  readonly date: string;
}

async function runCaptures(captures: readonly Capture[]): Promise<Recorded[]> {
  const recorded: Recorded[] = [];
  for (const capture of captures) {
    const date = new Date().toISOString();
    // oxlint-disable-next-line no-await-in-loop -- one request at a time, in catalog order, so each date says when it was answered.
    const answer = await send(capture.engine, capture.method, capture.path, capture.body);
    recorded.push({ capture, answer, outcome: outcomeOf(capture.engine, answer), date });
  }
  return recorded;
}

function problemsOf(recorded: readonly Recorded[]): string[] {
  return recorded.flatMap(({ capture, answer, outcome }) => {
    const where = `${capture.engine}/${capture.name}`;
    if (outcome !== capture.expect) {
      return [
        `${where}: expected ${capture.expect}, got ${outcome}: HTTP ${answer.status} ${answer.body.slice(0, 500)}`,
      ];
    }
    const why = outcome === "pass" && capture.check !== undefined ? capture.check(parse(answer.body)) : null;
    return why === null ? [] : [`${where}: ${why}`];
  });
}

function record(entry: Recorded, provenance: Provenance): object {
  const { capture, answer } = entry;
  return {
    $captured: {
      engine: capture.engine,
      image: provenance.image,
      digest: provenance.digest,
      version: provenance.version,
      date: entry.date,
      runtime: RUNTIME,
      surface: capture.surface,
      request: {
        method: capture.method,
        path: capture.path,
        headers: capture.engine === "milvus" ? { authorization: "<token>" } : {},
        body: capture.body ?? null,
      },
    },
    outcome: entry.outcome,
    payload: { status: answer.status, bodyBytes: answer.bodyBytes, body: answer.body },
  };
}

/** Where each engine's REST rows live in the captures, by the collection the expected cells name. */
const ROW_CAPTURES: Readonly<Record<Engine, Readonly<Record<string, string>>>> = {
  milvus: {
    "query-docs_int64": "default/docs_int64",
    "query-docs_varchar": "default/docs_varchar",
    "query-edge_values": "default/edge_values",
    "query-emb_list": "default/emb_list",
  },
  qdrant: {
    "scroll-docs": "docs",
    "retrieve-small_dtypes": "small_dtypes",
    "retrieve-plain": "plain",
    "retrieve-edge_values": "edge_values",
  },
};

function restRows(engine: Engine, recorded: readonly Recorded[]): Map<string, Record<string, unknown>[]> {
  const rows = new Map<string, Record<string, unknown>[]>();
  for (const entry of recorded) {
    const collection = ROW_CAPTURES[engine][entry.capture.name];
    if (entry.capture.engine !== engine || collection === undefined) continue;
    const answer = parse(entry.answer.body) as { data?: unknown; result?: unknown };
    const result = engine === "milvus" ? answer.data : answer.result;
    const list = Array.isArray(result) ? result : (result as { points?: unknown[] } | undefined)?.points;
    rows.set(collection, (list ?? []) as Record<string, unknown>[]);
  }
  return rows;
}

function restCell(engine: Engine, row: Record<string, unknown>, field: string): unknown {
  if (engine === "milvus") {
    // An embedding list, `<field>[<subfield>]`: REST answers the struct array as its elements.
    const subfield = /^(.+)\[(.+)\]$/.exec(field);
    if (subfield === null) return row[field];
    const elements = row[subfield[1]];
    return Array.isArray(elements)
      ? elements.map((element) => (element as Record<string, unknown>)[subfield[2]])
      : elements;
  }
  const vector = row.vector;
  if (field === "" && Array.isArray(vector)) return vector;
  return (vector as Record<string, unknown> | undefined)?.[field] ?? null;
}

interface CrossCheck {
  readonly equal: number;
  readonly notComparable: readonly string[];
  readonly differs: readonly string[];
  readonly uncaptured: number;
}

function crossCheck(engine: Engine, cells: readonly ExpectedCell[], recorded: readonly Recorded[]): CrossCheck {
  const rows = restRows(engine, recorded);
  let equal = 0;
  let uncaptured = 0;
  const notComparable: string[] = [];
  const differs: string[] = [];
  for (const cell of cells) {
    const candidates = rows.get(cell.collection);
    if (candidates === undefined) {
      uncaptured++;
      continue;
    }
    const where = `${cell.collection} ${cell.match.field} ${String(cell.match.value)} ${cell.field}`;
    const row = candidates.find((entry) => String(entry[cell.match.field]) === String(cell.match.value));
    if (row === undefined) {
      differs.push(`${where}: no REST row`);
      continue;
    }
    const compared = compareCell(cell.cell, restCell(engine, row, cell.field));
    if (compared.status === "equal") equal++;
    else if (compared.status === "not-comparable") notComparable.push(`${where}: ${compared.detail}`);
    else differs.push(`${where}: ${compared.detail}`);
  }
  return { equal, notComparable, differs, uncaptured };
}

/**
 * The Qdrant seed's manifest states no HNSW settings, so the derivation takes Qdrant's default `m` for every vector.
 * This reads each collection's and each vector's `hnsw_config` from its describe capture and derives the
 * expected fields again with them: any field whose index kind changes names a collection that does not hold the
 * default, and stops the run.
 */
function hnswDifferences(manifest: QdrantManifest, recorded: readonly Recorded[]): string[] {
  type Described = { result: { config: { hnsw_config: QdrantHnswConfig; params: { vectors?: unknown } } } };
  const collections = Object.fromEntries(
    Object.entries(manifest.collections).map(([name, collection]) => {
      const entry = recorded.find((r) => r.capture.engine === "qdrant" && r.capture.name === `describe-${name}`);
      if (entry === undefined) throw new Error(`no describe capture of the Qdrant collection ${name}`);
      const { hnsw_config, params } = (parse(entry.answer.body) as Described).result.config;
      const named = (params.vectors ?? {}) as Record<string, { hnsw_config?: QdrantHnswConfig }>;
      const vectors = collection.vectors.map((vector) => {
        // An unnamed vector's settings sit on params.vectors itself, a named vector's under its name.
        const own = (vector.name === "" ? (named as { hnsw_config?: QdrantHnswConfig }) : named[vector.name])
          ?.hnsw_config;
        return own === undefined ? vector : { ...vector, hnsw_config: own };
      });
      return [name, { ...collection, hnsw_config, vectors }];
    }),
  );
  const derived = expectedQdrantFields(manifest);
  const described = expectedQdrantFields({ ...manifest, collections });
  return Object.entries(derived).flatMap(([name, fields]) =>
    fields.flatMap((field, index) =>
      field.indexKind === described[name]?.[index]?.indexKind
        ? []
        : [
            `${name}.${field.name}: derived ${field.indexKind}, the described hnsw_config gives ${described[name]?.[index]?.indexKind}`,
          ],
    ),
  );
}

function assertNoSecret(name: string, text: string): void {
  for (const form of SECRET_FORMS) {
    if (text.includes(form)) throw new Error(`${name} would hold the credential this run sends: nothing written`);
  }
  if (/\\?"Milvus\\?"/.test(text))
    throw new Error(`${name} would hold the default password as a value: nothing written`);
  if (/-----BEGIN|PRIVATE KEY/.test(text))
    throw new Error(`${name} would hold a key or a certificate: nothing written`);
}

/** A run's report; a one-engine run holds that engine's provenance and cross-check alone. */
interface RunReport {
  readonly runtime: string;
  readonly provenance: Readonly<Partial<Record<Engine, Provenance>>>;
  readonly crossCheck: Readonly<Partial<Record<Engine, Omit<CrossCheck, "differs">>>>;
  readonly written: readonly string[];
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} <value> is required`);
  return value;
}

/** The engines a run captures: both, or the one `--engine` names. */
function runEngines(): readonly Engine[] {
  if (!process.argv.includes("--engine")) return ENGINES;
  const named = argument("--engine");
  if (!(ENGINES as readonly string[]).includes(named))
    throw new Error(`--engine ${named} is not one of ${ENGINES.join(", ")}`);
  return [named as Engine];
}

async function captureRun(): Promise<number> {
  const reportFile = argument("--report");
  const engines = runEngines();
  const runs = (engine: Engine) => engines.includes(engine);
  for (const engine of engines) requireHealthy(ENDPOINTS[engine].container);
  const pinned: Partial<Record<Engine, { image: string; digest: string }>> = {};
  const manifestText: Partial<Record<Engine, string>> = {};
  for (const engine of engines) {
    pinned[engine] = pinnedImage(ENDPOINTS[engine].container);
    manifestText[engine] = seedManifest(engine, pinned[engine] as { image: string; digest: string });
  }
  const milvus = runs("milvus") ? (parse(manifestText.milvus as string) as MilvusManifest) : undefined;
  const qdrant = runs("qdrant") ? (parse(manifestText.qdrant as string) as QdrantManifest) : undefined;
  const provenance: Partial<Record<Engine, Provenance>> = {};
  if (milvus !== undefined)
    provenance.milvus = manifestProvenance("milvus", milvus, pinned.milvus as { image: string; digest: string });
  if (qdrant !== undefined)
    provenance.qdrant = manifestProvenance("qdrant", qdrant, pinned.qdrant as { image: string; digest: string });
  const recorded = await runCaptures([
    ...(milvus === undefined ? [] : milvusCaptures(milvus)),
    ...(qdrant === undefined ? [] : qdrantCaptures(qdrant)),
  ]);
  const problems = problemsOf(recorded);
  if (problems.length > 0) throw new Error(`Nothing written:\n${problems.join("\n")}`);
  const cells = {
    milvus: milvus === undefined ? undefined : expectedMilvusCells(milvus),
    qdrant: qdrant === undefined ? undefined : expectedQdrantCells(qdrant),
  };
  const checks: Partial<Record<Engine, CrossCheck>> = {};
  for (const engine of engines) checks[engine] = crossCheck(engine, cells[engine]?.cells ?? [], recorded);
  const differing = engines.flatMap((engine) => checks[engine]?.differs ?? []);
  if (differing.length > 0)
    throw new Error(`A derived cell differs from REST; nothing written:\n${differing.join("\n")}`);
  const hnsw = qdrant === undefined ? [] : hnswDifferences(qdrant, recorded);
  if (hnsw.length > 0)
    throw new Error(`A derived index kind differs from describe; nothing written:\n${hnsw.join("\n")}`);

  // A one-engine run keeps the other engine's entry of expected-scores.json as the last run wrote it.
  const kept =
    engines.length === ENGINES.length
      ? {}
      : (JSON.parse(readFileSync(path.join(OUT, "expected-scores.json"), "utf8")) as Record<string, unknown>);
  const nonFinite = recorded.find(
    (entry) => entry.capture.engine === "qdrant" && entry.capture.name === "search-non-finite",
  );
  const files = new Map<string, string>();
  if (milvus !== undefined && cells.milvus !== undefined) {
    files.set("milvus/manifest.json", manifestText.milvus as string);
    files.set(
      "milvus/expected-fields.json",
      serialiseFixture({ $derived: DERIVED, fields: expectedMilvusFields(milvus) }),
    );
    files.set("milvus/expected-cells.json", serialiseFixture({ $derived: DERIVED, ...cells.milvus }));
  }
  if (qdrant !== undefined && cells.qdrant !== undefined) {
    files.set("qdrant/manifest.json", manifestText.qdrant as string);
    files.set(
      "qdrant/expected-fields.json",
      serialiseFixture({ $derived: DERIVED, fields: expectedQdrantFields(qdrant) }),
    );
    files.set("qdrant/expected-cells.json", serialiseFixture({ $derived: DERIVED, ...cells.qdrant }));
  }
  files.set(
    "expected-scores.json",
    serialiseFixture({
      $derived: { by: DERIVED.by, from: "milvus/manifest.json and qdrant/search-non-finite.json" },
      milvus: milvus === undefined ? kept.milvus : milvusNonFiniteScore(milvus),
      qdrant:
        qdrant === undefined
          ? kept.qdrant
          : {
              collection: "edge_values",
              id: 2,
              field: "sp",
              printed: nonFinite === undefined ? undefined : firstPoint(parse(nonFinite.answer.body))?.score,
              capture: "qdrant/search-non-finite.json",
            },
    }),
  );
  for (const entry of recorded) {
    files.set(
      `${entry.capture.engine}/${entry.capture.name}.json`,
      serialiseFixture(record(entry, provenance[entry.capture.engine] as Provenance)),
    );
  }
  for (const [name, text] of files) assertNoSecret(name, text);
  for (const engine of engines) rmSync(path.join(OUT, engine), { recursive: true, force: true });
  for (const [name, text] of files) {
    const file = path.join(OUT, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const crossChecks: Partial<Record<Engine, Omit<CrossCheck, "differs">>> = {};
  for (const engine of engines) {
    const check = checks[engine] as CrossCheck;
    crossChecks[engine] = { equal: check.equal, notComparable: check.notComparable, uncaptured: check.uncaptured };
  }
  const report: RunReport = {
    runtime: RUNTIME,
    provenance,
    crossCheck: crossChecks,
    written: [...files.keys()].sort(),
  };
  writeFileSync(reportFile, serialiseFixture(report));
  console.error(`wrote ${files.size} files under tests/fixtures/vector`);
  return 0;
}

// -- the README's generated blocks ----------------------------------------------------------------------------------

interface CapturedFile {
  readonly file: string;
  readonly record: {
    readonly $captured: {
      readonly engine: string;
      readonly image: string;
      readonly digest: string;
      readonly version: string;
      readonly date: string;
      readonly runtime: string;
      readonly surface: string;
      readonly request: { readonly method: string; readonly path: string };
    };
    readonly outcome: string;
  };
}

function capturedFiles(): CapturedFile[] {
  return ENGINES.flatMap((engine) =>
    readdirSync(path.join(OUT, engine))
      .filter((file) => file.endsWith(".json") && file !== "manifest.json" && !file.startsWith("expected-"))
      .sort()
      .map((file) => ({
        file: `${engine}/${file}`,
        record: JSON.parse(readFileSync(path.join(OUT, engine, file), "utf8")) as CapturedFile["record"],
      })),
  );
}

/** The content of one generated block, between its markers. */
function blockOf(readme: string, block: string): string {
  const start = `<!-- generated:${block} -->`;
  const end = `<!-- /generated:${block} -->`;
  const from = readme.indexOf(start);
  const to = readme.indexOf(end);
  if (from === -1 || to < from) throw new Error(`tests/fixtures/vector/README.md has no ${start} ... ${end} block`);
  return readme.slice(from + start.length, to);
}

function replaceBlock(readme: string, block: string, content: string): string {
  const start = `<!-- generated:${block} -->`;
  const end = `<!-- /generated:${block} -->`;
  const from = readme.indexOf(start);
  const to = readme.indexOf(end);
  if (from === -1 || to < from) throw new Error(`tests/fixtures/vector/README.md has no ${start} ... ${end} block`);
  return `${readme.slice(0, from + start.length)}\n${content}\n${readme.slice(to)}`;
}

function renderReadme(): number {
  const report = JSON.parse(readFileSync(argument("--report"), "utf8")) as RunReport;
  const files = capturedFiles();
  const provenance = [
    "| Engine | Image | Digest | Server version | Captured | Runtime |",
    "|---|---|---|---|---|---|",
    ...ENGINES.map((engine) => {
      const own = files.filter(({ record: r }) => r.$captured.engine === engine).map(({ record: r }) => r.$captured);
      const dates = own.map((captured) => captured.date).sort();
      const runtimes = [...new Set(own.map((captured) => captured.runtime))].join(", ");
      return `| ${engine} | \`${own[0]?.image}\` | \`${own[0]?.digest}\` | ${own[0]?.version} | ${dates[0]} to ${dates.at(-1)} | ${runtimes} |`;
    }),
  ].join("\n");
  // An engine the report does not hold, after a one-engine run, keeps the lines the README holds for it.
  const file = path.join(OUT, "README.md");
  let readme = readFileSync(file, "utf8");
  const previous = blockOf(readme, "cross-check").split("\n");
  const row = (engine: Engine): string => {
    const check = report.crossCheck[engine];
    if (check !== undefined)
      return `| ${engine} | ${check.equal} | ${check.notComparable.length} | ${check.uncaptured} |`;
    const kept = previous.find((line) => line.startsWith(`| ${engine} |`));
    if (kept === undefined)
      throw new Error(`the report holds no cross-check of ${engine}, and the README none to keep`);
    return kept;
  };
  const notComparable = (engine: Engine): string[] => {
    const check = report.crossCheck[engine];
    if (check !== undefined) return check.notComparable.map((line) => `- ${engine}: ${line}.`);
    return previous.filter((line) => line.startsWith(`- ${engine}: `));
  };
  const cross = [
    "| Engine | Cells equal to REST as float32 | Cells REST answers in another shape | Cells no capture holds |",
    "|---|---|---|---|",
    ...ENGINES.map(row),
    "",
    ...ENGINES.flatMap(notComparable),
  ].join("\n");
  const catalog = [
    "| File | Outcome | Request | Surface |",
    "|---|---|---|---|",
    ...files.map(
      ({ file, record: r }) =>
        `| \`${file}\` | ${r.outcome} | \`${r.$captured.request.method} ${r.$captured.request.path}\` | ${r.$captured.surface} |`,
    ),
  ].join("\n");
  readme = replaceBlock(readme, "provenance", provenance);
  readme = replaceBlock(readme, "cross-check", cross);
  readme = replaceBlock(readme, "catalog", catalog);
  writeFileSync(file, readme);
  console.error(`rendered ${files.length} captures into ${path.relative(ROOT, file)}`);
  return 0;
}

async function main(): Promise<number> {
  if (process.argv.includes("--readme")) return renderReadme();
  return captureRun();
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
