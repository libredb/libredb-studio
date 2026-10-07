import { describe, test, expect, beforeEach, afterEach } from "bun:test";

if (typeof globalThis.window === "undefined") {
  // @ts-expect-error: minimal window stub
  globalThis.window = globalThis;
}

import { mockGlobalFetch, restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { registerWorkspaceSync, releaseAccountWorkspace } from "@/lib/storage/sign-out";
import { SERVER_MIGRATED_KEY, UNSAVED_COLLECTIONS_KEY, WORKSPACE_OWNER_KEY } from "@/lib/storage/local-storage";

const CONNECTIONS = JSON.stringify([{ id: "c1", password: "pw" }]);

/** GET /api/auth/me after the sign-out: the session goes on (200) or has ended (401). */
type Session = "alive" | "ended";

function serverMode(serverModeOn: boolean, session: Session = "alive") {
  return mockGlobalFetch({
    "/api/storage/config": {
      ok: true,
      status: 200,
      json: { provider: serverModeOn ? "postgres" : "local", serverMode: serverModeOn },
    },
    "/api/auth/me":
      session === "alive"
        ? { json: { authenticated: true, user: { username: "admin@libredb.org" } } }
        : { status: 401, json: { authenticated: false } },
  });
}

/** The POST /api/auth/logout stand-in: records what the copy held when the session ended. */
function signOutAnswering(status: number, seen: (string | null)[] = []) {
  return async () => {
    seen.push(localStorage.getItem("libredb_connections"));
    return new Response(JSON.stringify({ success: status === 200 }), { status });
  };
}

async function networkDown(): Promise<Response> {
  throw new Error("network down");
}

/** A mounted sync whose flush rejects, as one does when a pending collection did not land. */
function failingSync() {
  const calls = { resumed: 0 };
  const unregister = registerWorkspaceSync({
    flush: async () => {
      throw new Error("Unsaved changes could not be saved");
    },
    resume: () => (calls.resumed += 1),
  });
  return { calls, unregister };
}

describe("releaseAccountWorkspace", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("libredb_connections", CONNECTIONS);
    localStorage.setItem(WORKSPACE_OWNER_KEY, "admin@libredb.org");
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  test("server mode: pushes what is pending, ends the session, then clears this browser's copy", async () => {
    serverMode(true);
    const order: string[] = [];
    const unregister = registerWorkspaceSync({
      flush: async () => {
        order.push(`flush:${localStorage.getItem("libredb_connections")}`);
      },
      resume: () => order.push("resume"),
    });

    const result = await releaseAccountWorkspace(async () => {
      order.push(`sign-out:${localStorage.getItem("libredb_connections")}`);
      return new Response("{}", { status: 200 });
    });
    unregister();

    expect(result.signedOut).toBe(true);
    expect(result.changesKept).toBe(false);
    expect(result.response?.ok).toBe(true);
    expect(order).toEqual([`flush:${CONNECTIONS}`, `sign-out:${CONNECTIONS}`]);
    expect(localStorage.getItem("libredb_connections")).toBeNull();
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBeNull();
    // Marked, so whatever is written to the emptied copy later is never taken for local-mode data.
    expect(localStorage.getItem(SERVER_MIGRATED_KEY)).not.toBeNull();
  });

  test("server mode with no sync mounted: ends the session, then clears this browser's copy", async () => {
    serverMode(true);
    const seen: (string | null)[] = [];
    const result = await releaseAccountWorkspace(signOutAnswering(200, seen));
    expect(result.signedOut).toBe(true);
    expect(seen).toEqual([CONNECTIONS]);
    expect(localStorage.getItem("libredb_connections")).toBeNull();
  });

  test("server mode with no sync mounted: changes an earlier sign-out kept stay with the copy", async () => {
    // An editor sign-out could not push them, and this page (the admin dashboard) has no sync to push
    // them now: clearing the copy here would lose what that sign-out promised to keep.
    serverMode(true);
    localStorage.setItem(UNSAVED_COLLECTIONS_KEY, JSON.stringify(["connections"]));

    const result = await releaseAccountWorkspace(signOutAnswering(200));

    expect(result).toMatchObject({ signedOut: true, changesKept: true });
    expect(localStorage.getItem("libredb_connections")).toBe(CONNECTIONS);
    expect(localStorage.getItem(UNSAVED_COLLECTIONS_KEY)).toBe(JSON.stringify(["connections"]));
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBe("admin@libredb.org");
  });

  test("server mode: a push that did not land because the session had ended clears the copy", async () => {
    serverMode(true, "ended");
    const seen: (string | null)[] = [];
    const { calls, unregister } = failingSync();

    const result = await releaseAccountWorkspace(signOutAnswering(200, seen));
    unregister();

    expect(result).toEqual({ signedOut: true, response: null, changesKept: false });
    expect(seen).toEqual([]);
    expect(calls.resumed).toBe(0);
    expect(localStorage.getItem("libredb_connections")).toBeNull();
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBeNull();
  });

  test("server mode: a push that did not land otherwise still ends the session and keeps the copy for this account", async () => {
    serverMode(true);
    const seen: (string | null)[] = [];
    const { calls, unregister } = failingSync();

    const result = await releaseAccountWorkspace(signOutAnswering(200, seen));
    unregister();

    expect(result.signedOut).toBe(true);
    expect(result.changesKept).toBe(true);
    expect(seen).toEqual([CONNECTIONS]);
    expect(calls.resumed).toBe(0);
    expect(localStorage.getItem("libredb_connections")).toBe(CONNECTIONS);
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBe("admin@libredb.org");
  });

  test("server mode: a push that did not land, then a sign-out refused while the session goes on, resumes", async () => {
    serverMode(true);
    const { calls, unregister } = failingSync();

    const result = await releaseAccountWorkspace(signOutAnswering(500));
    unregister();

    expect(result).toEqual({ signedOut: false, response: null, changesKept: false });
    expect(calls.resumed).toBe(1);
    expect(localStorage.getItem("libredb_connections")).toBe(CONNECTIONS);
  });

  test("server mode: a push that did not land, then a sign-out that ended the session anyway, keeps the copy", async () => {
    serverMode(true, "alive");
    const { unregister } = failingSync();
    const result = await releaseAccountWorkspace(async () => {
      // The answer is lost after the server ended the session.
      serverMode(true, "ended");
      throw new Error("connection reset");
    });
    unregister();

    expect(result).toEqual({ signedOut: true, response: null, changesKept: true });
    expect(localStorage.getItem("libredb_connections")).toBe(CONNECTIONS);
  });

  test("server mode: a sign-out the server refused while the session goes on keeps the copy and resumes the sync", async () => {
    serverMode(true);
    let resumed = 0;
    const unregister = registerWorkspaceSync({ flush: async () => {}, resume: () => (resumed += 1) });

    const result = await releaseAccountWorkspace(signOutAnswering(500));
    unregister();

    expect(result.signedOut).toBe(false);
    expect(resumed).toBe(1);
    expect(localStorage.getItem("libredb_connections")).toBe(CONNECTIONS);
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBe("admin@libredb.org");
  });

  test("server mode: a sign-out request that fails while the session goes on keeps the copy and resumes the sync", async () => {
    serverMode(true);
    let resumed = 0;
    const unregister = registerWorkspaceSync({ flush: async () => {}, resume: () => (resumed += 1) });

    const result = await releaseAccountWorkspace(networkDown);
    unregister();

    expect(result.signedOut).toBe(false);
    expect(resumed).toBe(1);
    expect(localStorage.getItem("libredb_connections")).toBe(CONNECTIONS);
  });

  test("server mode: a refused or failed sign-out after which no session is left clears the copy", async () => {
    serverMode(true, "ended");
    let resumed = 0;
    const unregister = registerWorkspaceSync({ flush: async () => {}, resume: () => (resumed += 1) });

    const refused = await releaseAccountWorkspace(signOutAnswering(500));
    expect(refused).toEqual({ signedOut: true, response: null, changesKept: false });
    expect(localStorage.getItem("libredb_connections")).toBeNull();

    localStorage.setItem("libredb_connections", CONNECTIONS);
    localStorage.setItem(WORKSPACE_OWNER_KEY, "admin@libredb.org");
    const failed = await releaseAccountWorkspace(networkDown);
    unregister();

    expect(failed.signedOut).toBe(true);
    expect(resumed).toBe(0);
    expect(localStorage.getItem("libredb_connections")).toBeNull();
  });

  test("server mode with no sync mounted: a refused sign-out keeps the copy", async () => {
    serverMode(true);
    expect((await releaseAccountWorkspace(signOutAnswering(500))).signedOut).toBe(false);
    expect((await releaseAccountWorkspace(networkDown)).signedOut).toBe(false);
    expect(localStorage.getItem("libredb_connections")).toBe(CONNECTIONS);
  });

  test("local mode: the session ends, nothing is pushed and nothing is cleared", async () => {
    serverMode(false);
    let pushed = false;
    const seen: (string | null)[] = [];
    const unregister = registerWorkspaceSync({
      flush: async () => {
        pushed = true;
      },
      resume: () => {},
    });

    const result = await releaseAccountWorkspace(signOutAnswering(200, seen));
    unregister();

    expect(result.signedOut).toBe(true);
    expect(pushed).toBe(false);
    expect(seen).toEqual([CONNECTIONS]);
    expect(localStorage.getItem("libredb_connections")).toBe(CONNECTIONS);
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBe("admin@libredb.org");
    expect(localStorage.getItem(SERVER_MIGRATED_KEY)).toBeNull();
  });

  test("local mode: a refused sign-out says so while the session goes on, and clears nothing when it has ended", async () => {
    serverMode(false);
    expect((await releaseAccountWorkspace(signOutAnswering(500))).signedOut).toBe(false);

    serverMode(false, "ended");
    expect((await releaseAccountWorkspace(signOutAnswering(500))).signedOut).toBe(true);
    expect(localStorage.getItem("libredb_connections")).toBe(CONNECTIONS);
    expect(localStorage.getItem(SERVER_MIGRATED_KEY)).toBeNull();
  });

  test("an unreadable storage mode fails the sign-out and clears nothing for a copy bound to a server account", async () => {
    mockGlobalFetch({ "/api/storage/config": { ok: false, status: 500, json: { error: "down" } } });
    const seen: (string | null)[] = [];

    await expect(releaseAccountWorkspace(signOutAnswering(200, seen))).rejects.toThrow("HTTP 500");
    expect(seen).toEqual([]);
    expect(localStorage.getItem("libredb_connections")).toBe(CONNECTIONS);
  });

  test("an unreadable storage mode counts as local mode for a copy never bound to a server account", async () => {
    localStorage.removeItem(WORKSPACE_OWNER_KEY);
    mockGlobalFetch({ "/api/storage/config": { ok: false, status: 500, json: { error: "down" } } });
    const seen: (string | null)[] = [];

    const result = await releaseAccountWorkspace(signOutAnswering(200, seen));

    expect(result.signedOut).toBe(true);
    expect(seen).toEqual([CONNECTIONS]);
    expect(localStorage.getItem("libredb_connections")).toBe(CONNECTIONS);
    expect(localStorage.getItem(SERVER_MIGRATED_KEY)).toBeNull();
  });

  test("unregistering a sync that was replaced leaves the newer one in place", async () => {
    serverMode(true);
    let newer = 0;
    const unregisterOlder = registerWorkspaceSync({ flush: async () => {}, resume: () => {} });
    const unregisterNewer = registerWorkspaceSync({
      flush: async () => {
        newer += 1;
      },
      resume: () => {},
    });
    unregisterOlder();

    await releaseAccountWorkspace(signOutAnswering(200));
    unregisterNewer();

    expect(newer).toBe(1);
  });
});
