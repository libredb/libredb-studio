/**
 * The Weaviate provider's scenarios (#1566 spec 7.3): what the evidence harness drives through the provider against
 * the live servers of docker/weaviate/README.md, and what the integration test replays from the captures it wrote.
 *
 * One list for both on purpose. A scenario is a service, a credential and the provider calls to make, in order; the
 * harness records every request the provider put on the wire with the answer it got, and the outcome of every call.
 * The integration test builds the same provider over a transport that answers from that record, makes the same
 * calls, and holds both the requests and the outcomes to it, so a change to any module that alters a request or what
 * the user sees fails by name. Pure data: importing this file opens nothing.
 */

/** The live servers, as the compose file publishes them. */
export const WEAVIATE_SERVICES = {
  weaviate: { port: 18280, version: "1.40.2", tls: false },
  "weaviate-1-38": { port: 18285, version: "1.38.22", tls: false },
  "weaviate-1-37": { port: 18281, version: "1.37.4", tls: false },
  "weaviate-nographql": { port: 18282, version: "1.40.2", tls: false },
  "weaviate-auth": { port: 18283, version: "1.40.2", tls: false },
  "weaviate-tls": { port: 18284, version: "1.40.2", tls: true },
} as const;

export type WeaviateService = keyof typeof WEAVIATE_SERVICES;

/**
 * Which key a scenario sends: none, the RBAC root key, the `viewer` user's key on that server, or a key the server
 * never issued. A fixture names the credential, never its value.
 */
export type WeaviateCredential = "none" | "root" | "reader" | "wrong";

export type WeaviateStep =
  | { readonly call: "query"; readonly text: string }
  | { readonly call: "listContainers" }
  | { readonly call: "countObjects" }
  | { readonly call: "listObjects" }
  | { readonly call: "describeObject"; readonly name: string }
  | { readonly call: "describeObjects"; readonly limit?: number }
  | { readonly call: "readObjectSource"; readonly name: string }
  | { readonly call: "getHealth" }
  | { readonly call: "getOverview" }
  | { readonly call: "getTableStats" }
  | { readonly call: "getIndexStats" }
  | { readonly call: "connectWarnings" };

export interface WeaviateScenario {
  readonly name: string;
  readonly service: WeaviateService;
  readonly credential: WeaviateCredential;
  /** TLS: `verify-ca` with the fixture's CA, or `disable` to send plain HTTP to the TLS port. */
  readonly ssl?: "verify-ca" | "disable";
  /** A seeded read-only connection, which the provider refuses without a key. */
  readonly readOnly?: boolean;
  readonly steps: readonly WeaviateStep[];
}

/** The 16 seeded floats every near-vector request sends to `Article`'s unnamed vector. */
export const ARTICLE_VECTOR: readonly number[] = [
  0.1, -0.2, 0.3, 0.4, -0.5, 0.6, 0.7, -0.8, 0.9, 0.1, 0.2, -0.3, 0.4, 0.5, -0.6, 0.7,
];

/** An `Article` id the seed writes on every server (a uuid5 of its fixed namespace). */
export const ARTICLE_ID = "9e6866af-ef70-5a5a-9b61-1ae7a41bad0d";

const v = JSON.stringify(ARTICLE_VECTOR);

/** The surface every server shows: the tree, the columns, the Source and the panels. */
const SURFACE: readonly WeaviateStep[] = [
  { call: "connectWarnings" },
  { call: "listContainers" },
  { call: "countObjects" },
  { call: "listObjects" },
  { call: "describeObjects" },
  { call: "describeObjects", limit: 2 },
  { call: "describeObject", name: "Article" },
  { call: "describeObject", name: "Product" },
  { call: "describeObject", name: "Author" },
  { call: "describeObject", name: "TenantNotes" },
  { call: "describeObject", name: "Empty" },
  { call: "readObjectSource", name: "Article" },
  { call: "readObjectSource", name: "Product" },
  { call: "readObjectSource", name: "TenantNotes" },
  { call: "readObjectSource", name: "TenantNotesAuto" },
  { call: "readObjectSource", name: "Empty" },
  { call: "getHealth" },
  { call: "getOverview" },
  { call: "getTableStats" },
  { call: "getIndexStats" },
];

