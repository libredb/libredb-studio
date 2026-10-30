// Seeds the Qdrant servers 1.19.1/agent-boundary/run.sh started, sends the agent boundary plan, and writes one capture
// per request into 1.19.1/agent-boundary/.
//
//   node tests/fixtures/qdrant/agent-boundary-probe.mjs
//
// The environment carries QDRANT_URL (an API key, a read-only API key and JWT RBAC), QDRANT_OPEN_URL (no key at all),
// the two keys QDRANT_FULL and QDRANT_READ_ONLY, generated per run, and QDRANT_EGRESS, the name of the listener
// container the inference address points at. Every JWT is minted here, HS256 with the API key, as the server checks
// them. A capture records the principal's name and rights, never a key or a token, and the script refuses to write a
// file that holds any key or token it used. Every request is sent raw: no Studio check stands in front of it, which is
// the point, since what is measured is what the server does on its own.
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the server holds then.
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = "1.19.1";
const image =
  "ghcr.io/qdrant/qdrant/qdrant:v1.19.1@sha256:808d42530f48a2b88abe960165ffe81e9ec71f505d72e6404145444e0e085822";
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, version, "agent-boundary");
mkdirSync(out, { recursive: true });
const capturedAt = new Date().toISOString().slice(0, 10);

const env = (name) => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
};
const servers = { auth: env("QDRANT_URL"), open: env("QDRANT_OPEN_URL") };
const full = env("QDRANT_FULL");
const egressContainer = env("QDRANT_EGRESS");

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A JWT the server accepts: HS256, signed with its API key. */
function jwt(claims) {
  const signed = `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url(claims)}`;
  return `${signed}.${createHmac("sha256", full).update(signed).digest("base64url")}`;
}

/** Every principal: the server it signs in to, its secret and what it may do, as a capture states it. */
const PRINCIPALS = {
  full: { server: "auth", key: full, rights: "the server's API key" },
  "read-only": { server: "auth", key: env("QDRANT_READ_ONLY"), rights: "the server's read-only API key" },
  "jwt-read": { server: "auth", key: jwt({ access: "r" }), rights: 'a JWT whose access claim is "r"' },
  "jwt-manage": { server: "auth", key: jwt({ access: "m" }), rights: 'a JWT whose access claim is "m"' },
  "jwt-collection-read": {
    server: "auth",
    key: jwt({ access: [{ collection: "plain", access: "r" }] }),
    rights: 'a JWT whose access claim is [{"collection":"plain","access":"r"}]',
  },
  "jwt-collection-write": {
    server: "auth",
    key: jwt({ access: [{ collection: "plain", access: "rw" }] }),
    rights: 'a JWT whose access claim is [{"collection":"plain","access":"rw"}]',
  },
  "jwt-no-access": { server: "auth", key: jwt({}), rights: "a JWT with no access claim" },
  anonymous: { server: "auth", key: undefined, rights: "no key, on the server with keys" },
  "open-anonymous": { server: "open", key: undefined, rights: "no key, on a server with no key configured" },
  "open-key": { server: "open", key: "not-a-real-key", rights: "a made-up key, on a server with no key configured" },
};
const SECRETS = Object.values(PRINCIPALS)
  .map((principal) => principal.key)
  .filter((key) => key !== undefined && key !== "not-a-real-key");

