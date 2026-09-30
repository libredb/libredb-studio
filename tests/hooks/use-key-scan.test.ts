import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { describe, test, expect, afterEach } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../helpers/mock-fetch";

import { useKeyScan, HELD_KEY_LIMIT, SCAN_ALL_MAX_KEYS } from "@/components/key-browser/use-key-scan";
import { pathKey } from "@/components/key-browser/tree";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The walk a keys panel drives.
 *
 * EVERY ASSERTION BELOW IS ABOUT THE CURSOR, because the cursor is the contract. A hook that ignored
 * the position it was given and restarted from `"0"` would answer a plausible first page, accumulate
 * a plausible set of keys, and pass any suite that read only `keys` — so the request bodies are
 * asserted, and the failure case checks the position is RETAINED rather than advanced.
 */

const CONNECTION: DatabaseConnection = {
  id: "redis-1",
  name: "Local Redis",
  type: "redis",
  host: "127.0.0.1",
  port: 6380,
  createdAt: new Date(0),
};

const CAPABILITY = { defaultCount: 500, maxCount: 1000 };

/**
 * The connection as it crosses the wire.
 *
 * `createdAt` is a `Date` in memory and a string once `JSON.stringify` has been through it, so an
 * expectation built from the live object can never equal the body that was actually sent.
 */
const WIRE_CONNECTION = JSON.parse(JSON.stringify(CONNECTION)) as Record<string, unknown>;

function hook() {
  return renderHook(() => useKeyScan({ connection: CONNECTION, capability: CAPABILITY, pattern: "" }));
}

/** The cursor the request carried. The helper hands a real `Request`, so the body is read once. */
async function cursorOf(req: Request): Promise<string> {
  const body = (await req.json().catch(() => ({}))) as { cursor?: string };
  return body.cursor ?? "0";
}

/** Every request body the hook sent, as the route would have received it. */
function bodiesOf(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>,
  );
}

/**
 * A page, in the shape the route answers with.
 *
 * `types` is optional here because most of these tests are about the WALK; the ones that are about
 * types pass it, and an absent map is the honest default — a page that described none.
 */
function page(keys: string[], cursor: string, total = 31, types: Record<string, string> = {}): MockFetchResponse {
  return { json: { keys, cursor, total, types } };
}

