/**
 * A turn of the event loop before every pull (src/lib/provider-host/core/turns.ts; docs/providers/CONTRACT.md, clause
 * C-49): a page pumped over a source already in memory never leaves the microtask queue on its own, so the host awaits
 * one `setImmediate` turn before each pull, and refuses the pull when the call's signal aborted or its deadline passed
 * during that turn.
 *
 * A ticker counts `setImmediate` turns; no timer is awaited and no assertion follows one.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type BatchLimit,
  type CallContext,
  CallRefusalError,
  encodedRowBytes,
  envReader,
  pumpPage,
  type ResultSource,
  rowsSource,
} from "@libredb/provider-sdk/calls";
import { withTurns } from "@/lib/provider-host/core/turns";

const HOUR = 3_600_000;

function contextOf(controller = new AbortController()): CallContext {
  return { deadline: Date.now() + HOUR, signal: controller.signal, env: envReader([], () => undefined) };
}

/** Rows of one cell, each 12 bytes as `encodedRowBytes` measures them. */
const rows = Array.from({ length: 6 }, (_, index) => [`row-${index}-xx`]);
const LIMITS = { maxRows: 100, maxBytes: 1_000, batchMaxBytes: 24 } as const;

/** A ticker that counts `setImmediate` turns until stopped. */
function ticker() {
  let ticks = 0;
  let running = true;
  const tick = () => {
    ticks += 1;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  return {
    read: () => ticks,
    stop: () => {
      running = false;
    },
  };
}

describe("withTurns", () => {
  test("the host yields one turn of the event loop before every pull", async () => {
    const inner = rowsSource([{ name: "v" }], rows, rows.length);
    const atPull: number[] = [];
    const clock = ticker();
    const counting: ResultSource = {
      columns: inner.columns,
      rowCount: inner.rowCount,
      next: (limit: BatchLimit) => {
        atPull.push(clock.read());
        return inner.next(limit);
      },
      close: () => inner.close(),
    };
    const turned = withTurns(counting, contextOf());

    const page = await pumpPage(turned, LIMITS, contextOf());
    clock.stop();

    expect(page.rows).toEqual(rows);
    expect(atPull).toHaveLength(3);
    expect(atPull[0]).toBeGreaterThanOrEqual(1);
    expect(atPull[1]).toBeGreaterThan(atPull[0] as number);
    expect(atPull[2]).toBeGreaterThan(atPull[1] as number);
    expect(turned.columns).toBe(inner.columns);
    expect(turned.rowCount).toBe(rows.length);
    expect(Object.hasOwn(withTurns(rowsSource([{ name: "v" }], rows), contextOf()), "rowCount")).toBe(false);
  });

  test("a signal that aborts during the turn stops the pull it precedes", async () => {
    const controller = new AbortController();
    const reason = new Error(randomUUID());
    const inner = rowsSource([{ name: "v" }], rows);
    let pulls = 0;
    let closes = 0;
    const aborting: ResultSource = {
      columns: inner.columns,
      next: async (limit: BatchLimit) => {
        pulls += 1;
        // Queued before the turn the host awaits ahead of the next pull, so the abort lands inside that turn.
        setImmediate(() => controller.abort(reason));
        return inner.next(limit);
      },
      close: async () => {
        closes += 1;
      },
    };
    const ctx = contextOf(controller);

    let caught: unknown;
    try {
      await pumpPage(withTurns(aborting, ctx), LIMITS, ctx);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CallRefusalError);
    expect((caught as CallRefusalError).refusals).toEqual([{ rule: "call-signal-aborted", pointer: "/signal" }]);
    expect((caught as CallRefusalError).cause).toBe(reason);
    expect(pulls).toBe(1);
    expect(closes).toBe(1);

    const past: CallContext = { ...contextOf(), deadline: Date.now() - 1 };
    let deadlineCaught: unknown;
    try {
      await withTurns(inner, past).next({ maxRows: 1, maxBytes: 100, measure: encodedRowBytes });
    } catch (error) {
      deadlineCaught = error;
    }
    expect((deadlineCaught as CallRefusalError).refusals).toEqual([
      { rule: "call-deadline-passed", pointer: "/deadline" },
    ]);
    expect((deadlineCaught as CallRefusalError).cause).toBeUndefined();
  });
});
