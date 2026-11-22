/**
 * L9, the Databend memory check (design 3.12, R10; X04, X10): what two statements at the statement budget cost the
 * heap at once, under the image's own Node and its 384 MiB `--max-old-space-size`, and how many bytes one page of the
 * widest display text takes.
 *
 * Phase "budget" runs two statements at once through the real transport against the local fixture, each at the row
 * cut of an unlimited query (`MAX_UNLIMITED_ROWS`), stopped by the first of the 100,000 rows, 250,000 cells and
 * 16 MiB of answer text; each result is decoded and serialised as a route serialises it, and both are held until both
 * are done. The request side is counted too: each statement's text is padded with a comment to just under the
 * proxy's 10 MB route-body bound (`bounded-json.ts`), and the transport holds it and its JSON copy.
 * Phase "pages" then runs each widest-text shape twice at once, one page of up to 10,000 rows: 400 Boolean, 240
 * Int8, 150 Timestamp, hex Binary and control-character columns, all generated with SQL, so no table is needed.
 *
 * The heap is sampled every millisecond the event loop is free, so the peak is a lower bound on the instant a parse
 * holds; `total_heap_size`, which V8 has committed, is reported beside it as the upper one. The check fails when the
 * used peak passes 288 MiB, 75 percent of the 384 MiB limit (plan D4).
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/), with the fixture up:
 *   P=<an empty directory>
 *   bun build tests/live/databend-memory-check.ts --target=node --outfile "$P/l9.mjs"
 *   write "$P/credentials.json" as {"user": "...", "password": "..."} from QUERY_DEFAULT_USER and
 *     QUERY_DEFAULT_PASSWORD in database-compose.yml (the image has no copy of the repository)
 *   docker run --rm --network host -v "$P:/l9" --entrypoint node ghcr.io/libredb/libredb-studio:latest \
 *     --max-old-space-size=384 /l9/l9.mjs
 * It only reads: every statement is a SELECT over `numbers()`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import { egressDecision } from "@/lib/db/egress-decision";
import { endpointUrl } from "@/lib/db/http/endpoint";
import { createNodeTransport, type NodeTransportOptions } from "@/lib/db/http/node-transport";
import {
  buildDatabendConnectionOptions,
  type DatabendConnectionOptions,
} from "@/lib/db/providers/sql/databend/connection-options";
import { decodeOutcome } from "@/lib/db/providers/sql/databend/decode";
import { createDatabendHttpTransport } from "@/lib/db/providers/sql/databend/http-transport";
import type { DatabendError, DatabendTransport } from "@/lib/db/providers/sql/databend/transport";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import type { DatabaseConnection } from "@/lib/types";

const MIB = 1024 * 1024;
const LIMIT_MIB = 384;
const MARGIN_MIB = 288;
/** Just under the proxy's 10 MB bound on a route body, so the statement text is as large as a request can carry. */
const STATEMENT_TEXT_BYTES = 9_900_000;
const QUERY_TIMEOUT_MS = 120_000;
const PAGE_ROWS = 10_000;

interface Credentials {
  readonly user: string;
  readonly password: string;
}

function credentials(): Credentials {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(here, "credentials.json"), "utf8")) as Credentials;
}

/** The heap's used and committed peaks since the last reset, sampled while the event loop is free. */
function heapSampler() {
  let used = 0;
  let total = 0;
  let rss = 0;
  const sample = () => {
    const heap = getHeapStatistics();
    used = Math.max(used, heap.used_heap_size);
    total = Math.max(total, heap.total_heap_size);
    rss = Math.max(rss, process.memoryUsage.rss());
  };
  sample();
  const timer = setInterval(sample, 1);
  return {
    sample,
    reset() {
      used = 0;
      total = 0;
      rss = 0;
      sample();
    },
    peaks: () => ({ usedMiB: mib(used), totalMiB: mib(total), rssMiB: mib(rss) }),
    stop: () => clearInterval(timer),
  };
}

function mib(bytes: number): number {
  return Math.round((bytes / MIB) * 10) / 10;
}

/** Every answer's byte length, by the statement it served, read off the shared transport's responses. */
function recordingTransport(
  answers: number[],
): (options: NodeTransportOptions) => ReturnType<typeof createNodeTransport> {
  return (options) => {
    const node = createNodeTransport(options);
    return {
      async request(request) {
        const response = await node.request(request);
        answers.push(Buffer.byteLength(response.text));
        return response;
      },
      close: () => node.close(),
    };
  };
}

function columns(count: number, expression: (index: number) => string): string {
  return Array.from({ length: count }, (_, index) => `${expression(index)} AS c${index}`).join(", ");
}

const PAGE_SHAPES: ReadonlyArray<{ readonly name: string; readonly sql: string }> = [
  { name: "400 Boolean", sql: `SELECT ${columns(400, (i) => `number % 2 = ${i % 2}`)} FROM numbers(1000000)` },
  { name: "240 Int8", sql: `SELECT ${columns(240, () => "(number % 256 - 128)::Int8")} FROM numbers(1000000)` },
  {
    name: "150 Timestamp",
    sql: `SELECT ${columns(150, () => "to_timestamp(1700000000 + number)")} FROM numbers(1000000)`,
  },
  { name: "hex Binary", sql: `SELECT ${columns(8, () => "to_binary(repeat('x', 512))")} FROM numbers(1000000)` },
  { name: "control characters", sql: `SELECT ${columns(8, () => "repeat(char(1), 512)")} FROM numbers(1000000)` },
];

