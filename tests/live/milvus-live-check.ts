/**
 * The Milvus live check (vector-family spec 7.3, gate 4, VF10, E24): a real MilvusProvider against the compose
 * services of docker/milvus/README.md, failing loudly on any change outside the harness's own collections.
 *
 * Runs by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/), on each runtime:
 *   docker cp libredb-milvus-seed:/credentials "$OUT/credentials"
 *   bun tests/live/milvus-live-check.ts --credentials "$OUT/credentials"
 *   bun build tests/live/milvus-live-check.ts --target=node --outfile "$OUT/live.mjs" && node "$OUT/live.mjs" --credentials "$OUT/credentials"
 *
 * What it proves: the collector of E24 reads every collection outside the prefix with reads only, before and after,
 * and the two snapshots agree; the model-ranker listener answers a positive control and then receives nothing from
 * Studio (VF10); the console examples, the REST equivalence, the copy loop, the refusal corpora, the telemetry check,
 * Load with its preview and Release on a collection of the harness's own, and the search ceilings. The documented
 * default credential is read from the credential record, never written here.
 */
// oxlint-disable no-await-in-loop -- checks run one at a time against a shared server, so each answer is its own request's and the listener counts only what this run sent.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { formatCellCopy } from "@/components/results-grid/utils";
import { RequestRefusal } from "@/lib/db/console/dialect";
import { CREDENTIAL_WARNINGS } from "@/lib/db/credential-warnings";
import { type CallOptions, type MilvusClient, MilvusError } from "@/lib/db/providers/vector/milvus/client";
import { buildMilvusConnectionOptions } from "@/lib/db/providers/vector/milvus/connection-options";
import { createGrpcMilvusClient } from "@/lib/db/providers/vector/milvus/grpc-client";
import { MilvusProvider } from "@/lib/db/providers/vector/milvus/index";
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import expectedCells from "../fixtures/vector/milvus/expected-cells.json";
import { assertUnchanged, compareSnapshots } from "./support/compare";
import { guardMutations } from "./support/mutation-guard";
import {
  type CollectionSnapshot,
  type FieldReading,
  readField,
  type SnapshotJson,
  type SnapshotRecord,
  type UnavailableReason,
} from "./support/snapshot";

const PREFIX = "studio_live_";
const PRIVATE = `${PREFIX}load`;
const RUNTIME = typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`;
const args = new Map<string, string>();
for (let at = 2; at < process.argv.length; at += 2) {
  args.set(process.argv[at].replace(/^--/, ""), process.argv[at + 1] ?? "");
}
const credentials = args.get("credentials");
if (credentials === undefined || credentials === "") {
  throw new Error("--credentials <dir copied from libredb-milvus-seed:/credentials>");
}

const declared = CREDENTIAL_WARNINGS.milvus?.find((entry) => entry.kind === "pair");
if (declared?.kind !== "pair") throw new Error("the milvus credential record declares no pair");
const pair: { readonly user: string; readonly password: string } = declared;
const readerPassword = readFileSync(join(credentials, "reader.password"), "utf8").trim();

const connection = (id: string, user: string, password: string): DatabaseConnection =>
  ({
    id,
    name: id,
    type: "milvus",
    host: "127.0.0.1",
    port: 19530,
    user,
    password,
    createdAt: new Date(0),
  }) as DatabaseConnection;
const ROOT = connection("live-root", pair.user, pair.password);
const READER = connection("live-reader", "reader", readerPassword);

const failures: string[] = [];
let passes = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    passes++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}: ${(error as Error).message}`);
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const measure = (name: string, value: unknown) =>
  console.log(`MEASURE ${JSON.stringify({ name, runtime: RUNTIME, value })}`);

/**
 * A vector cell with every element read as the float32 Milvus stores: Studio writes a float32 as its shortest text
 * (0.16769554) and the fixture holds its float64 widening (0.1676955372095108), and both name the same float32. A
 * sparse vector's indices are its keys and stay exact; integers (int8 and binary bytes) are unchanged by the rounding.
 */
