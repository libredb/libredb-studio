import "../setup-dom";
import { mockToastError, mockToastSuccess } from "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../helpers/mock-fetch";

import { useConnectionManager } from "@/hooks/use-connection-manager";
import type { ManagedConnectionPayload } from "@/hooks/use-connection-payload";
import { onSessionEnded } from "@/lib/config/base-path";
import { storage } from "@/lib/storage";
import type { DatabaseConnection } from "@/lib/types";

/*
  `/?connection=<id>` opens the editor on one connection.

  The id is the connection's full id in the browser, `seed:<id>` for a seed, and a link from
  another application carries it URL-encoded (`seed%3A<id>`). The hook reads it once the list has
  loaded, selects that connection instead of the default, and takes the parameter out of the
  address bar. An id the first load does not list opens at the first refresh that lists it,
  because a seed can be listed a little later than the link arrives. A miss is decided only by a
  refresh one seed-cache lifetime after the first load answered, since until then the server can
  answer from the cache the first load read. That miss keeps the default selection and raises a
  toast that does not say why: an unknown id, a seed the server hides from the reader's role, and
  a connection of the reader's own that the custom-connections policy hides all read the same. A
  managed list that could not be loaded is reported as that.

  No route here answers `GET /api/connections/policy` unless a test adds it, and the policy reader
  takes the 404 as custom connections allowed, which is how the hook behaves where the switch is
  unset. The managed answers carry a `cacheHint` of 12 seconds, so no refresh runs on its own
  during a test; a window `focus` event triggers one at once, and a test that wants a miss decided
  moves the hook's clock past the 12 seconds first (passSeedCache).
*/

