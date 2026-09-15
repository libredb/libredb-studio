import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld, type LocalWorld } from "@workflow/world-local";
import { type AgentHistoryEntry, decodeHistoryCursor } from "@/lib/agent/history";
import { AgentRunStore } from "@/lib/agent/run-store";
import { AgentStateError } from "@/lib/agent/state-guard";

/**
 * The history index over a REAL `@workflow/world-local`, for the same reason
 * `run-store.test.ts` runs against one: the properties under test are durability
 * properties. A mock world would prove the store calls what it calls; it would
 * not prove that a second store reads a history entry the first one wrote.
 */

const dataDirs: string[] = [];

function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-history-"));
  dataDirs.push(dir);
  return dir;
}

function storeAt(dataDir = freshDataDir()): { store: AgentRunStore; dataDir: string } {
  const world: LocalWorld = createLocalWorld({ dataDir, recoverActiveRuns: false });
  return { store: new AgentRunStore({ world }), dataDir };
}

function finish(overrides: Partial<AgentHistoryEntry> = {}): Omit<AgentHistoryEntry, "kind"> {
  return {
    atMs: 1_700_000_000_000,
    runId: "arun_1",
    sessionId: "ada",
    threadId: "arun_1",
    objective: "Why is checkout slow?",
    workflowType: "investigation",
    mode: "agent",
    connectionId: "seed:sales",
    createdAtMs: 1_699_999_000_000,
    status: "succeeded",
    answered: true,
    ...overrides,
  };
}