async function call(principal, method, path, body) {
  const { server, key } = PRINCIPALS[principal];
  const response = await fetch(`${servers[server]}${path}`, {
    method,
    headers: {
      ...(key === undefined ? {} : { "api-key": key }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, contentType: response.headers.get("content-type"), text: await response.text() };
}

/** A setup request with the API key, which must succeed. */
async function admin(server, method, path, body) {
  const principal = server === "auth" ? "full" : "open-anonymous";
  const answer = await call(principal, method, path, body);
  if (answer.status >= 300) throw new Error(`${method} ${path} answered ${answer.status}: ${answer.text}`);
  return JSON.parse(answer.text).result;
}

async function seed(server) {
  await admin(server, "PUT", "/collections/plain", { vectors: { size: 4, distance: "Dot" } });
  await admin(server, "PUT", "/collections/plain/points?wait=true", {
    points: [1, 2, 3].map((n) => ({
      id: n,
      vector: [0.1 * n, 0.2, 0.3, 0.4],
      payload: { city: `stored-city-${n}`, note: `stored-note-${n}`, meta: { name: `stored-nested-${n}` } },
    })),
  });
  await admin(server, "PUT", "/collections/plain/index?wait=true", { field_name: "city", field_schema: "keyword" });
  await admin(server, "PUT", "/collections/docs", {
    vectors: { text: { size: 4, distance: "Cosine" } },
    sparse_vectors: { keywords: {} },
  });
  await admin(server, "PUT", "/collections/docs/points?wait=true", {
    points: [11, 12].map((n) => ({
      id: n,
      vector: { text: [0.1 * n, 0.2, 0.3, 0.4], keywords: { indices: [1, 7], values: [0.5, 0.25] } },
      payload: { meta: { name: `stored-doc-${n}` } },
    })),
  });
  await admin(server, "PUT", "/collections/docs/index?wait=true", { field_name: "meta.name", field_schema: "keyword" });
  await admin(server, "PUT", "/collections/other", { vectors: { size: 4, distance: "Dot" } });
  await admin(server, "PUT", "/collections/other/points?wait=true", {
    points: [{ id: 21, vector: [0.1, 0.2, 0.3, 0.4], payload: { city: "stored-other" } }],
  });
  await admin(server, "POST", "/collections/aliases", {
    actions: [{ create_alias: { collection_name: "plain", alias_name: "plain_alias" } }],
  });
}

function egressCount() {
  const logs = execFileSync("docker", ["logs", egressContainer], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return logs.split("\n").filter((line) => line.startsWith("EGRESS ")).length;
}

function write(name, principal, method, path, body, answer, extra = {}) {
  const capture = {
    version,
    name: `agent-boundary/${name}`,
    image,
    capturedAt,
    principal: `${principal}: ${PRINCIPALS[principal].rights}`,
    request: {
      method,
      path,
      auth: PRINCIPALS[principal].key === undefined ? "none" : "api-key",
      ...(body === undefined ? {} : { body }),
    },
    status: answer.status,
    contentType: answer.contentType,
    body: answer.text,
    ...extra,
  };
  const text = `${JSON.stringify(capture, null, 2)}\n`;
  for (const secret of SECRETS) {
    if (text.includes(secret)) throw new Error(`${name} would hold a key or a token; nothing was written`);
  }
  writeFileSync(join(out, `${name}.json`), text);
  return answer;
}

/** Sends one request as `principal` and records it as `<name>-<principal>`. */
async function capture(name, principal, method, path, body) {
  return write(`${name}-${principal}`, principal, method, path, body, await call(principal, method, path, body));
}

const vector = [0.1, 0.2, 0.3, 0.4];

/** The client's 17 read routes, each as the console writes it, on the seeded collection `plain`. */
const READS = [
  ["root", "GET", "/"],
  ["collections", "GET", "/collections"],
  ["collection", "GET", "/collections/plain"],
  ["exists", "GET", "/collections/plain/exists"],
  ["aliases", "GET", "/aliases"],
  ["collection-aliases", "GET", "/collections/plain/aliases"],
  ["points", "POST", "/collections/plain/points", { ids: [1], with_payload: true, with_vector: true }],
  ["point", "GET", "/collections/plain/points/1"],
  ["scroll", "POST", "/collections/plain/points/scroll", { limit: 3, with_payload: true, with_vector: true }],
  ["count", "POST", "/collections/plain/points/count", { exact: true }],
  ["facet", "POST", "/collections/plain/facet", { key: "city" }],
  ["query", "POST", "/collections/plain/points/query", { query: vector, with_payload: true }],
  ["query-batch", "POST", "/collections/plain/points/query/batch", { searches: [{ query: vector }] }],
  ["query-groups", "POST", "/collections/plain/points/query/groups", { query: vector, group_by: "city" }],
  ["optimizations", "GET", "/collections/plain/optimizations"],
  ["snapshots", "GET", "/collections/plain/snapshots"],
  ["cluster", "GET", "/collections/plain/cluster"],
];

/** The two no-op writes the read-only proof sends: an empty alias update, and an empty point delete per collection. */
const PROOF_ALIAS = ["proof-alias", "POST", "/collections/aliases", { actions: [] }];
const proofDelete = (collection) => [
  `proof-delete-${collection}`,
  "POST",
  `/collections/${collection}/points/delete`,
  { points: [] },
];

/** Writes a read-only principal must be refused, each a real change were it admitted. */
const WRITES = [
  [
    "write-upsert",
    "PUT",
    "/collections/plain/points?wait=true",
    { points: [{ id: 99, vector, payload: { city: "written" } }] },
  ],
  ["write-delete-points", "POST", "/collections/plain/points/delete?wait=true", { points: [1] }],
  ["write-set-payload", "POST", "/collections/plain/points/payload?wait=true", { payload: { x: 1 }, points: [1] }],
  ["write-snapshot", "POST", "/collections/plain/snapshots"],
  ["write-storage-snapshot", "POST", "/snapshots"],
  ["write-optimizers", "PATCH", "/collections/plain", { optimizers_config: { indexing_threshold: 100 } }],
  [
    "write-cluster",
    "POST",
    "/collections/plain/cluster",
    { replicate_shard: { shard_id: 0, from_peer_id: 1, to_peer_id: 2 } },
  ],
  ["write-create-collection", "PUT", "/collections/created", { vectors: { size: 4, distance: "Dot" } }],
  ["write-delete-collection", "DELETE", "/collections/other"],
  [
    "write-alias",
    "POST",
    "/collections/aliases",
    { actions: [{ create_alias: { collection_name: "plain", alias_name: "written_alias" } }] },
  ],
  ["write-index", "PUT", "/collections/plain/index?wait=true", { field_name: "note", field_schema: "keyword" }],
];

/** Queries whose body names an inference object, each of which the server hands its inference address. */
const INFERENCE = [
  ["inference-document", { query: { text: "stored text", model: "not-a-real-model" } }],
  ["inference-image", { query: { image: "http://egress:8000/x.png", model: "not-a-real-model" } }],
  ["inference-object", { query: { object: { a: 1 }, model: "not-a-real-model" } }],
  ["inference-prefetch", { prefetch: [{ query: { text: "stored text", model: "not-a-real-model" } }], query: vector }],
  ["inference-none", { query: vector }],
];

const countAs = (name) => capture(name, "full", "POST", "/collections/plain/points/count", { exact: true });

async function main() {
  await seed("auth");
  await seed("open");

  for (const principal of ["full", "read-only", "jwt-read", "jwt-collection-read", "anonymous"]) {
    for (const [name, method, path, body] of READS) await capture(name, principal, method, path, body);
  }
  await capture("collection-docs", "read-only", "GET", "/collections/docs");
  await capture("collection-other", "jwt-collection-read", "GET", "/collections/other");
  await capture("count-other", "jwt-collection-read", "POST", "/collections/other/points/count", { exact: true });
  await capture("collections", "jwt-collection-write", "GET", "/collections");

  for (const principal of Object.keys(PRINCIPALS)) {
    for (const [name, method, path, body] of [PROOF_ALIAS, proofDelete("plain"), proofDelete("other")]) {
      await capture(name, principal, method, path, body);
    }
  }
  await capture("collections", "open-anonymous", "GET", "/collections");

  await countAs("write-count-before");
  for (const principal of ["read-only", "jwt-read", "jwt-collection-read"]) {
    for (const [name, method, path, body] of WRITES) await capture(name, principal, method, path, body);
  }
  await countAs("write-count-after-refused");
  await capture("write-state-collections-after", "full", "GET", "/collections");
  await capture("write-state-aliases-after", "full", "GET", "/aliases");
  await capture("write-state-collection-after", "full", "GET", "/collections/plain");

  // The positive controls: the API key's and a collection-scoped rw JWT's same upsert is answered and moves the count.
  await capture("write-upsert", "full", ...WRITES[0].slice(1));
  await countAs("write-count-after-full");
  await capture("write-upsert", "jwt-collection-write", "PUT", "/collections/plain/points?wait=true", {
    points: [{ id: 98, vector, payload: { city: "written" } }],
  });
  await countAs("write-count-after-collection-write");
  await admin("auth", "POST", "/collections/plain/points/delete?wait=true", { points: [98, 99] });
  await countAs("write-count-restored");

  for (const [name, body] of INFERENCE) {
    const before = egressCount();
    const answer = await call("read-only", "POST", "/collections/plain/points/query", body);
    // The listener prints its line as the request arrives; give the log a moment to show it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    write(`${name}-read-only`, "read-only", "POST", "/collections/plain/points/query", body, answer, {
      egressRequests: egressCount() - before,
    });
  }
}

await main();
