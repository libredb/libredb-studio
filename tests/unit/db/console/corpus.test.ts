/**
 * The console grammar over one corpus, on Bun and on the Node the tests find on PATH, with identical messages
 * (vector-family spec 3.4).
 *
 * The corpus: the nine Milvus console requests of the design's examples and the 257 Qdrant documentation blocks,
 * both under tests/fixtures/vector/corpus/; both engines' refusal corpora and seven string-and-comment fixtures,
 * written below as exact bytes; the bound cases; and the tag-shaped objects. The Qdrant v1 route table is the
 * provider's own (src/lib/db/providers/vector/qdrant/routes.ts), read under the stand-in dialect so the bound cases
 * keep their 2 MiB texts; the other tables are stand-ins built from tests/fixtures/vector/routes/.
 *
 * Under Node: the helper is bundled for Node and run in a child process. CI's Node is 24; the PR's completion
 * sequence runs this file a second time with Node 26 first on PATH.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConsoleDialectSpec, RouteSpec } from "@/lib/db/console/dialect";
import { classifyConsole } from "@/lib/db/console/guard";
import { ConsoleRefusal, parseConsole } from "@/lib/db/console/parser";
import { isTaggedFloat, isTaggedInt, type TaggedJson } from "@/lib/db/console/tagged-json";
import { QDRANT_ROUTES } from "@/lib/db/providers/vector/qdrant/routes";
import { type CorpusCase, type CorpusOutcome, type CorpusTable, corpusOutcomes } from "../../../helpers/console-corpus";
import {
  type FixtureRouteJson,
  MILVUS_STAND_IN,
  QDRANT_STAND_IN,
  type RouteTableJson,
  standInRoutes,
} from "../../../helpers/console-stand-ins";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures", "vector");
const readJson = <T>(...path: string[]): T => JSON.parse(readFileSync(join(FIXTURES, ...path), "utf8")) as T;

const milvusTable = readJson<RouteTableJson>("routes", "milvus-v1.json");
const qdrantV1Table = readJson<RouteTableJson>("routes", "qdrant-v1.json");
const qdrantFullTable = readJson<RouteTableJson>("routes", "qdrant-full.json");
const v1Ops = new Set(qdrantV1Table.routes.map((route) => route.op));
const allRead = () => "read" as const;

/** Every method the full Qdrant table names, so a documentation block is never refused for its method alone. */
const QDRANT_FULL_STAND_IN: ConsoleDialectSpec = {
  ...QDRANT_STAND_IN,
  id: "qdrant-full-stand-in",
  methods: [...new Set(qdrantFullTable.routes.map((route) => route.method))],
};

const TABLES: Readonly<Record<string, CorpusTable>> = {
  milvus: { spec: MILVUS_STAND_IN, routes: standInRoutes(milvusTable, allRead) },
  qdrant: { spec: QDRANT_STAND_IN, routes: QDRANT_ROUTES },
  "qdrant-full": {
    spec: QDRANT_FULL_STAND_IN,
    routes: standInRoutes(qdrantFullTable, (route: FixtureRouteJson) => (v1Ops.has(route.op) ? "read" : "write")),
  },
};

const docs = readJson<{ blocks: { file: string; text: string }[] }>("corpus", "qdrant-docs.json").blocks;
const milvusRequests = readJson<{ requests: { name: string; text: string }[] }>(
  "corpus",
  "milvus-requests.json",
).requests;

