/**
 * One case of the host page benchmark (docs/TOOLCHAIN.md, "The host page benchmark"): a generated page answered on
 * today's path or through the provider host, timed, with the heap it adds and the longest event-loop slice it holds.
 *
 * The rows are P-21's generator: row i is a pure function of i, in a narrow shape of 5 columns and a wide shape of 20,
 * in today's driver forms (a 64-bit integer as its decimal string, bytes as a `Buffer`, a `Date`), answered by a fake
 * legacy provider that returns them as they are. Both paths run the production code:
 *
 * - host: `runEditorQuery` (src/lib/api/editor-query.ts), so the legacy bridge, the host core's execute call, the SDK's
 *   pump with a turn of the event loop before every pull, and the facade's answer, then the route's `JSON.stringify`;
 * - today: the same answer composed from the same production helpers without the host, as `runEditorQuery` composed
 *   it before the host: prepare, probe, query, `pageOfProbe`, `firstResultSet`, `withScrubbedWarnings`,
 *   `rowsWithNonFiniteWords`, then `JSON.stringify`.
 *
 * The case compares both answers before it times anything, every answered row of both by the text the route writes
 * for it and the rest of the body as a whole, so both paths answer the same thing; where the host cut the page by
 * bytes, its rows are today's first rows, and its body is today's with the cut's row count and pagination. It defines no pump, source or measure of its own: tests/unit/host-page-benchmark.test.ts holds that.
 *
 * Heap: the live heap after a forced gc, read at every turn the host yields while it pumps and at the answer, minus
 * the live heap with the provider's rows built. Slice: the longest gap between two `setImmediate` turns of a ticker
 * while the installed host core's `executeCall` runs over the bridge, on the process's one page budget as production
 * runs it, the part of the host path P-21's slice measured, each page released once it answered; the facade's
 * whole-page `rowsWithNonFiniteWords` and the route's `JSON.stringify` are today's cost on both paths.
 */
import { deadlineSignal, encodedRowBytes, envReader, PAGE_MAX_BYTES } from "@libredb/provider-sdk/calls";
import { runEditorQuery } from "@/lib/api/editor-query";
import { firstResultSet } from "@/lib/api/first-result-set";
import { pageOfProbe, probePastPage } from "@/lib/api/page-probe";
import { providerTextScrub, withScrubbedWarnings } from "@/lib/db/operations/provider-text";
import { type DatabaseProvider, newQueryCallScope, type PreparedQuery, type QueryPrepareOptions } from "@/lib/db/types";
import { rowsWithNonFiniteWords } from "@/lib/non-finite";
import { hostCore } from "@/lib/provider-host/instance";
import { bridgedConsole } from "@/lib/provider-host/legacy-bridge";
import type { DatabaseConnection, QueryResult } from "@/lib/types";

export type Shape = "narrow" | "wide";
export type BenchPath = "today" | "host";

/** P-21's row counts; `max` is the most rows a 32 MiB page holds. */
export const ROW_COUNTS = ["50", "500", "10000", "100000", "max"] as const;
export type RowCount = (typeof ROW_COUNTS)[number];

/** P-21's warm-ups and repetitions per row count. */
export const REPETITIONS: Readonly<Record<RowCount, { readonly warmup: number; readonly reps: number }>> = {
  "50": { warmup: 50, reps: 300 },
  "500": { warmup: 20, reps: 100 },
  "10000": { warmup: 3, reps: 25 },
  "100000": { warmup: 2, reps: 9 },
  max: { warmup: 2, reps: 9 },
};

/** What one case reports, one JSON line on the child's standard output. */
export interface CaseReport {
  readonly runtime: string;
  readonly shape: Shape;
  readonly rowsArg: RowCount;
  readonly rows: number;
  readonly path: BenchPath;
  readonly reps: number;
  readonly answerBytes: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  /** The live heap the path adds, in MiB. */
  readonly heapAddedMiB: number;
  /** The longest event-loop slice while the host's execute call ran, in ms; 0 on today's path. */
  readonly sliceMaxMs: number;
}

// ---- P-21's deterministic generator: row i is a pure function of i ----

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ["lo", "re", "mi", "da", "ta", "ne", "su", "ko", "ra", "vi", "pe", "an", "or", "el", "us", "it"];

