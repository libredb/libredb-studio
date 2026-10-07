import { describe, test, expect, beforeEach, afterEach } from "bun:test";

if (typeof globalThis.window === "undefined") {
  // @ts-expect-error — minimal window stub
  globalThis.window = globalThis;
}

import { mockGlobalFetch, restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { registerPendingPush, releaseAccountWorkspace } from "@/lib/storage/sign-out";
import { WORKSPACE_OWNER_KEY } from "@/lib/storage/local-storage";

function serverMode(serverModeOn: boolean) {
  return mockGlobalFetch({
    "/api/storage/config": {
      ok: true,
      status: 200,
      json: { provider: serverModeOn ? "postgres" : "local", serverMode: serverModeOn },
    },
  });
}

describe("releaseAccountWorkspace", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("libredb_connections", JSON.stringify([{ id: "c1", password: "pw" }]));
    localStorage.setItem(WORKSPACE_OWNER_KEY, "admin@libredb.org");
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  test("server mode: pushes the pending collections first, then clears this browser's copy", async () => {
    serverMode(true);
    const seen: (string | null)[] = [];
    const unregister = registerPendingPush(async () => {
      seen.push(localStorage.getItem("libredb_connections"));
    });

    await releaseAccountWorkspace();
    unregister();

    expect(seen).toEqual([JSON.stringify([{ id: "c1", password: "pw" }])]);
    expect(localStorage.getItem("libredb_connections")).toBeNull();
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBeNull();
  });

  test("server mode with no sync mounted: clears this browser's copy", async () => {
    serverMode(true);
    await releaseAccountWorkspace();
    expect(localStorage.getItem("libredb_connections")).toBeNull();
  });

  test("server mode: a push that does not land keeps the copy and fails the sign-out", async () => {
    serverMode(true);
    const unregister = registerPendingPush(async () => {
      throw new Error("Unsaved changes could not be saved");
    });

    await expect(releaseAccountWorkspace()).rejects.toThrow("Unsaved changes could not be saved");
    unregister();

    expect(localStorage.getItem("libredb_connections")).not.toBeNull();
  });

  test("local mode: nothing is pushed and nothing is cleared", async () => {
    serverMode(false);
    let pushed = false;
    const unregister = registerPendingPush(async () => {
      pushed = true;
    });

    await releaseAccountWorkspace();
    unregister();

    expect(pushed).toBe(false);
    expect(localStorage.getItem("libredb_connections")).not.toBeNull();
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBe("admin@libredb.org");
  });

  test("an unreadable storage mode fails the sign-out and clears nothing", async () => {
    mockGlobalFetch({ "/api/storage/config": { ok: false, status: 500, json: { error: "down" } } });

    await expect(releaseAccountWorkspace()).rejects.toThrow("HTTP 500");
    expect(localStorage.getItem("libredb_connections")).not.toBeNull();
  });

  test("unregistering a push that was replaced leaves the newer one in place", async () => {
    serverMode(true);
    let newer = 0;
    const unregisterOlder = registerPendingPush(async () => {});
    const unregisterNewer = registerPendingPush(async () => {
      newer += 1;
    });
    unregisterOlder();

    await releaseAccountWorkspace();
    unregisterNewer();

    expect(newer).toBe(1);
  });
});
