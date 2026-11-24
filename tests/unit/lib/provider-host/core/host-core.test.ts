/**
 * The host core instance (src/lib/provider-host/core/host-core.ts; docs/providers/CONTRACT.md, clauses C-52 and C-53):
 * what a composition root installs once per process holds the core's console calls on a page budget of its own, frozen,
 * and nothing else, so a caller in any bundle reaches the same plain functions and no class or port of the bundle that
 * created it, and the process holds one page budget as it holds one core.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { BATCH_MAX_BYTES, envReader, PAGE_MAX_BYTES, type ResultSource } from "@libredb/provider-sdk/calls";
import {
  cancelCall,
  type ConsoleSession,
  endScopeCall,
  type ExecuteRecord,
  type PageRecord,
  transactionCall,
} from "@/lib/provider-host/core/console";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import { maintenancePreviewCall, maintenanceRunCall } from "@/lib/provider-host/core/maintenance";
import { treeCall } from "@/lib/provider-host/core/objects";

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

/** A source of three batches of one row each that counts its pulls. */
function largePage() {
  const seen = { pulls: 0 };
  const source: ResultSource = {
    columns: [{ name: "v" }],
    next: async () => {
      seen.pulls += 1;
      return { rows: [[seen.pulls]], done: seen.pulls >= 3 };
    },
    close: async () => {},
  };
  return { source, seen };
}

/** One execute of `source` on `core`, under a signal that never aborts. */
function runOn(core: HostCore, source: ResultSource): Promise<ExecuteRecord> {
  const session: ConsoleSession = {
    calls: {
      console: { execute: { honours: [] }, cancel: "not-offered", endScope: "not-offered", transaction: "not-offered" },
      objects: { tree: "not-offered" },
      maintenance: { run: "not-offered", preview: "not-offered" },
      monitoring: { panel: "not-offered", poolStats: "not-offered" },
    },
    execute: async () => ({ results: [source], warnings: [], executionTimeMs: 1, pageApplied: true }),
  };
  return core.executeCall(
    session,
    { statement: `select ${randomUUID()}`, page: { limit: 10, offset: 0 } },
    { deadline: Date.now() + 3_600_000, signal: new AbortController().signal, env: envReader([], () => undefined) },
    () => ({ maxRows: 10, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES }),
    { late: () => {}, cancelFailed: () => {} },
  );
}

function pageOf(record: ExecuteRecord): PageRecord {
  if (record.kind !== "page") throw new Error(`The call answered ${record.kind}, not a page.`);
  return record;
}

describe("the host core instance", () => {
  test("the host core holds the console calls on a page budget of its own, the tree call and the maintenance calls, frozen, and nothing else", () => {
    const core = createHostCore();

    expect(Object.keys(core).sort()).toEqual([
      "cancelCall",
      "endScopeCall",
      "executeCall",
      "maintenancePreviewCall",
      "maintenanceRunCall",
      "transactionCall",
      "treeCall",
    ]);
    expect(core.cancelCall).toBe(cancelCall);
    expect(core.treeCall).toBe(treeCall);
    expect(core.maintenanceRunCall).toBe(maintenanceRunCall);
    expect(core.maintenancePreviewCall).toBe(maintenancePreviewCall);
    expect(core.endScopeCall).toBe(endScopeCall);
    expect(core.transactionCall).toBe(transactionCall);
    expect(typeof core.executeCall).toBe("function");
    expect(Object.isFrozen(core)).toBe(true);
    const other = createHostCore();
    expect(other).not.toBe(core);
    expect(other.executeCall).not.toBe(core.executeCall);
  });

  test("each host core holds one large-page slot of its own", async () => {
    const coreA = createHostCore();
    const coreB = createHostCore();
    const held = pageOf(await runOn(coreA, largePage().source));

    const other = pageOf(await runOn(coreB, largePage().source));
    expect(other.page.rows).toEqual([[1], [2], [3]]);
    other.release();

    const waiting = largePage();
    const next = runOn(coreA, waiting.source);
    await until("the waiting page's first pull", () => waiting.seen.pulls === 1);
    // The page asks for the slot in the microtasks after its first batch; one more turn would be its second pull.
    await turn();
    expect(waiting.seen.pulls).toBe(1);
    held.release();
    const after = pageOf(await next);
    expect(after.page.rows).toEqual([[1], [2], [3]]);
    after.release();
  });
});