function text(random: () => number, min: number, max: number): string {
  const target = min + Math.floor(random() * (max - min + 1));
  const words: string[] = [];
  let length = 0;
  while (length < target) {
    const count = 1 + Math.floor(random() * 4);
    let word = "";
    for (let k = 0; k < count; k += 1) word += SYLLABLES[Math.floor(random() * SYLLABLES.length)];
    words.push(word);
    length += word.length + 1;
  }
  return words.join(" ").slice(0, target);
}

function bytes(random: () => number, count: number): Buffer {
  const buffer = Buffer.alloc(count);
  for (let k = 0; k < count; k += 1) buffer[k] = Math.floor(random() * 256);
  return buffer;
}

const STATUS = ["active", "pending", "closed", "archived", "failed"];
const REGION = ["eu-west-1", "us-east-1", "ap-south-1", "sa-east-1"];
const T0 = Date.UTC(2024, 0, 1);

export const COLUMNS: Readonly<Record<Shape, readonly string[]>> = {
  narrow: ["id", "name", "status", "amount", "created_at"],
  wide: [
    "id",
    "account_id",
    "score",
    "active",
    "code",
    "title",
    "body",
    "email",
    "status",
    "created_at",
    "updated_at",
    "deleted_at",
    "checksum",
    "payload",
    "attrs",
    "note",
    "qty",
    "price",
    "ratio",
    "region",
  ],
};

/** The cells of row `index` in today's driver forms. */
function cells(shape: Shape, index: number): unknown[] {
  const random = rng(0x9e3779b9 ^ Math.imul(index + 1, 0x85ebca6b));
  if (shape === "narrow") {
    return [
      index + 1,
      text(random, 8, 24),
      STATUS[Math.floor(random() * 5)],
      Math.round(random() * 1e6) / 100,
      new Date(T0 + Math.floor(random() * 3e10)),
    ];
  }
  const created = T0 + Math.floor(random() * 3e10);
  return [
    (BigInt("9000000000000000000") + BigInt(index) * BigInt(7919)).toString(),
    Math.floor(random() * 2_000_000),
    index % 1000 === 999 ? Number.NaN : Math.round(random() * 1e4) / 100,
    random() < 0.5,
    text(random, 20, 40),
    text(random, 20, 200),
    text(random, 20, 2000),
    `${text(random, 6, 12).replaceAll(" ", ".")}@example.test`,
    STATUS[Math.floor(random() * 5)],
    new Date(created),
    new Date(created + Math.floor(random() * 1e9)),
    random() < 0.8 ? null : new Date(created + Math.floor(random() * 2e9)),
    bytes(random, 16),
    bytes(random, 32 + Math.floor(random() * 225)),
    {
      tags: [text(random, 3, 8), text(random, 3, 8), text(random, 3, 8)],
      meta: {
        source: REGION[Math.floor(random() * 4)],
        retries: Math.floor(random() * 5),
        nested: { flag: random() < 0.5, ratio: Math.round(random() * 1000) / 1000 },
      },
      version: 1 + Math.floor(random() * 9),
    },
    random() < 0.5 ? null : text(random, 20, 500),
    random() < 0.3 ? null : Math.floor(random() * 10000),
    (Math.floor(random() * 1e8) / 100).toFixed(2),
    random() < 0.3 ? null : random(),
    REGION[Math.floor(random() * 4)],
  ];
}

/** Row `index` as the legacy provider answers it: an object keyed by the shape's columns. */
function objectRow(shape: Shape, index: number): Record<string, unknown> {
  const values = cells(shape, index);
  const row: Record<string, unknown> = {};
  COLUMNS[shape].forEach((column, k) => {
    row[column] = values[k];
  });
  return row;
}

/**
 * The rows of a case: `count` rows, or for `max` every row while their size, as the host's page budget measures it,
 * stays within 32 MiB, so the host answers the whole page and both paths answer the same rows.
 */
export function generateRows(shape: Shape, count: RowCount | number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  if (count !== "max") {
    for (let index = 0; index < Number(count); index += 1) rows.push(objectRow(shape, index));
    return rows;
  }
  let size = 0;
  for (let index = 0; ; index += 1) {
    const row = objectRow(shape, index);
    size += encodedRowBytes(COLUMNS[shape].map((column) => row[column]));
    if (size > PAGE_MAX_BYTES) return rows;
    rows.push(row);
  }
}

// ---- the two paths over one fake legacy provider ----

const CONNECTION = { id: "bench", name: "Bench", type: "postgres", createdAt: new Date(0) } as DatabaseConnection;
const SCRUB = providerTextScrub(CONNECTION, "any");
const STATEMENT = "SELECT * FROM bench";
const OPTIONS: QueryPrepareOptions = {};

