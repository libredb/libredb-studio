/**
 * Every cap of spec 6.6 refused with the same sentence on Bun and on the Node the tests find on PATH (QE12): the
 * request rules run under Bun, then in a Node child process from a bundle of tests/helpers/qdrant-request-outcomes.ts,
 * and the two answers must be equal, refusals and accepted bodies alike. CI's Node is 24; PR 4q's completion
 * sequence runs this file a second time with Node 26 first on PATH.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type RequestCase, type RequestOutcome, requestOutcomes } from "../../../helpers/qdrant-request-outcomes";

const query = (body: string) => `POST /collections/docs/points/query\n${body}`;
const leaf = '{"query": [0.1], "limit": 5}';
const ids = (count: number) => Array.from({ length: count }, (_, index) => index).join(",");

/** One text per bound of spec 6.6, each just past it, and the documentation's accepted shapes beside them. */
const CASES: readonly RequestCase[] = [
  { name: "rows", text: query('{"query": [0.1], "limit": 1001}') },
  { name: "retrieve ids", text: `POST /collections/docs/points\n{"ids": [${ids(1001)}]}` },
  {
    name: "batch rows",
    text: `POST /collections/docs/points/query/batch\n{"searches": [{"query": [0.1], "limit": 991}, {"query": [0.2]}]}`,
  },
  { name: "group rows", text: 'POST /collections/docs/points/query/groups\n{"group_by": "c", "limit": 334}' },
  {
    name: "batch size",
    text: `POST /collections/docs/points/query/batch\n{"searches": [${Array.from({ length: 11 }, () => leaf).join(",")}]}`,
  },
  {
    name: "prefetch depth",
    text: query(`{"prefetch": {"prefetch": {"prefetch": ${leaf}}}, "query": {"fusion": "rrf"}}`),
  },
  {
    name: "prefetch list",
    text: query(`{"prefetch": [${[leaf, leaf, leaf, leaf, leaf].join(",")}], "query": {"fusion": "rrf"}}`),
  },
  { name: "candidates", text: query('{"query": [0.1], "offset": 9991, "limit": 10}') },
  { name: "hnsw_ef", text: query('{"query": [0.1], "params": {"hnsw_ef": 1025}}') },
  { name: "oversampling", text: query('{"query": [0.1], "params": {"quantization": {"oversampling": 8.5}}}') },
  { name: "mmr", text: query('{"query": {"nearest": [0.1], "mmr": {"candidates_limit": 1025}}}') },
  { name: "facet limit", text: 'POST /collections/docs/facet\n{"key": "k", "limit": 1001}' },
  {
    name: "conditions",
    text: `POST /collections/docs/points/scroll\n{"filter": {"must": [${Array.from({ length: 257 }, () => '{"key": "k", "match": {"value": 1}}').join(",")}]}}`,
  },
  {
    name: "match list",
    text: `POST /collections/docs/points/scroll\n{"filter": {"must": [{"key": "a", "match": {"any": [${ids(10_001)}]}}]}}`,
  },
  { name: "formula depth", text: query(`{"query": {"formula": ${'{"neg": '.repeat(12)}1${"}".repeat(12)}}}`) },
  { name: "id range", text: 'POST /collections/docs/points\n{"ids": [18446744073709551616]}' },
  { name: "float32 range", text: query('{"query": [1e39], "using": "text"}') },
  { name: "inference", text: query('{"query": {"text": "t", "model": "openai/text-embedding-3-small"}}') },
  { name: "unknown key", text: 'POST /collections/docs/points/scroll\n{"filter": {"must_nto": []}}' },
  {
    name: "accepted query",
    text: query(
      '{"query": [0.2, 0.1, 0.9, 0.7], "filter": {"must": [{"key": "big", "match": {"value": 9007199254740993}}]}}',
    ),
  },
  { name: "accepted scroll", text: "POST /collections/docs/points/scroll" },
];

const inBun = requestOutcomes(CASES);
let underNode: { version: string; outcomes: RequestOutcome[] };

beforeAll(async () => {
  const node = Bun.which("node");
  if (node === null) {
    throw new Error(
      "No node on PATH: this test runs the request rules under Node, the production runtime; install Node 24 or later",
    );
  }
  const work = mkdtempSync(join(tmpdir(), "qdrant-request-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "..", "..", "..", "helpers", "qdrant-request-outcomes.ts")],
      target: "node",
      format: "esm",
      outdir: work,
    });
    expect({ success: build.success, logs: build.logs.map(String) }).toMatchObject({ success: true });
    writeFileSync(join(work, "input.json"), JSON.stringify(CASES));
    writeFileSync(
      join(work, "run.mjs"),
      [
        'import { readFileSync } from "node:fs";',
        `const { requestOutcomes } = await import(${JSON.stringify(pathToFileURL(build.outputs[0].path).href)});`,
        `const cases = JSON.parse(readFileSync(${JSON.stringify(join(work, "input.json"))}, "utf8"));`,
        "process.stdout.write(JSON.stringify({ version: process.version, outcomes: requestOutcomes(cases) }));",
        "",
      ].join("\n"),
    );
    const run = Bun.spawnSync([node, join(work, "run.mjs")], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toMatchObject({ exitCode: 0 });
    underNode = JSON.parse(run.stdout.toString());
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 180_000);

describe("the request rules on Bun and on Node", () => {
  test("the Node on PATH is 24 or 26", () => {
    expect(["24", "26"]).toContain(underNode.version.slice(1).split(".")[0]);
  });

  test("every cap is refused in phase 0, and every verdict, key, message and body is the same on both", () => {
    expect(inBun.filter((outcome) => outcome.verdict === "refused").every((outcome) => outcome.phase === 0)).toBe(true);
    expect(inBun.filter((outcome) => outcome.verdict === "accepted").map((outcome) => outcome.name)).toEqual([
      "accepted query",
      "accepted scroll",
    ]);
    expect(underNode.outcomes).toEqual(inBun);
  });
});
