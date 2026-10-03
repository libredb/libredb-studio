/**
 * The Qdrant live check (vector-family spec 7.3 and gate 4): a real QdrantProvider against the compose
 * services of docker/qdrant/README.md, failing loudly on any change outside the harness's own collections.
 *
 * Runs by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/), on each runtime:
 *   docker cp libredb-qdrant-keys:/keys "$OUT/keys"
 *   bun tests/live/qdrant-live-check.ts --keys "$OUT/keys"
 *   bun build tests/live/qdrant-live-check.ts --target=node --outfile "$OUT/live.mjs" && node "$OUT/live.mjs" --keys "$OUT/keys"
 *
 * What it proves: the collector reads every collection outside the prefix with reads only, before and after,
 * and the two snapshots agree; the inference listener and the snapshot-URL listener each answer a positive control
 * and then receive nothing from Studio; the console examples, the documentation corpus against REST, the copy
 * loop of every vector type, the credential and alias matrix, TLS and mutual TLS, and the refusal corpora. Every JWT
 * is minted here from the admin key it reads out of the copied volume and is never written to a file.
 */
// oxlint-disable no-await-in-loop -- checks run one at a time against shared servers, so each answer is its own request's and each listener counts only what this run sent.
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import http, { createServer, type Server } from "node:http";
import https from "node:https";
import { join } from "node:path";
import { formatCellCopy } from "@/components/results-grid/utils";
import { RequestRefusal } from "@/lib/db/console/dialect";
import { QdrantProvider } from "@/lib/db/providers/vector/qdrant/index";
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";
import type { DatabaseConnection, QueryResult, SSLConfig } from "@/lib/types";
import qdrantDocs from "../fixtures/vector/corpus/qdrant-docs.json";
import expectedCells from "../fixtures/vector/qdrant/expected-cells.json";
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
const RUNTIME = typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`;
const args = new Map<string, string>();
for (let at = 2; at < process.argv.length; at += 2) {
  args.set(process.argv[at].replace(/^--/, ""), process.argv[at + 1] ?? "");
}
const keysDir = args.get("keys");
if (keysDir === undefined || keysDir === "") throw new Error("--keys <dir copied from libredb-qdrant-keys:/keys>");
const key = (relative: string): string => readFileSync(join(keysDir, relative), "utf8").trim();
const ADMIN_KEY = key("auth/admin.key");
const READ_ONLY_KEY = key("auth/read-only.key");

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

/** JSON with every object's keys sorted, so two values compare by content and not by key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---- a raw REST client of the harness's own, for the collector, the setup and the REST side of every comparison ----

interface Rest {
  readonly port: number;
  readonly apiKey?: string;
  readonly tls?: { readonly ca: string; readonly cert?: string; readonly key?: string };
}
interface RestAnswer {
  readonly status: number;
  readonly text: string;
}

function send(target: Rest, method: string, path: string, body?: unknown): Promise<RestAnswer> {
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (target.apiKey !== undefined) headers["api-key"] = target.apiKey;
  const options = { host: "127.0.0.1", port: target.port, method, path, headers, ...(target.tls ?? {}) };
  return new Promise((resolve, reject) => {
    const request = (target.tls === undefined ? http : https).request(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    request.on("error", reject);
    request.setTimeout(60_000, () => request.destroy(new Error(`${method} ${path} timed out`)));
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

/** An answer parsed with every integer above 2^53 kept as its exact digits. */
const parse = (answer: RestAnswer): Record<string, unknown> =>
  JSON.parse(quoteUnsafeIntegers(answer.text)) as Record<string, unknown>;

/** The harness's setup client: reads, and writes that only ever name a collection under the prefix. */
function setupClient(target: Rest) {
  const client = {
    get: (path: string) => send(target, "GET", path),
    post: (path: string, body: unknown) => send(target, "POST", path, body),
    createCollection: (name: string, body: unknown) =>
      send(target, "PUT", `/collections/${encodeURIComponent(name)}`, body),
    recoverSnapshot: (name: string, body: unknown) =>
      send(target, "PUT", `/collections/${encodeURIComponent(name)}/snapshots/recover?wait=true`, body),
    deleteCollection: (name: string) => send(target, "DELETE", `/collections/${encodeURIComponent(name)}`),
  };
  return guardMutations(client, {
    prefix: PREFIX,
    reads: ["get", "post"],
    mutating: ["createCollection", "recoverSnapshot", "deleteCollection"],
    targetsOf: (_method, callArgs) => [String(callArgs[0])],
  });
}

// ---- the collector: reads only -------------------------------------------------------------------------------------

const VOLATILE = ["status", "optimizer_status", "segments_count", "indexed_vectors_count", "points_count"] as const;
const STABLE = ["schema", "configuration", "aliases", "loadState", "snapshots", "cluster", "exactCount"] as const;
const neverUnavailable = (): UnavailableReason | null => null;

/** A value as the snapshot holds it: plain JSON, with undefined members dropped. */
const json = (value: unknown): SnapshotJson => JSON.parse(JSON.stringify(value ?? null)) as SnapshotJson;

async function snapshot(target: Rest, label: string): Promise<SnapshotRecord> {
  const client = setupClient(target);
  const listing = parse(await client.get("/collections")).result as { collections: { name: string }[] };
  const names = listing.collections.map((entry) => entry.name);
  const collections: CollectionSnapshot[] = [];
  const read = (
    name: string,
    field: string,
    run: () => Promise<unknown>,
    unavailableOn: (error: unknown) => UnavailableReason | null = neverUnavailable,
  ) => readField(name, field, async () => json(await run()), unavailableOn);
  for (const name of names.filter((entry) => !entry.startsWith(PREFIX)).sort()) {
    const path = `/collections/${encodeURIComponent(name)}`;
    const info = parse(await client.get(path)).result as Record<string, unknown>;
    const config = (info.config ?? {}) as Record<string, unknown>;
    const fields: Record<string, FieldReading> = {
      schema: await read(name, "schema", async () => config.params ?? null),
      configuration: await read(name, "configuration", async () => ({ ...config, params: undefined })),
      aliases: await read(name, "aliases", async () => parse(await client.get(`${path}/aliases`)).result),
      loadState: { value: "always-loaded" },
      snapshots: await read(name, "snapshots", async () => parse(await client.get(`${path}/snapshots`)).result),
      cluster: await read(name, "cluster", async () => {
        const cluster = parse(await client.get(`${path}/cluster`)).result as Record<string, unknown>;
        return { shard_count: cluster.shard_count, local_shards: (cluster.local_shards as unknown[]).length };
      }),
      exactCount: await read(
        name,
        "exactCount",
        async () => {
          const answer = await client.post(`${path}/points/count`, { exact: true });
          if (answer.status !== 200) throw new Error(answer.text);
          return parse(answer).result;
        },
        (error) =>
          /Exact search disabled/.test(String((error as Error).message)) ? "strict-mode-exact-disabled" : null,
      ),
    };
    for (const field of VOLATILE) fields[field] = { value: json(info[field]) };
    collections.push({ engine: "qdrant", database: null, name, fields });
  }
  const aliases = parse(await client.get("/aliases")).result;
  collections.push({
    engine: "qdrant",
    database: null,
    name: "(aliases)",
    fields: { aliases: { value: json(aliases) } },
  });
  return {
    harness: `qdrant-live-check ${label}`,
    takenAt: new Date().toISOString(),
    prefix: PREFIX,
    scratch: ["qdrant:/scratch"],
    collections,
  };
}

// ---- the two listeners, reached by qdrant-auth as host.docker.internal ------------------------------------------

function bridgeGateway(): string {
  const given = process.env.QDRANT_LIVE_GATEWAY;
  if (given !== undefined && given !== "") return given;
  return execFileSync("docker", ["network", "inspect", "bridge", "-f", "{{(index .IPAM.Config 0).Gateway}}"], {
    encoding: "utf8",
  }).trim();
}

async function listen(host: string, port: number): Promise<{ server: Server; port: number; received: () => number }> {
  let count = 0;
  const server = createServer((_request, response) => {
    count++;
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  assert(address !== null && typeof address === "object", "the listener has no address");
  return { server, port: address.port, received: () => count };
}

// ---- the provider -------------------------------------------------------------------------------------------------

const connection = (id: string, port: number, password?: string, ssl?: SSLConfig): DatabaseConnection =>
  ({
    id,
    name: id,
    type: "qdrant",
    host: "127.0.0.1",
    port,
    password,
    ssl,
    createdAt: new Date(0),
  }) as DatabaseConnection;

function mint(claims: Record<string, unknown>): string {
  const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}`;
  return `${head}.${createHmac("sha256", ADMIN_KEY).update(head).digest("base64url")}`;
}
const LATER = Math.floor(Date.now() / 1000) + 3600;