/** The reads that never search: the same on every version. */
const READS: readonly WeaviateStep[] = [
  "GET /v1/meta",
  "GET /v1/schema",
  "GET /v1/schema/Article",
  "GET /v1/schema/Article/shards",
  "GET /v1/schema/TenantNotes/tenants",
  "GET /v1/schema/TenantNotes/tenants/acme",
  "GET /v1/schema/TenantNotes/tenants/initech",
  "GET /v1/aliases",
  "GET /v1/aliases/Articles",
  "GET /v1/nodes",
  "GET /v1/nodes?output=verbose",
  "GET /v1/nodes/Article?output=verbose",
  "GET /v1/objects?class=Article&limit=3",
  "GET /v1/objects?class=Article&limit=2&include=vector",
  "GET /v1/objects?class=Product&limit=1&include=vector",
  "GET /v1/objects?class=Author&limit=2",
  "GET /v1/objects?class=Empty",
  "GET /v1/objects?class=EdgeValues&limit=8",
  `GET /v1/objects/Article/${ARTICLE_ID}`,
  `GET /v1/objects/Article/${ARTICLE_ID}?include=vector`,
  "GET /v1/objects/Article/00000000-0000-0000-0000-000000000000",
  "GET /v1/objects?class=TenantNotes&limit=2&tenant=acme",
  "GET /v1/objects?class=TenantNotes&limit=2",
  "GET /v1/objects?class=TenantNotes&limit=2&tenant=initech",
  "GET /v1/objects?class=TenantNotesAuto&limit=2&tenant=umbrella",
  "GET /v1/objects?class=Missing&limit=2",
  "GET /v1/objects?class=Author&limit=2&offset=0",
  "GET /v1/objects?class=Author&limit=2&offset=2",
  "GET /v1/objects?class=Author&limit=2&sort=name",
  "GET /v1/objects?class=Author&limit=2&after=00000000-0000-0000-0000-000000000000",
  "GET /v1/schema/Missing",
].map((text) => ({ call: "query", text }) as const);

/** The searches and aggregates, written in the REST shape on every server. */
const SEARCHES: readonly WeaviateStep[] = [
  'POST /v1/search/Article/bm25 {"query": "vector", "limit": 3, "returnProperties": ["title", "wordCount"], "returnMetadata": ["score"]}',
  'POST /v1/search/Article/bm25 {"query": "vector", "where": {"path": ["category"], "operator": "Equal", "valueText": "alpha"}, "limit": 2, "returnProperties": ["title", "category"]}',
  'POST /v1/search/Article/bm25 {"query": "vector", "limit": 2}',
  `POST /v1/search/Article/near-vector {"vector": ${v}, "limit": 2, "returnProperties": ["title"], "returnMetadata": ["distance"]}`,
  `POST /v1/search/Article/near-vector {"vector": ${v}, "limit": 1, "includeVector": true}`,
  `POST /v1/search/Article/near-object {"id": "${ARTICLE_ID}", "limit": 2, "returnProperties": ["title"], "returnMetadata": ["distance"]}`,
  'POST /v1/search/Article/hybrid {"query": "vector", "alpha": 0, "limit": 2, "returnProperties": ["title"]}',
  'POST /v1/search/Product/near-vector {"vector": [0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8], "targetVector": "image", "limit": 1, "returnProperties": ["name"]}',
  'POST /v1/search/TenantNotes/bm25 {"query": "note", "tenant": "acme", "limit": 2}',
  'POST /v1/search/EdgeValues/bm25 {"query": "9007199254740991", "returnProperties": ["label", "big"]}',
  'POST /v1/search/Product/bm25 {"query": "product", "limit": 2, "returnProperties": ["name"]}',
  'POST /v1/search/Missing/bm25 {"query": "x"}',
  "POST /v1/aggregate/Article {}",
  "POST /v1/aggregate/Article",
  'POST /v1/aggregate/Article {"groupBy": "category"}',
  'POST /v1/aggregate/TenantNotes {"tenant": "acme"}',
  'POST /v1/aggregate/TenantNotes {"tenant": "initech"}',
  "POST /v1/aggregate/Empty {}",
  'POST /v1/aggregate/Article {"where": {"path": ["location"], "operator": "WithinGeoRange", "valueGeoRange": {"geoCoordinates": {"latitude": 41, "longitude": 29}, "distance": {"max": 3000000}}}}',
  'POST /v1/aggregate/Article {"where": {"operator": "And", "operands": [{"path": ["published"], "operator": "Equal", "valueBoolean": true}, {"path": ["location"], "operator": "WithinGeoRange", "valueGeoRange": {"geoCoordinates": {"latitude": 41, "longitude": 29}, "distance": {"max": 3000000}}}]}}',
  'POST /v1/search/Article/bm25 {"query": "vector", "where": {"path": ["tags"], "operator": "ContainsAny", "valueTextArray": ["graph", "shard"]}, "limit": 50, "returnProperties": ["title"]}',
].map((text) => ({ call: "query", text }) as const);