function asFloat32(value: unknown): unknown {
  if (typeof value === "number") return Math.fround(value);
  if (Array.isArray(value)) return value.map(asFloat32);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, asFloat32(item)]));
  }
  return value;
}

/** JSON with every object's keys sorted, so two values compare by content and not by key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function refused(run: () => Promise<unknown>): Promise<RequestRefusal> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RequestRefusal) return error;
    throw error;
  }
  throw new Error("expected Studio to refuse it");
}

// ---- the collector of E24: reads only, through the harness's own guarded client -------------------------------

async function adminClient(): Promise<MilvusClient> {
  const options = buildMilvusConnectionOptions(ROOT, { executionReadOnly: false, queryTimeout: 30_000 });
  const client = await createGrpcMilvusClient(options);
  return guardMutations(client, {
    prefix: PREFIX,
    reads: [
      "listDatabases",
      "showCollections",
      "describeCollection",
      "describeIndex",
      "getLoadState",
      "getCollectionStatistics",
      "showPartitions",
      "listAliases",
      "query",
      "close",
    ],
    mutating: [],
    targetsOf: () => [],
  });
}

const call = (db: string): CallOptions => ({ db, signal: AbortSignal.timeout(30_000) });
/** A value as the snapshot holds it: plain JSON, with undefined members dropped. */
const json = (value: unknown): SnapshotJson => JSON.parse(JSON.stringify(value ?? null)) as SnapshotJson;
const neverUnavailable = (): UnavailableReason | null => null;
const STABLE = [
  "schema",
  "configuration",
  "aliases",
  "partitions",
  "indexes",
  "loadState",
  "rowEstimate",
  "exactCount",
];

/** A collection with no index answers DescribeIndex with a status, which reads as no index at all. */
async function indexesOf(client: MilvusClient, db: string, name: string): Promise<unknown> {
  try {
    const answer = await client.describeIndex({ collection_name: name, index_name: "" }, call(db));
    // The server lists indexes, and each index's parameters, in no fixed order, so both are sorted by name.
    return answer.index_descriptions
      .map((index) => ({
        index_name: index.index_name,
        field_name: index.field_name,
        params: [...index.params].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      }))
      .sort((a, b) => (a.index_name < b.index_name ? -1 : a.index_name > b.index_name ? 1 : 0));
  } catch (error) {
    if (
      error instanceof MilvusError &&
      error.category === "status" &&
      /index not (found|exist)/i.test(error.detail ?? "")
    ) {
      return [];
    }
    throw error;
  }
}

async function snapshot(client: MilvusClient, label: string): Promise<SnapshotRecord> {
  const collections: CollectionSnapshot[] = [];
  const { db_names: databases } = await client.listDatabases(call("default"));
  for (const db of [...databases].sort()) {
    const { collection_names: names } = await client.showCollections(call(db));
    for (const name of [...names].filter((entry) => !entry.startsWith(PREFIX)).sort()) {
      const read = (field: string, run: () => Promise<unknown>) =>
        readField(`${db}/${name}`, field, async () => json(await run()), neverUnavailable);
      const describe = await client.describeCollection({ collection_name: name }, call(db));
      const load = await client.getLoadState({ collection_name: name }, call(db));
      const fields: Record<string, FieldReading> = {
        schema: { value: json(describe.schema) },
        configuration: { value: json({ properties: describe.properties, shards: describe.shards_num }) },
        aliases: await read(
          "aliases",
          async () => (await client.listAliases({ collection_name: name }, call(db))).aliases,
        ),
        partitions: await read(
          "partitions",
          async () => (await client.showPartitions({ collection_name: name }, call(db))).partition_names,
        ),
        indexes: await read("indexes", () => indexesOf(client, db, name)),
        loadState: { value: load.state },
        rowEstimate: await read(
          "rowEstimate",
          async () => (await client.getCollectionStatistics({ collection_name: name }, call(db))).stats,
        ),
        exactCount:
          load.state === "LoadStateLoaded"
            ? await read(
                "exactCount",
                async () =>
                  (
                    await client.query(
                      { collection_name: name, expr: "", output_fields: ["count(*)"], query_params: [] },
                      call(db),
                    )
                  ).fields_data,
              )
            : { unavailable: "not-loaded" },
      };
      collections.push({ engine: "milvus", database: db, name, fields });
    }
  }
  return {
    harness: `milvus-live-check ${label}`,
    takenAt: new Date().toISOString(),
    prefix: PREFIX,
    scratch: ["milvus:default/scratch"],
    collections,
  };
}

