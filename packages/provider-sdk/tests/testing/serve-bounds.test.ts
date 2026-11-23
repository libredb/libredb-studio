/**
 * A frame never grows past what the provider holds (docs/providers/CONTRACT.md, clause C-24), proven where a failure is
 * bounded.
 *
 * A transport that stringified a batch before encoding it, walked an answer's results to their length, or buffered a
 * source ahead of its pulls would allocate until the heap is gone on a sparse array of length 2^32 - 1 or on a source
 * that never ends. So no case runs in this process: each runs in a Node child under the helper's bound
 * (tests/helpers/node-child.ts) and prints one JSON line. Every line the child reaches, serve.test.ts reaches in
 * process too.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { defineProvider, encodedRowBytes, pumpPage, ResultSource } from "@libredb/provider-sdk/calls";
import type { FrameRefusal, serve } from "@libredb/provider-sdk/testing";
import { boundedChild } from "../helpers/node-child";

/** The old space each child may use: far less than a sparse list's text or an unbounded page would need. */
const HEAP_LIMIT_MIB = 64;

interface ChildDeps {
  readonly defineProvider: typeof defineProvider;
  readonly serve: typeof serve;
  readonly pumpPage: typeof pumpPage;
  readonly encodedRowBytes: typeof encodedRowBytes;
  readonly manifest: Record<string, unknown>;
}

interface ChildReport {
  readonly name: string;
  readonly error?: string;
  readonly path?: string;
  readonly refusals?: readonly FrameRefusal[];
  readonly end?: string;
  readonly rows?: number;
  readonly pulls?: number;
  readonly frames?: number;
}

/**
 * Runs in the child, from its text: a served module whose source answers a batch of a sparse list of the longest
 * length, whose execute answers results of that list, or whose source never ends, pumped to a 1 MiB page.
 */
async function runCase(deps: ChildDeps, name: string): Promise<ChildReport> {
  const longest: unknown[] = [];
  longest.length = 2 ** 32 - 1;
  let pulls = 0;
  let frames = 0;
  const source: ResultSource = {
    columns: [{ name: "k" }],
    async next() {
      pulls += 1;
      // A fresh row of 1 KiB each pull, so a page held without its byte cut grows the heap by its rows' text.
      return name === "rows"
        ? { rows: longest as unknown[][], done: false }
        : { rows: [["k".repeat(1020)]], done: false };
    },
    async close() {},
  };
  const impl = {
    open: async () => ({ handle: {} }),
    close: async () => {},
    console: {
      execute: async () => ({
        results: name === "results" ? (longest as ResultSource[]) : [source],
        warnings: [],
        executionTimeMs: 0,
        pageApplied: false,
      }),
    },
  };
  const manifest = JSON.parse(JSON.stringify(deps.manifest));
  manifest.engines[0].facets.monitoring.overview = "not-offered";
  const served = deps.serve(deps.defineProvider(manifest, impl), {
    observe: (frame) => {
      if (frame.call === "result.next" && frame.direction === "to-provider") frames += 1;
    },
  });
  const ctx = { deadline: Date.now() + 60_000, signal: new AbortController().signal, env: { get: () => undefined } };
  const opened = await served.open({
    ...ctx,
    engine: "exampledb",
    connectionId: "c",
    connection: {},
    egress: { blocksPrivateHosts: true, source: "default" },
    trust: { certificates: [] },
    policy: {
      readOnly: false,
      sendsStatements: true,
      allowExternalFileAccess: false,
      refuseWrites: false,
      managed: false,
      literalSeedFile: false,
    },
  });
  try {
    const answer = await served.console.execute(opened.handle, { statement: "s", page: { unlimited: true } }, ctx);
    const result = answer.results[0] as ResultSource;
    if (name === "rows") await result.next({ maxRows: 1, maxBytes: 1024, measure: deps.encodedRowBytes });
    const page = await deps.pumpPage(
      result,
      {
        maxRows: Number.MAX_SAFE_INTEGER,
        maxBytes: 1048576,
        batchMaxBytes: 1048576,
      },
      { deadline: Date.now() + 3_600_000, signal: new AbortController().signal },
    );
    return { name, end: page.end, rows: page.rows.length, pulls, frames };
  } catch (error) {
    const failure = error as { name: string; path?: string; refusals?: readonly FrameRefusal[] };
    return { name, error: failure.name, path: failure.path, refusals: failure.refusals };
  }
}

const SOURCE = path.join(import.meta.dir, "..", "..", "src");

const child = boundedChild({
  label: "serve-bounds",
  imports: [
    { from: path.join(SOURCE, "calls", "index.ts"), names: ["defineProvider", "encodedRowBytes", "pumpPage"] },
    { from: path.join(SOURCE, "testing", "index.ts"), names: ["serve"] },
    { from: path.join(import.meta.dir, "..", "fixtures", "minimal-manifest.json"), defaultAs: "manifest" },
  ],
  runCase,
  heapLimitMiB: HEAP_LIMIT_MIB,
  timeoutMs: 20_000,
});

beforeAll(() => child.build(), 60_000);

afterAll(() => {
  child.remove();
});

describe(`the memory transport in a Node child under --max-old-space-size=${HEAP_LIMIT_MIB}`, () => {
  test("a batch whose rows are a sparse list of the longest length is refused at its first hole, in a bounded child", async () => {
    expect(await child.run<ChildReport>("rows")).toEqual({ name: "rows", error: "ValueCodecError", path: "/rows/0" });
  }, 30_000);

  test("an execute answer whose results are a sparse list of the longest length is refused at its first hole, in a bounded child", async () => {
    expect(await child.run<ChildReport>("results")).toEqual({
      name: "results",
      error: "FrameRefusalError",
      refusals: [{ rule: "frame-value-unreadable", call: "console.execute", part: "answer", pointer: "/results/0" }],
    });
  }, 30_000);

  test("a served source that never ends is cut at the page's byte budget, in a bounded child", async () => {
    expect(await child.run<ChildReport>("never-ends")).toEqual({
      name: "never-ends",
      end: "byte-limit",
      rows: 1024,
      pulls: 1024,
      frames: 1024,
    });
  }, 30_000);
});