async function refused(run: () => Promise<unknown>): Promise<RequestRefusal> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RequestRefusal) return error;
    throw error;
  }
  throw new Error("expected Studio to refuse it");
}

/** A point id as body text: an integer id unquoted, digits and all, a UUID as a JSON string. */
const idText = (value: number | string): string =>
  typeof value === "string" && /^\d+$/.test(value) ? value : JSON.stringify(value);

/** The point ids of a point answer's `result`, in its order, or null for an answer that holds no points. */
function restPointIds(result: unknown): string[] | null {
  const ids = (points: unknown): string[] => (points as { id: number | string }[]).map((point) => String(point.id));
  if (Array.isArray(result)) {
    if (result.every((entry) => entry !== null && typeof entry === "object" && "id" in entry)) return ids(result);
    if (result.every((entry) => entry !== null && typeof entry === "object" && "points" in entry)) {
      return result.flatMap((entry) => ids((entry as { points: unknown }).points));
    }
    return null;
  }
  if (result === null || typeof result !== "object") return null;
  if ("points" in result) return ids((result as { points: unknown }).points);
  if ("groups" in result) {
    return (result as { groups: { hits: unknown }[] }).groups.flatMap((group) => ids(group.hits));
  }
  return null;
}

/** The point ids of a Studio result, in row order, skipping a group's empty row. */
const studioPointIds = (result: QueryResult): string[] =>
  result.rows.flatMap((row) => (row.id === null || row.id === undefined ? [] : [String(row.id)]));

