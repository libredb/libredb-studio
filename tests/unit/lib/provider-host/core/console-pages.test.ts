/**
 * The console execute under the host's page budget (src/lib/provider-host/core/console.ts and page-budget.ts;
 * docs/providers/CONTRACT.md, clause C-53): every page takes its first batch without waiting, a page that needs a
 * second batch takes the one large-page slot first and holds it until its record is released, and every path that ends
 * without a page gives the slot back before the call answers.
 *
 * Each call runs on `consoleCalls` over a budget of one slot this file creates per test, with fake sessions whose
 * sources answer one row per pull and record the budget at each pull. The test waits on what its fixtures signal, a
 * pull reached or a batch it holds, and on the budget's state through a bounded poll over turns that fails by name; no
 * timer is awaited and no assertion follows one.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  BATCH_MAX_BYTES,
  type CallContext,
  deadlineSignal,
  envReader,
  type ExecuteAnswer,
  type ExecuteRequest,
  PAGE_MAX_BYTES,
  type PumpLimits,
  type ResultSource,
} from "@libredb/provider-sdk/calls";
import {
  type ConsoleCalls,
  type ConsoleSession,
  consoleCalls,
  type ExecuteRecord,
  type HostCallPorts,
  type PageRecord,
} from "@/lib/provider-host/core/console";
import { createPageBudget, type PageBudget } from "@/lib/provider-host/core/page-budget";

const HOUR = 3_600_000;
const LIMITS: PumpLimits = { maxRows: 100, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES };

let budget: PageBudget;
let calls: ConsoleCalls;

beforeEach(() => {
  budget = createPageBudget(1);
  calls = consoleCalls(budget);
});

/** Lets every callback already queued run: one turn of the event loop, never a timer an assertion waits on. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Waits, one turn at a time, until `condition` holds; one that never holds within 200 turns fails by name. */
async function until(what: string, condition: () => boolean): Promise<void> {
  for (let turns = 0; turns < 200; turns += 1) {
    if (condition()) return;
    // oxlint-disable-next-line no-await-in-loop -- one turn at a time until the condition holds, bounded.
    await turn();
  }
  throw new Error(`Waited 200 turns and ${what} never held.`);
}

function contextOf(controller = new AbortController()): CallContext {
  return { deadline: Date.now() + HOUR, signal: controller.signal, env: envReader([], () => undefined) };
}

function requestOf(): ExecuteRequest {
  return { statement: `select ${randomUUID()}`, page: { limit: 100, offset: 0 } };
}

/**
 * A source of `count` batches of one row each, `[1]` to `[count]`, that records the budget's held count at each pull
 * and its closes; `gate(n)` holds the answer of pull `n` until the test opens it, and `reached(n)` resolves when pull
 * `n` starts.
 */
function paged(count: number) {
  const seen = { pulls: 0, closes: 0, heldAtPull: [] as number[] };
  const starts = Array.from({ length: count + 1 }, () => Promise.withResolvers<void>());
  const gates: (PromiseWithResolvers<void> | undefined)[] = [];
  const source: ResultSource = {
    columns: [{ name: "v" }],
    next: async () => {
      seen.pulls += 1;
      const pull = seen.pulls;
      seen.heldAtPull.push(budget.state().held);
      starts[pull]?.resolve();
      await gates[pull]?.promise;
      return { rows: [[pull]], done: pull >= count };
    },
    close: async () => {
      seen.closes += 1;
    },
  };
  return {
    source,
    seen,
    reached: (pull: number) => (starts[pull] as PromiseWithResolvers<void>).promise,
    gate: (pull: number) => {
      const gate = Promise.withResolvers<void>();
      gates[pull] = gate;
      return gate;
    },
  };
}

/** The rows of a page of `count` batches. */
const rowsUpTo = (count: number) => Array.from({ length: count }, (_, index) => [index + 1]);

/** A session whose execute answers `results`, and no cancel. */
function sessionOf(results: readonly ResultSource[]): ConsoleSession {
  return {
    calls: {
      console: {
        execute: { honours: ["params", "offset"] },
        cancel: "not-offered",
        endScope: "not-offered",
        transaction: "not-offered",
      },
      objects: { tree: "not-offered" },
      maintenance: { run: "not-offered", preview: "not-offered" },
      monitoring: { panel: "not-offered", poolStats: "not-offered" },
    },
    readOnlyStatements: false,
    execute: async (): Promise<ExecuteAnswer> => ({ results, warnings: [], executionTimeMs: 1, pageApplied: true }),
  };
}

