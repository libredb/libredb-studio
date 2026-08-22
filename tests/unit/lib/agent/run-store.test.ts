import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld, type LocalWorld } from "@workflow/world-local";
import { AGENT_ENABLED_ENV, AGENT_WORLD_TARGET_ENV, AgentConfigError } from "@/lib/agent/config";
import type { AgentLedgerEntry, AgentLedgerWorld } from "@/lib/agent/run-store";
import { AgentRunStore, AgentRunStoreError, ledgerStreamName, resolveAgentLedgerWorld } from "@/lib/agent/run-store";
import { AgentStateError } from "@/lib/agent/state-guard";
import type { AgentRunActor, AgentRunEvent } from "@/lib/agent/types";

/**
 * These tests run against a REAL `@workflow/world-local` instance over a real
 * temporary data directory — the durable backend T1 selects by default — because
 * the properties under test are durability properties. A mock world would prove
 * that the store calls the methods it calls; it could not prove that a second
 * process reads back what the first one wrote, which is the whole point of the
 * ledger (and the invariant T7b's restart proof rests on).
 */

const ACTOR: AgentRunActor = { sessionId: "sess_1", role: "admin" };

const OPEN_INPUT = {
  mode: "agent",
  actor: ACTOR,
  connectionId: "conn_1",
  objective: "Why is the orders report slow?",
} as const;

const dataDirs: string[] = [];

function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-store-"));
  dataDirs.push(dir);
  return dir;
}

function worldAt(dataDir: string): LocalWorld {
  return createLocalWorld({ dataDir, recoverActiveRuns: false });
}

/** A store plus the data directory behind it, so a test can open a second one on the same files. */
function storeAt(dataDir = freshDataDir(), clock?: () => number): { store: AgentRunStore; dataDir: string } {
  return { store: new AgentRunStore({ world: worldAt(dataDir), clock }), dataDir };
}

/** A settable epoch clock. Every timestamp in the ledger is driven explicitly. */
function fakeClock(startAt = 1_700_000_000_000): { read: () => number; set: (value: number) => void } {
  let current = startAt;
  return {
    read: () => current,
    set: (value: number) => {
      current = value;
    },
  };
}

function event(kind: AgentRunEvent["kind"], atMs: number, extra: Record<string, unknown> = {}): AgentRunEvent {
  return { kind, atMs, ...extra } as AgentRunEvent;
}

function artifactFor(runId: string, correlationId: string) {
  return {
    correlationId,
    runId,
    operationId: "sql.query.read",
    summary: { rowCount: 3, columnNames: ["id"], elapsedMs: 12 },
  };
}

async function captureStoreError(fn: () => Promise<unknown>): Promise<AgentRunStoreError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRunStoreError);
    return error as AgentRunStoreError;
  }
  throw new Error("expected the store to refuse");
}

