import { afterEach, describe, expect, test } from "bun:test";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { claimSignInRedirect, safeReturnPath, sessionRequiredBody, signInPath } from "@/lib/api/session-ended";
import { SESSION_REQUIRED_CODE, WORKSPACE_OWNER_MISMATCH_CODE } from "@/lib/config/base-path";

describe("sessionRequiredBody", () => {
  // base-path.ts writes the code out because next.config.ts reads that file and cannot resolve
  // the alias an import would need. This keeps the browser's copy and the server's code one value.
  test("is the code the browser's appFetch keys on", () => {
    expect(SESSION_REQUIRED_CODE).toBe(ApiErrorCode.AUTH_REQUIRED);
  });

  test("the owner mismatch code appFetch keys on is the server's", () => {
    expect(WORKSPACE_OWNER_MISMATCH_CODE).toBe(ApiErrorCode.WORKSPACE_OWNER_MISMATCH);
  });

  test("names the AUTH_REQUIRED code the browser keys on", () => {
    expect(sessionRequiredBody("Authentication required")).toEqual({
      error: "Authentication required",
      code: "AUTH_REQUIRED",
    });
  });
});

describe("safeReturnPath", () => {
  for (const path of ["/", "/admin", "/admin/audit?tab=2", "/settings/authenticator", "/%2F%2Fevil.example"]) {
    test(`keeps the app-relative path ${path}`, () => {
      expect(safeReturnPath(path)).toBe(path);
    });
  }

  test("returns the resolved form, not the string as written", () => {
    expect(safeReturnPath("/a/../admin?tab=2#top")).toBe("/admin?tab=2#top");
    expect(safeReturnPath("/admin/./audit")).toBe("/admin/audit");
  });

  test("keeps a path of exactly the byte cap", () => {
    const path = `/${"a".repeat(1023)}`;
    expect(safeReturnPath(path)).toBe(path);
  });

  // Each of these either leaves the application or loops back to the sign-in page.
  for (const path of [
    null,
    undefined,
    "",
    "admin",
    "//evil.example",
    "/\\evil.example",
    "https://evil.example/",
    "javascript:alert(1)",
    "/\tevil",
    "/x\ny",
    "/login",
    "/login?next=%2F",
    "/login/",
    "/./login",
    // Written with one leading slash, these RESOLVE to `//evil.example`, another host (#1420 review).
    "/..//evil.example",
    "/.//evil.example",
    "/a/..//evil.example",
    "/%2e%2e//evil.example",
    "/%2E%2E//evil.example",
    "/..\\/evil.example",
    // The byte cap, in bytes not characters: 342 three-byte characters are 1026 bytes.
    `/${"\u20ac".repeat(342)}`,
    `/${"a".repeat(1024)}`,
  ]) {
    test(`drops ${JSON.stringify(path)}`, () => {
      expect(safeReturnPath(path)).toBeNull();
    });
  }
});

describe("signInPath", () => {
  test("carries a safe return path, encoded", () => {
    expect(signInPath("/admin/audit?tab=2")).toBe("/login?next=%2Fadmin%2Faudit%3Ftab%3D2");
  });

  test("drops an unsafe one", () => {
    expect(signInPath("//evil.example")).toBe("/login");
  });
});

describe("claimSignInRedirect", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });
  function withStorage(): Map<string, string> {
    const store = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
    };
    return store;
  }

  // A session the server refuses while its token still verifies is sent from /login straight back
  // by the proxy; the guard stops that from looping.
  test("allows one redirect, refuses another inside ten seconds, allows one after", () => {
    withStorage();
    expect(claimSignInRedirect(100_000)).toBe(true);
    expect(claimSignInRedirect(105_000)).toBe(false);
    expect(claimSignInRedirect(109_999)).toBe(false);
    expect(claimSignInRedirect(110_000)).toBe(true);
  });

  test("a recorded time in the future (a clock moved back) does not block", () => {
    const store = withStorage();
    store.set("libredb.signInRedirectAt", "500000");
    expect(claimSignInRedirect(100_000)).toBe(true);
  });

  test("without usable storage the redirect always goes", () => {
    (globalThis as { window?: unknown }).window = {
      get sessionStorage(): never {
        throw new Error("SecurityError");
      },
    };
    expect(claimSignInRedirect(1)).toBe(true);
    expect(claimSignInRedirect(2)).toBe(true);
  });
});
