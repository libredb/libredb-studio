// Seeds the Weaviate servers 1.40.2/agent-boundary/run.sh started, sends the agent boundary plan, and writes one capture
// per request into 1.40.2/agent-boundary/.
//
//   node tests/fixtures/weaviate/agent-boundary-probe.mjs
//
// The environment carries WEAVIATE_URL (RBAC on), WEAVIATE_KEYONLY_URL (API keys, RBAC off), WEAVIATE_ANON_URL
// (anonymous access on), the two root keys WEAVIATE_ROOT and WEAVIATE_KEYONLY, generated per run, and WEAVIATE_EGRESS,
// the name of the listener container every module base URL points at. Every other key is created on the server by this
// script. A capture records the principal's name and role, never a key, and the script refuses to write a file that
// holds any key it saw. Every request is sent raw: no Studio check stands in front of it, which is the point, since
// what is measured is what the server does on its own.
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the server holds then.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = "1.40.2";
const image =
  "cr.weaviate.io/semitechnologies/weaviate:1.40.2@sha256:0083587dc01f33112e5406ce9b471df1abea480c71a0407af903929a389ae08a";
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, version, "agent-boundary");
mkdirSync(out, { recursive: true });
const capturedAt = new Date().toISOString().slice(0, 10);

const env = (name) => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
};
const servers = { rbac: env("WEAVIATE_URL"), keyonly: env("WEAVIATE_KEYONLY_URL"), anon: env("WEAVIATE_ANON_URL") };
const keys = { root: env("WEAVIATE_ROOT"), keyonly: env("WEAVIATE_KEYONLY") };
const egressContainer = env("WEAVIATE_EGRESS");

/** Every principal: the server it signs in to and what it may do, as a capture states it. */
const PRINCIPALS = {
  root: { server: "rbac", rights: "the RBAC root user" },
  viewer: { server: "rbac", rights: "db user holding the built-in viewer role" },
  admin: { server: "rbac", rights: "db user holding the built-in admin role" },
  widened: { server: "rbac", rights: "db user holding a custom role with read_data and update_data" },
  drift: { server: "rbac", rights: "db user holding a custom role, widened between two reads" },
  anonymous: { server: "rbac", rights: "no key, anonymous access off" },
  keyonly: { server: "keyonly", rights: "the one API key of a server with RBAC off" },
  "anonymous-open": { server: "anon", rights: "no key, anonymous access on" },
};

