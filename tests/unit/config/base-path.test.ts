import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  readBasePath,
  getBasePath,
  withBasePath,
  appFetch,
  currentAppPath,
  onSessionEnded,
  reportSessionEnded,
  heldWorkspaceOwner,
  holdWorkspaceOwner,
  WORKSPACE_OWNER_HEADER,
} from "@/lib/config/base-path";
import { sessionRequiredBody } from "@/lib/api/session-ended";

const originalBase = process.env.NEXT_PUBLIC_BASE_PATH;
const originalFetch = globalThis.fetch;
afterEach(() => {
  if (originalBase === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH;
  else process.env.NEXT_PUBLIC_BASE_PATH = originalBase;
  globalThis.fetch = originalFetch;
});

describe("build-time base path", () => {
  test("root stays the default", () => {
    expect(readBasePath()).toBe("");
    expect(readBasePath("")).toBe("");
    expect(readBasePath("/")).toBe("");
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    expect(getBasePath()).toBe("");
    expect(withBasePath("/api/db/query")).toBe("/api/db/query");
  });

  for (const prefix of ["/libredb", "/tools/libredb", "/~/libredb", "/v1.2/studio-beta"]) {
    test(`preserves ${prefix} on APIs, assets, and browser redirects`, () => {
      expect(readBasePath(prefix)).toBe(prefix);
      process.env.NEXT_PUBLIC_BASE_PATH = prefix;
      expect(getBasePath()).toBe(prefix);
      expect(withBasePath("/api/agent/runs/x/stream?after=1")).toBe(`${prefix}/api/agent/runs/x/stream?after=1`);
      expect(withBasePath("/logo.svg?v=3")).toBe(`${prefix}/logo.svg?v=3`);
      expect(withBasePath("/login?error=oidc_failed")).toBe(`${prefix}/login?error=oidc_failed`);
      expect(withBasePath("/")).toBe(`${prefix}/`);
    });
  }

  test("a prefix named api does not mistake the application's API path for an already prefixed path", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/api";
    expect(withBasePath("/api/db/query")).toBe("/api/api/db/query");
  });

  for (const invalid of [
    "libredb",
    "//evil.example",
    "/a//b",
    "/a/",
    "/.",
    "/a/../b",
    "/a/./b",
    "/x?y",
    "/x#y",
    "/%2fadmin",
    "/a\\b",
    "/foo bar",
    "/foo\nbar",
    "/foo\n",
    "/foo\r",
    "/foo\u2028",
    "/foo\u2029",
    "https://host/path",
  ]) {
    test(`rejects ambiguous configuration ${JSON.stringify(invalid)}`, () => {
      expect(() => readBasePath(invalid)).toThrow("BASE_PATH");
    });
  }

  test("leaves explicit remote, relative and protocol-relative URLs alone", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/tools/libredb";
    for (const url of ["https://cdn.example/vs", "//cdn.example/vs", "assets/icon.svg"]) {
      expect(withBasePath(url)).toBe(url);
    }
  });

  test("API requests preserve the original init, abort signal, body and response", async () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/~/libredb";
    const response = new Response("ok");
    const fetchMock = mock(async () => response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const controller = new AbortController();
    const init = { method: "POST", body: "query", signal: controller.signal };
    expect(await appFetch("/api/db/query", init)).toBe(response);
    expect(fetchMock).toHaveBeenCalledWith("/~/libredb/api/db/query", init);
    await appFetch("/api/auth/me");
    expect(fetchMock).toHaveBeenLastCalledWith("/~/libredb/api/auth/me");
  });

  test("a session-required 401 reaches the session-ended handler and the caller still gets the response", async () => {
    const response = new Response(JSON.stringify(sessionRequiredBody("Session expired. Sign in again.")), {
      status: 401,
    });
    globalThis.fetch = mock(async () => response) as unknown as typeof fetch;
    const handler = mock(() => {});
    const unregister = onSessionEnded(handler);
    try {
      expect(await appFetch("/api/db/query", { method: "POST" })).toBe(response);
      expect(handler).toHaveBeenCalledTimes(1);
      expect((await response.json()).code).toBe("AUTH_REQUIRED");
    } finally {
      unregister();
    }
  });
});

describe("currentAppPath", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });
  const at = (pathname: string, search = "") => {
    (globalThis as { window?: unknown }).window = { location: { pathname, search } };
  };

  test("is the path and query at the root", () => {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    at("/admin/audit", "?tab=2");
    expect(currentAppPath()).toBe("/admin/audit?tab=2");
  });

  test("strips the deployment prefix, which the router adds back", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/tools/libredb";
    at("/tools/libredb/admin", "?x=1");
    expect(currentAppPath()).toBe("/admin?x=1");
    at("/tools/libredb");
    expect(currentAppPath()).toBe("/");
  });

  test("leaves a path that only shares the prefix's first characters alone", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/tools/libredb";
    at("/tools/libredb-other");
    expect(currentAppPath()).toBe("/tools/libredb-other");
  });
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Answers the next appFetch with `response` and returns what appFetch handed back. */
async function respondWith(response: Response): Promise<Response> {
  globalThis.fetch = mock(async () => response) as unknown as typeof fetch;
  return appFetch("/api/db/query");
}

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});