/** A legacy provider that answers `rows` whole to any statement and applies no page of its own. */
function legacyProvider(shape: Shape, rows: Record<string, unknown>[]): DatabaseProvider {
  const prepareQuery = (query: string, options: QueryPrepareOptions = {}): PreparedQuery => ({
    query,
    wasLimited: false,
    limit: options.limit ?? 500,
    offset: options.offset ?? 0,
  });
  const result: QueryResult = { rows, fields: [...COLUMNS[shape]], rowCount: rows.length, executionTime: 12 };
  return {
    type: CONNECTION.type,
    config: CONNECTION,
    prepareQuery,
    query: async () => result,
    // The bridge reads the session's object model from the provider; this one states none.
    getCapabilities: () => ({}),
  } as unknown as DatabaseProvider;
}

/** An answer's body as the route writes it: its rows, and the fields beside them. */
export interface AnswerBody {
  readonly rows: readonly unknown[];
  readonly pagination: Readonly<Record<string, unknown>>;
  readonly [field: string]: unknown;
}

/** Today's answer body, composed from the production helpers as `runEditorQuery` composed it before the host. */
async function todayBody(shape: Shape, rows: Record<string, unknown>[]): Promise<AnswerBody> {
  const provider = legacyProvider(shape, rows);
  const options = { ...OPTIONS };
  const prepared = provider.prepareQuery(STATEMENT, options);
  const probe = probePastPage(provider, STATEMENT, options, prepared);
  const result = await provider.query(probe.query, undefined, undefined, newQueryCallScope());
  const page = pageOfProbe(prepared, result.rows);
  const answered = firstResultSet(withScrubbedWarnings(SCRUB, result));
  return {
    ...answered,
    ...(page.hasMore && { rowCount: page.rows.length }),
    rows: rowsWithNonFiniteWords(page.rows),
    pagination: {
      limit: prepared.limit,
      offset: prepared.offset,
      hasMore: page.hasMore,
      totalReturned: page.rows.length,
      wasLimited: page.hasMore || result.pagination?.wasLimited === true,
    },
  };
}

/** Today's answer text, as the route writes it. */
export async function todayText(shape: Shape, rows: Record<string, unknown>[]): Promise<string> {
  return JSON.stringify(await todayBody(shape, rows));
}

/** The host's answer body: `runEditorQuery`'s. */
async function hostBody(shape: Shape, rows: Record<string, unknown>[]): Promise<AnswerBody> {
  const { body } = await runEditorQuery(
    { form: "provider", provider: legacyProvider(shape, rows) },
    {
      statement: STATEMENT,
      options: { ...OPTIONS },
      signal: new AbortController().signal,
      route: "bench",
      scrub: SCRUB,
    },
  );
  return body as unknown as AnswerBody;
}

/** The host's answer text: `runEditorQuery`'s body as the route writes it. */
export async function hostText(shape: Shape, rows: Record<string, unknown>[]): Promise<string> {
  return JSON.stringify(await hostBody(shape, rows));
}

/**
 * Compares the host's answer with today's on every row the host answered, each by the text the route writes for it,
 * and on the rest of the body as a whole. A host page with fewer rows is a page cut by bytes: its rows are today's
 * first rows, and the rest of its body is today's with the cut's `rowCount`, `totalReturned` and `wasLimited`.
 *
 * @throws {Error} When the answers differ, naming the first row that does.
 */
export function compareAnswers(today: AnswerBody, host: AnswerBody): void {
  const answered = host.rows.length;
  if (answered > today.rows.length) {
    throw new Error(`The host answered ${answered} rows, more than today's ${today.rows.length}.`);
  }
  for (let index = 0; index < answered; index += 1) {
    if (JSON.stringify(host.rows[index]) !== JSON.stringify(today.rows[index])) {
      throw new Error(`The two paths answer different texts at row ${index}.`);
    }
  }
  const cut = answered < today.rows.length;
  const expected = cut
    ? {
        ...today,
        rowCount: answered,
        pagination: { ...today.pagination, totalReturned: answered, wasLimited: true },
      }
    : today;
  if (JSON.stringify({ ...host, rows: undefined }) !== JSON.stringify({ ...expected, rows: undefined })) {
    throw new Error("The two paths answer different texts beside the rows.");
  }
}