afterEach(() => {
  while (dataDirs.length > 0) {
    const dir = dataDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  // The 10 000-entry test leaves 10 000 chunk files behind, and deleting them
  // all on a Windows runner exceeds bun's default hook timeout — the hook is the
  // slow part, not the test, so it gets the same generous bound as the test.
}, 120_000);

describe("AgentRunStore — the history index", () => {
  test("records a finished run and lists it back as one conversation", async () => {
    const { store } = storeAt();

    await store.recordHistoryFinish(finish());
    const page = await store.listConversations("ada");

    expect(page.conversations).toHaveLength(1);
    expect(page.conversations[0]).toMatchObject({
      threadId: "arun_1",
      steps: [
        {
          runId: "arun_1",
          objective: "Why is checkout slow?",
          workflowType: "investigation",
          mode: "agent",
          status: "succeeded",
          answered: true,
          connectionId: "seed:sales",
        },
      ],
    });
    expect(page.nextCursor).toBeNull();
  });

  test("scopes the listing to the actor's session", async () => {
    const { store } = storeAt();

    await store.recordHistoryFinish(finish());
    const page = await store.listConversations("grace");

    expect(page.conversations).toEqual([]);
  });

  test("groups two steps of one thread into one conversation, oldest first", async () => {
    const { store } = storeAt();

    await store.recordHistoryFinish(finish({ runId: "arun_1", threadId: "arun_1", atMs: 1_000 }));
    await store.recordHistoryFinish(
      finish({
        runId: "arun_2",
        threadId: "arun_1",
        atMs: 2_000,
        objective: "And which table drives it?",
        status: "failed",
        answered: false,
      }),
    );

    const page = await store.listConversations("ada");
    expect(page.conversations).toHaveLength(1);
    expect(page.conversations[0]?.steps.map((step) => step.runId)).toEqual(["arun_1", "arun_2"]);
    expect(page.conversations[0]?.steps[1]).toMatchObject({ status: "failed", answered: false });
  });

  test("orders conversations newest first and pages with a cursor", async () => {
    const { store } = storeAt();

    for (const [n, atMs] of [
      [1, 1_000],
      [2, 2_000],
      [3, 3_000],
    ] as const) {
      await store.recordHistoryFinish(finish({ runId: `arun_${n}`, threadId: `arun_${n}`, atMs }));
    }

    const first = await store.listConversations("ada", { limit: 2 });
    expect(first.conversations.map((c) => c.threadId)).toEqual(["arun_3", "arun_2"]);
    expect(first.nextCursor).not.toBeNull();

    const cursor = decodeHistoryCursor(first.nextCursor as string);
    expect(cursor).not.toBeNull();
    const second = await store.listConversations("ada", { limit: 2, cursor: cursor ?? undefined });
    expect(second.conversations.map((c) => c.threadId)).toEqual(["arun_1"]);
    expect(second.nextCursor).toBeNull();
  });

  test("survives a second store over the same directory", async () => {
    const first = storeAt();
    await first.store.recordHistoryFinish(finish());

    const second = new AgentRunStore({ world: createLocalWorld({ dataDir: first.dataDir, recoverActiveRuns: false }) });
    const page = await second.listConversations("ada");

    expect(page.conversations).toHaveLength(1);
  });

  test("refuses to persist an index entry carrying a result payload", async () => {
    const { store } = storeAt();

    const hostile = { ...finish(), rows: [{ id: 1 }] } as unknown as Omit<AgentHistoryEntry, "kind">;

    let caught: unknown;
    try {
      await store.recordHistoryFinish(hostile);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentStateError);
    expect((await store.listConversations("ada")).conversations).toEqual([]);
  });

  test("a missing history stream reads as an empty list, not an error (P0#7)", async () => {
    const { store } = storeAt();

    const page = await store.listConversations("nobody");

    expect(page.conversations).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  test("scopes by the identity value, so the same user keeps their history across sessions (P0#8)", async () => {
    const { store } = storeAt();

    // The value is the USER identity, not the session: `AgentRunActor.sessionId`
    // is set to `session.username` by the start route, so a new JWT for the same
    // account carries the same value and reads the same stream. A different
    // identity — even a case difference — reads a different, empty stream.
    await store.recordHistoryFinish(finish({ sessionId: "koray" }));
    expect((await store.listConversations("koray")).conversations).toHaveLength(1);
    // A fresh session token for the same account is the same username, so it
    // still sees the history it wrote under a previous session.
    expect((await store.listConversations("koray")).conversations[0]?.steps[0]?.runId).toBe("arun_1");
    expect((await store.listConversations("KORAY")).conversations).toEqual([]);
  });

  test("N physical index writes fold into one logical step (P0#3 idempotency)", async () => {
    const { store } = storeAt();

    // Three physical appends of the same run id; the fold must show one step and
    // keep the FIRST entry's data, so a retried finish cannot rewrite the run.
    await store.recordHistoryFinish(finish({ runId: "arun_dup", threadId: "arun_dup", atMs: 1_000 }));
    await store.recordHistoryFinish(finish({ runId: "arun_dup", threadId: "arun_dup", atMs: 2_000, status: "failed" }));
    await store.recordHistoryFinish(
      finish({ runId: "arun_dup", threadId: "arun_dup", atMs: 3_000, status: "cancelled" }),
    );

    const page = await store.listConversations("ada");
    expect(page.conversations).toHaveLength(1);
    expect(page.conversations[0]?.steps).toHaveLength(1);
    expect(page.conversations[0]?.steps[0]).toMatchObject({
      runId: "arun_dup",
      status: "succeeded",
      updatedAtMs: 1_000,
    });
  });

  test("a crash between the ledger and the index leaves the run reopenable but unlisted (P0#6)", async () => {
    const first = storeAt();
    const record = await first.store.openRun({
      mode: "agent",
      actor: { sessionId: "ada", role: "admin" },
      connectionId: "seed:sales",
      objective: "Why is checkout slow?",
    });
    // The ledger records the ending, but the process died before the history
    // index append ran — the crash window between the two writes.
    await first.store.appendEvent(record.runId, {
      kind: "run-finished",
      atMs: 1_700_000_000_000,
      status: "succeeded",
    });

    // A restarted process reads the same files: the run is still the authority,
    // and the index has no entry for it. There is no rebuild, by design.
    const second = new AgentRunStore({
      world: createLocalWorld({ dataDir: first.dataDir, recoverActiveRuns: false }),
    });
    expect((await second.read(record.runId))?.record.status).toBe("succeeded");
    expect((await second.listConversations("ada")).conversations).toEqual([]);
  });

  test("100 concurrent index writes produce 100 distinct steps, no duplicates (P0#4)", async () => {
    const { store } = storeAt();

    await Promise.all(
      Array.from({ length: 100 }, (_, n) =>
        store.recordHistoryFinish(
          finish({ runId: `arun_${String(n).padStart(3, "0")}`, threadId: "arun_one_thread", atMs: 1_000 + n }),
        ),
      ),
    );

    const page = await store.listConversations("ada");
    expect(page.conversations).toHaveLength(1);
    const stepIds = page.conversations[0]?.steps.map((step) => step.runId) ?? [];
    expect(stepIds).toHaveLength(100);
    expect(new Set(stepIds).size).toBe(100);
  });

  test("lists 10 000 entries within a bounded time and keeps the retention cap (P1#11)", async () => {
    const { store } = storeAt();

    const writes: Promise<void>[] = [];
    for (let n = 0; n < 10_000; n += 1) {
      writes.push(
        store.recordHistoryFinish(
          finish({
            runId: `arun_${String(n).padStart(5, "0")}`,
            threadId: `arun_${String(n).padStart(5, "0")}`,
            atMs: n,
          }),
        ),
      );
      if (writes.length === 250) {
        await Promise.all(writes);
        writes.length = 0;
      }
    }
    await Promise.all(writes);

    const started = performance.now();
    // Ask for more than the retention cap, so the cap is the binding limit and
    // not the default page size: 10 000 entries fold into the newest 50.
    const page = await store.listConversations("ada", { limit: 100 });
    const elapsed = performance.now() - started;

    // The stream holds 10 000 lines; the fold parses them all and then applies
    // the retention cap, so the LISTING is bounded (50) even though the READ is
    // not — the listing cost is O(entries), which is the documented limit. The
    // store reads in 1 000-chunk pages (`STREAM_CHUNK_PAGE_SIZE`), so the read is
    // a handful of directory walks rather than a re-walk per 100-chunk page; the
    // bound below catches a catastrophic regression, not a fast path.
    expect(page.conversations).toHaveLength(50);
    expect(elapsed).toBeLessThan(120_000);
  }, 120_000);
});