/** Each engine's refusal corpus: one text per rule of the grammar the engine's dialect can break. */
const REFUSALS: readonly { readonly table: "milvus" | "qdrant"; readonly text: string; readonly reason: string }[] = [
  { table: "milvus", text: "POST /v2/vectordb/entities/search", reason: "body-required" },
  { table: "milvus", text: "GET /v2/vectordb/collections/list", reason: "unknown-method" },
  { table: "milvus", text: "POST /v2/vectordb/collections/drop\n{}", reason: "unknown-route" },
  { table: "milvus", text: "POST http://127.0.0.1:19530/v2/vectordb/entities/search\n{}", reason: "absolute-url" },
  { table: "milvus", text: "POST /v2/vectordb/entities/search?timeout=5\n{}", reason: "query-key" },
  { table: "milvus", text: "POST /v2/vectordb/entities/search\nAuthorization: Bearer x\n{}", reason: "header-line" },
  { table: "milvus", text: "// note\nPOST /v2/vectordb/collections/list\n{}", reason: "unknown-method" },
  { table: "milvus", text: 'POST /v2/vectordb/entities/search\n{"limit": 5 // five\n}', reason: "body-comment" },
  { table: "milvus", text: 'POST /v2/vectordb/entities/search\n{"limit": 5,}', reason: "trailing-comma" },
  { table: "milvus", text: 'POST /v2/vectordb/entities/search\n{"data": [[0.1, ...]]}', reason: "ellipsis" },
  { table: "milvus", text: 'POST /v2/vectordb/entities/search\n{"limit": 5, "limit": 6}', reason: "duplicate-key" },
  {
    table: "milvus",
    text: 'POST /v2/vectordb/entities/search\n{"__proto__": {"admin": true}}',
    reason: "prototype-key",
  },
  {
    table: "milvus",
    text: 'POST /v2/vectordb/entities/search\n{"a": 1}\nPOST /v2/vectordb/entities/search\n{"a": 1}',
    reason: "second-request",
  },
  { table: "milvus", text: "# only a comment", reason: "no-request" },
  { table: "qdrant", text: "DELETE /collections/docs", reason: "unknown-method" },
  { table: "qdrant", text: "GET /collections/{collection_name}", reason: "path-template" },
  { table: "qdrant", text: "GET /collections/docs#points", reason: "fragment" },
  { table: "qdrant", text: "POST /collections/docs/points/query?wait=true\n{}", reason: "query-key" },
  { table: "qdrant", text: "POST /collections/docs/points/query?timeout=-1\n{}", reason: "query-value" },
  { table: "qdrant", text: "GET /collections\n{}", reason: "body-not-allowed" },
  {
    table: "qdrant",
    text: 'POST /collections/docs/points/query\n{"query": [0.1, 0.2]\n# note\n}',
    reason: "comment-position",
  },
  { table: "qdrant", text: 'POST /collections/docs/points/query\n{"filter": {"must": [}', reason: "malformed-json" },
  { table: "qdrant", text: 'POST /collections/docs/points/query\n{"query": "http://x}', reason: "unterminated-string" },
  { table: "qdrant", text: "GET /collections\nGET /collections", reason: "second-request" },
  { table: "qdrant", text: "GET https://cloud.example/collections", reason: "absolute-url" },
];

/** Seven string-and-comment fixtures, exact bytes: where a // or a # is text, where a comment, and where a refusal. */
const STRINGS_AND_COMMENTS: readonly {
  readonly name: string;
  readonly table: "milvus" | "qdrant";
  readonly text: string;
  readonly verdict: string;
  readonly body?: string;
}[] = [
  {
    name: "a URL in a string",
    table: "qdrant",
    text: 'POST /collections/docs/points/query\n{"url": "http://example.com/a//b"}',
    verdict: "accepted",
    body: '{"url":"http://example.com/a//b"}',
  },
  {
    name: "a comment holding quotes",
    table: "qdrant",
    text: 'POST /collections/docs/points/query\n{"limit": 1 // a "quoted" {note}\n}',
    verdict: "accepted",
    body: '{"limit":1}',
  },
  {
    name: "a CR before the LF belongs to the comment",
    table: "qdrant",
    text: 'POST /collections/docs/points/query\r\n{"a": "x" // note\r\n, "b": 2}',
    verdict: "accepted",
    body: '{"a":"x","b":2}',
  },
  {
    name: "an unterminated string that swallowed //",
    table: "qdrant",
    text: 'POST /collections/docs/points/query\n{"a": "http://x}\n// note',
    verdict: "unterminated-string",
  },
  {
    name: "a # inside a string",
    table: "milvus",
    text: 'POST /v2/vectordb/entities/query\n{"filter": "tag == \\"#1\\""}',
    verdict: "accepted",
    body: '{"filter":"tag == \\"#1\\""}',
  },
  {
    name: "escaped quotes around //",
    table: "milvus",
    text: 'POST /v2/vectordb/entities/query\n{"filter": "\\"//\\""}',
    verdict: "accepted",
    body: '{"filter":"\\"//\\""}',
  },
  {
    name: "a comment after the body at the end of the text",
    table: "qdrant",
    text: 'POST /collections/docs/points/query\n{"limit": 3} // done',
    verdict: "accepted",
    body: '{"limit":3}',
  },
];