/** A seed as the managed route serializes it. */
const seed = (id: string, overrides: Partial<ManagedConnectionPayload> = {}): ManagedConnectionPayload => ({
  id: `seed:${id}`,
  seedId: id,
  name: `Seed ${id}`,
  type: "postgres",
  host: `${id}.internal`,
  port: 5432,
  database: id,
  user: "svc",
  managed: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const answer = (connections: ManagedConnectionPayload[]): MockFetchResponse => ({
  json: { connections, cacheHint: 12_000, pendingSeeds: [] },
});

const routes = (managed: MockFetchResponse | (() => MockFetchResponse | Promise<MockFetchResponse>)) => ({
  "/api/connections/managed": managed,
  "/api/db/health": { json: { status: "healthy" } },
});

/** The routes of a server that refuses custom connections (`ALLOW_CUSTOM_CONNECTIONS=false`). */
const refusingRoutes = (managed: MockFetchResponse) => ({
  ...routes(managed),
  "/api/connections/policy": { json: { customConnections: false } },
});

/** A connection the reader made, as storage holds it. */
const mine = (id: string): DatabaseConnection => ({
  id,
  name: `Mine ${id}`,
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: id,
  user: "me",
  password: "secret",
  createdAt: new Date("2026-01-01"),
});

const managedCalls = (fetchMock: ReturnType<typeof mockGlobalFetch>) =>
  fetchMock.mock.calls.filter((call) => String(call[0]).includes("/api/connections/managed")).length;

/** The window regaining focus, which makes the hook refresh the managed list at once. */
const focusWindow = () => {
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let clock: { mockRestore(): void } | null = null;

/**
 * Moves `Date.now` one seed-cache lifetime (the answers' 12-second `cacheHint`) ahead, as if that
 * long had passed since the first load answered; the clock keeps running from there.
 */
const passSeedCache = () => {
  const realNow = Date.now;
  clock = spyOn(Date, "now").mockImplementation(() => realNow() + 12_001);
};

const NOT_AVAILABLE = [
  "Connection not available",
  { description: "The link names a connection that is not available to you, so it was not opened." },
] as const;

const LIST_NOT_LOADED = [
  "Connections not loaded",
  {
    description:
      "The link names a connection, but the connection list could not be loaded, so it was not opened. Reload the page to try again.",
  },
] as const;

describe("opening the editor on a linked connection", () => {
  beforeEach(() => {
    mockToastError.mockClear();
    mockToastSuccess.mockClear();
    localStorage.clear();
  });

  afterEach(() => {
    clock?.mockRestore();
    clock = null;
    restoreGlobalFetch();
    window.history.replaceState(null, "", "/");
  });

  test("selects the linked connection and takes the parameter out of the address bar", async () => {
    window.history.replaceState(null, "", "/?connection=seed%3Abilling");
    mockGlobalFetch(routes(answer([seed("orders"), seed("billing")])));

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:billing"));
    expect(window.location.search).toBe("");
    expect(mockToastError).not.toHaveBeenCalled();
    // Persisted like any other selection, so a reload without the link reopens it.
    await waitFor(() => expect(storage.getActiveConnectionId()).toBe("seed:billing"));
  });

  test("the link wins over the connection the reader had open last time", async () => {
    storage.setActiveConnectionId("seed:orders");
    window.history.replaceState(null, "", "/?connection=seed%3Abilling");
    mockGlobalFetch(routes(answer([seed("orders"), seed("billing")])));

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:billing"));
  });

  test("an id the server did not list keeps the default selection, and a refresh after the seed cache that does not list it either says so without saying why", async () => {
    // `seed:payroll` stands for both causes: a seed that does not exist, and one whose roles leave
    // this reader out, which the route drops from the list before it answers.
    storage.setActiveConnectionId("seed:orders");
    window.history.replaceState(null, "", "/?connection=seed%3Apayroll");
    const fetchMock = mockGlobalFetch(routes(answer([seed("orders"), seed("billing")])));

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:orders"));
    // Consumed at once all the same: a reload must not follow the link again.
    expect(window.location.search).toBe("");
    expect(mockToastError).not.toHaveBeenCalled();

    passSeedCache();
    focusWindow();
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(...NOT_AVAILABLE));
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(result.current.activeConnection?.id).toBe("seed:orders");

    // Decided once: a later refresh says nothing more.
    focusWindow();
    await waitFor(() => expect(managedCalls(fetchMock)).toBe(3));
    await sleep(50);
    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  test("a refresh the server may still answer from the seed cache the first load read leaves a miss pending, with no toast", async () => {
    // A window focus refreshes at once, and until one seed-cache lifetime after the first load the
    // server can answer from the cache that load read, so that refresh's miss proves nothing yet.
    storage.setActiveConnectionId("seed:orders");
    window.history.replaceState(null, "", "/?connection=seed%3Apayroll");
    const fetchMock = mockGlobalFetch(routes(answer([seed("orders"), seed("billing")])));

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:orders"));
    expect(window.location.search).toBe("");

    focusWindow();
    await waitFor(() => expect(managedCalls(fetchMock)).toBe(2));
    await sleep(50);
    expect(mockToastError).not.toHaveBeenCalled();

    // Still pending: the first refresh once the cache has expired decides it, once.
    passSeedCache();
    focusWindow();
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(...NOT_AVAILABLE));
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(result.current.activeConnection?.id).toBe("seed:orders");
  });

  test("a seed the first load does not list yet opens when the next refresh lists it, with no toast", async () => {
    // The server re-reads its seed file only once its seed cache has expired, so a link for a
    // database created moments ago can arrive before the seed is listed.
    window.history.replaceState(null, "", "/?connection=seed%3Abilling");
    let calls = 0;
    mockGlobalFetch(
      routes(() => {
        calls += 1;
        return answer(calls === 1 ? [seed("orders")] : [seed("orders"), seed("billing")]);
      }),
    );

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:orders"));
    expect(window.location.search).toBe("");

    focusWindow();
    await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:billing"));
    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  test("a connection the reader chooses while the link is pending cancels the link, with no switch and no toast later", async () => {
    // Switching the active connection resets the transaction, turns editing off and discards
    // pending grid edits (Studio's connection-change effect), so a link that is still pending must
    // not take the reader away from a connection they picked themselves.
    window.history.replaceState(null, "", "/?connection=seed%3Abilling");
    let calls = 0;
    const fetchMock = mockGlobalFetch(
      routes(() => {
        calls += 1;
        return answer(calls === 1 ? [seed("orders"), seed("audit")] : [seed("orders"), seed("audit"), seed("billing")]);
      }),
    );

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:orders"));
    const audit = result.current.connections.find((c) => c.id === "seed:audit");
    act(() => {
      result.current.setActiveConnection(audit ?? null);
    });
    await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:audit"));

    passSeedCache();
    focusWindow();
    await waitFor(() => expect(managedCalls(fetchMock)).toBe(2));
    await sleep(50);
    expect(result.current.activeConnection?.id).toBe("seed:audit");
    expect(result.current.connections.map((c) => c.id)).toContain("seed:billing");
    expect(mockToastError).not.toHaveBeenCalled();
  });

  // The shell's fallback after the reader deletes the open connection is not a pick of theirs, but the delete is their
  // own act, so it cancels the link as their pick does.
  test("the connection a delete falls back to cancels a pending link, with no switch and no toast later", async () => {
    window.history.replaceState(null, "", "/?connection=seed%3Abilling");
    let calls = 0;
    const fetchMock = mockGlobalFetch(
      routes(() => {
        calls += 1;
        return answer(calls === 1 ? [seed("orders"), seed("audit")] : [seed("orders"), seed("audit"), seed("billing")]);
      }),
    );

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:orders"));
    const audit = result.current.connections.find((c) => c.id === "seed:audit");
    act(() => {
      result.current.activateFallback(audit ?? null);
    });
    await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:audit"));

    passSeedCache();
    focusWindow();
    await waitFor(() => expect(managedCalls(fetchMock)).toBe(2));
    await sleep(50);
    expect(result.current.activeConnection?.id).toBe("seed:audit");
    expect(result.current.connections.map((c) => c.id)).toContain("seed:billing");
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("a refresh that fails leaves the link pending, and the next refresh that answers decides", async () => {
    window.history.replaceState(null, "", "/?connection=seed%3Abilling");
    let calls = 0;
    const fetchMock = mockGlobalFetch(
      routes(() => {
        calls += 1;
        if (calls === 2) return { status: 503, json: { error: "warming up" } };
        return answer(calls === 1 ? [seed("orders")] : [seed("orders"), seed("billing")]);
      }),
    );

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:orders"));
    focusWindow();
    await waitFor(() => expect(managedCalls(fetchMock)).toBe(2));
    await sleep(50);
    expect(mockToastError).not.toHaveBeenCalled();
    expect(result.current.activeConnection?.id).toBe("seed:orders");

    focusWindow();
    await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:billing"));
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("a connection of the reader's own is treated like an unknown id while custom connections are refused", async () => {
    // The connection is in storage and the merged list, but the policy keeps it out of the list
    // the reader sees, and the server would refuse to open it.
    storage.saveConnection(mine("mine-1"));
    window.history.replaceState(null, "", "/?connection=mine-1");
    mockGlobalFetch(refusingRoutes(answer([seed("orders"), seed("billing")])));

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:orders"));
    expect(window.location.search).toBe("");

    passSeedCache();
    focusWindow();
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(...NOT_AVAILABLE));
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(result.current.activeConnection?.id).toBe("seed:orders");
    expect(result.current.connections.map((c) => c.id)).toEqual(["seed:orders", "seed:billing"]);
  });

  test("an empty list selects nothing, and a refresh after the seed cache that lists nothing either raises the same toast", async () => {
    window.history.replaceState(null, "", "/?connection=seed%3Abilling");
    mockGlobalFetch(routes(answer([])));

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => expect(window.location.search).toBe(""));
    passSeedCache();
    focusWindow();
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(...NOT_AVAILABLE));
    expect(result.current.activeConnection).toBeNull();
  });

  test("the rest of the address is kept", async () => {
    window.history.replaceState(null, "", "/?tab=2&connection=seed%3Abilling&mode=dark#results");
    mockGlobalFetch(routes(answer([seed("orders"), seed("billing")])));

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:billing"));
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("?tab=2&mode=dark");
    expect(window.location.hash).toBe("#results");
  });

  test("the parameter is removed with no history state of its own, which keeps Next's router in step", async () => {
    // The entry as Next's router writes it, whose state carries `__NA`. The router's patched
    // `replaceState` lets a call carrying that marker through without syncing its own address, so
    // the hook must not hand the current state back.
    const routerState = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: {} };
    window.history.replaceState(routerState, "", "/?connection=seed%3Abilling");
    const replace = spyOn(window.history, "replaceState");
    try {
      mockGlobalFetch(routes(answer([seed("orders"), seed("billing")])));

      const { result } = renderHook(() => useConnectionManager(true));

      await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:billing"));
      expect(replace).toHaveBeenCalledTimes(1);
      expect(replace).toHaveBeenCalledWith(null, "", "/");
    } finally {
      replace.mockRestore();
    }
  });

  test("without the parameter the address bar is left alone", async () => {
    const replace = spyOn(window.history, "replaceState");
    try {
      mockGlobalFetch(routes(answer([seed("orders"), seed("billing")])));

      const { result } = renderHook(() => useConnectionManager(true));

      await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:orders"));
      expect(replace).not.toHaveBeenCalled();
      expect(mockToastError).not.toHaveBeenCalled();
    } finally {
      replace.mockRestore();
    }
  });

  test("a connection of the reader's own can be linked when the managed list could not be read", async () => {
    storage.saveConnection(mine("mine-1"));
    storage.saveConnection(mine("mine-2"));
    window.history.replaceState(null, "", "/?connection=mine-2");
    mockGlobalFetch(routes({ status: 404, json: { error: "Not found" } }));

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => expect(result.current.activeConnection?.id).toBe("mine-2"));
    expect(window.location.search).toBe("");
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("a managed list that could not be loaded is reported as that, never as a connection that is not available", async () => {
    window.history.replaceState(null, "", "/?connection=seed%3Abilling");
    mockGlobalFetch(routes({ status: 500, json: { error: "Internal error" } }));

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(...LIST_NOT_LOADED));
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(result.current.activeConnection).toBeNull();
    expect(window.location.search).toBe("");
  });

  test("the stored list the editor falls back to obeys the policy too", async () => {
    // The managed list could not be read, so the first selection comes from storage, where the
    // editable copy of an unmanaged seed keeps its `seed:` id and stays openable.
    storage.saveConnection(mine("mine-1"));
    storage.saveConnection({ ...mine("copy"), id: "seed:sandbox", seedId: "sandbox", managed: false });
    window.history.replaceState(null, "", "/?connection=mine-1");
    mockGlobalFetch(refusingRoutes({ status: 404, json: { error: "Not found" } }));

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:sandbox"));
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith(...LIST_NOT_LOADED);
    expect(window.location.search).toBe("");
  });

  test("a session that ended leaves the link in the address bar for the sign-in page to return to, and says nothing", async () => {
    // appFetch hands the session-required answer to the page's handler, which sends the tab to
    // sign in with this address as the page to come back to, so the link must still be in it.
    window.history.replaceState(null, "", "/?connection=seed%3Abilling");
    const ended = mock(() => {});
    const stopListening = onSessionEnded(ended);
    const replace = spyOn(window.history, "replaceState");
    try {
      mockGlobalFetch(routes({ status: 401, json: { error: "Authentication required", code: "AUTH_REQUIRED" } }));

      const { result } = renderHook(() => useConnectionManager(true));

      await waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
      await sleep(50);
      expect(replace).not.toHaveBeenCalled();
      expect(window.location.search).toBe("?connection=seed%3Abilling");
      expect(mockToastError).not.toHaveBeenCalled();
      expect(result.current.activeConnection).toBeNull();
    } finally {
      replace.mockRestore();
      stopListening();
    }
  });

  test("React's development double effect still opens the linked connection", async () => {
    // StrictMode mounts, unmounts and mounts again, as development does. The first mount is
    // cancelled while it reads the policy, before it reaches the managed list or the link, so the
    // link is left for the second mount.
    window.history.replaceState(null, "", "/?connection=seed%3Abilling");
    const replace = spyOn(window.history, "replaceState");
    try {
      const fetchMock = mockGlobalFetch(routes(answer([seed("orders"), seed("billing")])));

      const { result } = renderHook(() => useConnectionManager(true), { wrapper: StrictMode });

      await waitFor(() => expect(result.current.activeConnection?.id).toBe("seed:billing"));
      expect(managedCalls(fetchMock)).toBe(1);
      expect(replace).toHaveBeenCalledTimes(1);
      expect(mockToastError).not.toHaveBeenCalled();
    } finally {
      replace.mockRestore();
    }
  });

  test("a load unmounted while its managed request is in flight takes nothing when that request throws", async () => {
    // Without the guard, the load would fall back to the stored list after the unmount, take the
    // link out of the address bar and toast about it on a page the hook no longer serves.
    window.history.replaceState(null, "", "/?connection=seed%3Abilling");
    let failRequest: (reason: Error) => void = () => {};
    const fetchMock = mockGlobalFetch(
      routes(
        () =>
          new Promise<MockFetchResponse>((_resolve, reject) => {
            failRequest = reject;
          }),
      ),
    );
    const replace = spyOn(window.history, "replaceState");
    try {
      const { unmount } = renderHook(() => useConnectionManager(true));
      await waitFor(() => expect(managedCalls(fetchMock)).toBe(1));

      unmount();
      failRequest(new TypeError("Failed to fetch"));
      // A timer runs only once every microtask the rejection queued has run, so the load has settled.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(replace).not.toHaveBeenCalled();
      expect(window.location.search).toBe("?connection=seed%3Abilling");
      expect(mockToastError).not.toHaveBeenCalled();
    } finally {
      replace.mockRestore();
    }
  });
});