async function call(principal, method, path, body) {
  const key = keys[principal];
  const response = await fetch(`${servers[PRINCIPALS[principal].server]}${path}`, {
    method,
    headers: {
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, contentType: response.headers.get("content-type"), text: await response.text() };
}

/** A setup request as root, which must succeed. */
async function root(method, path, body) {
  const answer = await call("root", method, path, body);
  if (answer.status >= 300) throw new Error(`${method} ${path} answered ${answer.status}: ${answer.text}`);
  return answer.text === "" ? null : JSON.parse(answer.text);
}

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const vector = (n) => [0.1 * n, 0.2, 0.3, 0.4];

async function seed() {
  await root("POST", "/v1/schema", {
    class: "Note",
    vectorizer: "none",
    properties: [
      { name: "body", dataType: ["text"] },
      { name: "objectCount", dataType: ["text"] },
      { name: "meta", dataType: ["object"], nestedProperties: [{ name: "name", dataType: ["text"] }] },
    ],
  });
  for (const n of [1, 2, 3]) {
    await root("POST", "/v1/objects", {
      class: "Note",
      id: uuid(n),
      properties: { body: `stored-body-${n}`, objectCount: `stored-count-${n}`, meta: { name: `stored-nested-${n}` } },
      vector: vector(n),
    });
  }
  await root("POST", "/v1/schema", {
    class: "Doc",
    vectorizer: "text2vec-openai",
    moduleConfig: {
      "text2vec-openai": { baseURL: "http://egress:8000", vectorizeClassName: false },
      "generative-openai": { baseURL: "http://egress:8000" },
    },
    properties: [{ name: "body", dataType: ["text"] }],
  });
  for (const n of [11, 12]) {
    await root("POST", "/v1/objects", {
      class: "Doc",
      id: uuid(n),
      properties: { body: `doc-${n}` },
      vector: vector(n),
    });
  }
  for (const [name, auto] of [
    ["Tenanted", true],
    ["TenantedManual", false],
  ]) {
    await root("POST", "/v1/schema", {
      class: name,
      vectorizer: "none",
      multiTenancyConfig: { enabled: true, autoTenantActivation: auto },
      properties: [{ name: "body", dataType: ["text"] }],
    });
    await root("POST", `/v1/schema/${name}/tenants`, [{ name: "hot" }, { name: "cold" }]);
    for (const [tenant, n] of [
      ["hot", 21],
      ["cold", 22],
    ]) {
      await root("POST", "/v1/objects", {
        class: name,
        id: uuid(n),
        tenant,
        properties: { body: `tenant-${tenant}` },
        vector: vector(n),
      });
    }
  }
  await setCold("Tenanted");
  await setCold("TenantedManual");
  await root("POST", "/v1/aliases", { alias: "NotesAlias", class: "Note" });
}

async function setCold(collection) {
  await root("PUT", `/v1/schema/${collection}/tenants`, [{ name: "cold", activityStatus: "COLD" }]);
}

async function user(name, roles) {
  const created = await root("POST", `/v1/users/db/${name}`);
  keys[name] = created.apikey;
  await root("POST", `/v1/authz/users/${name}/assign`, { roles, userType: "db" });
}

async function principals() {
  await user("viewer", ["viewer"]);
  await user("admin", ["admin"]);
  await root("POST", "/v1/authz/roles", {
    name: "agent-widened",
    permissions: [
      { action: "read_data", data: { collection: "*" } },
      { action: "update_data", data: { collection: "*" } },
    ],
  });
  await user("widened", ["agent-widened"]);
  await root("POST", "/v1/authz/roles", {
    name: "agent-drift",
    permissions: [{ action: "read_collections", collections: { collection: "*" } }],
  });
  await user("drift", ["agent-drift"]);
}

function egressCount() {
  const logs = execFileSync("docker", ["logs", egressContainer], { encoding: "utf8" });
  return logs.split("\n").filter((line) => line.startsWith("EGRESS ")).length;
}

/** An answer with what changes run to run replaced: times, the server's own start and node statistics it counts. */
function stable(text) {
  return text
    .replace(/"(creationTimeUnix|lastUpdateTimeUnix)":\d+/g, '"$1":0')
    .replace(/"(lastUpdateTime|creationTime)":"\d+"/g, '"$1":"0"')
    .replace(/"tookMs":\d+/g, '"tookMs":0');
}

function assertNoKey(text, file) {
  for (const key of Object.values(keys)) {
    if (key !== undefined && text.includes(key)) throw new Error(`${file} would hold a key; nothing was written`);
  }
}

let written = 0;
async function capture(name, principal, method, path, body, note, measureEgress = false) {
  const before = measureEgress ? egressCount() : undefined;
  const answer = await call(principal, method, path, body);
  // The listener prints after it answers; give it a moment, so a late line is not counted as none.
  if (measureEgress) await new Promise((resolve) => setTimeout(resolve, 500));
  const after = measureEgress ? egressCount() : undefined;
  const file = {
    version,
    name: `agent-boundary/${name}`,
    image,
    capturedAt,
    principal: `${principal}: ${PRINCIPALS[principal].rights}`,
    ...(note === undefined ? {} : { note }),
    request: {
      method,
      path,
      ...(body === undefined ? {} : { body }),
      auth: keys[principal] === undefined ? "none" : "bearer",
    },
    status: answer.status,
    contentType: answer.contentType,
    body: stable(answer.text),
    ...(measureEgress ? { egressRequests: after - before } : {}),
  };
  const text = `${JSON.stringify(file, null, 2)}\n`;
  assertNoKey(text, name);
  writeFileSync(join(out, `${name}.json`), text);
  written += 1;
  return answer;
}

/** The 19 operations of the provider's client table, each as one request a read would send. */
const OPERATIONS = [
  ["meta", "GET", "/v1/meta"],
  ["schema", "GET", "/v1/schema"],
  ["collection", "GET", "/v1/schema/Note"],
  ["shards", "GET", "/v1/schema/Note/shards"],
  ["tenants", "GET", "/v1/schema/Tenanted/tenants"],
  ["tenant", "GET", "/v1/schema/Tenanted/tenants/hot"],
  ["aliases", "GET", "/v1/aliases"],
  ["alias", "GET", "/v1/aliases/NotesAlias"],
  ["nodes", "GET", "/v1/nodes?output=verbose"],
  ["collection-nodes", "GET", "/v1/nodes/Note?output=verbose"],
  ["objects", "GET", "/v1/objects?class=Note&limit=2&include=vector"],
  ["object", "GET", `/v1/objects/Note/${uuid(1)}?include=vector`],
  ["search-bm25", "POST", "/v1/search/Note/bm25", { query: "stored", limit: 2 }],
  ["search-hybrid", "POST", "/v1/search/Note/hybrid", { query: "stored", alpha: 0, limit: 2 }],
  ["search-near-vector", "POST", "/v1/search/Note/near-vector", { vector: vector(1), limit: 2 }],
  ["search-near-object", "POST", "/v1/search/Note/near-object", { id: uuid(1), limit: 2 }],
  ["aggregate", "POST", "/v1/aggregate/Note", {}],
  ["ready", "GET", "/v1/.well-known/ready"],
  ["graphql", "POST", "/v1/graphql", { query: "{ Aggregate { Note { meta { count } } } }" }],
];

async function main() {
  await seed();
  await principals();

  // The viewer proof: what each principal's own record says it holds.
  for (const principal of ["root", "viewer", "admin", "widened", "anonymous", "keyonly", "anonymous-open"]) {
    await capture(`own-info-${principal}`, principal, "GET", "/v1/users/own-info");
  }
  await capture(
    "own-info-drift-before",
    "drift",
    "GET",
    "/v1/users/own-info",
    undefined,
    "before update_data is added",
  );
  await root("POST", "/v1/authz/roles/agent-drift/add-permissions", {
    permissions: [{ action: "update_data", data: { collection: "*" } }],
  });
  await capture("own-info-drift-after", "drift", "GET", "/v1/users/own-info", undefined, "after update_data is added");

  for (const principal of ["root", "viewer", "anonymous"]) {
    for (const [op, method, path, body] of OPERATIONS) {
      await capture(`${op}-${principal}`, principal, method, path, body);
    }
  }

  // Tenant wake: Tenanted has autoTenantActivation on, TenantedManual off; both hold a COLD tenant `cold`.
  const tenantRecord = "/v1/schema/Tenanted/tenants/cold";
  await capture("wake-record-before", "viewer", "GET", tenantRecord, undefined, "the COLD tenant's own record");
  await capture("wake-record-again", "viewer", "GET", tenantRecord, undefined, "reading the record did not wake it");
  await capture("wake-aggregate", "viewer", "POST", "/v1/aggregate/Tenanted", { tenant: "cold" }, "a viewer's count");
  await capture("wake-record-after-aggregate", "viewer", "GET", tenantRecord, undefined, "after the viewer's count");
  await setCold("Tenanted");
  await capture("wake-objects", "viewer", "GET", "/v1/objects?class=Tenanted&tenant=cold&limit=1");
  await capture("wake-record-after-objects", "viewer", "GET", tenantRecord, undefined, "after the viewer's list");
  await setCold("Tenanted");
  await capture("wake-shards", "viewer", "GET", "/v1/schema/Tenanted/shards?tenant=cold");
  await capture("wake-record-after-shards", "viewer", "GET", tenantRecord, undefined, "after the viewer's shard read");
  await capture("manual-aggregate", "viewer", "POST", "/v1/aggregate/TenantedManual", { tenant: "cold" });
  await capture("manual-record-after", "viewer", "GET", "/v1/schema/TenantedManual/tenants/cold");

  // The viewer's writes, each sent past every Studio check, with the root user's same write as the positive control
  // and the count of Note before and after each.
  const write = { class: "Note", id: uuid(9), properties: { body: "probe-write" } };
  await capture("write-count-before", "viewer", "POST", "/v1/aggregate/Note", {});
  await capture("write-object-viewer", "viewer", "POST", "/v1/objects", write);
  await capture("write-count-after-viewer", "viewer", "POST", "/v1/aggregate/Note", {});
  await capture("write-tenant-viewer", "viewer", "PUT", "/v1/schema/TenantedManual/tenants", [
    { name: "hot", activityStatus: "COLD" },
  ]);
  await capture("write-tenant-after-viewer", "viewer", "GET", "/v1/schema/TenantedManual/tenants/hot");
  await capture("write-schema-viewer", "viewer", "DELETE", "/v1/schema/Doc");
  await capture("write-schema-after-viewer", "viewer", "GET", "/v1/schema/Doc");
  await capture("write-object-root", "root", "POST", "/v1/objects", write, "the positive control");
  await capture("write-count-after-root", "viewer", "POST", "/v1/aggregate/Note", {});
  await root("DELETE", `/v1/objects/Note/${uuid(9)}`);

  // Vectorizer and generative egress: Doc names text2vec-openai and generative-openai at the listener.
  const egress = [
    ["egress-hybrid-alpha-half", "POST", "/v1/search/Doc/hybrid", { query: "doc", alpha: 0.5, limit: 1 }],
    ["egress-hybrid-alpha-zero", "POST", "/v1/search/Doc/hybrid", { query: "doc", alpha: 0, limit: 1 }],
    ["egress-bm25", "POST", "/v1/search/Doc/bm25", { query: "doc", limit: 1 }],
    ["egress-near-object", "POST", "/v1/search/Doc/near-object", { id: uuid(11), limit: 1 }],
    ["egress-near-text", "POST", "/v1/search/Doc/near-text", { query: ["doc"], limit: 1 }],
    [
      "egress-graphql-near-text",
      "POST",
      "/v1/graphql",
      { query: '{ Get { Doc(nearText: {concepts: ["doc"]}, limit: 1) { body } } }' },
    ],
    [
      "egress-graphql-generate",
      "POST",
      "/v1/graphql",
      {
        query:
          '{ Get { Doc(limit: 1) { body _additional { generate(singleResult: {prompt: "say {body}"}) { singleResult error } } } } }',
      },
    ],
    ["egress-aggregate", "POST", "/v1/aggregate/Doc", {}],
  ];
  for (const [name, method, path, body] of egress) {
    await capture(name, "viewer", method, path, body, undefined, true);
  }
  console.log(`${written} captures written to ${out}`);
}

await main();
