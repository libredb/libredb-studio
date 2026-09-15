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
import { SOURCE_CHARACTER_LIMIT } from "@/lib/db/object-kinds";
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
  test("the store's own key is pinned by VALUE, because changing it discards every stored draft", () => {
    // The suffix is a version, so a shape change is a new key rather than a migration. Nothing
    // else in the suite reads the string rather than the constant, so a refactor or a bad merge
    // that edited it would silently orphan every user's drafts with the suite green.
    expect(DRAFT_KEY).toBe("libredb_source_drafts_v1");
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

  test("a text of exactly the read bound is NOT too long, and the boundary is which side it falls", () => {
    // SOURCE_CHARACTER_LIMIT is the route's own READ bound, so a maximal read is exactly this
    // many characters and was never too long. Under `>=` this draft is refused and the pane
    // prints "longer than the 1,000,000 characters this definition can be read at" about a text
    // that is exactly that long, which is the false sentence the fourth reason exists to prevent.
    const storage = fakeStorage();
    const maximal = draft("z".repeat(SOURCE_CHARACTER_LIMIT), 1);
    expect(writeDraft(storage, "a", maximal)).toEqual({ ok: true, evicted: [] });
    expect(readDraft(storage, "a")).toEqual(maximal);
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
    // One population per arm of the shape walk, because an arm whose false branch is never taken
    // is 100 percent line-covered and certifies nothing. Each of these three deleted the arm
    // above it and the suite stayed green before they existed.
    storage.setItem(DRAFT_KEY, JSON.stringify({ a: { text: "x", savedAt: "1", base: BASE } }));
    expect(readDraft(storage, "a")).toBeUndefined();
    storage.setItem(DRAFT_KEY, JSON.stringify({ a: { text: "x", savedAt: 1 } }));
    expect(readDraft(storage, "a")).toBeUndefined();
    // `base` is carried opaquely and is still the field the restore banner compares against the
    // part's current revision, so a scalar there would reach that comparison as one.
    storage.setItem(DRAFT_KEY, JSON.stringify({ a: { text: "x", savedAt: 1, base: 5 } }));
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
 * Cases the brief's own set does not contain, each added because a mutation that MUST be killed
 * survived the set as written (#789).
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

  test("a store that is an array of WELL FORMED drafts is still replaced, not indexed", () => {
    // Three populations deep, and only the third can see the guard. The brief's readDraft case
    // asks an array store for key "a", which answers undefined either way. An array of junk is
    // now dropped entry by entry by the shape walk, so it cannot see it either. Only an array
    // whose ELEMENTS are drafts can: without the guard those survive as the numbered keys "0"
    // and "1" of a record, each one an undeletable draft nothing can ever address.
    const storage = fakeStorage();
    storage.setItem(DRAFT_KEY, JSON.stringify([draft("zero", 1), draft("one", 2)]));
    expect(writeDraft(storage, "a", draft("one", 1))).toEqual({ ok: true, evicted: [] });
    expect(JSON.parse(storage.getItem(DRAFT_KEY) ?? "null")).toEqual({ a: draft("one", 1) });
  });

  test("dropDraft swallows a storage failure rather than breaking a successful apply", () => {
    // The live caller is the successful-apply handler and the explicit Discard. A throw out of
    // this call would turn a write that DID reach the engine into a broken success handler.
    const storage = fakeStorage({ throwOnSet: true });
    expect(() => dropDraft(storage, "a")).not.toThrow();
  });

  test("a drop the browser refused leaves the draft READABLE, which is the caller's only signal", () => {
    // `dropDraft` is void by contract, so no caller can tell "dropped" from "refused" by its
    // answer. The state is still observable, and this pins the one surface that makes it so: a
    // re-read. Without it the consequence after a SUCCESSFUL apply is a restore banner on the next
    // mount offering the pre-apply text with no reason attached, which is X14's shape at reduced
    // scale. Task 15 either re-reads here or the banner has nothing to say.
    const seeded = fakeStorage();
    seeded.setItem(DRAFT_KEY, JSON.stringify({ a: draft("one", 1) }));
    const refusing = {
      get length() {
        return seeded.length;
      },
      clear: () => seeded.clear(),
      key: (index: number) => seeded.key(index),
      getItem: (key: string) => seeded.getItem(key),
      removeItem: (key: string) => seeded.removeItem(key),
      setItem: () => {
        const error = new Error("The quota has been exceeded.");
        error.name = "QuotaExceededError";
        throw error;
      },
    } as Storage;
    dropDraft(refusing, "a");
    expect(readDraft(refusing, "a")).toEqual(draft("one", 1));
  });

  test("a store cost of exactly the budget is within it, and evicts nothing", () => {
    // The eviction loop's own boundary. Under `>=` this write finds no droppable neighbour, so it
    // answers `budget` about a record that fits, and the reader is told to shorten a text that was
    // never over. The record is built to land on the boundary rather than near it.
    const storage = fakeStorage();
    const fixed = JSON.stringify({ a: draft("", 1) }).length;
    // The text has to reach the budget while staying under the READ bound, so it is newlines:
    // each one costs two characters serialized. The odd character, if any, is a plain one.
    const serialized = DRAFT_BUDGET_CHARACTERS - DRAFT_KEY.length - fixed;
    const text = String.fromCharCode(10).repeat(Math.floor(serialized / 2)) + "y".repeat(serialized % 2);
    const exact = draft(text, 1);
    expect(text.length).toBeLessThanOrEqual(SOURCE_CHARACTER_LIMIT);
    expect(DRAFT_KEY.length + JSON.stringify({ a: exact }).length).toBe(DRAFT_BUDGET_CHARACTERS);
    expect(writeDraft(storage, "a", exact)).toEqual({ ok: true, evicted: [] });
    expect(readDraft(storage, "a")).toEqual(exact);
  });

  test("a malformed neighbour in the store is not a throw on the write path", () => {
    // The asymmetry the read side already declares real: `readStore` treats a half-written record
    // as a population that exists, and the write path then walked the same bytes trusting them.
    // MEASURED on the pre-fix module: this raised
    // `TypeError: null is not an object (evaluating 'entry.savedAt')` out of `oldestDroppable`.
    const storage = fakeStorage();
    const filler = "x".repeat(600_000);
    storage.setItem(DRAFT_KEY, JSON.stringify({ broken: null, old: draft(filler, 1) }));
    expect(writeDraft(storage, "new", draft(filler, 2))).toEqual({ ok: true, evicted: ["old"] });
    expect(JSON.parse(storage.getItem(DRAFT_KEY) ?? "null")).toEqual({ new: draft(filler, 2) });
  });

  test("an entry with no savedAt does not wedge every later write on budget forever", () => {
    // `undefined < Infinity` is false, so a neighbour without a `savedAt` was never selectable as
    // a victim: `oldestDroppable` answered undefined with a droppable record sitting right there
    // and every subsequent write was refused `budget` permanently. Filtering the store through
    // the same shape walk the read uses removes the entry instead of being stuck behind it.
    const storage = fakeStorage();
    const filler = "x".repeat(600_000);
    storage.setItem(DRAFT_KEY, JSON.stringify({ stale: { text: filler, base: BASE } }));
    expect(writeDraft(storage, "new", draft(filler, 2))).toEqual({ ok: true, evicted: [] });
    expect(readDraft(storage, "new")).toBeDefined();
  });
});