const nested = (depth: number) =>
  `POST /v2/vectordb/entities/search\n{"data": ${"[".repeat(depth - 1)}0.1${"]".repeat(depth - 1)}}`;
/** A filter tree `depth` containers deep, the body object counted: each must level adds an object and an array. */
function nestedFilter(depth: number): string {
  let condition = depth % 2 === 0 ? '{"key": "a"}' : '{"key": "a", "match": {"value": 1}}';
  let total = 1 + (depth % 2 === 0 ? 1 : 2);
  while (total < depth) {
    condition = `{"must": [${condition}]}`;
    total += 2;
  }
  return `POST /collections/docs/points/query\n{"filter": ${condition}}`;
}
const uuid = (index: number) => `"${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000"`;
const hasId = (count: number) =>
  `POST /collections/docs/points/query\n{"filter": {"must": [{"has_id": [${Array.from({ length: count }, (_, index) => uuid(index)).join(",")}]}]}}`;
function exactlyOneMebibyteOfZeros(): string {
  const head = 'POST /v2/vectordb/entities/search\n{"data": [';
  const body = head + "0,".repeat(Math.floor((1_048_576 - head.length) / 2));
  return body + " ".repeat(1_048_576 - body.length);
}

/** A Qdrant text of exactly the stand-in's 2,097,152-byte bound: an open list, then one unit repeated to the end. */
function floodOf(unit: string): string {
  const head = 'POST /collections/docs/points/query\n{"a": [';
  const body = head + unit.repeat(Math.floor((2_097_152 - head.length) / unit.length));
  return body + " ".repeat(2_097_152 - body.length);
}
/** Texts at the bound made of what no count charges on its own: separators, empty arrays, comments and blank lines. */
const FLOODS: readonly { readonly name: string; readonly unit: string; readonly verdict: string }[] = [
  { name: "2 MiB of colons in a list", unit: ":", verdict: "malformed-json" },
  { name: "2 MiB of commas in a list", unit: ",", verdict: "malformed-json" },
  { name: "2 MiB of empty arrays in a list", unit: "[],", verdict: "too-many-nodes" },
  { name: "2 MiB of comment lines in a list", unit: "//\n", verdict: "malformed-json" },
  { name: "2 MiB of blank lines in a list", unit: "\n", verdict: "malformed-json" },
  { name: "2 MiB of whitespace lines in a list", unit: " \n", verdict: "malformed-json" },
];