describe("useKeyScan", () => {
  afterEach(() => {
    restoreGlobalFetch();
  });

  test("starts with nothing walked and no total", () => {
    mockGlobalFetch({});

    const { result } = hook();

    expect(result.current.keys).toEqual([]);
    expect(result.current.scanned).toBe(0);
    // Null rather than 0: the denominator is the SERVER's count and nothing local can stand in for
    // it, so "not asked yet" and "the database holds nothing" must not render identically.
    expect(result.current.total).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(result.current.exhausted).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.stoppedBy).toBeNull();
  });

  test("takes one page, records the total, and asks with the declared batch size", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["app:env", "app:cache:ttl"], "9") });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });

    expect(result.current.keys).toEqual(["app:env", "app:cache:ttl"]);
    expect(result.current.scanned).toBe(2);
    expect(result.current.total).toBe(31);

    // No `pattern` key at all rather than an empty one: `MATCH ""` is a pattern no key satisfies, so
    // forwarding an absent pattern as an empty string would turn "every key" into "no key".
    expect(bodiesOf(fetchMock)).toEqual([{ connection: WIRE_CONNECTION, cursor: "0", count: 500 }]);
  });

  test("forwards a pattern when there is one", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "0") });
    const { result } = renderHook(() =>
      useKeyScan({ connection: CONNECTION, capability: CAPABILITY, pattern: "app:*" }),
    );

    await act(async () => {
      await result.current.scanMore();
    });

    expect(bodiesOf(fetchMock)).toEqual([{ connection: WIRE_CONNECTION, cursor: "0", pattern: "app:*", count: 500 }]);
  });

  test("walks the database it was pointed at, and leaves the choice to the engine when it is not", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "0") });
    const { result } = renderHook(() =>
      useKeyScan({ connection: CONNECTION, capability: CAPABILITY, pattern: "", database: 3 }),
    );

    await act(async () => {
      await result.current.scanMore();
    });

    // Absent `database` is a different request from `database: 0` — it is the engine's own session
    // database, which a panel that has not been asked to move must not move off.
    expect(bodiesOf(fetchMock)).toEqual([{ connection: WIRE_CONNECTION, cursor: "0", count: 500, database: 3 }]);
  });

  test("counts a repeat the walk was handed but hands the tree one of it", async () => {
    // `SCAN` may return a key twice while the table rehashes, and the two answers are for two
    // readers. `scanned` is what the walk has been through — the number the progress line is measured
    // against, so a repeat counts — while `keys` is the tree's input, and a tree cannot draw one key
    // twice. Deduplicating at the source is also what keeps that list bounded: with a scoped Load
    // more appending whole batches, an undeduped list grows until the search feeding the tree is the
    // slowest thing on screen.
    let call = 0;
    mockGlobalFetch({
      "/api/db/keys/scan": () => {
        call += 1;
        return call === 1 ? page(["a", "b"], "1") : page(["b", "c"], "0");
      },
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });
    await act(async () => {
      await result.current.scanMore();
    });

    expect(result.current.keys).toEqual(["a", "b", "c"]);
    expect(result.current.scanned).toBe(4);
  });

  test("records each key's type as the page describes it", async () => {
    mockGlobalFetch({
      "/api/db/keys/scan": page(["session:abc", "app:env"], "0", 31, { "session:abc": "hash", "app:env": "string" }),
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });

    // The type arrives WITH the key it describes, which is the reason it is on the page at all: a row
    // drawn now can never be drawn beside a type that is still on its way.
    expect(result.current.types.get("session:abc")).toBe("hash");
    expect(result.current.types.get("app:env")).toBe("string");
  });

  test("accumulates types across pages, and throws them away with the walk", async () => {
    let call = 0;
    mockGlobalFetch({
      "/api/db/keys/scan": () => {
        call += 1;
        return call === 1 ? page(["a"], "1", 31, { a: "string" }) : page(["b"], "0", 31, { b: "list" });
      },
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });
    await act(async () => {
      await result.current.scanMore();
    });
    // The second page described only `b`, and `a` keeps what the first page said: the map is the
    // server's answers accumulated, not the newest answer alone.
    expect(result.current.types.get("a")).toBe("string");
    expect(result.current.types.get("b")).toBe("list");

    act(() => {
      result.current.reset();
    });
    // A discarded walk's types describe keys that are no longer in the tree, and a stale type beside a
    // fresh key of the same name would be a claim about the wrong value.
    expect(result.current.types.size).toBe(0);
  });

  test("reports that the counts are one node's, and claims nothing when the server did not say", async () => {
    // The cluster-shaped page: `SCAN` and `DBSIZE` answer for one node, so the panel's denominator is
    // one node's and the reader has to be told that rather than discovering a third of the key space.
    mockGlobalFetch({
      "/api/db/keys/scan": { json: { keys: ["a"], cursor: "0", total: 333_249, types: {}, clustered: true } },
    });
    const { result } = hook();
    await act(async () => {
      await result.current.scanMore();
    });
    expect(result.current.clustered).toBe(true);

    // A server that says `cluster_enabled:0` is an ordinary one: FALSE is an answer, and the panel
    // draws no node warning for it. `undefined` is a reply that could not be read at all - covered by
    // the provider suite - and it claims nothing either.
    mockGlobalFetch({
      "/api/db/keys/scan": { json: { keys: ["b"], cursor: "0", total: 42, types: {}, clustered: false } },
    });
    // Its OWN walk: the one above came back on cursor `0`, and a spent walk refuses a second page -
    // the state would never be written and the assertion would be true for the wrong reason.
    const plain = hook();
    await act(async () => {
      await plain.result.current.scanMore();
    });
    expect(plain.result.current.clustered).toBe(false);

    // Thrown away with the walk: a fresh walk of an unknown server starts from not knowing.
    act(() => {
      result.current.reset();
    });
    expect(result.current.clustered).toBeUndefined();
  });

  test("advances the cursor between pages", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": async (req) => ((await cursorOf(req)) === "0" ? page(["a"], "7") : page(["b"], "0")),
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });
    await act(async () => {
      await result.current.scanMore();
    });

    expect(bodiesOf(fetchMock)).toMatchObject([{ cursor: "0" }, { cursor: "7" }]);
  });

  test("refuses a second page while one is in flight", async () => {
    /*
     * The gate is built FIRST and its opener assigned inside the executor, rather than the handler
     * creating the promise it waits on. An assignment made inside a callback is one TypeScript
     * cannot see, so `release` would narrow to `null` and `release?.()` would stop compiling — the
     * shape `tests/hooks/use-provider-metadata.test.ts` already uses for the same reason.
     */
    // A no-op default rather than `| null`: the executor below replaces it before anything waits,
    // and a nullable declaration narrows to `null` at the call site, where `release?.()` then has
    // type `never`. `release` is reassigned inside the promise's executor, which TypeScript cannot
    // see, so the declared type is what the call site has to be callable from.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": async () => {
        await gate;
        return page(["a"], "0");
      },
    });
    const { result } = hook();

    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.scanMore();
    });
    // The second press reads the SAME cursor the first one is still holding, so letting it through
    // would advance from a position neither answer has earned.
    await act(async () => {
      await result.current.scanMore();
    });
    expect(fetchMock.mock.calls.length).toBe(1);

    release();
    await act(async () => {
      await first;
    });
  });

  test("stops at the spent cursor and refuses to walk past it", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["only"], "0") });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });
    expect(result.current.exhausted).toBe(true);

    // Cursor "0" means the walk saw everything there was, so asking again would re-walk it.
    await act(async () => {
      await result.current.scanMore();
    });
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  test("absorbs an empty page without disturbing the keys already held", async () => {
    let call = 0;
    mockGlobalFetch({
      "/api/db/keys/scan": () => {
        call += 1;
        // `SCAN MATCH` can answer an empty batch and a non-zero cursor at once, which is a real
        // reply and not an end-of-walk signal.
        return call === 1 ? page(["a"], "4") : page([], "0");
      },
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });
    await act(async () => {
      await result.current.scanMore();
    });

    expect(result.current.keys).toEqual(["a"]);
    expect(result.current.scanned).toBe(1);
    expect(result.current.exhausted).toBe(true);
  });

  test("reports the route's own sentence on a failure and keeps the last acknowledged cursor", async () => {
    let fail = true;
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": () => (fail ? { status: 500, json: { error: "NOPERM no scan for you" } } : page(["a"], "5")),
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });
    expect(result.current.error).toBe("NOPERM no scan for you");

    // Retrying re-asks the batch that failed rather than skipping it: the cursor is still where the
    // server last acknowledged it, because an error is not progress.
    fail = false;
    await act(async () => {
      await result.current.scanMore();
    });

    expect(bodiesOf(fetchMock)).toMatchObject([{ cursor: "0" }, { cursor: "0" }]);
    expect(result.current.error).toBeNull();
    expect(result.current.keys).toEqual(["a"]);
  });

  test("names the HTTP status when a failure carries no sentence", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": { status: 502, text: "bad gateway" } });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });

    expect(result.current.error).toBe("The key walk failed with HTTP 502");
  });

  test("Scan all pages until the walk is spent", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": async (req) => {
        const cursor = await cursorOf(req);
        if (cursor === "0") return page(["a", "b"], "1");
        if (cursor === "1") return page(["c"], "2");
        return page(["d"], "0");
      },
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanAll();
    });

    expect(fetchMock.mock.calls.length).toBe(3);
    expect(result.current.keys).toEqual(["a", "b", "c", "d"]);
    expect(result.current.exhausted).toBe(true);
    expect(result.current.scanningAll).toBe(false);
    // A walk that reached the end was not "stopped": there is nothing it failed to reach.
    expect(result.current.stoppedBy).toBeNull();
    expect(result.current.error).toBeNull();
  });

  test("Scan all stops at the cap and says so in its own words", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": async (req) => {
        // Full pages that never spend the cursor, so only the client's own cap can end this walk.
        const index = Number(await cursorOf(req)) / CAPABILITY.defaultCount;
        const keys = Array.from({ length: CAPABILITY.defaultCount }, (_, offset) => `bulk:${index * 500 + offset}`);
        return page(keys, String((index + 1) * CAPABILITY.defaultCount));
      },
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanAll();
    });

    expect(result.current.scanned).toBe(SCAN_ALL_MAX_KEYS);
    expect(result.current.exhausted).toBe(false);
    // A cap nobody can see is the defect this sentence exists to prevent: without it, a walk that
    // gave up reads as a database holding exactly that many keys.
    expect(result.current.stoppedBy).toBe("Stopped after 10,000 keys. Narrow the pattern to walk a smaller key space.");
    expect(fetchMock.mock.calls.length).toBe(SCAN_ALL_MAX_KEYS / CAPABILITY.defaultCount);
  });

  test("Stop ends a running Scan all after the page in flight", async () => {
    // A no-op default rather than `| null`: the executor below replaces it before anything waits,
    // and a nullable declaration narrows to `null` at the call site, where `release?.()` then has
    // type `never`. `release` is reassigned inside the promise's executor, which TypeScript cannot
    // see, so the declared type is what the call site has to be callable from.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": async (req) => {
        if ((await cursorOf(req)) !== "0") return page(["b"], "2");
        await gate;
        return page(["a"], "1");
      },
    });
    const { result } = hook();

    let running: Promise<void> = Promise.resolve();
    act(() => {
      running = result.current.scanAll();
    });
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBe(1);
    });

    act(() => {
      result.current.stop();
    });
    release();
    await act(async () => {
      await running;
    });

    // The page already in flight lands and is counted — it is not a request that can be recalled —
    // and it is the last one, which is what "stop" can honestly mean here.
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(result.current.keys).toEqual(["a"]);
    expect(result.current.stoppedBy).toBe("Stopped.");
    expect(result.current.scanningAll).toBe(false);
  });

  test("Scan all ends a failed walk rather than re-asking the same page forever", async () => {
    let call = 0;
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": () => {
        call += 1;
        return call === 1 ? page(["a"], "1") : { status: 500, json: { error: "boom" } };
      },
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanAll();
    });

    expect(fetchMock.mock.calls.length).toBe(2);
    expect(result.current.error).toBe("boom");
    expect(result.current.scanningAll).toBe(false);
    // Not "stopped": the walk did not choose to end, it failed, and the panel shows the sentence.
    expect(result.current.stoppedBy).toBeNull();
  });

  test("Scan all refuses a second press while one is running", async () => {
    // A no-op default rather than `| null`: the executor below replaces it before anything waits,
    // and a nullable declaration narrows to `null` at the call site, where `release?.()` then has
    // type `never`. `release` is reassigned inside the promise's executor, which TypeScript cannot
    // see, so the declared type is what the call site has to be callable from.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockGlobalFetch({
      "/api/db/keys/scan": async () => {
        await gate;
        return page(["a"], "0");
      },
    });
    const { result } = hook();

    let running: Promise<void> = Promise.resolve();
    act(() => {
      running = result.current.scanAll();
    });
    await act(async () => {
      await result.current.scanAll();
    });

    release();
    await act(async () => {
      await running;
    });

    expect(result.current.keys).toEqual(["a"]);
  });

  test("reset throws the walk away and starts again at cursor zero", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["a"], "3") });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });
    act(() => {
      result.current.reset();
    });

    expect(result.current.keys).toEqual([]);
    expect(result.current.scanned).toBe(0);
    expect(result.current.total).toBeNull();
    expect(result.current.exhausted).toBe(false);

    await act(async () => {
      await result.current.scanMore();
    });
    expect(bodiesOf(fetchMock)).toMatchObject([{ cursor: "0" }, { cursor: "0" }]);
  });

  test("ignores a page that lands after unmount", async () => {
    /*
     * There is no session to close, because a cursor is a position rather than a handle — but a
     * response still arrives, and setting state on an unmounted hook is the one thing the cleanup
     * has to prevent. Both arms are exercised: a late ANSWER and a late FAILURE, which are two
     * different `return`s in the hook.
     */
    const releases: Array<() => void> = [];
    let mode: "ok" | "fail" = "ok";
    mockGlobalFetch({
      "/api/db/keys/scan": async () => {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        if (mode === "fail") throw new Error("late failure");
        return page(["late"], "0");
      },
    });

    const first = hook();
    let ok: Promise<void> = Promise.resolve();
    act(() => {
      ok = first.result.current.scanMore();
    });
    await waitFor(() => {
      expect(releases.length).toBe(1);
    });
    first.unmount();
    releases[0]();
    await act(async () => {
      await ok;
    });
    expect(first.result.current.keys).toEqual([]);

    mode = "fail";
    const second = hook();
    let bad: Promise<void> = Promise.resolve();
    act(() => {
      bad = second.result.current.scanMore();
    });
    await waitFor(() => {
      expect(releases.length).toBe(2);
    });
    second.unmount();
    releases[1]();
    await act(async () => {
      await bad;
    });
    expect(second.result.current.error).toBeNull();
  });

  /**
   * WHAT A WALK THAT WAS THROWN AWAY MAY STILL DO: nothing.
   *
   * `reset` is what a new pattern, a new database and the panel's refresh all run, and the page in
   * the air at that moment belongs to the question that was just abandoned. Letting it land would
   * append another database's keys to a fresh tree and move the cursor to a position in a walk nobody
   * is taking — a sample mixed from two walks, which is the one state the panel cannot explain.
   *
   * The old code got this wrong in a way only a mid-walk reset could show, so each of the three places
   * a late answer used to write is checked on its own: the page, its failure, and a scoped page.
   */
  describe("a page whose walk was discarded", () => {
    /** A gate the test opens to decide when a held page lands. */
    function gate() {
      // A no-op default rather than `| null`: the executor below replaces it before anything waits,
      // and a nullable declaration narrows to `null` at the call site, where `release?.()` then has
      // type `never`.
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { held, release: () => release() };
    }

    test("does not land its keys, its cursor or its total", async () => {
      const held = gate();
      let call = 0;
      mockGlobalFetch({
        "/api/db/keys/scan": async () => {
          call += 1;
          if (call === 1) {
            await held.held;
            return page(["stale"], "5", 900);
          }
          return page(["fresh"], "0", 31);
        },
      });
      const { result } = hook();

      let stale: Promise<void> = Promise.resolve();
      act(() => {
        stale = result.current.scanMore();
      });
      act(() => {
        result.current.reset();
      });
      // The new walk is not blocked by the abandoned page: it belongs to a walk that is gone, and
      // waiting for it would leave a freshly reset panel showing nothing until an answer it has
      // already decided not to use comes back.
      await act(async () => {
        await result.current.scanMore();
      });
      held.release();
      await act(async () => {
        await stale;
      });

      expect(result.current.keys).toEqual(["fresh"]);
      expect(result.current.scanned).toBe(1);
      expect(result.current.total).toBe(31);
      expect(result.current.busy).toBe(false);
    });

    test("does not report its failure against the walk that replaced it", async () => {
      const held = gate();
      let call = 0;
      mockGlobalFetch({
        "/api/db/keys/scan": async () => {
          call += 1;
          if (call === 1) {
            await held.held;
            return { status: 500, json: { error: "NOPERM no scan for you" } };
          }
          return page(["fresh"], "0");
        },
      });
      const { result } = hook();

      let stale: Promise<void> = Promise.resolve();
      act(() => {
        stale = result.current.scanMore();
      });
      act(() => {
        result.current.reset();
      });
      await act(async () => {
        await result.current.scanMore();
      });
      held.release();
      await act(async () => {
        await stale;
      });

      // The refusal describes a read the panel has already replaced: shown against the new walk it
      // would be a sentence about a question nobody is asking.
      expect(result.current.error).toBeNull();
      expect(result.current.keys).toEqual(["fresh"]);
    });
  });

  /**
   * The walk scoped to ONE PREFIX, which is the only thing that can answer "is there more under
   * here" about a prefix the global sample happened to miss.
   *
   * The assertions are on the REQUEST as much as on the answer, because the two things that make
   * this different from the global walk are exactly the two fields it sends: a pattern built from the
   * prefix, and a cursor that belongs to that prefix rather than to the walk.
   */
  describe("loadMoreUnder()", () => {
    const APP = ["app", "cache"];
    const APP_PATTERN = "app:cache:*";

    /** The body of the nth request, as the route would have received it. */
    const bodyAt = (fetchMock: { mock: { calls: unknown[][] } }, index: number) =>
      JSON.parse(String((fetchMock.mock.calls[index][1] as RequestInit).body)) as Record<string, unknown>;

    test("asks about the prefix itself, starting where that prefix's walk starts", async () => {
      const fetchMock = mockGlobalFetch({
        "/api/db/keys/scan": (req) => {
          void req;
          return page(["app:cache:ttl"], "17");
        },
      });
      const { result } = hook();

      // The global walk is not started here on purpose: a scoped load must work without it, since the
      // panel's first page may have failed while a folder is still worth asking about.
      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });

      // The batch is the LARGEST the engine declares rather than the global walk's default: a scoped
      // walk is asked in PRESSES, and `MATCH` is not indexed, so a smaller batch does not make one
      // press cheaper — it makes more of them for the same answer.
      expect(bodyAt(fetchMock, 0)).toMatchObject({ cursor: "0", pattern: APP_PATTERN, count: 1000 });
      expect(result.current.keys).toEqual(["app:cache:ttl"]);
      expect(result.current.nodeCursors.get(pathKey(APP))).toBe("17");
    });

    test("continues that prefix's own walk on the next press", async () => {
      const fetchMock = mockGlobalFetch({
        "/api/db/keys/scan": () => page(["app:cache:a"], "17"),
      });
      const { result } = hook();

      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });
      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });

      // The SECOND request carries this prefix's cursor, not the global walk's and not `"0"` again: a
      // row that restarted the prefix every press would re-read the same first page forever.
      expect(bodyAt(fetchMock, 0)).toMatchObject({ cursor: "0" });
      expect(bodyAt(fetchMock, 1)).toMatchObject({ cursor: "17" });
    });

    test("records a spent prefix so the row can stop offering itself", async () => {
      mockGlobalFetch({ "/api/db/keys/scan": page(["app:cache:ttl"], "0") });
      const { result } = hook();

      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });

      expect(result.current.nodeCursors.get(pathKey(APP))).toBe("0");
    });

    test("drops names the server returned that are not under the prefix", async () => {
      // `MATCH` is an unescaped glob and a real key segment can contain `*`, so a scoped answer can
      // carry keys from outside the prefix. They are the server's answer to a question that was not
      // asked, and letting them in would put a key under a folder it does not belong to.
      mockGlobalFetch({
        "/api/db/keys/scan": page(["app:cache:ttl", "app:cached:other", "app:envelope", "elsewhere:x"], "0"),
      });
      const { result } = hook();

      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });

      expect(result.current.keys).toEqual(["app:cache:ttl"]);
    });

    test("escapes the prefix half of the pattern, and ONLY that half", async () => {
      // `[` opens a character class in a Redis glob, so an unescaped prefix would ask the server for
      // a different set of keys entirely. The escaping is the repository's shared `escapeGlob` rule
      // (#427) rather than a copy of it, so this walk and the object surface's own prefix listing
      // cannot drift apart.
      const fetchMock = mockGlobalFetch({
        "/api/db/keys/scan": page(["weird[1:inner", "weirder[x:other"], "0"),
      });
      const { result } = hook();

      await act(async () => {
        await result.current.loadMoreUnder(["weird[1"]);
      });

      expect(bodyAt(fetchMock, 0)).toMatchObject({ pattern: "weird\\[1:*" });
      // And the ANSWER is compared against the real name, unescaped: escaping the keys would drop a
      // literal key that genuinely contains `*`.
      expect(result.current.keys).toEqual(["weird[1:inner"]);
    });

    test("leaves the global walk's progress and cursor alone", async () => {
      let call = 0;
      const fetchMock = mockGlobalFetch({
        "/api/db/keys/scan": () => {
          call += 1;
          // First the global walk's page, then the scoped one, then the global walk's again.
          if (call === 1) return page(["top:one"], "7", 31);
          if (call === 2) return page(["app:cache:ttl"], "3");
          return page(["top:two"], "0", 31);
        },
      });
      const { result } = hook();

      await act(async () => {
        await result.current.scanMore();
      });
      expect(result.current.scanned).toBe(1);

      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });
      // The scoped page handed back a key the global walk had not counted, and it still does not
      // count: `scanned` is measured against `total`, which is the DATABASE's key count, so adding a
      // scoped batch would push the progress line past its own denominator.
      expect(result.current.scanned).toBe(1);
      expect(result.current.total).toBe(31);

      await act(async () => {
        await result.current.scanMore();
      });
      // And the global cursor is where the global walk left it, not where the scoped page did.
      expect(bodyAt(fetchMock, 2)).toMatchObject({ cursor: "7" });
      expect(result.current.keys).toEqual(["top:one", "app:cache:ttl", "top:two"]);
    });

    test("shares the tree's one copy of a key with the global walk", async () => {
      let call = 0;
      mockGlobalFetch({
        "/api/db/keys/scan": () => {
          call += 1;
          return call === 1 ? page(["app:cache:ttl"], "9") : page(["app:cache:ttl"], "0");
        },
      });
      const { result } = hook();

      await act(async () => {
        await result.current.scanMore();
      });
      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });

      expect(result.current.keys).toEqual(["app:cache:ttl"]);
    });

    test("refuses a second page for one prefix while the first is in flight", async () => {
      // A callable default rather than `| null`: the executor below replaces it before anything waits,
      // and a nullable declaration narrows to `null` at the call site, where the call then has type
      // `never`. The opener is assigned inside a promise's executor, which TypeScript cannot see.
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetchMock = mockGlobalFetch({
        "/api/db/keys/scan": async () => {
          await gate;
          return page(["app:cache:ttl"], "0");
        },
      });
      const { result } = hook();

      let first: Promise<void> = Promise.resolve();
      act(() => {
        first = result.current.loadMoreUnder(APP);
      });
      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });

      // Both presses would read the same scoped cursor and both advance from it, so the second would
      // overwrite the position the first earned — the same rule the global walk keeps.
      expect(fetchMock.mock.calls.length).toBe(1);
      release();
      await act(async () => {
        await first;
      });
      expect(result.current.nodeLoading.size).toBe(0);
    });

    test("marks the prefix while its page is in flight", async () => {
      // A callable default rather than `| null`: the executor below replaces it before anything waits,
      // and a nullable declaration narrows to `null` at the call site, where the call then has type
      // `never`. The opener is assigned inside a promise's executor, which TypeScript cannot see.
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mockGlobalFetch({
        "/api/db/keys/scan": async () => {
          await gate;
          return page(["app:cache:ttl"], "0");
        },
      });
      const { result } = hook();

      let pending: Promise<void> = Promise.resolve();
      act(() => {
        pending = result.current.loadMoreUnder(APP);
      });
      await waitFor(() => {
        expect(result.current.nodeLoading.has(pathKey(APP))).toBe(true);
      });

      release();
      await act(async () => {
        await pending;
      });
      expect(result.current.nodeLoading.has(pathKey(APP))).toBe(false);
    });

    test("reports a scoped failure without ending the walk somebody else started", async () => {
      let call = 0;
      mockGlobalFetch({
        "/api/db/keys/scan": () => {
          call += 1;
          if (call === 1) return page(["top:one"], "7", 31);
          if (call === 2) return { status: 500, json: { error: "NOPERM no scan for you" } };
          return page(["top:two"], "0", 31);
        },
      });
      const { result } = hook();

      await act(async () => {
        await result.current.scanMore();
      });
      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });
      expect(result.current.error).toBe("NOPERM no scan for you");
      // The prefix keeps no cursor, so its next press re-asks the batch that failed rather than
      // skipping it — the same rule the global walk keeps.
      expect(result.current.nodeCursors.get(pathKey(APP))).toBeUndefined();

      // AND THE WALK STILL RUNS. A prefix that refused is not a reason to end a walk started at the
      // database level, which is why this path does not set the loop's own failure flag.
      await act(async () => {
        await result.current.scanMore();
      });
      expect(result.current.keys).toEqual(["top:one", "top:two"]);
    });

    test("clears every prefix's walk on reset", async () => {
      const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["app:cache:ttl"], "17") });
      const { result } = hook();

      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });
      act(() => {
        result.current.reset();
      });
      expect(result.current.nodeCursors.size).toBe(0);
      expect(result.current.nodeLoading.size).toBe(0);

      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });
      // From the start, not from where the discarded walk stood: a cursor left standing would answer
      // the next walk's Load more with keys from the walk that was thrown away.
      expect(bodyAt(fetchMock, 1)).toMatchObject({ cursor: "0" });
    });

    test("ignores a scoped page that lands after unmount", async () => {
      const releases: Array<() => void> = [];
      let mode: "ok" | "fail" = "ok";
      mockGlobalFetch({
        "/api/db/keys/scan": async () => {
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
          if (mode === "fail") throw new Error("late scoped failure");
          return page(["app:cache:ttl"], "0");
        },
      });

      const first = hook();
      let ok: Promise<void> = Promise.resolve();
      act(() => {
        ok = first.result.current.loadMoreUnder(APP);
      });
      await waitFor(() => {
        expect(releases.length).toBe(1);
      });
      first.unmount();
      releases[0]();
      await act(async () => {
        await ok;
      });
      expect(first.result.current.nodeCursors.size).toBe(0);

      mode = "fail";
      const second = hook();
      let bad: Promise<void> = Promise.resolve();
      act(() => {
        bad = second.result.current.loadMoreUnder(APP);
      });
      await waitFor(() => {
        expect(releases.length).toBe(2);
      });
      second.unmount();
      releases[1]();
      await act(async () => {
        await bad;
      });
      expect(second.result.current.error).toBeNull();
    });

    test("drops a scoped page whose walk was thrown away, cursor and keys alike", async () => {
      // A no-op default rather than `| null`: the executor below replaces it before anything waits,
      // and a nullable declaration narrows to `null` at the call site, where `release?.()` then has
      // type `never`.
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let call = 0;
      const fetchMock = mockGlobalFetch({
        "/api/db/keys/scan": async () => {
          call += 1;
          if (call === 1) return page(["app:env"], "9");
          // The scoped page, held so the walk can be thrown away while it is in the air.
          if (call === 2) {
            await held;
            return page(["app:late"], "0");
          }
          return page(["fresh:key"], "0");
        },
      });
      const { result } = hook();

      await act(async () => {
        await result.current.scanMore();
      });
      let scoped: Promise<void> = Promise.resolve();
      act(() => {
        scoped = result.current.loadMoreUnder(APP);
      });
      act(() => {
        result.current.reset();
      });
      await act(async () => {
        await result.current.scanMore();
      });
      release();
      await act(async () => {
        await scoped;
      });

      // A prefix's cursor belongs to the walk it was measured in: recorded against the new one it
      // would answer a later Load more with keys from a key space nobody is looking at.
      expect(result.current.keys).toEqual(["fresh:key"]);
      expect(result.current.nodeCursors.size).toBe(0);
      expect(result.current.scanned).toBe(1);
      expect(bodyAt(fetchMock, 2)).toMatchObject({ cursor: "0" });
    });
  });
});

