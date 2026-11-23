/**
 * The host's page budget (src/lib/provider-host/core/page-budget.ts; docs/providers/CONTRACT.md, clause C-53): a budget
 * of large-page slots, one in a host core, taken in arrival order and released exactly once, and the source wrapper that
 * takes a slot before a page's second pull and runs every later pull under it.
 *
 * Every wait here is ended by a signal the test aborts itself or by a release the test makes; no timer is awaited and
 * no assertion follows one. `page-budget-bounds.test.ts` holds a wait a real deadline ends, in a bounded Node child.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type BatchLimit,
  type CallContext,
  CallRefusalError,
  encodedRowBytes,
  envReader,
  type ResultSource,
  rowsSource,
} from "@libredb/provider-sdk/calls";
import {
  createPageBudget,
  LARGE_PAGE_SLOTS,
  type LargePageSlot,
  type PageHold,
  withLargePageSlot,
} from "@/lib/provider-host/core/page-budget";

const HOUR = 3_600_000;
const LIMIT: BatchLimit = Object.freeze({ maxRows: 1, maxBytes: 1_024, measure: encodedRowBytes });

function contextOf(controller = new AbortController()): CallContext {
  return { deadline: Date.now() + HOUR, signal: controller.signal, env: envReader([], () => undefined) };
}

/** Lets every callback already queued run: one turn of the event loop, never a timer an assertion waits on. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A signal that never aborts. */
const open = (): AbortSignal => new AbortController().signal;

/** Whether `promise` has settled after the callbacks already queued ran. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await turn();
  return done;
}

describe("the page budget", () => {
  test("a free slot is taken at once, and a host core's budget holds one slot", async () => {
    expect(LARGE_PAGE_SLOTS).toBe(1);
    const budget = createPageBudget(LARGE_PAGE_SLOTS);
    expect(budget.slots).toBe(1);
    expect(budget.state()).toEqual({ slots: 1, held: 0, waiting: 0 });

    const slot = await budget.take(open());

    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 0 });
    slot.release();
    expect(budget.state()).toEqual({ slots: 1, held: 0, waiting: 0 });
  });

  test("a page that finds every slot held waits, and slots go in arrival order as they are released", async () => {
    const budget = createPageBudget(1);
    const granted: string[] = [];
    const first = await budget.take(open());
    const second = budget.take(open()).then((slot) => {
      granted.push("second");
      return slot;
    });
    const third = budget.take(open()).then((slot) => {
      granted.push("third");
      return slot;
    });

    expect(await settled(second)).toBe(false);
    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 2 });

    first.release();
    const secondSlot = await second;
    expect(granted).toEqual(["second"]);
    expect(await settled(third)).toBe(false);
    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 1 });

    secondSlot.release();
    const thirdSlot = await third;
    expect(granted).toEqual(["second", "third"]);
    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 0 });
    thirdSlot.release();
    expect(budget.state()).toEqual({ slots: 1, held: 0, waiting: 0 });
  });

  test("a wait its signal ends rejects with the signal's reason and leaves the queue", async () => {
    const budget = createPageBudget(1);
    const first = await budget.take(open());
    const controller = new AbortController();
    const reason = new Error(randomUUID());
    const leaving = budget.take(controller.signal);
    const staying = budget.take(open());
    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 2 });

    controller.abort(reason);
    const caught = await leaving.catch((error: unknown) => error);

    expect(caught).toBe(reason);
    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 1 });
    first.release();
    const next = await staying;
    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 0 });
    next.release();
  });

  test("a signal already aborted is refused at once and takes no free slot", async () => {
    const budget = createPageBudget(1);
    const controller = new AbortController();
    const reason = new Error(randomUUID());
    controller.abort(reason);

    const caught = await budget.take(controller.signal).catch((error: unknown) => error);

    expect(caught).toBe(reason);
    expect(budget.state()).toEqual({ slots: 1, held: 0, waiting: 0 });
  });

  test("a slot released twice is refused by name", async () => {
    const budget = createPageBudget(1);
    const slot = await budget.take(open());
    const waiting = budget.take(open());
    slot.release();
    const next = await waiting;
    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 0 });

    expect(() => slot.release()).toThrow(
      new Error(
        "A large-page slot was released twice, a defect of the host: each slot is released exactly once, by the page that took it.",
      ),
    );
    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 0 });
    next.release();
  });

  test("a slot count that is not a positive safe integer is refused", () => {
    for (const slots of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createPageBudget(slots)).toThrow(
        new RangeError("The page budget's slot count must be a positive safe integer."),
      );
    }
    expect(createPageBudget(3).state()).toEqual({ slots: 3, held: 0, waiting: 0 });
  });
});

/** A source of `count` one-cell rows that records the budget's held count at each pull, and its closes. */
function observed(count: number, budget: ReturnType<typeof createPageBudget>) {
  const inner = rowsSource(
    [{ name: "v" }],
    Array.from({ length: count }, (_, index) => [index]),
    count,
  );
  const seen = { heldAtPull: [] as number[], closes: 0 };
  const source: ResultSource = {
    columns: inner.columns,
    rowCount: count,
    next: (limit: BatchLimit) => {
      seen.heldAtPull.push(budget.state().held);
      return inner.next(limit);
    },
    close: async () => {
      seen.closes += 1;
    },
  };
  return { source, seen };
}

