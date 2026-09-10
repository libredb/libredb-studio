import { afterEach, describe, expect, mock, test } from "bun:test";
import { readBasePath, getBasePath, withBasePath, appFetch } from "@/lib/config/base-path";

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
      expect(withBasePath("/logo.svg?v=2")).toBe(`${prefix}/logo.svg?v=2`);
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
});
