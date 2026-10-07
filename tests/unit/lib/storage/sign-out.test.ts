import { describe, test, expect, beforeEach, afterEach } from "bun:test";

if (typeof globalThis.window === "undefined") {
  // @ts-expect-error: minimal window stub
  globalThis.window = globalThis;
}

import { mockGlobalFetch, restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { registerWorkspaceSync, releaseAccountWorkspace } from "@/lib/storage/sign-out";
import { SERVER_MIGRATED_KEY, WORKSPACE_OWNER_KEY } from "@/lib/storage/local-storage";

const CONNECTIONS = JSON.stringify([{ id: "c1", password: "pw" }]);

function serverMode(serverModeOn: boolean) {
  return mockGlobalFetch({
    "/api/storage/config": {
      ok: true,
      status: 200,
      json: { provider: serverModeOn ? "postgres" : "local", serverMode: serverModeOn },
    },
  });
}

/** The POST /api/auth/logout stand-in: records what the copy held when the session ended. */
function signOutAnswering(status: number, seen: (string | null)[] = []) {
  return async () => {
    seen.push(localStorage.getItem("libredb_connections"));
    return new Response(JSON.stringify({ success: status === 200 }), { status });
  };
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

    const response = await releaseAccountWorkspace(async () => {
      order.push(`sign-out:${localStorage.getItem("libredb_connections")}`);
      return new Response("{}", { status: 200 });
    });
    unregister();

    expect(response.ok).toBe(true);
    expect(order).toEqual([`flush:${CONNECTIONS}`, `sign-out:${CONNECTIONS}`]);
    expect(localStorage.getItem("libredb_connections")).toBeNull();
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBeNull();
    // Marked, so whatever is written to the emptied copy later is never taken for local-mode data.
    expect(localStorage.getItem(SERVER_MIGRATED_KEY)).not.toBeNull();
  });

  test("server mode with no sync mounted: ends the session, then clears this browser's copy", async () => {
    serverMode(true);
    const seen: (string | null)[] = [];
    await releaseAccountWorkspace(signOutAnswering(200, seen));
    expect(seen).toEqual([CONNECTIONS]);
    expect(localStorage.getItem("libredb_connections")).toBeNull();
  });

  test("server mode: a push that does not land keeps the session and the copy", async () => {
    serverMode(true);
    const seen: (string | null)[] = [];
    const unregister = registerWorkspaceSync({
      flush: async () => {
        throw new Error("Unsaved changes could not be saved");
      },
      resume: () => {},
    });

    await expect(releaseAccountWorkspace(signOutAnswering(200, seen))).rejects.toThrow(
      "Unsaved changes could not be saved",
    );
    unregister();

    expect(seen).toEqual([]);
    expect(localStorage.getItem("libredb_connections")).toBe(CONNECTIONS);
  });

  test("server mode: a sign-out the server refused keeps the copy and resumes the sync", async () => {
    serverMode(true);
    let resumed = 0;
    const unregister = registerWorkspaceSync({ flush: async () => {}, resume: () => (resumed += 1) });

    const response = await releaseAccountWorkspace(signOutAnswering(500));
    unregister();

    expect(response.status).toBe(500);
    expect(resumed).toBe(1);
    expect(localStorage.getItem("libredb_connections")).toBe(CONNECTIONS);
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBe("admin@libredb.org");
  });

  test("server mode: a sign-out request that fails keeps the copy and resumes the sync", async () => {
    serverMode(true);
    let resumed = 0;
    const unregister = registerWorkspaceSync({ flush: async () => {}, resume: () => (resumed += 1) });

    await expect(
      releaseAccountWorkspace(async () => {
        throw new Error("network down");
      }),
    ).rejects.toThrow("network down");
    unregister();

    expect(resumed).toBe(1);
    expect(localStorage.getItem("libredb_connections")).toBe(CONNECTIONS);
  });

  test("server mode with no sync mounted: a refused sign-out keeps the copy", async () => {
    serverMode(true);
    await releaseAccountWorkspace(signOutAnswering(500));
    await expect(
      releaseAccountWorkspace(async () => {
        throw new Error("network down");
      }),
    ).rejects.toThrow("network down");
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

    await releaseAccountWorkspace(signOutAnswering(200, seen));
    unregister();

    expect(pushed).toBe(false);
    expect(seen).toEqual([CONNECTIONS]);
    expect(localStorage.getItem("libredb_connections")).toBe(CONNECTIONS);
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBe("admin@libredb.org");
    expect(localStorage.getItem(SERVER_MIGRATED_KEY)).toBeNull();
  });

  test("an unreadable storage mode fails the sign-out and clears nothing", async () => {
    mockGlobalFetch({ "/api/storage/config": { ok: false, status: 500, json: { error: "down" } } });
    const seen: (string | null)[] = [];

    await expect(releaseAccountWorkspace(signOutAnswering(200, seen))).rejects.toThrow("HTTP 500");
    expect(seen).toEqual([]);
    expect(localStorage.getItem("libredb_connections")).toBe(CONNECTIONS);
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