/** Reads a live stream to the point where `count` entries have arrived, then releases it. */
async function takeEntries(
  stream: ReadableStream<AgentLedgerEntry>,
  count: number,
): Promise<readonly AgentLedgerEntry[]> {
  const reader = stream.getReader();
  const entries: AgentLedgerEntry[] = [];
  try {
    while (entries.length < count) {
      const next = await reader.read();
      if (next.done) break;
      entries.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  return entries;
}

afterEach(() => {
  while (dataDirs.length > 0) {
    const dir = dataDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── opening a run ──────────────────────────────────────────────────────────

describe("AgentRunStore — opening a run", () => {
  test("mints a run id and records the header as the run's first ledger entry", async () => {
    const clock = fakeClock();
    const { store } = storeAt(undefined, clock.read);

    const record = await store.openRun(OPEN_INPUT);

    expect(record.runId).toMatch(/^arun_[0-9a-f]{32}$/);
    expect(record).toMatchObject({
      mode: "agent",
      status: "queued",
      actor: ACTOR,
      connectionId: "conn_1",
      objective: "Why is the orders report slow?",
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      events: [],
    });
  });

  test("accepts a caller-supplied run id, so a workflow run and its ledger can share one identity", async () => {
    const { store } = storeAt();

    const record = await store.openRun({ ...OPEN_INPUT, runId: "run_01K5ZQ7BW9EXAMPLE" });

    expect(record.runId).toBe("run_01K5ZQ7BW9EXAMPLE");
    expect((await store.read("run_01K5ZQ7BW9EXAMPLE"))?.record.runId).toBe("run_01K5ZQ7BW9EXAMPLE");
  });

  test.each([
    ["", "empty"],
    ["arun-1234", "a dash, which would let one run's ledger read another's"],
    ["arun.1234", "a dot, which the backend refuses as a path component"],
    ["arun/1234", "a path separator"],
    ["arun 1234", "a space"],
    ["arun_\u0000", "a null byte"],
    ["a".repeat(65), "longer than the bound"],
  ])("refuses the run id %p (%s)", async (runId) => {
    const { store } = storeAt();
    const error = await captureStoreError(() => store.openRun({ ...OPEN_INPUT, runId }));
    expect(error.reasonCode).toBe("INVALID_RUN_ID");
  });

  test("refuses to open a run twice over the same id", async () => {
    const { store } = storeAt();
    const record = await store.openRun(OPEN_INPUT);

    const error = await captureStoreError(() => store.openRun({ ...OPEN_INPUT, runId: record.runId }));

    expect(error.reasonCode).toBe("RUN_ALREADY_OPEN");
    expect(error.message).toContain(record.runId);
  });

  test("opens with auto-execute off when nothing asked for it", async () => {
    const { store } = storeAt();

    const record = await store.openRun(OPEN_INPUT);

    // Absent means off, which is the only safe reading: the setting gives away the
    // editor's time limit, and a caller that said nothing has asked for nothing.
    expect(record.autoExecute).toBe(false);
  });

  test("records the auto-execute setting on the run, where nothing later can widen it", async () => {
    const dataDir = freshDataDir();
    const { store } = storeAt(dataDir);

    const record = await store.openRun({ ...OPEN_INPUT, autoExecute: true });

    expect(record.autoExecute).toBe(true);
    // Re-read through a second store over the same files: a resumed drive reads the
    // value the drive that died was opened with, like `mode` and `workflowType`.
    expect((await storeAt(dataDir).store.read(record.runId))?.record.autoExecute).toBe(true);
  });

  test("opens as an explicitly chosen workflow when nothing said where the workflow came from", async () => {
    const { store } = storeAt();

    const record = await store.openRun(OPEN_INPUT);

    // Absent means chosen, and that is a reading rather than a fallback: a caller
    // that sends a workflow without saying otherwise sent the one it was told.
    expect(record.workflowSource).toBe("chosen");
  });

  test.each(["inferred", "chosen"] as const)(
    "records the workflow source %p on the run, where a resumed drive reads it back",
    async (workflowSource) => {
      const dataDir = freshDataDir();
      const { store } = storeAt(dataDir);

      const record = await store.openRun({ ...OPEN_INPUT, workflowSource });

      expect(record.workflowSource).toBe(workflowSource);
      // Re-read through a second store over the same files: the "change" affordance
      // is keyed on this, and it must survive the process that opened the run.
      expect((await storeAt(dataDir).store.read(record.runId))?.record.workflowSource).toBe(workflowSource);
    },
  );

  test("records no classifier outcome when nothing said how the workflow was read", async () => {
    const { store } = storeAt();

    const record = await store.openRun(OPEN_INPUT);

    // `"unrecorded"` rather than either of the other two, and it is the only answer
    // the header supports: a caller that named its own workflow ran no classifier, so
    // there is no outcome — which is a different fact from one that ran and succeeded
    // and from one that ran and fell back.
    expect(record.workflowReading).toBe("unrecorded");
  });

  test.each(["classified", "unclassified", "unrecorded"] as const)(
    "records the workflow reading %p on the run, where a resumed drive reads it back",
    async (workflowReading) => {
      const dataDir = freshDataDir();
      const { store } = storeAt(dataDir);

      const record = await store.openRun({ ...OPEN_INPUT, workflowReading });

      expect(record.workflowReading).toBe(workflowReading);
      // Re-read through a second store over the same files. This is the whole reason
      // the field exists: the sentence the rail owes about a run it did not open is
      // read from here, and a rail that reloaded has no other source for it.
      expect((await storeAt(dataDir).store.read(record.runId))?.record.workflowReading).toBe(workflowReading);
    },
  );

  test("reads back nothing for a run that was never opened", async () => {
    const { store } = storeAt();
    expect(await store.read("arun_00000000000000000000000000000000")).toBeNull();
  });

  test.each(["", "arun-1234", "arun.1234"])("refuses to read the malformed run id %p", async (runId) => {
    const { store } = storeAt();
    expect((await captureStoreError(() => store.read(runId))).reasonCode).toBe("INVALID_RUN_ID");
  });
});

// ─── the fold: status and history are derived, never stored twice ────────────

describe("AgentRunStore — folding the ledger into a record", () => {
  test("a started run reads as running and carries its events in order", async () => {
    const clock = fakeClock();
    const { store } = storeAt(undefined, clock.read);
    const { runId } = await store.openRun(OPEN_INPUT);

    clock.set(1_700_000_001_000);
    await store.appendEvent(runId, event("run-started", 1_700_000_001_000, { mode: "agent" }));
    clock.set(1_700_000_002_000);
    await store.appendEvent(
      runId,
      event("statement-drafted", 1_700_000_002_000, { stepId: "s1", sql: "SELECT 1", rationale: "smoke" }),
    );

    const view = await store.read(runId);

    expect(view?.record.status).toBe("running");
    expect(view?.record.events.map((entry) => entry.kind)).toEqual(["run-started", "statement-drafted"]);
    expect(view?.record.updatedAtMs).toBe(1_700_000_002_000);
    expect(view?.record.createdAtMs).toBe(1_700_000_000_000);
  });

  test.each(["succeeded", "failed", "cancelled"] as const)("a %s run reads as that terminal status", async (status) => {
    const { store } = storeAt();
    const { runId } = await store.openRun(OPEN_INPUT);

    await store.appendEvent(runId, event("run-started", 1, { mode: "agent" }));
    await store.appendEvent(runId, event("run-finished", 2, { status }));

    const view = await store.read(runId);
    expect(view?.record.status).toBe(status);
    expect(view?.terminal).toBe(true);
  });

  test("keeps entry order across the backend's pagination boundary", async () => {
    const { store } = storeAt();
    const { runId } = await store.openRun(OPEN_INPUT);

    // The backend pages snapshot reads (default 100 chunks per page), so a run
    // longer than one page is the case where a naive single-page read silently
    // truncates the history a resumed run replays.
    for (let index = 0; index < 150; index++) {
      await store.appendEvent(runId, event("tool-invoked", index, { stepId: `s${index}`, tool: "run_read_query" }));
    }

    const view = await store.read(runId);
    expect(view?.record.events).toHaveLength(150);
    expect(view?.record.events.map((entry) => (entry as { stepId: string }).stepId)).toEqual(
      Array.from({ length: 150 }, (_unused, index) => `s${index}`),
    );
  });

  test("a cancellation request is visible in the view but is not one of the run's events", async () => {
    const clock = fakeClock();
    const { store } = storeAt(undefined, clock.read);
    const { runId } = await store.openRun(OPEN_INPUT);
    await store.appendEvent(runId, event("run-started", 1, { mode: "agent" }));

    clock.set(1_700_000_009_000);
    await store.requestCancellation(runId, { sessionId: "sess_2", role: "admin" });

    const view = await store.read(runId);
    expect(view?.cancellationRequestedAtMs).toBe(1_700_000_009_000);
    // T2 pinned `AgentRunEvent` closed. A cancellation REQUEST is not one of
    // those semantic events: the run is still running until its loop finishes it.
    expect(view?.record.events.map((entry) => entry.kind)).toEqual(["run-started"]);
    expect(view?.record.status).toBe("running");
  });

  test("a repeated cancellation request keeps the first instant", async () => {
    const clock = fakeClock();
    const { store } = storeAt(undefined, clock.read);
    const { runId } = await store.openRun(OPEN_INPUT);

    clock.set(1_700_000_005_000);
    await store.requestCancellation(runId, ACTOR);
    clock.set(1_700_000_006_000);
    await store.requestCancellation(runId, ACTOR);

    expect((await store.read(runId))?.cancellationRequestedAtMs).toBe(1_700_000_005_000);
  });
});

// ─── step settlement, the half T7b's idempotency rests on ───────────────────

describe("AgentRunStore — step settlement", () => {
  test("classifies a completed step as settled and an invoked-only step as unsettled", async () => {
    const { store } = storeAt();
    const { runId } = await store.openRun(OPEN_INPUT);

    await store.appendEvent(runId, event("tool-invoked", 1, { stepId: "done", tool: "run_read_query" }));
    await store.appendEvent(
      runId,
      event("tool-completed", 2, { stepId: "done", artifact: artifactFor(runId, "corr_1") }),
    );
    await store.appendEvent(runId, event("tool-invoked", 3, { stepId: "hanging", tool: "run_read_query" }));

    const view = await store.read(runId);
    expect([...(view?.settledSteps.keys() ?? [])]).toEqual(["done"]);
    expect(view?.settledSteps.get("done")?.kind).toBe("tool-completed");
    expect(view?.unsettledStepIds).toEqual(["hanging"]);
  });

  test("a refused step is settled too — the run asked, the boundary answered", async () => {
    const { store } = storeAt();
    const { runId } = await store.openRun(OPEN_INPUT);

    await store.appendEvent(runId, event("tool-invoked", 1, { stepId: "s1", tool: "run_read_query" }));
    await store.appendEvent(
      runId,
      event("tool-refused", 2, { stepId: "s1", refusal: { class: "policy-denied", reasonCode: "ROLE_FORBIDDEN" } }),
    );

    const view = await store.read(runId);
    expect(view?.settledSteps.get("s1")?.kind).toBe("tool-refused");
    expect(view?.unsettledStepIds).toEqual([]);
  });
});

// ─── durability ─────────────────────────────────────────────────────────────

describe("AgentRunStore — durability", () => {
  test("a second store over the same data directory reads the whole run back", async () => {
    const { store, dataDir } = storeAt();
    const { runId } = await store.openRun(OPEN_INPUT);
    await store.appendEvent(runId, event("run-started", 1, { mode: "agent" }));
    await store.appendEvent(runId, event("tool-invoked", 2, { stepId: "s1", tool: "inspect_schema" }));

    // A fresh world instance over the same files is what a restarted process gets.
    const restarted = new AgentRunStore({ world: worldAt(dataDir) });
    const view = await restarted.read(runId);

    expect(view?.record.status).toBe("running");
    expect(view?.record.objective).toBe(OPEN_INPUT.objective);
    expect(view?.unsettledStepIds).toEqual(["s1"]);
  });

  test("an answer survives the fold and a second store's re-read, presentation and all", async () => {
    // The kind has to be in `EVENT_KINDS` or the line is refused as unknown on the
    // way back in — the fold is where an event the writer knew about and the reader
    // did not becomes a malformed ledger rather than a missing entry.
    const { store, dataDir } = storeAt();
    const { runId } = await store.openRun(OPEN_INPUT);
    const answer = event("answer-composed", 4, {
      sql: "SELECT region, SUM(net_total) AS net_total FROM orders GROUP BY region",
      artifact: artifactFor(runId, "corr_answer"),
      presentation: {
        kind: "chart",
        spec: { type: "bar", x: "id", y: ["net_total"], caption: "Net total by region." },
      },
      handover: "none",
    });

    await store.appendEvent(runId, event("run-started", 1, { mode: "agent" }));
    await store.appendEvent(runId, answer);

    const restarted = new AgentRunStore({ world: worldAt(dataDir) });
    const view = await restarted.read(runId);

    expect(view?.record.events).toEqual([event("run-started", 1, { mode: "agent" }), answer]);
  });

  test("two runs whose ids share a prefix never read each other's entries", async () => {
    const { store } = storeAt();
    const shorter = await store.openRun({ ...OPEN_INPUT, runId: "arun_aaa" });
    const longer = await store.openRun({ ...OPEN_INPUT, runId: "arun_aaabbb", objective: "other run" });

    await store.appendEvent(longer.runId, event("run-started", 1, { mode: "agent" }));

    expect((await store.read(shorter.runId))?.record.events).toEqual([]);
    expect((await store.read(shorter.runId))?.record.objective).toBe(OPEN_INPUT.objective);
    expect((await store.read(longer.runId))?.record.events).toHaveLength(1);
    expect(ledgerStreamName(shorter.runId)).not.toBe(ledgerStreamName(longer.runId));
  });

  test("a dash in a run id would make one run read another's ledger, which is why the charset refuses it", async () => {
    // The test above passes with or without the guard, because two dashless ids
    // cannot collide. This one pins the REASON the guard exists: the backend
    // selects a stream's chunk files by the prefix `<streamName>-`, so the ledger
    // of a run called `arun_x-y` lands in files that run `arun_x`'s own read
    // matches. Demonstrated here by writing to exactly the stream that run id
    // would have used, and then showing the charset makes it unreachable.
    const dataDir = freshDataDir();
    const world = worldAt(dataDir);
    const store = new AgentRunStore({ world });
    const { runId } = await store.openRun({ ...OPEN_INPUT, runId: "arun_x" });
    const siblingStream = `${ledgerStreamName(runId)}-y`;

    await world.writeToStream(
      siblingStream,
      "arun_x",
      `${JSON.stringify({ kind: "event", event: event("run-started", 9, { mode: "agent" }) })}\n`,
    );

    // Run `arun_x` never emitted an event, yet its own ledger now reports one and
    // reads as running: that is the sibling's entry, bleeding across.
    const contaminated = await store.read(runId);
    expect(contaminated?.record.events).toHaveLength(1);
    expect(contaminated?.record.status).toBe("running");

    // Which is exactly why no such run id can exist in the first place.
    expect((await captureStoreError(() => store.openRun({ ...OPEN_INPUT, runId: "arun_x-y" }))).reasonCode).toBe(
      "INVALID_RUN_ID",
    );
  });
});

// ─── the persistence guard ──────────────────────────────────────────────────

describe("AgentRunStore — refuses to persist anything that is not inert", () => {
  test("refuses an event carrying a raw result set, and writes nothing", async () => {
    const { store } = storeAt();
    const { runId } = await store.openRun(OPEN_INPUT);

    const hostile = event("tool-completed", 1, {
      stepId: "s1",
      artifact: { ...artifactFor(runId, "corr_1"), rows: [{ id: 1 }] },
    });

    await expect(store.appendEvent(runId, hostile)).rejects.toBeInstanceOf(AgentStateError);
    expect((await store.read(runId))?.record.events).toEqual([]);
  });

  test("refuses an event carrying a live client handle", async () => {
    const { store } = storeAt();
    const { runId } = await store.openRun(OPEN_INPUT);
    class FakePool {
      readonly connect = () => undefined;
    }

    const hostile = event("tool-invoked", 1, { stepId: "s1", tool: "run_read_query", pool: new FakePool() });

    await expect(store.appendEvent(runId, hostile)).rejects.toBeInstanceOf(AgentStateError);
    expect((await store.read(runId))?.record.events).toEqual([]);
  });

  test("refuses a header carrying a credential-shaped field before the run exists at all", async () => {
    const { store } = storeAt();

    await expect(
      store.openRun({ ...OPEN_INPUT, actor: { ...ACTOR, password: "hunter2" } as unknown as AgentRunActor }),
    ).rejects.toBeInstanceOf(AgentStateError);
  });
});

// ─── a ledger that does not read back as a ledger ───────────────────────────

describe("AgentRunStore — refuses a ledger it cannot trust", () => {
  test("refuses a run whose ledger does not open with a header", async () => {
    const dataDir = freshDataDir();
    const world = worldAt(dataDir);
    const runId = "arun_headerless";
    await world.writeToStream(
      ledgerStreamName(runId),
      runId,
      `${JSON.stringify({ kind: "event", event: event("run-started", 1, { mode: "agent" }) })}\n`,
    );

    const store = new AgentRunStore({ world });
    const error = await captureStoreError(() => store.read(runId));

    expect(error.reasonCode).toBe("MALFORMED_LEDGER");
    expect(error.message).toContain(runId);
  });

  test("refuses a ledger line that is not a ledger entry", async () => {
    const dataDir = freshDataDir();
    const world = worldAt(dataDir);
    const store = new AgentRunStore({ world });
    const { runId } = await store.openRun(OPEN_INPUT);

    await world.writeToStream(ledgerStreamName(runId), runId, "{not json}\n");

    expect((await captureStoreError(() => store.read(runId))).reasonCode).toBe("MALFORMED_LEDGER");
  });

  test("refuses a ledger that carries a second run header", async () => {
    const dataDir = freshDataDir();
    const world = worldAt(dataDir);
    const store = new AgentRunStore({ world });
    const { runId } = await store.openRun(OPEN_INPUT);

    const header = {
      kind: "run-opened",
      atMs: 2,
      runId,
      mode: "agent",
      actor: ACTOR,
      connectionId: "conn_1",
      objective: "second",
    };
    await world.writeToStream(ledgerStreamName(runId), runId, `${JSON.stringify(header)}\n`);

    expect((await captureStoreError(() => store.read(runId))).reasonCode).toBe("MALFORMED_LEDGER");
  });

  test("refuses a header that names a different run", async () => {
    const dataDir = freshDataDir();
    const world = worldAt(dataDir);
    const store = new AgentRunStore({ world });
    const { runId } = await store.openRun({ ...OPEN_INPUT, runId: "arun_first" });
    const foreign = {
      kind: "run-opened",
      atMs: 2,
      runId: "arun_second",
      mode: "agent",
      actor: ACTOR,
      connectionId: "conn_1",
      objective: "elsewhere",
    };

    await world.writeToStream(ledgerStreamName(runId), runId, `${JSON.stringify(foreign)}\n`);

    const error = await captureStoreError(() => store.read(runId));
    expect(error.reasonCode).toBe("MALFORMED_LEDGER");
    expect(error.message).toContain("arun_second");
  });

  test("refuses a ledger entry whose kind it does not know", async () => {
    const dataDir = freshDataDir();
    const world = worldAt(dataDir);
    const store = new AgentRunStore({ world });
    const { runId } = await store.openRun(OPEN_INPUT);

    await world.writeToStream(ledgerStreamName(runId), runId, `${JSON.stringify({ kind: "who-knows" })}\n`);

    expect((await captureStoreError(() => store.read(runId))).reasonCode).toBe("MALFORMED_LEDGER");
  });

  test("tolerates a chunk boundary that splits an entry in two", async () => {
    // The store writes one newline-terminated entry per chunk, but a backend is
    // free to coalesce or split chunks, so the reader is framed on newlines
    // rather than on chunk boundaries.
    const dataDir = freshDataDir();
    const world = worldAt(dataDir);
    const store = new AgentRunStore({ world });
    const { runId } = await store.openRun(OPEN_INPUT);
    const line = JSON.stringify({ kind: "event", event: event("run-started", 7, { mode: "agent" }) });

    await world.writeToStream(ledgerStreamName(runId), runId, line.slice(0, 12));
    await world.writeToStream(ledgerStreamName(runId), runId, `${line.slice(12)}\n`);

    expect((await store.read(runId))?.record.status).toBe("running");
  });
});

// ─── the live stream ────────────────────────────────────────────────────────

describe("AgentRunStore — streaming a run", () => {
  test("replays the ledger from the start and then follows it live", async () => {
    const { store } = storeAt();
    const { runId } = await store.openRun(OPEN_INPUT);

    const stream = await store.stream(runId);
    const pending = takeEntries(stream, 2);
    await store.appendEvent(runId, event("run-started", 1, { mode: "agent" }));

    const entries = await pending;
    expect(entries.map((entry) => entry.kind)).toEqual(["run-opened", "event"]);
    expect(entries[1]).toMatchObject({ kind: "event", event: { kind: "run-started" } });
  });

  test("ends when the run is closed", async () => {
    const { store } = storeAt();
    const { runId } = await store.openRun(OPEN_INPUT);
    await store.appendEvent(runId, event("run-finished", 1, { status: "succeeded" }));

    const stream = await store.stream(runId);
    await store.close(runId);

    const reader = stream.getReader();
    const seen: AgentLedgerEntry[] = [];
    let next = await reader.read();
    while (!next.done) {
      seen.push(next.value);
      next = await reader.read();
    }
    expect(seen).toHaveLength(2);
  });

  test("starts from a given index, so a reconnecting reader need not replay the whole ledger", async () => {
    const { store } = storeAt();
    const { runId } = await store.openRun(OPEN_INPUT);
    await store.appendEvent(runId, event("run-started", 1, { mode: "agent" }));
    await store.appendEvent(runId, event("run-finished", 2, { status: "succeeded" }));

    const entries = await takeEntries(await store.stream(runId, { startIndex: 2 }), 1);

    expect(entries[0]).toMatchObject({ kind: "event", event: { kind: "run-finished" } });
  });

  test("refuses to stream a malformed run id", async () => {
    const { store } = storeAt();
    expect((await captureStoreError(() => store.stream("arun-nope"))).reasonCode).toBe("INVALID_RUN_ID");
  });

  test("refuses to close a malformed run id", async () => {
    const { store } = storeAt();
    expect((await captureStoreError(() => store.close("arun.nope"))).reasonCode).toBe("INVALID_RUN_ID");
  });
});

// ─── the world seam ─────────────────────────────────────────────────────────

describe("AgentRunStore — the world seam", () => {
  test("needs nothing from the backend beyond the four stream methods it declares", async () => {
    // The seam is structural on purpose: the store depends on the four Streamer
    // methods every sanctioned world implements, not on a concrete world class.
    const calls: string[] = [];
    const world: AgentLedgerWorld = {
      writeToStream: async (name, runId, chunk) => {
        calls.push(`write:${name}:${runId}:${String(chunk).trim().slice(0, 12)}`);
      },
      getStreamChunks: async () => ({ data: [], cursor: null, hasMore: false, done: false }),
      readFromStream: async () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      closeStream: async (name) => {
        calls.push(`close:${name}`);
      },
    };
    const store = new AgentRunStore({ world });

    const record = await store.openRun({ ...OPEN_INPUT, runId: "arun_seam" });
    await store.close(record.runId);

    expect(calls).toEqual([`write:agent-ledger-arun_seam:arun_seam:{"kind":"run`, "close:agent-ledger-arun_seam"]);
  });
});

// ─── binding to the backend T1 selected ─────────────────────────────────────

// The LLM keys are in this list because #331 T5 derives availability from them:
// `resolveAgentLedgerWorld` builds a world only when the agent is available, and
// `bun` loads a checkout's `.env`, so leaving them alone would make this suite
// answer one way locally and the other in CI.
const WORLD_ENV_KEYS = [
  AGENT_ENABLED_ENV,
  AGENT_WORLD_TARGET_ENV,
  "WORKFLOW_LOCAL_DATA_DIR",
  "VERCEL_DEPLOYMENT_ID",
  "LLM_PROVIDER",
  "LLM_API_KEY",
  "LLM_MODEL",
  "LLM_API_URL",
] as const;

/** The model configuration that makes the runtime available. */
const MODEL_ENV = { LLM_PROVIDER: "gemini", LLM_API_KEY: "test-key" };

/**
 * Restores both the environment and the SDK's process-global world cache. The
 * cache matters: `getWorld()` memoises into a `Symbol.for` slot on `globalThis`,
 * so a world built here over a temporary directory would otherwise be handed to
 * every later test in this process.
 */
async function withWorldEnv(env: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of WORLD_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    await body();
  } finally {
    const { setWorld } = await import("workflow/runtime");
    setWorld(undefined);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("resolveAgentLedgerWorld", () => {
  test("refuses when no model is configured, so an AI-less server builds no world", async () => {
    await withWorldEnv({}, async () => {
      const error = await captureStoreError(() => resolveAgentLedgerWorld());
      expect(error.reasonCode).toBe("RUNTIME_DISABLED");
    });
  });

  test.each(["off", "false"])("refuses while the off-switch reads %p", async (flag) => {
    await withWorldEnv({ ...MODEL_ENV, [AGENT_ENABLED_ENV]: flag }, async () => {
      expect((await captureStoreError(() => resolveAgentLedgerWorld())).reasonCode).toBe("RUNTIME_DISABLED");
    });
  });

  test("builds the zero-config local backend and a run written through it reads back", async () => {
    const dataDir = freshDataDir();
    await withWorldEnv({ ...MODEL_ENV, WORKFLOW_LOCAL_DATA_DIR: dataDir }, async () => {
      const world = await resolveAgentLedgerWorld();
      const store = new AgentRunStore({ world });

      const record = await store.openRun(OPEN_INPUT);

      expect((await store.read(record.runId))?.record.objective).toBe(OPEN_INPUT.objective);
      // The ledger really landed in the configured backend's data directory,
      // rather than in whatever default the SDK would have picked.
      expect(fs.existsSync(path.join(dataDir, "streams"))).toBe(true);
    });
  });

  test("refuses an unsanctioned backend before any world is built", async () => {
    await withWorldEnv({ ...MODEL_ENV, [AGENT_WORLD_TARGET_ENV]: "@evil/world" }, async () => {
      await expect(resolveAgentLedgerWorld()).rejects.toBeInstanceOf(AgentConfigError);
    });
  });
});

describe("AgentRunStore — a closed run refuses further appends", () => {
  test("an append after close is refused, never silently lost", async () => {
    const { store } = storeAt();
    const run = await store.openRun(OPEN_INPUT);
    await store.close(run.runId);

    const error = await captureStoreError(() =>
      store.appendEvent(run.runId, event("tool-invoked", 2, { stepId: "s1", tool: "run_read_query" })),
    );
    expect(error.reasonCode).toBe("RUN_ALREADY_CLOSED");
  });

  test("the run is still readable after close; only appends are refused", async () => {
    const { store } = storeAt();
    const run = await store.openRun(OPEN_INPUT);
    await store.close(run.runId);

    expect((await store.read(run.runId))?.record.runId).toBe(run.runId);
  });
});
