// Seeds the Weaviate server 1.40.2/data-scope/run.sh started, sends the data-scope plan as a broad and a narrow
// principal, and writes one capture per request into 1.40.2/data-scope/.
//
//   node tests/fixtures/weaviate/data-scope-probe.mjs
//
// The environment carries WEAVIATE_URL (RBAC on) and its root key WEAVIATE_ROOT, generated per run. Every other key is
// created on the server by this script. A capture records the principal's name and role, never a key, and the script
// refuses to write a file that holds any key it saw. Every request is sent raw: no Studio check stands in front of it,
// since what is measured is what the server itself lets each principal see.
//
// The question it answers: which names a key that passes the agent's viewer proof reads beyond the collections,
// tenants and aliases its role grants. The broad principal holds the built-in viewer role; the narrow one a custom
// role holding only viewer actions, scoped to the collection Note, the tenant acme of Tenanted, the alias NotesAlias
// and the node reads of Note and Tenanted.
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the server holds then.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = "1.40.2";
const image =
  "cr.weaviate.io/semitechnologies/weaviate:1.40.2@sha256:0083587dc01f33112e5406ce9b471df1abea480c71a0407af903929a389ae08a";
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, version, "data-scope");
mkdirSync(out, { recursive: true });
const capturedAt = new Date().toISOString().slice(0, 10);

const env = (name) => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
};
const server = env("WEAVIATE_URL");
const keys = { root: env("WEAVIATE_ROOT") };

/** Every principal and what it may do, as a capture states it. */
const PRINCIPALS = {
  root: "the RBAC root user",
  viewer: "db user holding the built-in viewer role",
  scoped:
    "db user holding a custom role of viewer actions only: read_collections on Note and Tenanted, read_tenants on Tenanted/acme, read_aliases on NotesAlias, read_nodes verbose on Note and Tenanted, read_data on Note and Tenanted/acme",
};

async function call(principal, method, path, body) {
  const response = await fetch(`${server}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${keys[principal]}`,
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

const vector = (n) => [0.1 * n, 0.2, 0.3, 0.4];

async function seed() {
  for (const name of ["Note", "Doc"]) {
    await root("POST", "/v1/schema", {
      class: name,
      vectorizer: "none",
      properties: [{ name: "body", dataType: ["text"] }],
    });
    for (const n of [1, 2, 3]) {
      await root("POST", "/v1/objects", {
        class: name,
        properties: { body: `stored-${name}-${n}` },
        vector: vector(n),
      });
    }
  }
  await root("POST", "/v1/schema", {
    class: "Tenanted",
    vectorizer: "none",
    multiTenancyConfig: { enabled: true, autoTenantActivation: false },
    properties: [{ name: "body", dataType: ["text"] }],
  });
  await root("POST", "/v1/schema/Tenanted/tenants", [{ name: "acme" }, { name: "globex" }, { name: "initech" }]);
  for (const [tenant, n] of [
    ["acme", 1],
    ["globex", 2],
    ["globex", 3],
  ]) {
    await root("POST", "/v1/objects", {
      class: "Tenanted",
      tenant,
      properties: { body: `stored-${tenant}-${n}` },
      vector: vector(n),
    });
  }
  await root("POST", "/v1/aliases", { alias: "NotesAlias", class: "Note" });
  await root("POST", "/v1/aliases", { alias: "DocsAlias", class: "Doc" });
}

async function user(name, roles) {
  const created = await root("POST", `/v1/users/db/${name}`);
  keys[name] = created.apikey;
  await root("POST", `/v1/authz/users/${name}/assign`, { roles, userType: "db" });
}

async function principals() {
  await user("viewer", ["viewer"]);
  await root("POST", "/v1/authz/roles", {
    name: "agent-scoped",
    permissions: [
      { action: "read_collections", collections: { collection: "Note" } },
      { action: "read_collections", collections: { collection: "Tenanted" } },
      { action: "read_tenants", tenants: { collection: "Tenanted", tenant: "acme" } },
      { action: "read_aliases", aliases: { alias: "NotesAlias", collection: "Note" } },
      { action: "read_nodes", nodes: { verbosity: "verbose", collection: "Note" } },
      { action: "read_nodes", nodes: { verbosity: "verbose", collection: "Tenanted" } },
      { action: "read_data", data: { collection: "Note" } },
      { action: "read_data", data: { collection: "Tenanted", tenant: "acme" } },
    ],
  });
  await user("scoped", ["agent-scoped"]);
}

/** An answer with what changes run to run replaced: times and the random names of single-tenant shards. */
function stable(text) {
  return text
    .replace(/"tookMs":\d+/g, '"tookMs":0')
    .replace(/"name":"[A-Za-z0-9]{12}"/g, '"name":"<shard>"')
    .replace(/"gitHash":"[0-9a-f]+"/g, '"gitHash":"<git>"');
}

function assertNoKey(text, file) {
  for (const key of Object.values(keys)) {
    if (key !== undefined && text.includes(key)) throw new Error(`${file} would hold a key; nothing was written`);
  }
}

let written = 0;
async function capture(name, principal, method, path, body) {
  const answer = await call(principal, method, path, body);
  const file = {
    version,
    name: `data-scope/${name}`,
    image,
    capturedAt,
    principal: `${principal}: ${PRINCIPALS[principal]}`,
    request: { method, path, ...(body === undefined ? {} : { body }), auth: "bearer" },
    status: answer.status,
    contentType: answer.contentType,
    body: stable(answer.text),
  };
  const text = `${JSON.stringify(file, null, 2)}\n`;
  assertNoKey(text, name);
  writeFileSync(join(out, `${name}.json`), text);
  written += 1;
}

/** Each read the agent may send, aimed inside and outside the narrow principal's grants. */
const READS = [
  ["own-info", "GET", "/v1/users/own-info"],
  ["schema", "GET", "/v1/schema"],
  ["collection-doc", "GET", "/v1/schema/Doc"],
  ["shards-doc", "GET", "/v1/schema/Doc/shards"],
  ["tenants", "GET", "/v1/schema/Tenanted/tenants"],
  ["tenant-globex", "GET", "/v1/schema/Tenanted/tenants/globex"],
  ["shards-globex", "GET", "/v1/schema/Tenanted/shards?tenant=globex"],
  ["aliases", "GET", "/v1/aliases"],
  ["alias-docs", "GET", "/v1/aliases/DocsAlias"],
  ["nodes", "GET", "/v1/nodes"],
  ["nodes-verbose", "GET", "/v1/nodes?output=verbose"],
  ["collection-nodes-doc", "GET", "/v1/nodes/Doc?output=verbose"],
  ["collection-nodes-tenanted", "GET", "/v1/nodes/Tenanted?output=verbose"],
  ["aggregate-doc", "POST", "/v1/aggregate/Doc", {}],
  ["aggregate-globex", "POST", "/v1/aggregate/Tenanted", { tenant: "globex" }],
];

async function main() {
  await seed();
  await principals();
  for (const principal of ["viewer", "scoped"]) {
    for (const [name, method, path, body] of READS) {
      await capture(`${name}-${principal}`, principal, method, path, body);
    }
  }
  console.log(`${written} captures written to ${out}`);
}

await main();
