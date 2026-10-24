/**
 * The Weaviate provider's path parity check (#1566 spec 3.3): the same console request on 1.40.2, which answers
 * it over REST search, and on 1.38.22 and 1.37.4, which answer it over GraphQL, compared row for row once the
 * path note is set aside. Every where operator and value type, every search kind, the aggregate with and without
 * groupBy, and the metadata cell types. It caught the GraphQL spelling of a value list (valueText, never
 * valueTextArray) and the 1.37 line's WithinGeoRange aggregate count of 0.
 *
 * Two differences are the servers' own and are expected: a grouped aggregate's groups come in no defined order (and
 * where counts tie, a limit picks any of them), and 1.37 counts a WithinGeoRange aggregate as 0, which the provider
 * notes. Anything else fails the run.
 *
 * Run by hand, never by `bun run test`, from a process that reaches the compose service names (the servers of
 * docker/weaviate/README.md, `weaviate`, `weaviate-1-38` and `weaviate-1-37`):
 *   bun tests/live/weaviate-path-parity.ts
 */
import { WeaviateProvider } from "@/lib/db/providers/vector/weaviate";

const SERVERS = [
  ["1.40 REST", "weaviate"],
  ["1.38 GraphQL", "weaviate-1-38"],
  ["1.37 GraphQL", "weaviate-1-37"],
] as const;
const V16 = "[0.1, -0.2, 0.3, 0.4, -0.5, 0.6, 0.7, -0.8, 0.9, 0.1, 0.2, -0.3, 0.4, 0.5, -0.6, 0.7]";
const W = (where: string) => `"where": ${where}`;
const FILTERS = [
  '{"path": ["category"], "operator": "Equal", "valueText": "alpha"}',
  '{"path": ["category"], "operator": "NotEqual", "valueText": "alpha"}',
  '{"path": ["wordCount"], "operator": "GreaterThan", "valueInt": 400}',
  '{"path": ["wordCount"], "operator": "GreaterThanEqual", "valueInt": 400}',
  '{"path": ["wordCount"], "operator": "LessThan", "valueInt": 120}',
  '{"path": ["wordCount"], "operator": "LessThanEqual", "valueInt": 120}',
  '{"path": ["rating"], "operator": "GreaterThan", "valueNumber": 3.5}',
  '{"path": ["published"], "operator": "Equal", "valueBoolean": false}',
  '{"path": ["publishedAt"], "operator": "LessThan", "valueDate": "2026-01-01T00:00:00Z"}',
  '{"path": ["title"], "operator": "Like", "valueText": "article 0*"}',
  '{"path": ["tags"], "operator": "ContainsAny", "valueTextArray": ["graph", "shard"]}',
  '{"path": ["tags"], "operator": "ContainsAll", "valueTextArray": ["graph", "vector"]}',
  '{"path": ["location"], "operator": "WithinGeoRange", "valueGeoRange": {"geoCoordinates": {"latitude": 41, "longitude": 29}, "distance": {"max": 3000000}}}',
  '{"operator": "And", "operands": [{"path": ["category"], "operator": "Equal", "valueText": "beta"}, {"path": ["wordCount"], "operator": "GreaterThan", "valueInt": 300}]}',
  '{"operator": "Or", "operands": [{"path": ["category"], "operator": "Equal", "valueText": "beta"}, {"path": ["category"], "operator": "Equal", "valueText": "gamma"}]}',
  '{"operator": "Not", "operands": [{"path": ["category"], "operator": "Equal", "valueText": "beta"}]}',
  '{"operator": "And", "operands": [{"operator": "Or", "operands": [{"path": ["published"], "operator": "Equal", "valueBoolean": true}, {"path": ["rating"], "operator": "LessThan", "valueNumber": 1}]}, {"path": ["title"], "operator": "Like", "valueText": "*vector*"}]}',
];
const REQUESTS: string[] = [];
for (const f of FILTERS) {
  REQUESTS.push(
    `POST /v1/search/Article/bm25 {"query": "vector", ${W(f)}, "limit": 50, "returnProperties": ["title"]}`,
  );
  REQUESTS.push(`POST /v1/aggregate/Article {${W(f)}}`);
  REQUESTS.push(
    `POST /v1/search/Article/near-vector {"vector": ${V16}, ${W(f)}, "limit": 20, "returnProperties": ["title"], "returnMetadata": ["distance"]}`,
  );
}
REQUESTS.push(
  'POST /v1/search/Article/bm25 {"query": "vector graph", "limit": 30, "returnProperties": ["title", "wordCount", "rating", "published", "publishedAt", "tags", "category"], "returnMetadata": ["score", "creationTime", "lastUpdateTime"]}',
  'POST /v1/search/Article/bm25 {"query": "vector", "queryProperties": ["title"], "limit": 30}',
  'POST /v1/search/Article/bm25 {"query": "vector", "limit": 10, "offset": 5}',
  'POST /v1/search/Article/bm25 {"query": "vector", "autoLimit": 1}',
  'POST /v1/search/Article/hybrid {"query": "vector", "alpha": 0, "limit": 25, "returnProperties": ["title"]}',
  'POST /v1/search/Article/hybrid {"query": "vector", "alpha": 0, "queryProperties": ["body"], "limit": 25}',
  `POST /v1/search/Article/near-vector {"vector": ${V16}, "limit": 25, "returnMetadata": ["distance", "certainty"]}`,
  `POST /v1/search/Article/near-vector {"vector": ${V16}, "distance": 0.8, "limit": 100}`,
  'POST /v1/search/Article/near-object {"id": "9e6866af-ef70-5a5a-9b61-1ae7a41bad0d", "limit": 25, "returnMetadata": ["distance"]}',
  'POST /v1/search/Product/near-vector {"vector": [0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8], "targetVector": "image", "limit": 25, "returnProperties": ["name", "price", "sku"]}',
  `POST /v1/search/Product/near-vector {"vector": ${V16}, "targetVector": "text", "limit": 25}`,
  'POST /v1/search/Product/bm25 {"query": "product", "limit": 25}',
  'POST /v1/search/TenantNotes/bm25 {"query": "note", "tenant": "globex", "limit": 25}',
  'POST /v1/search/EdgeValues/bm25 {"query": "edge", "returnProperties": ["label", "big", "bigs"]}',
  'POST /v1/search/Author/bm25 {"query": "author", "limit": 25}',
  "POST /v1/aggregate/Article {}",
  'POST /v1/aggregate/Article {"groupBy": "category"}',
  'POST /v1/aggregate/Article {"groupBy": "category", "limit": 3}',
  'POST /v1/aggregate/Product {"groupBy": "name", "limit": 1000}',
  'POST /v1/aggregate/TenantNotes {"tenant": "acme"}',
  'POST /v1/aggregate/TenantNotesAuto {"tenant": "hooli", "groupBy": "note"}',
);

