import { withBasePathEnv } from "../helpers/base-path";
import "../setup-dom";
import { mockToastSuccess, mockToastError } from "../helpers/mock-sonner";
import { mockRouterPush, mockRouterRefresh } from "../helpers/mock-navigation";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";

import { useAuth } from "@/hooks/use-auth";
import { registerWorkspaceSync } from "@/lib/storage/sign-out";

// =============================================================================
// useAuth Tests
// =============================================================================
describe("useAuth", () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
    mockRouterRefresh.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  // ── Initial State ─────────────────────────────────────────────────────────

  test("initially user is null and isAdmin is false", () => {
    mockGlobalFetch({
      "/api/auth/me": { ok: true, json: { user: null } },
    });

    const { result } = renderHook(() => useAuth());

    expect(result.current.user).toBeNull();
    expect(result.current.isAdmin).toBe(false);
  });

  // ── Fetch User on Mount ───────────────────────────────────────────────────

  test("after mount fetches /api/auth/me and sets user", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/auth/me": { ok: true, json: { user: { role: "user" } } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).toEqual({ role: "user" });
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/me");
  });

  // ── isAdmin Derived State ─────────────────────────────────────────────────

  test("isAdmin is true when user role is admin", async () => {
    mockGlobalFetch({
      "/api/auth/me": { ok: true, json: { user: { role: "admin" } } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.isAdmin).toBe(true);
    });

    expect(result.current.user?.role).toBe("admin");
  });

  test("isAdmin is false when user role is user", async () => {
    mockGlobalFetch({
      "/api/auth/me": { ok: true, json: { user: { role: "user" } } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    expect(result.current.isAdmin).toBe(false);
  });

  // ── handleLogout ──────────────────────────────────────────────────────────

  test("handleLogout calls /api/auth/logout with POST method", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/auth/me": { ok: true, json: { user: { role: "user" } } },
      "/api/storage/config": { ok: true, json: { provider: "local", serverMode: false } },
      "/api/auth/logout": { ok: true, json: { success: true } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    await act(async () => {
      await result.current.handleLogout();
    });

    // Find the logout call among all fetch calls
    const logoutCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/auth/logout"),
    );
    expect(logoutCall).toBeDefined();
    expect(logoutCall![1]).toEqual({ method: "POST" });
  });

  test('handleLogout calls router.push("/login") and router.refresh()', async () => {
    mockGlobalFetch({
      "/api/auth/me": { ok: true, json: { user: { role: "user" } } },
      "/api/storage/config": { ok: true, json: { provider: "local", serverMode: false } },
      "/api/auth/logout": { ok: true, json: { success: true } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(mockRouterPush).toHaveBeenCalledWith("/login");
    expect(mockRouterRefresh).toHaveBeenCalled();
  });

  test("handleLogout shows success toast on success", async () => {
    mockGlobalFetch({
      "/api/auth/me": { ok: true, json: { user: { role: "user" } } },
      "/api/storage/config": { ok: true, json: { provider: "local", serverMode: false } },
      "/api/auth/logout": { ok: true, json: { success: true } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    await act(async () => {
      await result.current.handleLogout();
    });

    // useToast wraps sonnerToast.success for non-destructive variant
    expect(mockToastSuccess).toHaveBeenCalledWith("Logged out", {
      description: "You have been successfully logged out.",
    });
  });

  test("handleLogout shows destructive toast on error", async () => {
    mockGlobalFetch({
      "/api/auth/me": { ok: true, json: { user: { role: "user" } } },
      "/api/storage/config": { ok: true, json: { provider: "local", serverMode: false } },
    });

    // Override fetch so logout throws a network error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/auth/logout")) {
        throw new Error("Network error");
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    await act(async () => {
      await result.current.handleLogout();
    });

    // useToast wraps sonnerToast.error for destructive variant
    expect(mockToastError).toHaveBeenCalledWith("Error", { description: "Failed to logout." });
  });

  // ── /api/auth/me non-ok response ───────────────────────────────────────────

  test("/api/auth/me answers 401 → user stays null and the page goes to the login screen", async () => {
    // A session the server has ended (a disabled, deleted or demoted stored account) still has a
    // cookie that verifies in the proxy, so only the client can take the tab to the login screen.
    mockGlobalFetch({
      "/api/auth/me": { ok: false, status: 401, json: { error: "Unauthorized" } },
    });

    const { result } = renderHook(() => useAuth());

    // With the page it was on as the return path (#1420).
    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith("/login?next=%2F"));
    expect(result.current.user).toBeNull();
    expect(result.current.isAdmin).toBe(false);
  });

  test("/api/auth/me answers another failure → user stays null and the page stays", async () => {
    mockGlobalFetch({
      "/api/auth/me": { ok: false, status: 500, json: { error: "Server error" } },
    });

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(result.current.user).toBeNull();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  // ── /api/auth/me throws network error ──────────────────────────────────────

  test("/api/auth/me throws network error → user stays null, no crash", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/auth/me")) {
        throw new Error("Network error");
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }) as typeof fetch;

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(result.current.user).toBeNull();
    expect(result.current.isAdmin).toBe(false);

    globalThis.fetch = originalFetch;
  });

  // ── User with no role property → isAdmin=false ─────────────────────────────

  test("user with no role property → isAdmin=false", async () => {
    mockGlobalFetch({
      "/api/auth/me": { ok: true, json: { user: { name: "john" } } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    expect(result.current.isAdmin).toBe(false);
  });

  // ── User with role='' → isAdmin=false ──────────────────────────────────────

  test('user with role="" → isAdmin=false', async () => {
    mockGlobalFetch({
      "/api/auth/me": { ok: true, json: { user: { role: "" } } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    expect(result.current.isAdmin).toBe(false);
  });

  // ── User with role='viewer' → isAdmin=false ────────────────────────────────

  test('user with role="viewer" → isAdmin=false', async () => {
    mockGlobalFetch({
      "/api/auth/me": { ok: true, json: { user: { role: "viewer" } } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    expect(result.current.isAdmin).toBe(false);
  });

  // ── handleLogout function is stable ────────────────────────────────────────

  test("handleLogout can be called before user fetch completes", async () => {
    // Slow fetch for /me, fast for logout
    let resolveMe: ((value: Response) => void) | undefined;
    const mePromise = new Promise<Response>((resolve) => {
      resolveMe = resolve;
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/auth/me")) return mePromise;
      if (url.includes("/api/storage/config")) {
        return new Response(JSON.stringify({ provider: "local", serverMode: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/auth/logout")) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const { result } = renderHook(() => useAuth());

    // Logout before me resolves
    await act(async () => {
      await result.current.handleLogout();
    });

    expect(mockRouterPush).toHaveBeenCalledWith("/login");

    // Now resolve me
    resolveMe!(
      new Response(JSON.stringify({ user: { role: "user" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });

  // ── handleLogout with OIDC redirect ──────────────────────────────────────

  test("handleLogout redirects to OIDC logout URL when present", async () => {
    // Mock window.location to prevent navigation side effects
    const savedDescriptor = Object.getOwnPropertyDescriptor(window, "location");
    const locationMock = { href: "" };
    Object.defineProperty(window, "location", {
      value: locationMock,
      writable: true,
      configurable: true,
    });

    mockGlobalFetch({
      "/api/auth/me": { ok: true, json: { user: { role: "user" } } },
      "/api/storage/config": { ok: true, json: { provider: "local", serverMode: false } },
      "/api/auth/logout": {
        ok: true,
        json: { success: true, redirectUrl: "https://auth0.com/v2/logout?client_id=abc" },
      },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    await act(async () => {
      await result.current.handleLogout();
    });

    // redirectUrl branch: window.location.href should be set, router.push should NOT
    expect(locationMock.href).toBe("https://auth0.com/v2/logout?client_id=abc");
    expect(mockRouterPush).not.toHaveBeenCalledWith("/login");

    // Restore window.location
    if (savedDescriptor) {
      Object.defineProperty(window, "location", savedDescriptor);
    }
  });

  // ── Logout with non-ok response still navigates ───────────────────────────

  test("handleLogout says a refused sign-out did not complete and stays on the page", async () => {
    mockGlobalFetch({
      "/api/auth/me": { ok: true, json: { user: { role: "user" } } },
      "/api/storage/config": { ok: true, json: { provider: "local", serverMode: false } },
      "/api/auth/logout": { ok: false, status: 500, json: { error: "Server error" } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Error", { description: "Failed to logout." });
  });
  test("auth hook sends requests under basePath and leaves Next router navigation logical", async () => {
    await withBasePathEnv("/~/libredb", async () => {
      const fetchMock = mockGlobalFetch({
        "/~/libredb/api/auth/me": { json: { user: { role: "user" } } },
        "/~/libredb/api/auth/logout": { json: { success: true } },
        "/~/libredb/api/storage/config": { json: { provider: "local", serverMode: false } },
      });
      const { result, unmount } = renderHook(() => useAuth());
      try {
        await waitFor(() => expect(result.current.user).toEqual({ role: "user" }));
        expect(fetchMock).toHaveBeenCalledWith("/~/libredb/api/auth/me");
        await act(async () => result.current.handleLogout());
        expect(fetchMock).toHaveBeenCalledWith("/~/libredb/api/auth/logout", { method: "POST" });
        expect(mockRouterPush).toHaveBeenCalledWith("/login");
      } finally {
        unmount();
        restoreGlobalFetch();
      }
    });
  });

  // ── Sign-out and this browser's copy of the workspace ─────────────────────

  describe("sign-out and the browser copy", () => {
    beforeEach(() => {
      localStorage.clear();
      localStorage.setItem("libredb_connections", JSON.stringify([{ id: "c1" }]));
      localStorage.setItem("libredb_workspace_tabs_v1:c1", "[]");
      localStorage.setItem("libredb_workspace_owner", "user@libredb.org");
    });

    afterEach(() => {
      localStorage.clear();
    });

    test("server mode: pending pushes go out, then the session ends, then the copy is cleared", async () => {
      const order: string[] = [];
      mockGlobalFetch({
        "/api/auth/me": { ok: true, json: { user: { role: "user" } } },
        "/api/storage/config": { ok: true, json: { provider: "postgres", serverMode: true } },
        "/api/auth/logout": () => {
          order.push(`logout:${localStorage.getItem("libredb_connections")}`);
          return { ok: true, json: { success: true } };
        },
      });
      const unregister = registerWorkspaceSync({
        flush: async () => {
          order.push(`push:${localStorage.getItem("libredb_connections")}`);
        },
        resume: () => {},
      });

      const { result } = renderHook(() => useAuth());
      await waitFor(() => {
        expect(result.current.user).not.toBeNull();
      });
      await act(async () => {
        await result.current.handleLogout();
      });
      unregister();

      const copy = JSON.stringify([{ id: "c1" }]);
      expect(order).toEqual([`push:${copy}`, `logout:${copy}`]);
      expect(localStorage.getItem("libredb_connections")).toBeNull();
      expect(localStorage.getItem("libredb_workspace_tabs_v1:c1")).toBeNull();
      expect(localStorage.getItem("libredb_workspace_owner")).toBeNull();
      expect(mockRouterPush).toHaveBeenCalledWith("/login");
    });

    test("server mode: a push that does not land ends the session, keeps the copy for this account and says so", async () => {
      const fetchMock = mockGlobalFetch({
        "/api/auth/me": { ok: true, json: { user: { role: "user", username: "user@libredb.org" } } },
        "/api/storage/config": { ok: true, json: { provider: "postgres", serverMode: true } },
        "/api/auth/logout": { ok: true, json: { success: true } },
      });
      const unregister = registerWorkspaceSync({
        flush: async () => {
          throw new Error("Unsaved changes could not be saved to server storage");
        },
        resume: () => {},
      });

      const { result } = renderHook(() => useAuth());
      await waitFor(() => {
        expect(result.current.user).not.toBeNull();
      });
      await act(async () => {
        await result.current.handleLogout();
      });
      unregister();

      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/auth/logout"))).toBe(true);
      expect(localStorage.getItem("libredb_connections")).not.toBeNull();
      expect(localStorage.getItem("libredb_workspace_owner")).toBe("user@libredb.org");
      expect(mockToastSuccess).toHaveBeenCalledWith("Logged out", {
        description:
          "Some changes could not be saved to server storage. They stay in this browser for this account until a different account signs in here.",
      });
      expect(mockRouterPush).toHaveBeenCalledWith("/login");
    });

    test("server mode: a sign-out refused after which no session is left clears the copy and goes to sign in", async () => {
      let signedIn = true;
      mockGlobalFetch({
        "/api/auth/me": () =>
          signedIn
            ? { ok: true, json: { user: { role: "user", username: "user@libredb.org" } } }
            : { ok: false, status: 401, json: { authenticated: false } },
        "/api/storage/config": { ok: true, json: { provider: "postgres", serverMode: true } },
        "/api/auth/logout": () => {
          signedIn = false;
          return { ok: false, status: 500, json: { error: "Server error" } };
        },
      });

      const { result } = renderHook(() => useAuth());
      await waitFor(() => {
        expect(result.current.user).not.toBeNull();
      });
      await act(async () => {
        await result.current.handleLogout();
      });

      expect(localStorage.getItem("libredb_connections")).toBeNull();
      expect(localStorage.getItem("libredb_workspace_owner")).toBeNull();
      expect(mockToastError).not.toHaveBeenCalled();
      expect(mockRouterPush).toHaveBeenCalledWith("/login");
    });

    test("server mode: a sign-out the server refused keeps the copy", async () => {
      mockGlobalFetch({
        "/api/auth/me": { ok: true, json: { user: { role: "user" } } },
        "/api/storage/config": { ok: true, json: { provider: "postgres", serverMode: true } },
        "/api/auth/logout": { ok: false, status: 500, json: { error: "Server error" } },
      });

      const { result } = renderHook(() => useAuth());
      await waitFor(() => {
        expect(result.current.user).not.toBeNull();
      });
      await act(async () => {
        await result.current.handleLogout();
      });

      expect(localStorage.getItem("libredb_connections")).not.toBeNull();
      expect(localStorage.getItem("libredb_workspace_owner")).toBe("user@libredb.org");
    });

    test("local mode: the copy stays", async () => {
      mockGlobalFetch({
        "/api/auth/me": { ok: true, json: { user: { role: "user" } } },
        "/api/storage/config": { ok: true, json: { provider: "local", serverMode: false } },
        "/api/auth/logout": { ok: true, json: { success: true } },
      });

      const { result } = renderHook(() => useAuth());
      await waitFor(() => {
        expect(result.current.user).not.toBeNull();
      });
      await act(async () => {
        await result.current.handleLogout();
      });

      expect(localStorage.getItem("libredb_connections")).not.toBeNull();
      expect(localStorage.getItem("libredb_workspace_tabs_v1:c1")).toBe("[]");
      expect(mockRouterPush).toHaveBeenCalledWith("/login");
    });
  });
});