describe("withLargePageSlot", () => {
  test("a page's first pull takes no slot, and every later pull runs under the one slot it took", async () => {
    const budget = createPageBudget(1);
    const { source, seen } = observed(3, budget);
    const hold: PageHold = { waiting: false };
    const wrapped = withLargePageSlot(source, budget, contextOf(), hold);

    expect(wrapped.columns).toBe(source.columns);
    expect(wrapped.rowCount).toBe(3);
    expect(await wrapped.next(LIMIT)).toEqual({ rows: [[0]], done: false });
    expect(hold).toEqual({ waiting: false });
    expect(budget.state().held).toBe(0);
    expect(await wrapped.next(LIMIT)).toEqual({ rows: [[1]], done: false });
    const slot = hold.slot as LargePageSlot;
    expect(slot).toBeDefined();
    expect(hold.waiting).toBe(false);
    expect(await wrapped.next(LIMIT)).toEqual({ rows: [[2]], done: true });
    expect(hold.slot).toBe(slot);
    expect(seen.heldAtPull).toEqual([0, 1, 1]);
    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 0 });

    await wrapped.close();
    expect(seen.closes).toBe(1);
    slot.release();
    expect(budget.state().held).toBe(0);

    const unknownCount = withLargePageSlot(rowsSource([{ name: "v" }], []), budget, contextOf(), { waiting: false });
    expect("rowCount" in unknownCount).toBe(false);
    expect(Object.isFrozen(wrapped)).toBe(true);
  });

  test("a pull whose wait for a slot the call's signal ends is refused as checkCallStart answers, the signal's reason as its cause, and the source is not pulled", async () => {
    const budget = createPageBudget(1);
    const other = await budget.take(open());
    const { source, seen } = observed(3, budget);
    const controller = new AbortController();
    const reason = new Error(randomUUID());
    const hold: PageHold = { waiting: false };
    const wrapped = withLargePageSlot(source, budget, contextOf(controller), hold);

    await wrapped.next(LIMIT);
    const second = wrapped.next(LIMIT);
    expect(await settled(second)).toBe(false);
    expect(hold.waiting).toBe(true);
    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 1 });

    controller.abort(reason);
    const caught = await second.catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(CallRefusalError);
    expect((caught as CallRefusalError).refusals).toEqual([{ rule: "call-signal-aborted", pointer: "/signal" }]);
    expect((caught as Error).cause).toBe(reason);
    // The first pull ran while the other page held the only slot; the refused pull never reached the source.
    expect(seen.heldAtPull).toEqual([1]);
    expect(hold.slot).toBeUndefined();
    expect(hold.waiting).toBe(true);
    expect(budget.state()).toEqual({ slots: 1, held: 1, waiting: 0 });
    other.release();
  });
});