describe("appFetch session-ended notice", () => {
  test("calls the registered handler for a session-required 401, leaving the body readable", async () => {
    const handler = mock(() => {});
    unregister = onSessionEnded(handler);
    const response = json(401, sessionRequiredBody("Session expired. Sign in again."));

    await respondWith(response);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({ error: "Session expired. Sign in again.", code: "AUTH_REQUIRED" });
  });

  // A wrong database password and a rejected model key are both 401 too, with the Studio session
  // intact. Sending the user to sign in for either would be wrong.
  for (const body of [
    { error: "password authentication failed", code: "AUTH_ERROR" },
    { error: "Invalid API key. Please check your configuration.", code: "LLM_AUTH" },
    { success: false, message: "Invalid email or password" },
    null,
  ]) {
    test(`ignores a 401 whose body is ${JSON.stringify(body)}`, async () => {
      const handler = mock(() => {});
      unregister = onSessionEnded(handler);
      await respondWith(json(401, body));
      expect(handler).not.toHaveBeenCalled();
    });
  }

  test("ignores a 401 whose body is not JSON", async () => {
    const handler = mock(() => {});
    unregister = onSessionEnded(handler);
    await respondWith(new Response("<!DOCTYPE html>", { status: 401 }));
    expect(handler).not.toHaveBeenCalled();
  });

  test("ignores every other status", async () => {
    const handler = mock(() => {});
    unregister = onSessionEnded(handler);
    await respondWith(json(403, sessionRequiredBody("x")));
    await respondWith(json(200, sessionRequiredBody("x")));
    expect(handler).not.toHaveBeenCalled();
  });

  test("with no handler registered, as in an embedding application, nothing happens", async () => {
    const response = json(401, sessionRequiredBody("Authentication required"));
    await respondWith(response);
    expect(response.bodyUsed).toBe(false);
  });

  test("reportSessionEnded calls the registered handler, and does nothing without one", () => {
    reportSessionEnded();
    const handler = mock(() => {});
    unregister = onSessionEnded(handler);
    reportSessionEnded();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("unregistering removes only the handler it registered", async () => {
    const first = mock(() => {});
    const second = mock(() => {});
    const removeFirst = onSessionEnded(first);
    unregister = onSessionEnded(second);
    removeFirst();

    await respondWith(json(401, sessionRequiredBody("x")));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    unregister();
    unregister = null;
    await respondWith(json(401, sessionRequiredBody("x")));
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("appFetch and the account this tab claimed the browser copy for", () => {
  const originalReload = window.location.reload;
  let reload: ReturnType<typeof mock>;

  afterEach(() => {
    holdWorkspaceOwner(null);
    Object.defineProperty(window.location, "reload", { value: originalReload, configurable: true });
  });

  function sentHeaders(fetchMock: ReturnType<typeof mock>): Headers {
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    return new Headers(init?.headers);
  }

  function answering(response: () => Response) {
    const fetchMock = mock<(input: string, init?: RequestInit) => Promise<Response>>(async () => response());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function watchReload() {
    reload = mock(() => {});
    Object.defineProperty(window.location, "reload", { value: reload, configurable: true });
  }

  test("before a claim no owner header is sent, and the arguments pass through untouched", async () => {
    const fetchMock = answering(() => json(200, {}));
    const init = { method: "PUT", headers: { "Content-Type": "application/json" } };

    await appFetch("/api/storage/connections", init);

    expect(heldWorkspaceOwner()).toBeNull();
    expect(fetchMock.mock.calls[0]).toEqual(["/api/storage/connections", init]);
  });

  test("while a claim is held every app request names the claimed account, keeping the caller's headers", async () => {
    const fetchMock = answering(() => json(200, {}));
    holdWorkspaceOwner("ana@libredb.org");

    await appFetch("/api/storage/connections", { method: "PUT", headers: { "Content-Type": "application/json" } });
    const headers = sentHeaders(fetchMock);
    expect(headers.get(WORKSPACE_OWNER_HEADER)).toBe("ana%40libredb.org");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PUT");

    await appFetch("/api/auth/me");
    expect(sentHeaders(fetchMock).get(WORKSPACE_OWNER_HEADER)).toBe("ana%40libredb.org");
  });

  test("a request that leaves the application never carries it", async () => {
    const fetchMock = answering(() => json(200, {}));
    holdWorkspaceOwner("ana@libredb.org");

    await appFetch("https://example.com/x");
    await appFetch("//example.com/x");

    expect(fetchMock.mock.calls.map((call) => call.length)).toEqual([1, 1]);
  });

  test("an owner mismatch while a claim is held reloads the tab, so the owner check runs again", async () => {
    watchReload();
    holdWorkspaceOwner("ana@libredb.org");
    answering(() => json(409, { error: "x", code: "WORKSPACE_OWNER_MISMATCH" }));

    const response = await appFetch("/api/storage/connections");

    expect(reload).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(409);
    expect(response.bodyUsed).toBe(false);
  });

  test("any other 409, a body that is not JSON, or no claim held does not reload", async () => {
    watchReload();
    holdWorkspaceOwner("ana@libredb.org");
    answering(() => json(409, { error: "conflict", code: "QUERY_ERROR" }));
    await appFetch("/api/storage/connections");
    answering(() => new Response("<html>", { status: 409 }));
    await appFetch("/api/storage/connections");

    holdWorkspaceOwner(null);
    answering(() => json(409, { error: "x", code: "WORKSPACE_OWNER_MISMATCH" }));
    await appFetch("/api/storage/connections");

    expect(reload).not.toHaveBeenCalled();
  });
});

// next.config.ts reads this file, and a config file cannot resolve the alias an import would use:
// an import here fails `next build` before it compiles anything ("Cannot find module").
test("base-path.ts stays import-free, so next.config.ts can load it", () => {
  const source = readFileSync(new URL("../../../src/lib/config/base-path.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/^\s*(import|export\s+[^;]*\sfrom)\s/m);
});