const OPEN: Rest = { port: 6333 };
const AUTH: Rest = { port: 6343, apiKey: ADMIN_KEY };
const NON_LOCAL_MODEL = /"model"\s*:\s*"(?!(?:qdrant\/bm25|bm25)")/;

async function main(): Promise<void> {
  console.log(`START ${RUNTIME}`);
  const beforeOpen = await snapshot(OPEN, "qdrant before");
  const beforeAuth = await snapshot(AUTH, "qdrant-auth before");
  const gateway = bridgeGateway();
  const inference = await listen(gateway, 18904);
  const snapshotListener = await listen(gateway, 0);
  const auth = setupClient(AUTH);
  const control = `${PREFIX}control`;

  await check("positive controls: qdrant-auth reaches both listeners", async () => {
    await auth.createCollection(control, { vectors: { text: { size: 4, distance: "Cosine" } } });
    const exists = await auth.get(`/collections/${control}/exists`);
    assert(exists.text.includes('"exists":true'), "the control collection is missing");
    // positive control: the inference listener is reachable
    await auth.post(`/collections/${control}/points/query`, {
      query: { text: "positive control", model: "positive-control/model" },
      using: "text",
      limit: 1,
    });
    await auth.recoverSnapshot(control, {
      location: `http://host.docker.internal:${snapshotListener.port}/control.snapshot`,
    });
    for (let waited = 0; waited < 50 && (inference.received() === 0 || snapshotListener.received() === 0); waited++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(inference.received() > 0, "the inference listener received nothing from its positive control");
    assert(snapshotListener.received() > 0, "the snapshot listener received nothing from its positive control");
  });
  const inferenceAfterControl = inference.received();
  const snapshotAfterControl = snapshotListener.received();

  const open = new QdrantProvider(connection("live-open", 6333));
  await open.connect();

  const EXAMPLES: readonly [string, string, (result: QueryResult) => void][] = [
    ["1 collections", "GET /collections", (r) => assert(JSON.stringify(r.rows).includes("docs"), "docs missing")],
    ["2 one point", "GET /collections/docs/points/42", (r) => assert(r.rows.length === 1, `${r.rows.length} rows`)],
    [
      "3 filtered scroll",
      'POST /collections/docs/points/scroll\n{"filter": {"must": [{"key": "category", "match": {"value": "alpha"}}]}, "limit": 1, "with_payload": true, "with_vector": false}',
      (r) => assert(r.rows.length === 1, `${r.rows.length} rows`),
    ],
    [
      "4 dense query",
      'POST /collections/plain/points/query?consistency=majority\n{"query": [0.2, 0.1, 0.9, 0.7], "filter": {"must": [{"key": "city", "match": {"value": "London"}}]}, "params": {"hnsw_ef": 128, "exact": false}, "limit": 3}',
      (r) => assert(r.rows.length <= 3, `${r.rows.length} rows`),
    ],
    [
      "5 sparse query",
      'POST /collections/docs/points/query\n{"query": {"indices": [1, 3, 5, 7], "values": [0.1, 0.2, 0.3, 0.4]}, "using": "keywords"}',
      (r) => assert(r.rows.length === 10, `${r.rows.length} rows, not the explicit default 10`),
    ],
    [
      "6 exact count",
      'POST /collections/docs/points/count\n{"filter": {"must": [{"key": "category", "match": {"value": "alpha"}}]}, "exact": true}',
      (r) => assert(r.rows.length === 1, "no count row"),
    ],
    [
      "7 local BM25",
      'POST /collections/docs/points/query\n{"query": {"text": "vector search", "model": "qdrant/bm25"}, "using": "keywords", "limit": 5, "with_payload": true}',
      (r) => assert(r.rows.length <= 5, `${r.rows.length} rows`),
    ],
    [
      "8 batch",
      'POST /collections/docs/points/query/batch\n{"searches": [{"query": 42, "using": "text", "limit": 3}, {"query": 42, "using": "image", "limit": 3}]}',
      (r) => assert(r.fields[0] === "$search", "no $search column"),
    ],
    [
      "9 groups",
      'POST /collections/docs/points/query/groups\n{"query": 42, "using": "text", "group_by": "category", "group_size": 2, "limit": 3}',
      (r) => assert(r.fields[0] === "$group", "no $group column"),
    ],
    [
      "10 comments",
      '// two titles from a scroll\nPOST /collections/docs/points/scroll\n{\n    "limit": 2, // two points\n    "with_payload": ["title"]\n}',
      (r) => assert(r.rows.length === 2, `${r.rows.length} rows`),
    ],
  ];
  for (const [name, text, expectResult] of EXAMPLES) {
    await check(`example ${name}`, async () => expectResult(await open.query(text)));
  }

  await check("ids above 2^53 read exactly those points", async () => {
    for (const id of ["9007199254740993", "9223372036854775808", "18446744073709551615"]) {
      const result = await open.query(`GET /collections/docs/points/${id}`);
      assert(String(result.rows[0]?.id) === id, `point ${id} read as ${String(result.rows[0]?.id)}`);
    }
    await refused(() => open.query("GET /collections/docs/points/18446744073709551616"));
  });

  await check(
    "the documentation corpus answers through Studio as it answers over REST (gate 4 equivalence)",
    async () => {
      let compared = 0;
      for (const block of (qdrantDocs as { blocks: { file: string; text: string }[] }).blocks) {
        if (/"sample"\s*:\s*"random"/.test(block.text)) continue; // nondeterministic, excluded by name
        let studio: QueryResult;
        try {
          studio = await open.query(block.text);
        } catch {
          continue; // a refused or failing block is the refusal corpus's, below
        }
        const [line, ...body] = block.text.split("\n").filter((row) => !/^\s*(\/\/|#)/.test(row));
        const [method, target] = line.trim().split(/\s+/);
        const restBody = body.join("\n").replace(/\/\/[^\n"]*$/gm, "");
        const rest = await send(OPEN, method, target, restBody.trim() === "" ? undefined : restBody);
        assert(rest.status === 200, `${block.file}: Studio answered and REST answered ${rest.status}`);
        const restIds = restPointIds(parse(rest).result);
        if (restIds !== null) {
          const studioIds = studioPointIds(studio);
          assert(canonical(studioIds) === canonical(restIds), `${block.file}: hits differ`);
        }
        compared++;
      }
      measure("corpus-compared", compared);
      assert(compared > 0, "no documentation block was compared");
    },
  );

  await check(
    "the copy loop: every expected cell reads back exactly, and its copy searches its own vector",
    async () => {
      const { cells } = expectedCells as {
        cells: { collection: string; match: { value: number | string }; field: string; cell: unknown }[];
      };
      for (const cell of cells) {
        const column = cell.field === "" ? "vector" : `vector.${cell.field}`;
        const withVector = cell.field === "" ? "true" : JSON.stringify([cell.field]);
        const read = await open.query(
          `POST /collections/${cell.collection}/points\n{"ids": [${idText(cell.match.value)}], "with_vector": ${withVector}}`,
        );
        const value = read.rows[0]?.[column];
        const copied = formatCellCopy(value, { vector: read.vectorColumns?.[column] });
        const where = `${cell.collection} ${String(cell.match.value)} ${column}`;
        assert(canonical(JSON.parse(copied)) === canonical(cell.cell), `${where}: the copy differs`);
        // The copied text goes into the body as it is, so a float written `1.0` stays one (a parse would make it 1).
        const body = `{"query": ${copied}${cell.field === "" ? "" : `, "using": "${cell.field}"`}, "limit": 5}`;
        const path = `/collections/${cell.collection}/points/query`;
        if (JSON.stringify(cell.cell).includes("null")) {
          await refused(() => open.query(`POST ${path}\n${body}`)); // a float16 element that overflowed, refused by name
          continue;
        }
        const studio = await open.query(`POST ${path}\n${body}`);
        // A score that is not finite is excluded from the REST comparison by name (vector-family spec 7.3).
        if (studio.warnings?.some((warning) => /not (a )?finite/i.test(warning.message))) continue;
        const restIds = restPointIds(parse(await send(OPEN, "POST", path, body)).result) ?? [];
        assert(canonical(studioPointIds(studio)) === canonical(restIds), `${where}: hits differ from REST`);
      }
    },
  );

  await check("every refusal corpus is refused before the wire, and the listeners receive nothing", async () => {
    const authProvider = new QdrantProvider(connection("live-auth", 6343, ADMIN_KEY));
    await authProvider.connect();
    const hosted = (qdrantDocs as { blocks: { text: string }[] }).blocks.filter((block) =>
      NON_LOCAL_MODEL.test(block.text),
    );
    for (const block of hosted) {
      // Every collection the block names becomes the control, which the harness owns and verified above.
      await refused(() =>
        authProvider.query(block.text.replace(/\/collections\/[^/\s?]+/g, `/collections/${control}`)),
      );
    }
    for (const text of [
      'POST /collections/docs/points/scroll\n{"fliter": {"must": []}}',
      'POST /collections/docs/points/scroll\n{"filter": {"must_nto": []}}',
      'POST /collections/docs/points/scroll\n{"filter": {"must": [{"key": "n", "match": {"value": 1}, "rnage": {"gt": 0}}]}}',
      "GET /collections?api_key=x",
      'PUT /collections/docs/points\n{"points": []}',
      `POST /collections/${control}/snapshots/recover\n{"location": "http://host.docker.internal:${snapshotListener.port}/x.snapshot"}`,
      "GET /telemetry",
      "GET /collections/..",
    ]) {
      await refused(() => authProvider.query(text));
    }
    await authProvider.disconnect();
    assert(inference.received() === inferenceAfterControl, "the inference listener received a request from Studio");
    assert(
      snapshotListener.received() === snapshotAfterControl,
      "the snapshot listener received a request from Studio",
    );
  });

  await check("the credential and alias matrix on qdrant-auth", async () => {
    const opens = async (password: string) => {
      const provider = new QdrantProvider(connection("live-cred", 6343, password));
      try {
        await provider.connect();
        return "opened";
      } catch (error) {
        return (error as Error).message;
      } finally {
        await provider.disconnect().catch(() => undefined);
      }
    };
    assert((await opens(ADMIN_KEY)) === "opened", "the admin key did not open");
    assert((await opens(READ_ONLY_KEY)) === "opened", "the read-only key did not open");
    assert((await opens(mint({ access: "r", exp: LATER }))) === "opened", "a read JWT did not open");
    const expired = await opens(mint({ access: "r", exp: 1 }));
    assert(/the JWT has expired/i.test(expired), `an expired JWT answered: ${expired}`);
    assert(!expired.includes(ADMIN_KEY.slice(0, 12)), "a refusal holds part of the key");
    const aliasOnly = new QdrantProvider(
      connection("live-alias", 6343, mint({ access: [{ collection: "docs_alias", access: "r" }], exp: LATER })),
    );
    await aliasOnly.connect();
    const listed = await aliasOnly.query("GET /collections");
    assert(!JSON.stringify(listed.rows).includes('"docs"'), "an alias-only token listed docs");
    const throughAlias = await aliasOnly.query("GET /collections/docs_alias/points/42");
    assert(throughAlias.rows.length === 1, "an alias-only token did not read through its alias");
    await aliasOnly.disconnect();
  });

  await check("TLS and mutual TLS", async () => {
    const ca = key("ca.pem");
    const tls = new QdrantProvider(
      connection("live-tls", 6353, key("tls/read-only.key"), { mode: "verify-full", caCert: ca }),
    );
    await tls.connect();
    await tls.disconnect();
    const mtls = new QdrantProvider(
      connection("live-mtls", 6363, key("mtls/read-only.key"), {
        mode: "verify-full",
        caCert: ca,
        clientCert: key("client.pem"),
        clientKey: key("client.key"),
      }),
    );
    await mtls.connect();
    await mtls.disconnect();
    const noClientCert = new QdrantProvider(
      connection("live-mtls-none", 6363, key("mtls/read-only.key"), { mode: "verify-full", caCert: ca }),
    );
    let refusedHandshake = false;
    await noClientCert.connect().catch(() => {
      refusedHandshake = true;
    });
    assert(refusedHandshake, "the mutual TLS server accepted a connection with no client certificate");
  });

  await check("a slow scroll stops at the server timeout Studio sends", async () => {
    const slow = new QdrantProvider({ ...connection("live-qm4", 6333), queryTimeout: 3000 });
    await slow.connect();
    const should = Array.from({ length: 256 }, (_, at) => ({ key: "absent_key", match: { value: `no-match-${at}` } }));
    const started = Date.now();
    const outcome = await slow
      .query(`POST /collections/payload_spread/points/scroll\n${JSON.stringify({ filter: { should }, limit: 10 })}`)
      .then(
        () => "answered",
        (error: Error) => error.name,
      );
    measure("qm4-scroll", { outcome, elapsedMs: Date.now() - started });
    await slow.disconnect();
  });

  await open.disconnect();
  await auth.deleteCollection(control);
  inference.server.close();
  snapshotListener.server.close();
  const afterOpen = await snapshot(OPEN, "qdrant after");
  const afterAuth = await snapshot(AUTH, "qdrant-auth after");
  await check("every collection outside the prefix is unchanged on both servers", async () => {
    const classes = { stable: [...STABLE], volatile: [...VOLATILE] };
    assertUnchanged(compareSnapshots(beforeOpen, afterOpen, classes));
    assertUnchanged(compareSnapshots(beforeAuth, afterAuth, classes));
  });
  console.log(`END ${RUNTIME} passes=${passes} failures=${failures.length}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