type Row = Record<string, unknown>;
const canonical = (rows: Row[], fields: string[]) =>
  rows.map((row) => JSON.stringify(fields.map((f) => [f, row[f]]))).sort();
const providers = await Promise.all(
  SERVERS.map(async ([, host]) => {
    const p = new WeaviateProvider({ id: host, name: host, type: "weaviate", host, port: 8080 } as never);
    await p.connect();
    return p;
  }),
);
let same = 0;
const differ: string[] = [];
let unexpected = 0;
/** The servers' own differences: a grouped aggregate's order and tie-breaking, and 1.37's geo aggregate. */
const expectedDifference = (text: string, problem: string) =>
  (/"groupBy"/.test(text) && /other order|different rows/.test(problem)) ||
  (/WithinGeoRange/.test(text) &&
    text.startsWith("POST /v1/aggregate/") &&
    problem.startsWith("1.37 GraphQL: different rows"));
for (const text of REQUESTS) {
  const outs = await Promise.all(
    providers.map(async (p) => {
      try {
        const r = await p.query(text);
        const fields = r.fields.filter(
          (f) => !/^\$(score|explainScore|creationTime|lastUpdateTime|distance|certainty)$/.test(f),
        );
        const ordered = r.rows.map((row) => JSON.stringify(fields.map((f) => row[f])));
        return {
          ok: true,
          rows: r.rowCount,
          fields: r.fields.join(","),
          set: canonical(r.rows as Row[], fields).join("|"),
          order: ordered.join("|"),
          types: JSON.stringify(r.columnTypes),
          metaTypes: r.fields
            .filter((f) => f.startsWith("$"))
            .map((f) => `${f}:${typeof (r.rows[0] ?? {})[f]}`)
            .join(","),
        };
      } catch (e) {
        return { ok: false, error: `${(e as Error).constructor.name}: ${(e as Error).message.slice(0, 160)}` };
      }
    }),
  );
  const [rest, ...gql] = outs;
  const problems: string[] = [];
  for (const [i, g] of gql.entries()) {
    const name = SERVERS[i + 1][0];
    if (rest.ok !== g.ok) problems.push(`${name}: ${rest.ok ? "REST ok" : rest.error} vs ${g.ok ? "ok" : g.error}`);
    else if (rest.ok && g.ok) {
      if (rest.rows !== g.rows) problems.push(`${name}: ${rest.rows} rows vs ${g.rows}`);
      else if (rest.fields !== g.fields) problems.push(`${name}: fields ${rest.fields} vs ${g.fields}`);
      else if (rest.set !== g.set) problems.push(`${name}: different rows`);
      else if (/near-|groupBy/.test(text) && rest.order !== g.order) problems.push(`${name}: same rows, other order`);
      if (rest.metaTypes !== g.metaTypes) problems.push(`${name}: cell types ${rest.metaTypes} vs ${g.metaTypes}`);
    } else if (rest.error !== g.error) problems.push(`${name}: errors differ: ${rest.error} | ${g.error}`);
  }
  const surprising = problems.filter((problem) => !expectedDifference(text, problem));
  unexpected += surprising.length;
  if (problems.length === 0) same += 1;
  else
    differ.push(
      `${surprising.length ? "UNEXPECTED" : "expected"} ${text.slice(0, 150)}\n    ${problems.join("\n    ")}`,
    );
  console.log(`${problems.length ? "DIFF" : "SAME"} ${rest.ok ? `${rest.rows} rows` : "error"}  ${text.slice(0, 110)}`);
}
console.log(`\n${same} of ${REQUESTS.length} requests answer the same on REST and on both GraphQL servers`);
for (const d of differ) console.log(`DIFF ${d}`);
for (const p of providers) await p.disconnect();
console.log(
  unexpected === 0 ? "path parity check passed" : `path parity check failed: ${unexpected} unexpected differences`,
);
process.exit(unexpected === 0 ? 0 : 1);