/** The longest gap between two `setImmediate` turns of a ticker while the host's execute call runs over the bridge. */
async function executeSlice(shape: Shape, rows: Record<string, unknown>[]): Promise<number> {
  const bridged = bridgedConsole(legacyProvider(shape, rows), { ...OPTIONS });
  const deadline = Date.now() + 600_000;
  let running = true;
  let last = performance.now();
  let longest = 0;
  const tick = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  const record = await hostCore().executeCall(
    bridged.session,
    { statement: STATEMENT, page: { limit: 500, offset: 0 } },
    { deadline, signal: deadlineSignal(deadline), env: envReader([], () => undefined) },
    bridged.pumpLimits,
    { late: () => {}, cancelFailed: () => {} },
  );
  running = false;
  if (record.kind !== "page") throw new Error(`The host's execute call answered ${record.kind}, not a page.`);
  record.release();
  return Math.max(longest, performance.now() - last);
}

// ---- one case in a fresh child ----

const runtime = globalThis as unknown as { gc?: () => void };

function collect(): void {
  if (runtime.gc === undefined) throw new Error("No gc: run the case under node --expose-gc.");
  runtime.gc();
  runtime.gc();
}

function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))] as number;
}

/**
 * The live heap `path` adds over `rows`, read after a forced gc at every turn the host yields and at the answer.
 * The sample scheduled for the turn after the answer is cleared, so no forced gc of this reading runs inside the
 * slice read next: a pending one held the first slice of the wide 100,000-row case for two full collections, about
 * 85 ms with that case's rows live.
 */
export async function heapAdded(path: BenchPath, shape: Shape, rows: Record<string, unknown>[]): Promise<number> {
  collect();
  const base = process.memoryUsage().heapUsed;
  let peak = base;
  let pending: NodeJS.Immediate | undefined;
  const sample = () => {
    collect();
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    pending = setImmediate(sample);
  };
  if (path === "host") pending = setImmediate(sample);
  const answer = await (path === "host" ? hostText(shape, rows) : todayText(shape, rows));
  clearImmediate(pending);
  collect();
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  if (answer.length === 0) throw new Error("The answer is empty.");
  return (peak - base) / 2 ** 20;
}

/**
 * Runs one case, `--shape`, `--rows`, `--path`, from `argv`, and answers its report: the answers of both paths compared
 * on every answered row, then the heap, the slice on the host path, and the timed repetitions after warm-up, each
 * after a forced gc.
 *
 * @throws {Error} When the two paths answer different texts, or an argument is not one the benchmark defines.
 */
export async function runCase(argv: readonly string[]): Promise<CaseReport> {
  const args = new Map<string, string>();
  for (let index = 0; index + 1 < argv.length; index += 2) args.set(argv[index].replace(/^--/, ""), argv[index + 1]);
  const shape = args.get("shape") as Shape;
  const rowsArg = args.get("rows") as RowCount;
  const path = args.get("path") as BenchPath;
  if (!(shape in COLUMNS) || !ROW_COUNTS.includes(rowsArg) || (path !== "today" && path !== "host")) {
    throw new Error(`Not a benchmark case: ${argv.join(" ")}`);
  }
  const { warmup, reps } = REPETITIONS[rowsArg];
  const rows = generateRows(shape, rowsArg);

  compareAnswers(await todayBody(shape, rows), await hostBody(shape, rows));

  const heapAddedMiB = await heapAdded(path, shape, rows);
  let sliceMaxMs = 0;
  if (path === "host") {
    for (let k = 0; k < reps; k += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time: a slice is read on an otherwise idle loop.
      sliceMaxMs = Math.max(sliceMaxMs, await executeSlice(shape, rows));
    }
  }

  const times: number[] = [];
  let answerBytes = 0;
  for (let k = 0; k < warmup + reps; k += 1) {
    collect();
    const started = performance.now();
    // oxlint-disable-next-line no-await-in-loop -- one timed run at a time, each after its own forced gc.
    const answer = await (path === "host" ? hostText(shape, rows) : todayText(shape, rows));
    const elapsed = performance.now() - started;
    answerBytes = Buffer.byteLength(answer);
    if (k >= warmup) times.push(elapsed);
  }

  return {
    runtime: `node ${process.version}`,
    shape,
    rowsArg,
    rows: rows.length,
    path,
    reps,
    answerBytes,
    medianMs: quantile(times, 0.5),
    p95Ms: quantile(times, 0.95),
    heapAddedMiB,
    sliceMaxMs,
  };
}
