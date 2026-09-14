import { describe, expect, test } from "bun:test";
import {
  DRAFT_BUDGET_CHARACTERS,
  DRAFT_KEY,
  draftKeyFor,
  dropDraft,
  readDraft,
  writeDraft,
  type SourceDraft,
} from "@/components/object-source/source-drafts";
import type { ObjectEditRevision } from "@/lib/db/types";

const BASE: ObjectEditRevision = { check: "guarded", token: "t", basis: "b", scope: "server" };

/** An injectable Storage, which is what makes the whole eviction arithmetic testable with no browser. */
function fakeStorage(options: { readonly throwOnSet?: boolean } = {}): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => {
      if (options.throwOnSet) {
        const error = new Error("The quota has been exceeded.");
        error.name = "QuotaExceededError";
        throw error;
      }
      map.set(key, value);
    },
  } as Storage;
}

const draft = (text: string, savedAt: number): SourceDraft => ({ text, savedAt, base: BASE });

describe("the key", () => {
  test("is the pane's own address plus the part id, and no new identity scheme", () => {
    expect(draftKeyFor("conn-1/app.order_total(integer)/function", "definition")).toBe(
      "conn-1/app.order_total(integer)/function/definition",
    );
  });
});

describe("writeDraft", () => {
  test("round trips through one key", () => {
    const storage = fakeStorage();
    expect(writeDraft(storage, "a", draft("SELECT 1", 10))).toEqual({ ok: true, evicted: [] });
    expect(readDraft(storage, "a")).toEqual(draft("SELECT 1", 10));
    // ONE key, because the budget is a property of the SET and eviction has to count the store's
    // own characters.
    expect(storage.getItem(DRAFT_KEY)).not.toBeNull();
  });

  test("evicts oldest first, and NEVER the draft being written", () => {
    const storage = fakeStorage();
    const filler = "x".repeat(400_000);
    writeDraft(storage, "old", draft(filler, 1));
    writeDraft(storage, "middle", draft(filler, 2));
    const result = writeDraft(storage, "new", draft(filler, 3));
    expect(result).toEqual({ ok: true, evicted: ["old"] });
    expect(readDraft(storage, "old")).toBeUndefined();
    expect(readDraft(storage, "middle")).toBeDefined();
    expect(readDraft(storage, "new")).toBeDefined();
  });

  test("the budget is counted as the KEY's own characters plus the serialized record", () => {
    const storage = fakeStorage();
    writeDraft(storage, "a", draft("y".repeat(900_000), 1));
    const held = storage.getItem(DRAFT_KEY) ?? "";
    expect(DRAFT_KEY.length + held.length).toBeLessThanOrEqual(DRAFT_BUDGET_CHARACTERS);
    expect(DRAFT_BUDGET_CHARACTERS).toBe(1_048_576);
  });

  test("a text above the read bound is refused and nothing is stored", () => {
    const storage = fakeStorage();
    // Not a second number: a draft longer than the route's own read bound cannot have come from a
    // read of this object, so the route would refuse it anyway.
    expect(writeDraft(storage, "a", draft("z".repeat(1_000_001), 1))).toEqual({ ok: false, reason: "too-long" });
    expect(readDraft(storage, "a")).toBeUndefined();
  });

  test("a draft that cannot fit the budget even alone is refused as over budget", () => {
    const storage = fakeStorage();
    // Under the read bound and still too big once escaped: every newline costs two characters
    // serialized, so this is reachable with a real definition rather than only with a fixture.
    const newlines = String.fromCharCode(10).repeat(600_000);
    expect(writeDraft(storage, "a", draft(newlines, 1))).toEqual({ ok: false, reason: "budget" });
    expect(readDraft(storage, "a")).toBeUndefined();
  });

  test("a QuotaExceededError from the browser is a RESULT and never a throw", () => {
    // X14's whole lesson, measured: the silent version is indistinguishable from working. It can
    // happen INSIDE our budget, because the origin is shared with everything else this app stores.
    const storage = fakeStorage({ throwOnSet: true });
    expect(writeDraft(storage, "a", draft("SELECT 1", 1))).toEqual({ ok: false, reason: "quota" });
  });

  test("no storage at all is its own reason", () => {
    expect(writeDraft(null, "a", draft("SELECT 1", 1))).toEqual({ ok: false, reason: "unavailable" });
    expect(readDraft(null, "a")).toBeUndefined();
    expect(() => dropDraft(null, "a")).not.toThrow();
  });
});