describe("the held-key limit", () => {
  test("takes the limit's worth of a page and then refuses every further walk", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": page(
        Array.from({ length: HELD_KEY_LIMIT + 1 }, (_, index) => `bulk:${index}`),
        "7",
      ),
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });

    // HANDED and HELD are two different numbers and both are reported: the walk was given ten thousand
    // and one keys, the tree holds the limit's worth of them, and the difference is the tail this
    // bound refused rather than keys that were never walked.
    expect(result.current.scanned).toBe(HELD_KEY_LIMIT + 1);
    expect(result.current.keys.length).toBe(HELD_KEY_LIMIT);

    // A full tree is NOT a spent walk: the cursor is still live, and nothing arrives now because the
    // panel cannot take it - so a reader who narrows the pattern gets a fresh walk from cursor zero.
    expect(result.current.exhausted).toBe(false);

    // The next page would be a page bought to drop, so it is not taken.
    await act(async () => {
      await result.current.scanMore();
    });
    expect(fetchMock.mock.calls.length).toBe(1);

    // A prefix's own walk refuses before it even asks: no cursor recorded, nothing in flight.
    await act(async () => {
      await result.current.loadMoreUnder(["bulk", "0"]);
    });
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(result.current.nodeCursors.size).toBe(0);
  });
});

