import { describe, test, expect, afterEach } from "bun:test";

import { recordQuerySuccess, dismissStarPrompt, STAR_PROMPT_QUERY_THRESHOLD } from "@/lib/community/star-prompt";

// The module writes straight to localStorage (a per-browser nudge, never user
// data), so the tests drive a real key/value store rather than the storage layer.
const COUNT_KEY = "libredb_star_prompt_query_count";
const HANDLED_KEY = "libredb_star_prompt_handled";

const originalLocalStorage = globalThis.localStorage;
const originalWindow = globalThis.window;

interface StorageBehaviour {
  throwOnRead?: boolean;
  throwOnWrite?: boolean;
}

function installStorage(entries: Record<string, string> = {}, behaviour: StorageBehaviour = {}) {
  const store = new Map<string, string>(Object.entries(entries));
  globalThis.localStorage = {
    getItem: (key: string) => {
      if (behaviour.throwOnRead) throw new Error("storage read denied");
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (behaviour.throwOnWrite) throw new Error("storage write denied");
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    length: 0,
    key: () => null,
  } as unknown as Storage;
  return store;
}

afterEach(() => {
  globalThis.localStorage = originalLocalStorage;
  globalThis.window = originalWindow;
});

describe("star-prompt", () => {
  test("threshold is the tenth successful query", () => {
    expect(STAR_PROMPT_QUERY_THRESHOLD).toBe(10);
  });

  test("stays silent below the threshold and counts every success", () => {
    const store = installStorage();

    for (let i = 1; i < STAR_PROMPT_QUERY_THRESHOLD; i++) {
      expect(recordQuerySuccess()).toBe(false);
    }

    expect(store.get(COUNT_KEY)).toBe(String(STAR_PROMPT_QUERY_THRESHOLD - 1));
  });

  test("fires exactly once, on the run that reaches the threshold", () => {
    const store = installStorage({ [COUNT_KEY]: String(STAR_PROMPT_QUERY_THRESHOLD - 1) });

    expect(recordQuerySuccess()).toBe(true);
    expect(store.get(COUNT_KEY)).toBe(String(STAR_PROMPT_QUERY_THRESHOLD));
    expect(recordQuerySuccess()).toBe(false);
  });

  test("never fires again once the count is past the threshold", () => {
    installStorage({ [COUNT_KEY]: String(STAR_PROMPT_QUERY_THRESHOLD + 5) });

    expect(recordQuerySuccess()).toBe(false);
  });

  test("never fires once dismissed, and stops counting", () => {
    const store = installStorage({ [COUNT_KEY]: String(STAR_PROMPT_QUERY_THRESHOLD - 1) });

    dismissStarPrompt();
    expect(store.get(HANDLED_KEY)).toBeDefined();

    expect(recordQuerySuccess()).toBe(false);
    expect(store.get(COUNT_KEY)).toBe(String(STAR_PROMPT_QUERY_THRESHOLD - 1));
  });

  test("treats a corrupt stored count as zero", () => {
    const store = installStorage({ [COUNT_KEY]: "not-a-number" });

    expect(recordQuerySuccess()).toBe(false);
    expect(store.get(COUNT_KEY)).toBe("1");
  });

  test("treats a negative stored count as zero", () => {
    const store = installStorage({ [COUNT_KEY]: "-4" });

    expect(recordQuerySuccess()).toBe(false);
    expect(store.get(COUNT_KEY)).toBe("1");
  });

  test("degrades to never prompting when reads throw", () => {
    installStorage({ [COUNT_KEY]: String(STAR_PROMPT_QUERY_THRESHOLD - 1) }, { throwOnRead: true });

    expect(recordQuerySuccess()).toBe(false);
    expect(recordQuerySuccess()).toBe(false);
  });

  test("degrades to never prompting when writes throw", () => {
    installStorage({ [COUNT_KEY]: String(STAR_PROMPT_QUERY_THRESHOLD - 1) }, { throwOnWrite: true });

    expect(recordQuerySuccess()).toBe(false);
    expect(() => {
      dismissStarPrompt();
    }).not.toThrow();
  });

  test("is a no-op on the server, where there is no window", () => {
    // A WORKING store is installed on purpose: both guards must be pinned by the
    // store staying untouched, not merely by nothing throwing.
    const store = installStorage({ [COUNT_KEY]: String(STAR_PROMPT_QUERY_THRESHOLD - 1) });
    globalThis.window = undefined as unknown as Window & typeof globalThis;

    expect(recordQuerySuccess()).toBe(false);
    expect(() => {
      dismissStarPrompt();
    }).not.toThrow();

    expect(store.get(HANDLED_KEY)).toBeUndefined();
    expect(store.get(COUNT_KEY)).toBe(String(STAR_PROMPT_QUERY_THRESHOLD - 1));
  });
});