// ---- REST, for the equivalence run and the private collection, guarded by prefix ------------------------------

async function restCall(route: string, body: Record<string, unknown>): Promise<{ code: number; data: unknown }> {
  const response = await fetch(`http://127.0.0.1:19530/v2/vectordb/${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${pair.user}:${pair.password}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // Every integer above 2^53 is kept as its exact digits, as Studio keeps an Int64.
  return JSON.parse(quoteUnsafeIntegers(await response.text())) as { code: number; data: unknown };
}

/** The harness's REST client: reads, and writes that only ever name a collection under the prefix. */
const rest = guardMutations(
  {
    read: (route: string, body: Record<string, unknown>) => restCall(route, body),
    write: (route: string, body: Record<string, unknown>) => restCall(route, body),
  },
  {
    prefix: PREFIX,
    reads: ["read"],
    mutating: ["write"],
    targetsOf: (_method, callArgs) => [String((callArgs[1] as { collectionName?: unknown }).collectionName)],
  },
);

// ---- the model-ranker listener of VF10 --------------------------------------------------------------------------

function composeGateway(): string {
  // MILVUS_LIVE_GATEWAY lets a run inside a container (Node 26) take the gateway the host read.
  const given = process.env.MILVUS_LIVE_GATEWAY;
  if (given !== undefined && given !== "") return given;
  return execFileSync(
    "docker",
    ["network", "inspect", "libredb-studio_default", "-f", "{{(index .IPAM.Config 0).Gateway}}"],
    {
      encoding: "utf8",
    },
  ).trim();
}

async function listen(host: string): Promise<{ server: Server; url: string; received: () => number }> {
  let count = 0;
  const server = createServer((_request, response) => {
    count++;
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  assert(address !== null && typeof address === "object", "the listener has no address");
  return { server, url: `http://${host}:${address.port}/`, received: () => count };
}

const UNIT = [0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338];
const rankerBody = (endpoint: string, key: "functionScore" | "functionChains" = "functionScore") => ({
  collectionName: "docs_int64",
  annsField: "vec",
  data: [UNIT],
  limit: 5,
  outputFields: ["title"],
  [key]: {
    functions: [
      {
        name: "rr",
        type: "Rerank",
        inputFieldNames: ["title"],
        params: { reranker: "model", provider: "tei", queries: ["x"], endpoint },
      },
    ],
  },
});

// ---- the run ------------------------------------------------------------------------------------------------------

const rows = (result: QueryResult) => result.rows as Record<string, unknown>[];

const EXAMPLES: readonly [string, string, (result: QueryResult) => void][] = [
  [
    "1 collections/list",
    'POST /v2/vectordb/collections/list\n{"dbName": "default"}',
    (r) => assert(JSON.stringify(r.rows).includes("docs_int64"), "docs_int64 missing"),
  ],
  [
    "2 describe an unloaded collection",
    'POST /v2/vectordb/collections/describe\n{"collectionName": "unloaded_big"}',
    (r) => assert(/NotLoad/.test(JSON.stringify(r.rows)), "not NotLoad"),
  ],
  [
    "3 query",
    'POST /v2/vectordb/entities/query\n{"collectionName": "docs_int64", "filter": "seq >= 10 and title like \\"doc 001%\\"", "outputFields": ["id", "seq", "title", "tags", "big_int"], "limit": 5}',
    (r) => assert(r.rows.length > 0 && r.rows.length <= 5, `${r.rows.length} rows`),
  ],
  [
    "4 exact count",
    'POST /v2/vectordb/entities/query\n{"collectionName": "docs_int64", "filter": "maybe_count is null", "outputFields": ["count(*)"]}',
    (r) => assert(r.rows.length === 1 && "count(*)" in rows(r)[0], `count ${JSON.stringify(r.rows)}`),
  ],
  [
    "5 get",
    'POST entities/get\n{"collectionName": "docs_varchar", "id": ["vc-0001", "vc-0002"], "outputFields": ["pk", "label"]}',
    (r) => assert(r.rows.length === 2, `${r.rows.length} rows`),
  ],
  [
    "6 dense search",
    `# nearest neighbours\nPOST /v2/vectordb/entities/search\n${JSON.stringify({ collectionName: "docs_int64", annsField: "vec", data: [UNIT], filter: "seq >= 100", searchParams: { params: { ef: 64 } }, outputFields: ["seq", "title"], limit: 5 })}`,
    (r) => assert(r.rows.length === 5 && "distance" in rows(r)[0], "no distance"),
  ],
  [
    "7 BM25 text search",
    'POST /v2/vectordb/entities/search\n{"collectionName": "fts", "annsField": "text_sparse", "data": ["vector index"], "outputFields": ["id", "text"], "limit": 5}',
    (r) => assert(r.rows.length > 0, "no rows"),
  ],
  [
    "8 hybrid search",
    'POST /v2/vectordb/entities/hybrid_search\n{"collectionName": "docs_varchar", "search": [{"annsField": "f16", "data": [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]], "limit": 10}, {"annsField": "sparse", "data": [{"17": 0.4, "230": 0.2}], "limit": 10}], "rerank": {"strategy": "rrf", "params": {"k": 60}}, "outputFields": ["pk", "label"], "limit": 5}',
    (r) => assert(r.rows.length > 0, "no rows"),
  ],
  [
    "9 search by id",
    'POST /v2/vectordb/entities/search\n{"collectionName": "docs_varchar", "annsField": "f16", "ids": ["vc-0000", "vc-0001"], "outputFields": ["pk", "label"], "limit": 3}',
    (r) =>
      assert(
        rows(r).some((row) => row.pk === "vc-0000"),
        "own row missing",
      ),
  ],
  [
    "10 grouped search",
    'POST /v2/vectordb/entities/search\n{"collectionName": "docs_varchar", "annsField": "f16", "data": [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]], "groupingField": "label", "groupSize": 1, "outputFields": ["pk", "label"], "limit": 4}',
    (r) => assert(new Set(rows(r).map((row) => row.label)).size === r.rows.length, "groups repeat"),
  ],
];

const SEARCH = "POST /v2/vectordb/entities/search";
const CEILINGS: readonly [string, Record<string, unknown>][] = [
  [
    "ef 65,537",
    { collectionName: "docs_int64", annsField: "vec", data: [UNIT], searchParams: { params: { ef: 65537 } }, limit: 5 },
  ],
  [
    "ef below offset plus limit",
    {
      collectionName: "docs_int64",
      annsField: "vec",
      data: [UNIT],
      searchParams: { params: { ef: 15 } },
      limit: 10,
      offset: 20,
    },
  ],
  [
    "search cost 10,250",
    {
      collectionName: "docs_varchar",
      annsField: "f16",
      data: [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]],
      groupingField: "label",
      groupSize: 10,
      limit: 1024,
      offset: 1,
    },
  ],
  [
    "range_filter alone",
    {
      collectionName: "docs_int64",
      annsField: "vec",
      data: [UNIT],
      searchParams: { params: { range_filter: 0.5 } },
      limit: 5,
    },
  ],
];