const BOUNDS: readonly (CorpusCase & { readonly verdict: string })[] = [
  { name: "arrays 32 deep", table: "milvus", text: nested(32), full: false, verdict: "accepted" },
  { name: "arrays 33 deep", table: "milvus", text: nested(33), full: false, verdict: "too-deep" },
  { name: "a filter 32 deep", table: "qdrant", text: nestedFilter(32), full: false, verdict: "accepted" },
  { name: "a filter 33 deep", table: "qdrant", text: nestedFilter(33), full: false, verdict: "too-deep" },
  {
    name: "100,000 nested brackets",
    table: "milvus",
    text: `POST /v2/vectordb/entities/search\n{"data": ${"[".repeat(100_000)}`,
    full: false,
    verdict: "too-deep",
  },
  {
    name: "exactly 1,048,576 bytes of 0,",
    table: "milvus",
    text: exactlyOneMebibyteOfZeros(),
    full: false,
    verdict: "too-many-numbers",
  },
  {
    name: "4,097 small objects",
    table: "milvus",
    text: `POST /v2/vectordb/entities/search\n{"data": [${"{},".repeat(4_096)}{}]}`,
    full: false,
    verdict: "too-many-nodes",
  },
  {
    name: "4,097 empty arrays in one list",
    table: "milvus",
    text: `POST /v2/vectordb/entities/search\n{"data": [${"[],".repeat(4_096)}[]]}`,
    full: false,
    verdict: "too-many-nodes",
  },
  {
    name: "an object of 4,097 keys with [] values",
    table: "milvus",
    text: `POST /v2/vectordb/entities/search\n{${Array.from({ length: 4_097 }, (_, index) => `"k${index}": []`).join(",")}}`,
    full: false,
    verdict: "too-many-nodes",
  },
  ...FLOODS.map((flood) => ({
    name: flood.name,
    table: "qdrant",
    text: floodOf(flood.unit),
    full: false,
    verdict: flood.verdict,
  })),
  { name: "10,000 UUIDs in has_id", table: "qdrant", text: hasId(10_000), full: false, verdict: "accepted" },
  { name: "32,769 UUIDs in has_id", table: "qdrant", text: hasId(32_769), full: false, verdict: "too-many-scalars" },
];

const TAG_SHAPED: readonly CorpusCase[] = [
  {
    name: "an int-shaped object as a Milvus limit",
    table: "milvus",
    text: 'POST /v2/vectordb/entities/query\n{"collectionName": "docs", "limit": {"kind":"int","digits":"42"}}',
    full: true,
    integerAt: { path: ["limit"], field: "limit", range: "int64" },
  },
  {
    name: "a float-shaped object as a Qdrant point id",
    table: "qdrant",
    text: 'POST /collections/docs/points\n{"ids": [7, {"kind":"float","text":"1.5","value":1.5}]}',
    full: true,
    integerAt: { path: ["ids", 1], field: "ids[1]", range: "uint64" },
  },
  {
    name: "an int-shaped object as a Qdrant point id",
    table: "qdrant",
    text: 'POST /collections/docs/points\n{"ids": [{"kind":"int","digits":"42"}]}',
    full: true,
    integerAt: { path: ["ids", 0], field: "ids[0]", range: "uint64" },
  },
  {
    name: "an integer literal as a Milvus limit",
    table: "milvus",
    text: 'POST /v2/vectordb/entities/query\n{"collectionName": "docs", "limit": 42}',
    full: true,
    integerAt: { path: ["limit"], field: "limit", range: "int64" },
  },
  {
    name: "integer literals as Qdrant point ids, one past the range",
    table: "qdrant",
    text: 'POST /collections/docs/points\n{"ids": [18446744073709551615, 18446744073709551616]}',
    full: true,
    integerAt: { path: ["ids", 1], field: "ids[1]", range: "uint64" },
  },
];

const CASES: readonly CorpusCase[] = [
  ...milvusRequests.map((request) => ({
    name: `milvus/${request.name}`,
    table: "milvus",
    text: request.text,
    full: true,
  })),
  ...docs.map((block) => ({ name: `qdrant-full/${block.file}`, table: "qdrant-full", text: block.text, full: true })),
  ...docs.map((block) => ({ name: `qdrant/${block.file}`, table: "qdrant", text: block.text, full: true })),
  ...REFUSALS.map((entry, index) => ({ name: `refusal/${index}`, table: entry.table, text: entry.text, full: true })),
  ...STRINGS_AND_COMMENTS.map((entry) => ({
    name: `strings/${entry.name}`,
    table: entry.table,
    text: entry.text,
    full: true,
  })),
  ...BOUNDS.map((entry) => ({ name: entry.name, table: entry.table, text: entry.text, full: entry.full })),
  ...TAG_SHAPED,
];