/**
 * The walk in a declared shape (spec 3.4, 4.6): an etcd-shaped provider's pages, with an opaque
 * cursor, a prefix Load more and the keys a page left out.
 */
describe("a walk in a declared shape", () => {
  afterEach(() => {
    restoreGlobalFetch();
  });

  const ETCD_SCAN = {
    defaultCount: 500,
    maxCount: 1000,
    separator: "/",
    cursor: "opaque",
    pattern: "prefix",
    totalScope: "walk",
  } as const;
  const REASON = "a key that is not UTF-8 text has no name a row could carry; a typed get shows it in base64.";

  /** A page with the keys it left out, in the shape the route answers with. */
  function skippingPage(keys: string[], cursor: string, count: number): MockFetchResponse {
    return { json: { keys, cursor, total: 9, types: {}, skipped: { count, reason: REASON } } };
  }

  /** The body of the nth request, as the route would have received it. */
  const bodyAt = (fetchMock: { mock: { calls: unknown[][] } }, index: number) =>
    JSON.parse(String((fetchMock.mock.calls[index][1] as RequestInit).body)) as Record<string, unknown>;

  function etcdHook() {
    return renderHook(() => useKeyScan({ connection: CONNECTION, capability: ETCD_SCAN, pattern: "" }));
  }

  test("hands an opaque cursor back exactly as the page wrote it", async () => {
    const opaque = "k:L2FwcC9i:12:9";
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": async (req) =>
        (await cursorOf(req)) === "0" ? page(["/app/a"], opaque, 9) : page(["/app/b"], "0", 9),
    });
    const { result } = etcdHook();

    await act(async () => {
      await result.current.scanMore();
    });
    await act(async () => {
      await result.current.scanMore();
    });

    expect(bodiesOf(fetchMock).map((body) => body.cursor)).toEqual(["0", opaque]);
    expect(result.current.keys).toEqual(["/app/a", "/app/b"]);
    expect(result.current.exhausted).toBe(true);
  });

  test("passes a page's skipped keys through and adds them up across the walk's pages", async () => {
    mockGlobalFetch({
      "/api/db/keys/scan": async (req) =>
        (await cursorOf(req)) === "0" ? skippingPage(["/a"], "k:x:3:9", 2) : skippingPage(["/b"], "0", 1),
    });
    const { result } = etcdHook();

    // Nothing is left out before a page says so: null, and not a zero count a panel would draw.
    expect(result.current.skipped).toBeNull();
    await act(async () => {
      await result.current.scanMore();
    });
    expect(result.current.skipped).toEqual({ count: 2, reason: REASON });

    await act(async () => {
      await result.current.scanMore();
    });
    expect(result.current.skipped).toEqual({ count: 3, reason: REASON });
  });

  test("gives the reason of the latest page that left a key out", async () => {
    const later = "the second page's own words.";
    mockGlobalFetch({
      "/api/db/keys/scan": async (req) =>
        (await cursorOf(req)) === "0"
          ? skippingPage(["/a"], "k:x:3:9", 2)
          : { json: { keys: ["/b"], cursor: "0", total: 9, types: {}, skipped: { count: 1, reason: later } } },
    });
    const { result } = etcdHook();

    await act(async () => {
      await result.current.scanMore();
    });
    await act(async () => {
      await result.current.scanMore();
    });

    // The count is the walk's, added up; the words are the provider's latest, and are never joined.
    expect(result.current.skipped).toEqual({ count: 3, reason: later });
  });

  test("leaves skipped at null for a page that left nothing out", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": skippingPage(["/a"], "0", 0) });
    const { result } = etcdHook();

    await act(async () => {
      await result.current.scanMore();
    });

    // A zero count says nothing was left out, which the panel must not draw as a line.
    expect(result.current.skipped).toBeNull();
  });

  test("throws the skipped count away with the walk", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": skippingPage(["/a"], "k:x:3:9", 2) });
    const { result } = etcdHook();

    await act(async () => {
      await result.current.scanMore();
    });
    act(() => {
      result.current.reset();
    });
    expect(result.current.skipped).toBeNull();

    await act(async () => {
      await result.current.scanMore();
    });
    // The restarted walk counts its own pages from nothing, never on top of the old walk's.
    expect(result.current.skipped).toEqual({ count: 2, reason: REASON });
  });

  test("leaves skipped untouched in a prefix's Load more, as it leaves scanned", async () => {
    let call = 0;
    mockGlobalFetch({
      "/api/db/keys/scan": () => {
        call += 1;
        return call === 1 ? skippingPage(["/app/a"], "k:x:3:9", 2) : skippingPage(["/app/b"], "0", 5);
      },
    });
    const { result } = etcdHook();

    await act(async () => {
      await result.current.scanMore();
    });
    await act(async () => {
      await result.current.loadMoreUnder(["", "app"]);
    });

    expect(result.current.keys).toEqual(["/app/a", "/app/b"]);
    expect(result.current.skipped).toEqual({ count: 2, reason: REASON });
    expect(result.current.scanned).toBe(1);
  });

  test("asks a prefix's Load more for the bare prefix and keeps that prefix's opaque cursor", async () => {
    const opaque = "k:L2Fw:7:12";
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": async (req) =>
        (await cursorOf(req)) === "0" ? page(["/app/a", "/app/b", "/apple/x"], opaque, 12) : page(["/app/c"], "0", 12),
    });
    const { result } = etcdHook();

    await act(async () => {
      await result.current.loadMoreUnder(["", "app"]);
    });
    await act(async () => {
      await result.current.loadMoreUnder(["", "app"]);
    });

    // The bare prefix and its separator, from the same helper the Sidebar hands over with, and the
    // largest batch the engine declares, as a Redis Load more asks for.
    expect(bodyAt(fetchMock, 0)).toMatchObject({ cursor: "0", pattern: "/app/", count: 1000 });
    expect(bodyAt(fetchMock, 1)).toMatchObject({ cursor: opaque, pattern: "/app/" });
    // A key the answer held that is not under the prefix by segments is dropped, as on Redis.
    expect(result.current.keys).toEqual(["/app/a", "/app/b", "/app/c"]);
    expect(result.current.nodeCursors.get(pathKey(["", "app"]))).toBe("0");
  });

  test("asks the root row's Load more for the separator itself", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["/a"], "0", 1) });
    const { result } = etcdHook();

    await act(async () => {
      await result.current.loadMoreUnder([""]);
    });

    expect(bodyAt(fetchMock, 0)).toMatchObject({ pattern: "/" });
  });

  test("names the prefix when Scan all stops at its cap", async () => {
    const wide = { ...ETCD_SCAN, defaultCount: SCAN_ALL_MAX_KEYS, maxCount: SCAN_ALL_MAX_KEYS };
    mockGlobalFetch({
      "/api/db/keys/scan": page(
        Array.from({ length: SCAN_ALL_MAX_KEYS }, (_, index) => `/bulk/${index}`),
        "k:L2J1bGs:5:20000",
        20_000,
      ),
    });
    const { result } = renderHook(() => useKeyScan({ connection: CONNECTION, capability: wide, pattern: "" }));

    await act(async () => {
      await result.current.scanAll();
    });

    expect(result.current.stoppedBy).toBe("Stopped after 10,000 keys. Narrow the prefix to walk a smaller key space.");
  });
});