/** Ports that record every late failure and every failed cancel. */
function portsOf() {
  const late: unknown[] = [];
  const ports: HostCallPorts = { late: (error) => late.push(error), cancelFailed: (error) => late.push(error) };
  return { ports, late };
}

/** One execute of `results` on the file's console calls. */
function run(
  results: readonly ResultSource[],
  options: { readonly controller?: AbortController; readonly limits?: PumpLimits; readonly ports?: HostCallPorts } = {},
): Promise<ExecuteRecord> {
  return calls.executeCall(
    sessionOf(results),
    requestOf(),
    contextOf(options.controller),
    () => options.limits ?? LIMITS,
    options.ports ?? portsOf().ports,
  );
}

/** `record` as a page record; any other kind fails the case. */
function pageOf(record: ExecuteRecord): PageRecord {
  if (record.kind !== "page") throw new Error(`The call answered ${record.kind}, not a page.`);
  return record;
}

/** What `promise` threw; one that answers fails the case. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("The call was expected to fail, and it answered.");
}

describe("the console execute under the page budget", () => {
  test("every page takes its first batch without waiting", async () => {
    const holder = paged(3);
    const gate = holder.gate(2);
    const a = run([holder.source]);
    await holder.reached(2);
    const b = paged(3);
    const c = paged(1);
    const others = [run([b.source]), run([c.source])];

    await until("the second page waiting for the slot", () => budget.state().waiting === 1);
    const one = pageOf(await (others[1] as Promise<ExecuteRecord>));

    expect(b.seen.pulls).toBe(1);
    expect(one.page.rows).toEqual([[1]]);
    expect(c.seen.heldAtPull).toEqual([1]);
    gate.resolve();
    pageOf(await a).release();
    const second = pageOf(await (others[0] as Promise<ExecuteRecord>));
    expect(second.page.rows).toEqual(rowsUpTo(3));
    second.release();
    one.release();
    expect(budget.state()).toEqual({ slots: 1, held: 0, waiting: 0 });
  });

  test("of two concurrent large pages the second waits for the slot holding one batch, and is pumped once the first page is released", async () => {
    const first = paged(3);
    const second = paged(3);
    const a = run([first.source]);
    await first.reached(2);
    const b = run([second.source]);

    const recordA = pageOf(await a);
    await until("the second page waiting for the slot", () => budget.state().waiting === 1);
    await turn();

    expect(recordA.page.rows).toEqual(rowsUpTo(3));
    expect(second.seen.pulls).toBe(1);
    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 1 });
    recordA.release();
    const recordB = pageOf(await b);
    expect(recordB.page.rows).toEqual(rowsUpTo(3));
    expect(second.seen.heldAtPull).toEqual([1, 1, 1]);
    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 0 });
    recordB.release();
    expect(budget.state()).toEqual({ slots: 1, held: 0, waiting: 0 });
    expect([first.seen.closes, second.seen.closes]).toEqual([1, 1]);
  });

  test("three concurrent large pages are pumped one after another in arrival order, each waiting page holding one batch and no slot", async () => {
    const pages = [paged(3), paged(3), paged(3)];
    const [first, second, third] = pages as [ReturnType<typeof paged>, ...ReturnType<typeof paged>[]];
    const a = run([first.source]);
    await first.reached(2);
    const b = run([(second as ReturnType<typeof paged>).source]);
    await until("the second page waiting", () => budget.state().waiting === 1);
    const c = run([(third as ReturnType<typeof paged>).source]);
    await until("the third page waiting", () => budget.state().waiting === 2);

    expect(pages.map((page) => page.seen.pulls)).toEqual([3, 1, 1]);
    pageOf(await a).release();
    const recordB = pageOf(await b);
    expect(pages.map((page) => page.seen.pulls)).toEqual([3, 3, 1]);
    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 1 });
    recordB.release();
    const recordC = pageOf(await c);
    recordC.release();

    expect([recordB.page.rows, recordC.page.rows]).toEqual([rowsUpTo(3), rowsUpTo(3)]);
    expect(pages.flatMap((page) => page.seen.heldAtPull).every((held) => held <= 1)).toBe(true);
    expect(pages.map((page) => page.seen.closes)).toEqual([1, 1, 1]);
    expect(budget.state()).toEqual({ slots: 1, held: 0, waiting: 0 });
  });

  test("a page of one batch answers at once beside a large page that holds the slot", async () => {
    const large = paged(3);
    const gate = large.gate(3);
    const a = run([large.source]);
    await large.reached(3);
    const small = paged(1);

    const record = pageOf(await run([small.source]));

    expect(record.page).toEqual({ rows: [[1]], bytes: 3, end: "done" });
    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 0 });
    record.release();
    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 0 });
    gate.resolve();
    pageOf(await a).release();
    expect(budget.state()).toEqual({ slots: 1, held: 0, waiting: 0 });
  });

  test("a page whose pump is refused or fails, or whose other results fail to close, gives its slot back before the call answers", async () => {
    // A second batch whose row is larger than the whole page.
    const overPage: ResultSource = {
      columns: [{ name: "v" }],
      next: async () =>
        budget.state().held === 0 ? { rows: [[1]], done: false } : { rows: [["x".repeat(64)]], done: true },
      close: async () => {},
    };
    const refused = await run([overPage], { limits: { maxRows: 100, maxBytes: 16, batchMaxBytes: 16 } });
    expect(refused).toEqual({
      kind: "refused",
      called: true,
      refusals: [{ rule: "row-over-page", pointer: "/rows/0", limit: 16, size: 68 }],
    });
    expect(budget.state()).toEqual({ slots: 1, held: 0, waiting: 0 });

    const pulled = new Error(randomUUID());
    let pulls = 0;
    const failing: ResultSource = {
      columns: [{ name: "v" }],
      next: async () => {
        pulls += 1;
        if (pulls === 2) throw pulled;
        return { rows: [[pulls]], done: false };
      },
      close: async () => {},
    };
    expect(await failure(run([failing]))).toBe(pulled);
    expect(budget.state()).toEqual({ slots: 1, held: 0, waiting: 0 });

    const closeError = new Error(randomUUID());
    const brokenClose: ResultSource = {
      columns: [{ name: "v" }],
      next: async () => ({ rows: [], done: true }),
      close: async () => {
        throw closeError;
      },
    };
    const large = paged(2);
    expect(await failure(run([large.source, brokenClose]))).toBe(closeError);
    expect(large.seen.heldAtPull).toEqual([0, 1]);
    expect(budget.state()).toEqual({ slots: 1, held: 0, waiting: 0 });
  });

  test("a page answered after its call stopped gives its slot back", async () => {
    const large = paged(3);
    const gate = large.gate(3);
    const controller = new AbortController();
    const { ports, late } = portsOf();
    const running = run([large.source], { controller, ports });
    await large.reached(3);
    expect(budget.state().held).toBe(1);

    controller.abort();
    const record = await running;
    expect(record.kind).toBe("stopped");
    expect((record as { readonly waitingFor?: string }).waitingFor).toBe("page");
    expect(budget.state().held).toBe(1);
    gate.resolve();
    await until("the late page giving its slot back", () => budget.state().held === 0);
    await turn();

    expect(large.seen.closes).toBe(1);
    expect(late).toEqual([]);
  });

  /** A large page that holds the slot, and a second one whose call `controller` ends while it waits for the slot. */
  async function stoppedWhileWaiting(reason: unknown) {
    const holder = paged(2);
    const held = pageOf(await run([holder.source]));
    const waiting = paged(3);
    const controller = new AbortController();
    const { ports, late } = portsOf();
    const running = run([waiting.source], { controller, ports });
    await until("the second page waiting for the slot", () => budget.state().waiting === 1);

    controller.abort(reason);
    const record = await running;
    const state = budget.state();
    await until("the waiting page's source closed", () => waiting.seen.closes === 1);
    await turn();
    held.release();
    return { record, state, waiting, late };
  }

  test("a call whose wait for a slot its caller ends answers a stop marked as waiting for the slot, and holds no slot", async () => {
    const reason = new DOMException("The request went away.", "AbortError");

    const { record, state, waiting, late } = await stoppedWhileWaiting(reason);

    expect(record).toEqual({ kind: "stopped", reason, waitingFor: "large-page-slot", settled: expect.any(Promise) });
    expect((record as { readonly reason: unknown }).reason).toBe(reason);
    expect(state).toEqual({ slots: 1, held: 1, waiting: 0 });
    expect(waiting.seen.pulls).toBe(1);
    expect(late).toEqual([]);
    expect(budget.state()).toEqual({ slots: 1, held: 0, waiting: 0 });
  });

  test("a call whose wait for a slot its deadline ends answers a stop marked as waiting for the slot", async () => {
    const reason = new DOMException("The call's deadline has passed.", "TimeoutError");

    const { record, state, late } = await stoppedWhileWaiting(reason);

    expect(record).toEqual({ kind: "stopped", reason, waitingFor: "large-page-slot", settled: expect.any(Promise) });
    expect(state).toEqual({ slots: 1, held: 1, waiting: 0 });
    expect(late).toEqual([]);
  });

  /**
   * A page whose first pull the test holds, on a session that offers cancel, run under `ctx`; it answers the record,
   * once `stop` ended the call while the pull was held, and the runs the cancel was sent for, and then lets the pull go.
   */
  async function stoppedWhileRead(ctx: CallContext, stop: () => void) {
    const read = paged(2);
    const gate = read.gate(1);
    const cancelled: string[] = [];
    const session: ConsoleSession = {
      calls: {
        console: { execute: { honours: [] }, cancel: "offered", endScope: "not-offered", transaction: "not-offered" },
        objects: { tree: "not-offered" },
        maintenance: { run: "not-offered", preview: "not-offered" },
        monitoring: { panel: "not-offered", poolStats: "not-offered" },
      },
      readOnlyStatements: false,
      execute: async (): Promise<ExecuteAnswer> => ({
        results: [read.source],
        warnings: [],
        executionTimeMs: 1,
        pageApplied: true,
      }),
      cancel: async (request) => {
        cancelled.push(request.runId);
        return { cancelled: true };
      },
    };
    const { ports, late } = portsOf();
    const runId = randomUUID();
    const running = calls.executeCall(session, { ...requestOf(), runId }, ctx, () => LIMITS, ports);
    await read.reached(1);
    stop();
    const record = await running;
    gate.resolve();
    await until("the read page's source closed", () => read.seen.closes === 1);
    await turn();
    return { record, cancelled, runId, late };
  }

  test("a call whose page its caller stops while it is read answers a stop marked as waiting for the page", async () => {
    const controller = new AbortController();
    const reason = new DOMException("The request went away.", "AbortError");

    const { record, cancelled, runId, late } = await stoppedWhileRead(contextOf(controller), () =>
      controller.abort(reason),
    );

    expect(record).toEqual({ kind: "stopped", reason, waitingFor: "page", settled: expect.any(Promise) });
    expect((record as { readonly reason: unknown }).reason).toBe(reason);
    expect(cancelled).toEqual([runId]);
    expect(late).toEqual([]);
    expect(budget.state()).toEqual({ slots: 1, held: 0, waiting: 0 });
  });

  test("a call whose page its deadline stops while it is read answers a stop marked as waiting for the page", async () => {
    // The deadline's own timer is an hour away, so the test ends the call with the deadline's reason itself, once the
    // pull is held, and no runner's speed decides when the stop lands.
    const deadline = Date.now() + HOUR;
    const passed = new AbortController();
    const signal = AbortSignal.any([deadlineSignal(deadline), passed.signal]);
    const ctx: CallContext = { deadline, signal, env: envReader([], () => undefined) };
    const reason = new DOMException("The call's deadline has passed.", "TimeoutError");

    const { record, cancelled, runId, late } = await stoppedWhileRead(ctx, () => passed.abort(reason));

    expect(record).toEqual({ kind: "stopped", reason, waitingFor: "page", settled: expect.any(Promise) });
    expect((record as { readonly reason: unknown }).reason).toBe(signal.reason);
    expect(cancelled).toEqual([runId]);
    expect(late).toEqual([]);
    expect(budget.state()).toEqual({ slots: 1, held: 0, waiting: 0 });
  });

  test("a call stopped after its page was read, while its other results close, answers a stop marked as closing them", async () => {
    const read = paged(1);
    const closing = Promise.withResolvers<void>();
    const closeHeld = Promise.withResolvers<void>();
    const other: ResultSource = {
      columns: [{ name: "w" }],
      next: async () => ({ rows: [], done: true }),
      close: async () => {
        closing.resolve();
        await closeHeld.promise;
      },
    };
    const controller = new AbortController();
    const reason = new DOMException("The request went away.", "AbortError");
    const running = run([read.source, other], { controller });
    await closing.promise;

    controller.abort(reason);
    const record = await running;
    closeHeld.resolve();

    expect(read.seen).toEqual({ pulls: 1, closes: 1, heldAtPull: [0] });
    expect(record).toEqual({ kind: "stopped", reason, waitingFor: "other-results", settled: expect.any(Promise) });
    await until("the late page giving its slot back", () => budget.state().held === 0);
  });

  test("a page record released twice is refused by name", async () => {
    const large = pageOf(await run([paged(2).source]));
    const small = pageOf(await run([paged(1).source]));
    const message =
      "A page record was released twice, a defect of its caller: each page record is released exactly once, after its answer body is built.";

    large.release();
    small.release();

    expect(() => large.release()).toThrow(new Error(message));
    expect(() => small.release()).toThrow(new Error(message));
    expect(budget.state()).toEqual({ slots: 1, held: 0, waiting: 0 });
  });
});