/** What is refused before anything is sent: a fixture of these holds no request at all. */
const REFUSALS: readonly WeaviateStep[] = [
  'POST /v1/search/Article/hybrid {"query": "vector", "alpha": 0.5}',
  'POST /v1/search/Article/hybrid {"query": "vector"}',
  'POST /v1/search/Article/bm25 {"query": "x", "wher": {}}',
  'POST /v1/search/Article/near-text {"concepts": ["x"]}',
  "DELETE /v1/schema/Article",
  "POST /v1/objects {}",
  "GET /v1/backups/filesystem",
  "GET /v1/objects?class=TenantNotes&limit=2&tenant=nobody",
].map((text) => ({ call: "query", text }) as const);

export const WEAVIATE_SCENARIOS: readonly WeaviateScenario[] = [
  { name: "surface", service: "weaviate", credential: "none", steps: SURFACE },
  { name: "reads", service: "weaviate", credential: "none", steps: READS },
  { name: "searches", service: "weaviate", credential: "none", steps: SEARCHES },
  { name: "refusals", service: "weaviate", credential: "none", steps: REFUSALS },
  { name: "surface", service: "weaviate-1-38", credential: "none", steps: SURFACE },
  { name: "searches", service: "weaviate-1-38", credential: "none", steps: SEARCHES },
  { name: "surface", service: "weaviate-1-37", credential: "none", steps: SURFACE },
  { name: "reads", service: "weaviate-1-37", credential: "none", steps: READS },
  { name: "searches", service: "weaviate-1-37", credential: "none", steps: SEARCHES },
  { name: "surface", service: "weaviate-nographql", credential: "none", steps: SURFACE },
  { name: "searches", service: "weaviate-nographql", credential: "none", steps: SEARCHES },
  {
    name: "reader",
    service: "weaviate-auth",
    credential: "reader",
    steps: [
      { call: "connectWarnings" },
      { call: "listObjects" },
      { call: "readObjectSource", name: "Article" },
      { call: "getOverview" },
      { call: "getTableStats" },
      { call: "query", text: "GET /v1/objects?class=Article&limit=2" },
      { call: "query", text: 'POST /v1/search/Article/bm25 {"query": "vector", "limit": 2}' },
      { call: "query", text: "POST /v1/aggregate/Article {}" },
    ],
  },
  { name: "root", service: "weaviate-auth", credential: "root", steps: [{ call: "listObjects" }] },
  { name: "wrong-key", service: "weaviate-auth", credential: "wrong", steps: [] },
  { name: "no-key", service: "weaviate-auth", credential: "none", steps: [] },
  {
    name: "reader",
    service: "weaviate-tls",
    credential: "reader",
    ssl: "verify-ca",
    steps: [{ call: "listObjects" }, { call: "query", text: "GET /v1/objects?class=Article&limit=1" }],
  },
  { name: "plain-to-tls", service: "weaviate-tls", credential: "none", ssl: "disable", steps: [] },
];

/** A scenario's fixture path under tests/fixtures/weaviate/. */
export function scenarioFile(scenario: WeaviateScenario): string {
  return `${scenario.service}/${scenario.name}.json`;
}