/** One statement through the transport, decoded and serialised; what it kept, and the serialised length. */
async function runOne(transport: DatabendTransport, sql: string, rowCut: number) {
  const outcome = await transport.run({ sql, origin: "user", rowCut, signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) });
  const decoded = decodeOutcome(outcome, sql);
  const serialised = JSON.stringify({ fields: decoded.fields, rows: decoded.rows, rowCount: decoded.rowCount });
  return { sql, outcome, decoded, serialised };
}

/**
 * The first page that carries rows, read past the transport's cap so its size is measured even when the transport
 * refuses it: the same body the transport sends at a 10,000-row page, then the statement is killed.
 */
async function rawFirstPage(options: DatabendConnectionOptions, sql: string) {
  const node = createNodeTransport({
    origin: options.origin,
    tls: options.tls,
    maxSockets: 1,
    headers: options.headers,
  });
  const send = async (method: "GET" | "POST", path: string, body?: string) => {
    const response = await node.request({
      method,
      url: endpointUrl(options.origin, path),
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      maxResponseBytes: 512 * MIB,
    });
    return { bytes: Buffer.byteLength(response.text), answer: JSON.parse(response.text) as RawAnswer };
  };
  const settings = { format_null_as_str: "0", http_json_result_mode: "display", binary_output_format: "hex" };
  const pagination = { wait_time_secs: 10, max_rows_per_page: PAGE_ROWS, max_rows_in_buffer: 2 * PAGE_ROWS };
  let page = await send("POST", "/v1/query", JSON.stringify({ sql, session: { settings }, pagination }));
  const id = page.answer.id;
  while (page.answer.data.length === 0 && page.answer.next_uri !== null) {
    // oxlint-disable-next-line no-await-in-loop -- a long poll until the first rows.
    page = await send("GET", page.answer.next_uri);
  }
  await send("GET", `/v1/query/${id}/kill`).catch(() => undefined);
  node.close();
  return { rawPageBytes: page.bytes, rawPageRows: page.answer.data.length };
}

interface RawAnswer {
  readonly id: string;
  readonly data: readonly unknown[];
  readonly next_uri: string | null;
}

async function main(): Promise<void> {
  const { user, password } = credentials();
  const connection = {
    id: "l9",
    name: "L9",
    type: "databend",
    host: "127.0.0.1",
    port: 8000,
    user,
    password,
    createdAt: new Date(0),
  } as unknown as DatabaseConnection;
  const options = buildDatabendConnectionOptions(connection, {
    queryTimeout: QUERY_TIMEOUT_MS,
    appVersion: null,
    egress: egressDecision(),
  });
  const answers: number[] = [];
  const transport = createDatabendHttpTransport(options, { createNodeTransport: recordingTransport(answers) });
  const heap = heapSampler();
  const baseline = heap.peaks();
  const report: Record<string, unknown> = {
    node: process.version,
    heapSizeLimitMiB: mib(getHeapStatistics().heap_size_limit),
    baseline,
  };

  // Phase "budget": two statements at once, request side included.
  heap.reset();
  const select = "SELECT number, repeat('x', 160) AS s FROM numbers(1000000) /* ";
  const padding = "p".repeat(STATEMENT_TEXT_BYTES - select.length - 3);
  const statementText = (n: number) => `${select}${n}${padding.slice(1)} */`;
  answers.length = 0;
  const settled = await Promise.allSettled([1, 2].map((n) => runOne(transport, statementText(n), MAX_UNLIMITED_ROWS)));
  heap.sample();
  report.budget = {
    results: settled.map((run) =>
      run.status === "fulfilled"
        ? {
            statementTextBytes: Buffer.byteLength(run.value.sql),
            truncated: run.value.outcome.truncated,
            rows: run.value.outcome.rows.length,
            serialisedBytes: run.value.serialised.length,
          }
        : { failed: (run.reason as DatabendError).category, message: (run.reason as Error).message },
    ),
    answers: answers.length,
    largestAnswerBytes: Math.max(0, ...answers),
    answerBytesTotal: answers.reduce((sum, bytes) => sum + bytes, 0),
    peaks: heap.peaks(),
  };
  settled.length = 0;

  // Phase "pages": each widest-text shape, first one raw page past the cap to measure it, then two at once.
  const pages: Record<string, unknown>[] = [];
  for (const shape of PAGE_SHAPES) {
    // oxlint-disable-next-line no-await-in-loop -- one shape at a time, so each peak is its own.
    const raw = await rawFirstPage(options, shape.sql);
    heap.reset();
    answers.length = 0;
    // oxlint-disable-next-line no-await-in-loop -- one shape at a time, so each peak is its own.
    const runs = await Promise.allSettled([0, 1].map(() => runOne(transport, shape.sql, PAGE_ROWS)));
    heap.sample();
    pages.push({
      shape: shape.name,
      ...raw,
      results: runs.map((run) =>
        run.status === "fulfilled"
          ? { rows: run.value.outcome.rows.length, truncated: run.value.outcome.truncated }
          : { failed: (run.reason as DatabendError).category },
      ),
      largestAnswerBytes: Math.max(0, ...answers),
      peaks: heap.peaks(),
    });
  }
  report.pages = pages;

  heap.stop();
  await transport.close();
  const peakUsed = Math.max(
    (report.budget as { peaks: { usedMiB: number } }).peaks.usedMiB,
    ...pages.map((page) => (page.peaks as { usedMiB: number }).usedMiB),
  );
  report.peakUsedMiB = peakUsed;
  report.limitMiB = LIMIT_MIB;
  report.marginMiB = MARGIN_MIB;
  report.withinMargin = peakUsed <= MARGIN_MIB;
  console.log(JSON.stringify(report, null, 2));
  if (peakUsed > MARGIN_MIB) process.exitCode = 1;
}

await main();
