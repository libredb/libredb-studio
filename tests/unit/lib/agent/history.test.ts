import { describe, expect, test } from "bun:test";
import {
  type AgentHistoryEntry,
  decodeHistoryCursor,
  encodeHistoryCursor,
  foldHistoryEntries,
  historyStreamName,
  paginateHistory,
  parseHistoryEntry,
} from "@/lib/agent/history";
import type { AgentConversationSummary } from "@/lib/agent/types";

/**
 * The run-history index (#830), as pure functions over entries and the page
 * slice. These are the parts of the feature that do not touch the durable
 * backend, so they are tested here against fixtures rather than against a world.
 */

function entry(overrides: Partial<AgentHistoryEntry> = {}): AgentHistoryEntry {
  return {
    kind: "history-finished",
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

function summary(threadId: string, updatedAtMs: number): AgentConversationSummary {
  return {
    threadId,
    steps: [
      {
        runId: `arun_${threadId}`,
        objective: "Why is checkout slow?",
        workflowType: "investigation",
        mode: "agent",
        status: "succeeded",
        answered: true,
        connectionId: "seed:sales",
        createdAtMs: updatedAtMs - 1_000,
        updatedAtMs,
      },
    ],
  };
}

describe("historyStreamName", () => {
  test("is a fixed-width hash after the prefix, so no key is a prefix of another", () => {
    const name = historyStreamName("ada@example.com");
    expect(name).toMatch(/^agent-history-[0-9a-f]{64}$/);
  });

  test("is deterministic and distinct per session", () => {
    expect(historyStreamName("ada")).toBe(historyStreamName("ada"));
    expect(historyStreamName("ada")).not.toBe(historyStreamName("grace"));
  });
});

describe("parseHistoryEntry", () => {
  test("reads a valid entry back field for field", () => {
    const source = entry();
    expect(parseHistoryEntry(JSON.stringify(source))).toEqual(source);
  });

  test("returns null for a line that is not JSON", () => {
    expect(parseHistoryEntry("not json")).toBeNull();
  });

  test("returns null for a JSON value that is not an object", () => {
    expect(parseHistoryEntry('"history-finished"')).toBeNull();
    expect(parseHistoryEntry("[1,2,3]")).toBeNull();
  });

  test("returns null for an entry of another kind, which is how a newer build's line is skipped", () => {
    // Every field is valid except `kind`: what rejects the line is the kind
    // check, not the missing-field checks that would reject any bare object.
    expect(parseHistoryEntry(JSON.stringify({ ...entry(), kind: "history-opened" }))).toBeNull();
  });

  test.each<[string, Record<string, unknown>]>([
    ["workflowType", { workflowType: "not-a-workflow" }],
    ["mode", { mode: "not-a-mode" }],
    ["status", { status: "running" }],
    ["answered", { answered: "yes" }],
    ["createdAtMs", { createdAtMs: "1" }],
    ["atMs", { atMs: null }],
    ["threadId", { threadId: 7 }],
  ])("returns null when %s is off-shape", (_field, overrides) => {
    expect(parseHistoryEntry(JSON.stringify(entry(overrides as Partial<AgentHistoryEntry>)))).toBeNull();
  });
});

describe("foldHistoryEntries", () => {
  test("groups steps into conversations, oldest first, and keeps the thread id", () => {
    const root = entry({ runId: "arun_1", threadId: "arun_1", atMs: 1_000, objective: "Why is checkout slow?" });
    const follow = entry({
      runId: "arun_2",
      threadId: "arun_1",
      atMs: 2_000,
      objective: "And which table drives it?",
      status: "failed",
      answered: false,
    });

    const [conversation] = foldHistoryEntries([root, follow]);

    expect(conversation?.threadId).toBe("arun_1");
    expect(conversation?.steps.map((step) => step.runId)).toEqual(["arun_1", "arun_2"]);
    expect(conversation?.steps[1]).toMatchObject({ status: "failed", answered: false });
  });

  test("sorts conversations newest first by their latest step", () => {
    const older = entry({ runId: "arun_1", threadId: "t_old", atMs: 1_000 });
    const newer = entry({ runId: "arun_2", threadId: "t_new", atMs: 2_000 });

    expect(foldHistoryEntries([older, newer]).map((c) => c.threadId)).toEqual(["t_new", "t_old"]);
  });

  test("breaks a finish-timestamp tie by thread id, so the order is total", () => {
    // Distinct run ids: a run id is unique by construction, and the fold now
    // dedupes on it (a double-written run must collapse, not read as two runs).
    const a = entry({ runId: "arun_aaa", threadId: "arun_aaa", atMs: 1_000 });
    const b = entry({ runId: "arun_bbb", threadId: "arun_bbb", atMs: 1_000 });

    expect(foldHistoryEntries([b, a]).map((c) => c.threadId)).toEqual(["arun_aaa", "arun_bbb"]);
  });

  test("caps the listing to the retention bound, keeping the newest", () => {
    const entries = [1, 2, 3].map((n) => entry({ runId: `arun_${n}`, threadId: `t_${n}`, atMs: n }));

    expect(foldHistoryEntries(entries, 2).map((c) => c.threadId)).toEqual(["t_3", "t_2"]);
  });
});

describe("history cursors", () => {
  test("round-trips the pair that names a page boundary", () => {
    expect(decodeHistoryCursor(encodeHistoryCursor({ updatedAtMs: 1_234, threadId: "arun_abc" }))).toEqual({
      updatedAtMs: 1_234,
      threadId: "arun_abc",
    });
  });

  test.each(["", "no-dot", ".arun_1", "abc.arun_1", "12.arun-with-dash", "-1.arun_1", "12."])(
    "decodes %j as null",
    (raw) => {
      expect(decodeHistoryCursor(raw)).toBeNull();
    },
  );
});

describe("paginateHistory", () => {
  const summaries = [summary("t_3", 3), summary("t_2", 2), summary("t_1", 1)];

  test("serves the first page and a cursor for the rest", () => {
    const page = paginateHistory(summaries, { limit: 2 });

    expect(page.conversations.map((c) => c.threadId)).toEqual(["t_3", "t_2"]);
    expect(page.nextCursor).toBe("2.t_2");
  });

  test("a cursor starts strictly after the page it was handed back for", () => {
    const first = paginateHistory(summaries, { limit: 2 });
    const cursor = decodeHistoryCursor(first.nextCursor as string);
    expect(cursor).not.toBeNull();

    const second = paginateHistory(summaries, { limit: 2, cursor: cursor ?? undefined });
    expect(second.conversations.map((c) => c.threadId)).toEqual(["t_1"]);
    expect(second.nextCursor).toBeNull();
  });

  test("returns no cursor on the last page", () => {
    const page = paginateHistory(summaries, { limit: 10 });
    expect(page.nextCursor).toBeNull();
  });

  test("a cursor past everything yields an empty page and no cursor", () => {
    const page = paginateHistory(summaries, { limit: 2, cursor: { updatedAtMs: 0, threadId: "arun_000" } });
    expect(page.conversations).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  test("uses the default page size when the caller says nothing", () => {
    const page = paginateHistory(summaries, {});
    // All three fit inside the default, so nothing is held back and no cursor is minted.
    expect(page.conversations).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });
});

describe("history index hardening", () => {
  test("collapses a duplicate run into one step (P0#3 idempotency)", () => {
    const once = entry({ runId: "arun_1", threadId: "arun_1", atMs: 1_000 });
    const twice = entry({ runId: "arun_1", threadId: "arun_1", atMs: 2_000, status: "failed" });

    const [conversation] = foldHistoryEntries([once, twice, twice]);

    expect(conversation?.steps).toHaveLength(1);
    // The first entry wins: a retried append cannot rewrite the run's own record.
    expect(conversation?.steps[0]).toMatchObject({ runId: "arun_1", status: "succeeded", updatedAtMs: 1_000 });
  });

  test("sorts and pages 500 conversations sharing one timestamp (P0#10)", () => {
    const entries = Array.from({ length: 500 }, (_, n) =>
      entry({ runId: `arun_${String(n).padStart(4, "0")}`, threadId: `t_${String(n).padStart(4, "0")}`, atMs: 42 }),
    );

    const all = foldHistoryEntries(entries, 1000);
    expect(all).toHaveLength(500);
    // Total order by threadId on the tie, so the first page starts at the lexicographic minimum.
    expect(all[0]?.threadId).toBe("t_0000");
    expect(all[499]?.threadId).toBe("t_0499");

    const first = paginateHistory(all, { limit: 200 });
    expect(first.conversations).toHaveLength(200);
    const cursor = decodeHistoryCursor(first.nextCursor as string);
    expect(cursor).toEqual({ updatedAtMs: 42, threadId: "t_0199" });

    const second = paginateHistory(all, { limit: 200, cursor: cursor ?? undefined });
    expect(second.conversations[0]?.threadId).toBe("t_0200");
    expect(second.conversations).toHaveLength(200);
  });

  test("the stream name is deterministic across separator and Unicode inputs (P0#26)", () => {
    expect(historyStreamName("")).toMatch(/^agent-history-[0-9a-f]{64}$/);
    expect(historyStreamName("a-b.c_d@example.com")).toMatch(/^agent-history-[0-9a-f]{64}$/);
    expect(historyStreamName("Şeyma-用户-🙂")).toMatch(/^agent-history-[0-9a-f]{64}$/);
    expect(historyStreamName("x".repeat(4096))).toMatch(/^agent-history-[0-9a-f]{64}$/);
    // Fixed width: no key can be a prefix of another, whatever the input.
    expect(historyStreamName("a")).not.toBe(historyStreamName("a-b"));
  });

  test("a flood of malformed lines is skipped, never thrown (P1#12)", () => {
    const valid = entry();
    const garbage = [
      "not json",
      '{"kind":"future-kind"}',
      JSON.stringify({ kind: "history-finished", status: "running" }),
      JSON.stringify({ kind: "history-finished", atMs: 1, answered: "yes" }),
      "",
    ];
    const entries = [...garbage.map((g) => parseHistoryEntry(g)), parseHistoryEntry(JSON.stringify(valid))];
    expect(entries.filter(Boolean)).toHaveLength(1);
  });

  test("refuses cursor values that are signed-shaped but out of bounds (P1#13)", () => {
    expect(decodeHistoryCursor(`999999999999999999999999999.t_1`)).not.toBeNull(); // number, clamped only by consumers
    expect(decodeHistoryCursor(`-1.t_1`)).toBeNull();
    expect(decodeHistoryCursor(`42.${"x".repeat(65)}`)).toBeNull(); // over the run-id width
    expect(decodeHistoryCursor("42.用户")).toBeNull(); // non [A-Za-z0-9_]
  });

  test("round-trips a Unicode objective (P2#25)", () => {
    const unicode = entry({ objective: "Hangi departmanda çalışan var? 👥" });
    expect(parseHistoryEntry(JSON.stringify(unicode))?.objective).toBe(unicode.objective);
  });

  test("sorts by finish timestamp, so a late-arriving older clock sorts below (P2#28)", () => {
    const newer = entry({ runId: "arun_new", threadId: "t_new", atMs: 1_000 });
    const older = entry({ runId: "arun_old", threadId: "t_old", atMs: 999 });

    expect(foldHistoryEntries([older, newer]).map((c) => c.threadId)).toEqual(["t_new", "t_old"]);
  });
});