describe("readDraft", () => {
  test("a store that is not a record of drafts answers undefined rather than throwing", () => {
    const storage = fakeStorage();
    storage.setItem(DRAFT_KEY, "{not json");
    expect(readDraft(storage, "a")).toBeUndefined();
    storage.setItem(DRAFT_KEY, JSON.stringify({ a: { text: 5 } }));
    expect(readDraft(storage, "a")).toBeUndefined();
    storage.setItem(DRAFT_KEY, JSON.stringify([1, 2]));
    expect(readDraft(storage, "a")).toBeUndefined();
  });
});

describe("dropDraft", () => {
  test("removes one draft and leaves the others", () => {
    const storage = fakeStorage();
    writeDraft(storage, "a", draft("one", 1));
    writeDraft(storage, "b", draft("two", 2));
    dropDraft(storage, "a");
    expect(readDraft(storage, "a")).toBeUndefined();
    expect(readDraft(storage, "b")).toBeDefined();
  });
});

/**
 * Four cases the brief's own set does not contain, each added because a mutation the brief
 * REQUIRED to kill survived the set as written. The numbers are in `task-06-report.md`.
 */
describe("the populations the eviction policy is actually for", () => {
  test("evicts the oldest by savedAt, which is not the one written first", () => {
    // In the brief's eviction test the write order and the savedAt order agree, so evicting by
    // insertion order produces the same answer and mutation (a) survives it. Here they disagree.
    const storage = fakeStorage();
    const filler = "x".repeat(400_000);
    writeDraft(storage, "written-first", draft(filler, 3));
    writeDraft(storage, "oldest", draft(filler, 1));
    expect(writeDraft(storage, "new", draft(filler, 2))).toEqual({ ok: true, evicted: ["oldest"] });
    expect(readDraft(storage, "oldest")).toBeUndefined();
    expect(readDraft(storage, "written-first")).toBeDefined();
    expect(readDraft(storage, "new")).toBeDefined();
  });

  test("the draft being written survives even when it is the oldest of the set", () => {
    // The brief's eviction test never makes the target the oldest, so a policy that allowed the
    // target to be dropped answers the same thing there. This is the case that separates them.
    const storage = fakeStorage();
    const filler = "x".repeat(600_000);
    writeDraft(storage, "keep", draft(filler, 9));
    expect(writeDraft(storage, "target", draft(filler, 1))).toEqual({ ok: true, evicted: ["keep"] });
    expect(readDraft(storage, "target")).toBeDefined();
    expect(readDraft(storage, "keep")).toBeUndefined();
  });

  test("the KEY's own characters are inside the budget, in the 24-character window that can see it", () => {
    // Mutation (d), counting the serialized value alone, leaves the brief's budget assertion
    // green, because a 900,000-character draft is nowhere near the boundary. Only a record
    // sitting inside DRAFT_KEY.length of the budget can tell the two countings apart, and both
    // halves of that window are asserted here rather than assumed.
    const storage = fakeStorage();
    writeDraft(storage, "old", draft("o", 1));
    const fixed = JSON.stringify({ old: draft("o", 1), new: draft("", 2) }).length;
    const text = String.fromCharCode(10).repeat(
      Math.ceil((DRAFT_BUDGET_CHARACTERS - DRAFT_KEY.length + 1 - fixed) / 2),
    );
    const record = JSON.stringify({ old: draft("o", 1), new: draft(text, 2) });
    expect(record.length).toBeLessThanOrEqual(DRAFT_BUDGET_CHARACTERS);
    expect(DRAFT_KEY.length + record.length).toBeGreaterThan(DRAFT_BUDGET_CHARACTERS);
    expect(writeDraft(storage, "new", draft(text, 2))).toEqual({ ok: true, evicted: ["old"] });
  });

  test("a store that is an array is replaced rather than spread into the record it is not", () => {
    // The brief's readDraft case asks an ARRAY store for key "a", which answers undefined with or
    // without the array guard, because an array has no "a" index. The guard's live consequence is
    // on the WRITE: without it the array's elements survive as numbered keys of the record.
    const storage = fakeStorage();
    storage.setItem(DRAFT_KEY, JSON.stringify([1, 2]));
    expect(writeDraft(storage, "a", draft("one", 1))).toEqual({ ok: true, evicted: [] });
    expect(JSON.parse(storage.getItem(DRAFT_KEY) ?? "null")).toEqual({ a: draft("one", 1) });
  });

  test("dropDraft swallows a storage failure rather than breaking a successful apply", () => {
    // The live caller is the successful-apply handler and the explicit Discard. A throw out of
    // this call would turn a write that DID reach the engine into a broken success handler.
    const storage = fakeStorage({ throwOnSet: true });
    expect(() => dropDraft(storage, "a")).not.toThrow();
  });
});