/**
 * The first token of a block's first line that is neither blank nor a comment: a method when the block opens with a
 * request line, anything else when the block is a fragment, which the grammar refuses whatever reason it names.
 */
const requestToken = (text: string): string => {
  const line = text
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item !== "" && !QDRANT_STAND_IN.commentMarkers.some((marker) => item.startsWith(marker)));
  return line?.split(/\s+/)[0] ?? "";
};

const inBun = corpusOutcomes(TABLES, CASES);
const outcome = (name: string): CorpusOutcome => {
  const found = inBun.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no outcome named ${name}`);
  return found;
};
const tally = (prefix: string) => {
  const counts: Record<string, number> = {};
  for (const entry of inBun.filter((item) => item.name.startsWith(prefix)))
    counts[entry.verdict] = (counts[entry.verdict] ?? 0) + 1;
  return counts;
};

let underNode: { version: string; outcomes: CorpusOutcome[] };

beforeAll(async () => {
  const node = Bun.which("node");
  if (node === null)
    throw new Error(
      "No node on PATH: this test runs the corpus under Node, the production runtime; install Node 24 or later",
    );
  const work = mkdtempSync(join(tmpdir(), "console-corpus-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "..", "..", "..", "helpers", "console-corpus.ts")],
      target: "node",
      format: "esm",
      outdir: work,
    });
    expect({ success: build.success, logs: build.logs.map(String) }).toMatchObject({ success: true });
    writeFileSync(join(work, "input.json"), JSON.stringify({ tables: TABLES, cases: CASES }));
    writeFileSync(
      join(work, "run.mjs"),
      [
        'import { readFileSync } from "node:fs";',
        `const { corpusOutcomes } = await import(${JSON.stringify(pathToFileURL(build.outputs[0].path).href)});`,
        `const input = JSON.parse(readFileSync(${JSON.stringify(join(work, "input.json"))}, "utf8"));`,
        "process.stdout.write(JSON.stringify({ version: process.version, outcomes: corpusOutcomes(input.tables, input.cases) }));",
        "",
      ].join("\n"),
    );
    const run = Bun.spawnSync([node, join(work, "run.mjs")], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    expect({
      exitCode: run.exitCode,
      timedOut: run.exitedDueToTimeout === true,
      stderr: run.stderr.toString(),
    }).toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
    underNode = JSON.parse(run.stdout.toString());
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 180_000);

describe("Bun and Node read the corpus identically", () => {
  test("the Node on PATH is 24 or 26", () => {
    expect(["24", "26"]).toContain(underNode.version.slice(1).split(".")[0]);
  });

  test("every verdict, message, body, formatted text and token drawing is the same", () => {
    expect(underNode.outcomes.length).toBe(inBun.length);
    expect(underNode.outcomes).toEqual(inBun);
  });
});

describe("the Milvus requests", () => {
  test("all nine are accepted", () => {
    expect(milvusRequests.length).toBe(9);
    expect(tally("milvus/")).toEqual({ accepted: 9 });
  });
});

describe("the Qdrant documentation blocks", () => {
  test("257 blocks: 227 accepted against the full route table and 30 refused by name", () => {
    expect(docs.length).toBe(257);
    const full = tally("qdrant-full/");
    expect(full.accepted).toBe(227);
    expect(257 - full.accepted).toBe(30);
  });

  test("against the 17-route v1 table: 82 accepted, 155 refused as routes v1 does not run, 20 refused by the grammar", () => {
    expect(qdrantV1Table.routes.length).toBe(17);
    const methods = new Set(qdrantFullTable.routes.map((route) => route.method));
    const outcomes = inBun.filter((entry) => entry.name.startsWith("qdrant/"));
    expect(outcomes.length).toBe(docs.length);
    const buckets = { accepted: 0, notRun: 0, grammar: 0 };
    outcomes.forEach((entry, index) => {
      if (entry.verdict === "accepted") buckets.accepted += 1;
      else if (entry.verdict === "unknown-route") buckets.notRun += 1;
      else if (entry.verdict === "unknown-method" && methods.has(requestToken(docs[index].text))) buckets.notRun += 1;
      else buckets.grammar += 1;
    });
    // An earlier count was 81, 155 and 21, taken before query keys were declared per route: the optimizations
    // block with ?with=queued,completed is accepted now, because with is a key that route declares, and the one
    // ?wait=true block refused then for its key is a PUT, which the v1 table refuses first as a route it does not run.
    expect(buckets).toEqual({ accepted: 82, notRun: 155, grammar: 20 });
  });
});

describe("the refusal corpora", () => {
  test.each(REFUSALS.map((entry, index) => [index, entry.table, entry.reason] as const))(
    "%d: %s refuses as %s",
    (index, _table, reason) => {
      expect(outcome(`refusal/${index}`).verdict).toBe(reason);
    },
  );
});

describe("the string-and-comment fixtures", () => {
  test.each(STRINGS_AND_COMMENTS.map((entry) => [entry.name, entry.verdict, entry.body ?? null] as const))(
    "%s: %s",
    (name, verdict, body) => {
      const read = outcome(`strings/${name}`);
      expect({ verdict: read.verdict, body: read.body }).toEqual({ verdict, body });
    },
  );
});

describe("the bounds", () => {
  test.each(BOUNDS.map((entry) => [entry.name, entry.verdict] as const))(
    "%s: %s, never a RangeError",
    (name, verdict) => {
      expect(outcome(name).verdict).toBe(verdict);
    },
  );

  test("the 32,769-UUID case names the scalar-leaf bound", () => {
    expect(outcome("32,769 UUIDs in has_id").message).toContain("more than 32768 strings in its lists of strings");
  });

  test("the 1,048,576-byte case is exactly at the text bound, and its peak memory is recorded", () => {
    const text = exactlyOneMebibyteOfZeros();
    expect(new TextEncoder().encode(text).length).toBe(1_048_576);
    const before = process.memoryUsage().rss;
    let refusal: unknown;
    try {
      parseConsole(MILVUS_STAND_IN, TABLES.milvus.routes, text);
    } catch (error) {
      refusal = error;
    }
    const grown = process.memoryUsage().rss - before;
    console.info(
      `console corpus: the 1,048,576-byte numeric case grew the RSS by ${Math.round(grown / 1_048_576)} MiB`,
    );
    expect((refusal as ConsoleRefusal).reason).toBe("too-many-numbers");
  });
});

describe("a text at the bound made of separators, empty arrays, comments or blank lines", () => {
  test.each(FLOODS.map((flood) => [flood.name, flood.verdict, flood.unit] as const))(
    "%s is refused as %s without holding a token for each, and its peak memory is recorded",
    (name, verdict, unit) => {
      const text = floodOf(unit);
      expect(new TextEncoder().encode(text).length).toBe(2_097_152);
      const before = process.memoryUsage().rss;
      let refusal: unknown;
      try {
        parseConsole(QDRANT_STAND_IN, TABLES.qdrant.routes, text);
      } catch (error) {
        refusal = error;
      }
      const grown = process.memoryUsage().rss - before;
      console.info(`console corpus: ${name} grew the RSS by ${Math.round(grown / 1_048_576)} MiB`);
      expect((refusal as ConsoleRefusal).reason).toBe(verdict as ConsoleRefusal["reason"]);
      // Reading every such text to its end kept a token or an array for each unit, 150 MiB and more.
      expect(grown).toBeLessThan(128 * 1_048_576);
    },
  );
});

describe("tag-shaped objects", () => {
  test("parse to objects, write back as objects, and are refused naming the field where an integer is required", () => {
    const limit = outcome("an int-shaped object as a Milvus limit");
    expect(limit.body).toBe('{"collectionName":"docs","limit":{"kind":"int","digits":"42"}}');
    expect(limit.formatted).toContain('"limit": {\n    "kind": "int",\n    "digits": "42"\n  }');
    expect(limit.integer).toBe("limit must be an integer, found an object.");
    const floatId = outcome("a float-shaped object as a Qdrant point id");
    expect(floatId.op).toBe("get_points");
    expect(floatId.body).toBe('{"ids":[7,{"kind":"float","text":"1.5","value":1.5}]}');
    expect(floatId.integer).toBe("ids[1] must be an integer, found an object.");
    const intId = outcome("an int-shaped object as a Qdrant point id");
    expect(intId.body).toBe('{"ids":[{"kind":"int","digits":"42"}]}');
    expect(intId.integer).toBe("ids[0] must be an integer, found an object.");
  });

  test("the same rule takes an integer literal, and refuses one past the field's range by name", () => {
    expect(outcome("an integer literal as a Milvus limit").integer).toBe("accepted");
    expect(outcome("integer literals as Qdrant point ids, one past the range").integer).toBe(
      "ids[1] is 18446744073709551616, outside the uint64 range.",
    );
  });

  test("the tag checks are false on the parsed values themselves", () => {
    const body = parseConsole(
      QDRANT_STAND_IN,
      TABLES.qdrant.routes,
      'POST /collections/docs/points\n{"ids": [{"kind":"int","digits":"42"}, {"kind":"float","text":"1.5","value":1.5}, 7]}',
    ).body;
    const ids = body.ids as readonly TaggedJson[];
    expect(ids.map((id) => [isTaggedInt(id), isTaggedFloat(id)])).toEqual([
      [false, false],
      [false, false],
      [true, false],
    ]);
  });
});

/** A request for a route: its template with every placeholder filled, and an empty body where it takes one. */
function requestFor(table: CorpusTable, route: RouteSpec): string {
  const path = route.template
    .replace(/\{collection_name\}/g, "docs")
    .replace(/\{id\}/g, "42")
    .replace(/\{[a-z_]+\}/g, "x");
  return `${route.method} ${table.spec.pathPrefix}${path}${route.body === "none" ? "" : "\n{}"}`;
}

describe("classifyConsole over both tables", () => {
  // The route fixtures carry no class, so the two v1 stand-in tables declare every route a read themselves. What
  // this holds is that each v1 route's own request parses and is classified by the class its table declares; that
  // a provider's own route table declares each v1 route a read is held beside that table, by its own test.
  test("every v1 route of both tables parses and classifies as the read its table declares", () => {
    for (const [name, table] of [
      ["milvus", TABLES.milvus],
      ["qdrant", TABLES.qdrant],
    ] as const) {
      for (const route of table.routes) {
        expect(route.class, `${name} ${route.op}`).toBe("read");
        expect(classifyConsole(table.spec, table.routes, requestFor(table, route)), `${name} ${route.op}`).toBe("read");
      }
    }
  });

  test("the class is the matched route's own: over the full table, each route answers the class it declares", () => {
    const table = TABLES["qdrant-full"];
    const classes = new Set<string>();
    for (const route of table.routes) {
      classes.add(route.class);
      expect(classifyConsole(table.spec, table.routes, requestFor(table, route)), route.op).toBe(route.class);
    }
    expect([...classes].sort()).toEqual(["read", "write"]);
  });

  test("a write route in a synthetic table classifies as write", () => {
    const routes: readonly RouteSpec[] = [
      ...TABLES.qdrant.routes,
      {
        method: "POST",
        template: "collections/{collection_name}/points/delete",
        op: "delete_points",
        class: "write",
        params: { collection_name: "name" },
        query: {},
        body: "required",
      },
    ];
    expect(classifyConsole(QDRANT_STAND_IN, routes, 'POST /collections/docs/points/delete\n{"points": [1]}')).toBe(
      "write",
    );
  });
});
