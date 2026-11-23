/**
 * The host's page budget (docs/providers/CONTRACT.md, clause C-53), part of the provider host core.
 *
 * A page budget holds a count of large-page slots. Every page takes its first batch without waiting, at most
 * `BATCH_MAX_BYTES` or one row; a page that needs a second batch first takes a slot, `withLargePageSlot`, and runs every
 * later pull under it. A page that finds every slot held waits for one, in arrival order, until its call's signal
 * aborts; a waiting page holds its first batch, in the pump, and no slot, so no two pages wait on each other. The caller
 * releases the page once its answer body is built, exactly once, which releases its slot; the host releases a page that
 * ends any other way. A slot released twice is refused by name, never ignored.
 *
 * A host core holds one budget of `LARGE_PAGE_SLOTS` slots, one (src/lib/provider-host/core/host-core.ts). One is the
 * count measured safe on the 384 MiB old space the image and the chart set: a bridged 32 MiB page at its fullest holds
 * about 150 MiB, its provider's rows included, so two at once leave too little beside Studio's idle heap. The count
 * does not follow the heap limit V8 reports, since that limit adds a young generation whose size differs by Node
 * version and machine, and Bun reports another; a count read from it would give one deployment different counts. A
 * legacy provider has answered every row before the first pull, so a slot is held for the pump and the body only, and a
 * concurrent large page waits about that long for each page ahead of it.
 *
 * The budget does not bound a legacy provider's own rows, held before the first pull, nor the caller's answer text,
 * written from the body after the release.
 *
 * `state()` answers the budget's counts as data, for a test or a debugger. Core imports only the SDK's public subpaths
 * other than `testing`, Node built-ins and its own files, and keeps no module state: each budget's queue lives in the
 * budget (tests/unit/lib/provider-host/core-boundary.test.ts).
 */
import { type CallContext, CallRefusalError, checkCallStart, type ResultSource } from "@libredb/provider-sdk/calls";

/** How many large-page slots a host core's budget holds. */
export const LARGE_PAGE_SLOTS = 1;

/** A large-page slot a page holds; released exactly once. */
export interface LargePageSlot {
  /**
   * Gives the slot back, to the first page waiting for one.
   *
   * @throws {Error} For a slot already released, a defect of the host.
   */
  release(): void;
}

/** A budget's counts, as data. */
export interface PageBudgetState {
  readonly slots: number;
  readonly held: number;
  readonly waiting: number;
}

/** A budget of large-page slots. */
export interface PageBudget {
  readonly slots: number;
  /**
   * A slot: at once when one is free, otherwise once one is released to this taker, in arrival order. Rejects with the
   * signal's reason, by reference, when `signal` aborts first or had aborted already, and the taker leaves the queue.
   */
  take(signal: AbortSignal): Promise<LargePageSlot>;
  state(): PageBudgetState;
}

/** What one page holds of the budget: the slot it took, and whether it is waiting for one. */
export interface PageHold {
  slot?: LargePageSlot;
  /** Set before the page asks for a slot, and cleared only when it is granted one. */
  waiting: boolean;
}

const RELEASED_TWICE =
  "A large-page slot was released twice, a defect of the host: each slot is released exactly once, by the page that took it.";

/**
 * A new budget of `slots` large-page slots, none held.
 *
 * @throws {RangeError} For a slot count that is not a positive safe integer, a host defect.
 */
export function createPageBudget(slots: number): PageBudget {
  if (!Number.isSafeInteger(slots) || slots <= 0) {
    throw new RangeError("The page budget's slot count must be a positive safe integer.");
  }
  const waiters: (() => void)[] = [];
  let held = 0;

  function grant(): LargePageSlot {
    held += 1;
    let released = false;
    return Object.freeze({
      release(): void {
        if (released) throw new Error(RELEASED_TWICE);
        released = true;
        held -= 1;
        waiters.shift()?.();
      },
    });
  }

  return Object.freeze({
    slots,
    take(signal: AbortSignal): Promise<LargePageSlot> {
      if (signal.aborted) return Promise.reject(signal.reason);
      if (held < slots) return Promise.resolve(grant());
      return new Promise<LargePageSlot>((resolve, reject) => {
        const admit = (): void => {
          signal.removeEventListener("abort", leave);
          resolve(grant());
        };
        const leave = (): void => {
          waiters.splice(waiters.indexOf(admit), 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", leave, { once: true });
        waiters.push(admit);
      });
    },
    state: (): PageBudgetState => ({ slots, held, waiting: waiters.length }),
  });
}

/**
 * `source`, its first pull passed through and every later one run under a large-page slot of `budget`, taken before
 * the second pull and recorded in `hold`; the page's caller releases it.
 *
 * A wait for the slot that `ctx.signal` ends throws `CallRefusalError` with every refusal `checkCallStart` answers, the
 * signal's reason as its cause, and the source is not pulled. `columns`, `rowCount` and `close` are the source's own.
 */
export function withLargePageSlot(
  source: ResultSource,
  budget: PageBudget,
  ctx: Pick<CallContext, "deadline" | "signal">,
  hold: PageHold,
): ResultSource {
  let pulled = false;
  return Object.freeze({
    columns: source.columns,
    ...(source.rowCount === undefined ? {} : { rowCount: source.rowCount }),
    async next(limit: Parameters<ResultSource["next"]>[0]) {
      if (pulled && hold.slot === undefined) {
        hold.waiting = true;
        try {
          hold.slot = await budget.take(ctx.signal);
        } catch {
          throw new CallRefusalError(checkCallStart(ctx), { cause: ctx.signal.reason });
        }
        hold.waiting = false;
      }
      pulled = true;
      return source.next(limit);
    },
    close: () => source.close(),
  });
}
