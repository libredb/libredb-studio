import { describe, test, expect, beforeEach, afterEach } from "bun:test";

if (typeof globalThis.window === "undefined") {
  // @ts-expect-error: minimal window stub
  globalThis.window = globalThis;
}

import { mockGlobalFetch, restoreGlobalFetch } from "../../../helpers/mock-fetch";
import {
  claimWorkspaceForSignedInAccount,
  readSignedInUsername,
  SessionEndedError,
} from "@/lib/storage/workspace-owner";
import { SERVER_MIGRATED_KEY, WORKSPACE_OWNER_KEY } from "@/lib/storage/local-storage";

const SERVER_MODE = { "/api/storage/config": { json: { provider: "postgres", serverMode: true } } };

describe("claimWorkspaceForSignedInAccount", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("libredb_connections", JSON.stringify([{ id: "c1" }]));
    localStorage.setItem(WORKSPACE_OWNER_KEY, "admin@libredb.org");
    localStorage.setItem(SERVER_MIGRATED_KEY, "2026-10-07");
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  test("server mode: a different account's copy is cleared and the signed-in account owns it", async () => {
    mockGlobalFetch({ ...SERVER_MODE, "/api/auth/me": { json: { user: { username: "user@libredb.org" } } } });

    await claimWorkspaceForSignedInAccount();

    expect(localStorage.getItem("libredb_connections")).toBeNull();
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBe("user@libredb.org");
  });

  test("server mode: the same account keeps its copy", async () => {
    mockGlobalFetch({ ...SERVER_MODE, "/api/auth/me": { json: { user: { username: "admin@libredb.org" } } } });

    await claimWorkspaceForSignedInAccount();

    expect(localStorage.getItem("libredb_connections")).not.toBeNull();
  });

  test("server mode: an unreadable signed-in account throws and keeps the copy unclaimed", async () => {
    mockGlobalFetch({ ...SERVER_MODE, "/api/auth/me": { ok: false, status: 503, json: { error: "down" } } });

    await expect(claimWorkspaceForSignedInAccount()).rejects.toThrow("HTTP 503");
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBe("admin@libredb.org");
  });

  test("local mode: nothing changes and the signed-in account is not asked for", async () => {
    const fetchMock = mockGlobalFetch({ "/api/storage/config": { json: { provider: "local", serverMode: false } } });

    await claimWorkspaceForSignedInAccount();

    expect(localStorage.getItem("libredb_connections")).not.toBeNull();
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  test("a storage mode that cannot be read throws for a copy that was bound to a server account", async () => {
    mockGlobalFetch({ "/api/storage/config": { ok: false, status: 500, json: { error: "down" } } });
    await expect(claimWorkspaceForSignedInAccount()).rejects.toThrow("HTTP 500");

    localStorage.removeItem(WORKSPACE_OWNER_KEY);
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(claimWorkspaceForSignedInAccount()).rejects.toThrow("offline");

    localStorage.setItem(WORKSPACE_OWNER_KEY, "admin@libredb.org");
    localStorage.removeItem(SERVER_MIGRATED_KEY);
    await expect(claimWorkspaceForSignedInAccount()).rejects.toThrow("offline");
    expect(localStorage.getItem("libredb_connections")).not.toBeNull();
  });

  test("a storage mode that cannot be read counts as local mode for a copy never bound to a server account", async () => {
    localStorage.removeItem(WORKSPACE_OWNER_KEY);
    localStorage.removeItem(SERVER_MIGRATED_KEY);

    mockGlobalFetch({ "/api/storage/config": { ok: false, status: 500, json: { error: "down" } } });
    await claimWorkspaceForSignedInAccount();
    expect(localStorage.getItem("libredb_connections")).not.toBeNull();

    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await claimWorkspaceForSignedInAccount();
    expect(localStorage.getItem("libredb_connections")).not.toBeNull();
  });
});

describe("readSignedInUsername", () => {
  afterEach(() => {
    restoreGlobalFetch();
  });

  test("answers the username of GET /api/auth/me", async () => {
    mockGlobalFetch({ "/api/auth/me": { json: { user: { username: "user@libredb.org" } } } });
    expect(await readSignedInUsername()).toBe("user@libredb.org");
  });

  test("a 401 throws SessionEndedError: the session has ended", async () => {
    mockGlobalFetch({ "/api/auth/me": { status: 401, json: { authenticated: false } } });
    const failure = await readSignedInUsername().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SessionEndedError);
  });

  test("any other failure is not SessionEndedError", async () => {
    mockGlobalFetch({ "/api/auth/me": { status: 503, json: { error: "down" } } });
    const failure = await readSignedInUsername().catch((err: unknown) => err);
    expect(failure).not.toBeInstanceOf(SessionEndedError);
  });

  test("an answer without a username throws", async () => {
    mockGlobalFetch({ "/api/auth/me": { json: { user: { username: "" } } } });
    await expect(readSignedInUsername()).rejects.toThrow("no username");
  });
});