interface ExpectedCell {
  readonly collection: string;
  readonly match: { readonly field: string; readonly value: number | string };
  readonly field: string;
  readonly kind: string;
  readonly dtype: string;
  readonly cell: unknown;
}

/**
 * A hit list as its primary keys, as text so an Int64 compares as its digits. REST answers a search that names no
 * output field with the key and the score alone, so the key is the one other field of a REST hit.
 */
function hitKeys(hits: readonly Record<string, unknown>[], key: string): string[] {
  return hits.map((hit) => String(hit[key]));
}
function restKeyOf(hits: readonly Record<string, unknown>[]): string {
  const names = Object.keys(hits[0] ?? {}).filter((name) => name !== "distance");
  assert(names.length === 1, `a REST hit holds ${names.join(", ")} beside its score`);
  return names[0];
}

async function main(): Promise<void> {
  console.log(`START ${RUNTIME}`);
  const admin = await adminClient();
  const before = await snapshot(admin, "before");
  const listener = await listen(composeGateway());
  const root = new MilvusProvider(ROOT);
  const reader = new MilvusProvider(READER);
  await root.connect();
  await reader.connect();

  await check("VF10 positive control: the server reaches the listener", async () => {
    // positive control: the model-ranker listener is reachable
    await rest.read("entities/search", rankerBody(listener.url));
    for (let waited = 0; waited < 50 && listener.received() === 0; waited++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(listener.received() > 0, "the listener received nothing from its positive control");
  });
  const afterControl = listener.received();

  for (const [name, text, expectResult] of EXAMPLES) {
    await check(`example ${name}`, async () => expectResult(await root.query(text)));
  }

  await check("REST equivalence: example 6 by primary key and score", async () => {
    const text = EXAMPLES[5][1];
    const studio = rows(await root.query(text));
    const body = JSON.parse(text.split("\n").slice(2).join("\n")) as Record<string, unknown>;
    const restRows = (await rest.read("entities/search", body)).data as Record<string, unknown>[];
    assert(
      canonical(studio.map((row) => String(row.seq))) === canonical(restRows.map((row) => String(row.seq))),
      "order differs",
    );
    for (const [at, row] of studio.entries()) {
      assert(Math.fround(Number(row.distance)) === Math.fround(Number(restRows[at].distance)), `score ${at} differs`);
    }
  });

  await check("REST equivalence: example 1 as a set", async () => {
    const studio = (await root.query(EXAMPLES[0][1])).rows.map((row) => String(Object.values(row)[0])).sort();
    const { data } = await rest.read("collections/list", { dbName: "default" });
    assert(canonical(studio) === canonical((data as string[]).map(String).sort()), "sets differ");
  });

  await check(
    "the copy loop: every expected cell reads back exactly, and its copy searches its own field",
    async () => {
      let compared = 0;
      for (const cell of (expectedCells as { cells: ExpectedCell[] }).cells) {
        const [dbName, collectionName] = cell.collection.split("/");
        // unloaded_big is released by design, and a struct array's sub-field is no output field: both excluded by name.
        if (collectionName === "unloaded_big" || cell.kind === "multi") continue;
        const filter = `${cell.match.field} == ${JSON.stringify(cell.match.value)}`;
        const read = await root.query(
          `POST /v2/vectordb/entities/query\n${JSON.stringify({ dbName, collectionName, filter, outputFields: [cell.field], limit: 1 })}`,
        );
        const where = `${cell.collection} ${String(cell.match.value)} ${cell.field}`;
        const copied = formatCellCopy(rows(read)[0]?.[cell.field], { vector: read.vectorColumns?.[cell.field] });
        assert(
          canonical(asFloat32(JSON.parse(copied))) === canonical(asFloat32(cell.cell)),
          `${where}: the copy differs as float32`,
        );
        // The copied text goes into the body as it is, so what the user pastes is what is sent.
        const body = `{"dbName": ${JSON.stringify(dbName)}, "collectionName": ${JSON.stringify(collectionName)}, "annsField": ${JSON.stringify(cell.field)}, "data": [${copied}], "limit": 5}`;
        if (JSON.stringify(cell.cell).includes("null")) {
          await refused(() => root.query(`${SEARCH}\n${body}`)); // a float16 element that overflowed, refused by name
          continue;
        }
        const studio = await root.query(`${SEARCH}\n${body}`);
        // A score that is not finite is excluded from the REST comparison by name (vector-family spec 7.3).
        if (studio.warnings?.some((warning) => /not (a )?finite/i.test(warning.message))) continue;
        // REST takes a binary vector as base64 and a float16 or bfloat16 one as its raw bytes, so only float32 and
        // sparse cells are sent there unchanged; the others are compared through Studio alone, by name.
        if (cell.dtype === "float32") {
          const restRows = (await rest.read("entities/search", JSON.parse(body) as Record<string, unknown>))
            .data as Record<string, unknown>[];
          const key = restKeyOf(restRows);
          assert(
            canonical(hitKeys(rows(studio), key)) === canonical(hitKeys(restRows, key)),
            `${where}: hits differ from REST`,
          );
        }
        compared++;
      }
      measure("copy-loop-compared", compared);
      assert(compared > 0, "no cell was compared");
    },
  );

  await check("E34 and the endpoint-bearing keys are refused with the listener untouched", async () => {
    for (const key of ["functionScore", "functionChains"] as const) {
      await refused(() => root.query(`${SEARCH}\n${JSON.stringify(rankerBody(listener.url, key))}`));
    }
    assert(listener.received() === afterControl, "the listener received a request from Studio");
  });

  await check("E28 ceilings are refused before any request", async () => {
    for (const [name, body] of CEILINGS) {
      try {
        await refused(() => root.query(`${SEARCH}\n${JSON.stringify(body)}`));
      } catch (error) {
        throw new Error(`${name}: ${(error as Error).message}`, { cause: error });
      }
    }
  });

  await check("E3: the management port lists no Studio client after a failing query", async () => {
    await root
      .query('POST /v2/vectordb/entities/query\n{"collectionName": "docs_int64", "filter": "seq >>> 1", "limit": 1}')
      .catch(() => undefined);
    const response = await fetch("http://127.0.0.1:19091/api/v1/_telemetry/clients", {
      headers: { authorization: `Basic ${Buffer.from(`${pair.user}:${pair.password}`).toString("base64")}` },
    });
    const text = await response.text();
    assert(!text.includes(hostname()), "the telemetry list names this machine");
    assert(!/libredb/i.test(text), "the telemetry list names Studio");
  });

  await check(
    "Load with its preview and Release on a private collection; the reader is refused by the server",
    async () => {
      await rest.write("collections/create", {
        collectionName: PRIVATE,
        dimension: 8,
        metricType: "COSINE",
        idType: "Int64",
        primaryFieldName: "id",
        vectorFieldName: "vec",
      });
      try {
        await rest.write("entities/insert", {
          collectionName: PRIVATE,
          data: Array.from({ length: 100 }, (_, id) => ({
            id,
            vec: Array.from({ length: 8 }, (_v, at) => (id + at + 1) / 100),
          })),
        });
        await rest.write("collections/release", { collectionName: PRIVATE });
        const preview = await root.previewMaintenance("load", ["default", PRIVATE]);
        assert(preview.refusal === undefined, `the preview refused: ${preview.refusal}`);
        assert(
          JSON.stringify(preview).includes("possibly several seconds old"),
          "no stale-figures note in the preview",
        );
        const loaded = await root.runMaintenance("load", PRIVATE, "default");
        assert(loaded.success && /^(Loaded|Loading \d+%)/.test(loaded.message), `load: ${loaded.message}`);
        const denied = await reader.runMaintenance("release", PRIVATE, "default").then(
          (result) => result.success,
          () => false,
        );
        assert(!denied, "the reader released a collection");
        const released = await root.runMaintenance("release", PRIVATE, "default");
        assert(released.success, `release: ${released.message}`);
      } finally {
        await rest.write("collections/drop", { collectionName: PRIVATE });
      }
    },
  );

  await root.disconnect();
  await reader.disconnect();
  listener.server.close();
  const after = await snapshot(admin, "after");
  admin.close();
  await check("VF10: every collection outside the prefix is unchanged", async () => {
    assertUnchanged(compareSnapshots(before, after, { stable: STABLE, volatile: [] }));
  });
  console.log(`END ${RUNTIME} passes=${passes} failures=${failures.length}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
