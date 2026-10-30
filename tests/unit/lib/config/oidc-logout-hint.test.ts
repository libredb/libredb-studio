import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { withBasePathEnv } from "../../../helpers/base-path";
import {
  OIDC_LOGOUT_HINT_COOKIE,
  fitsLogoutHintCookie,
  oidcLogoutHintCookiePath,
  readOidcLogoutHint,
} from "@/lib/config/oidc-logout-hint";

describe("config/oidc-logout-hint", () => {
  const original = process.env.OIDC_LOGOUT_HINT;

  afterEach(() => {
    if (original === undefined) delete process.env.OIDC_LOGOUT_HINT;
    else process.env.OIDC_LOGOUT_HINT = original;
  });

  test("unset or empty leaves it off", () => {
    delete process.env.OIDC_LOGOUT_HINT;
    expect(readOidcLogoutHint()).toBe(false);
    process.env.OIDC_LOGOUT_HINT = "  ";
    expect(readOidcLogoutHint()).toBe(false);
  });

  for (const value of ["true", "1", "on", "yes", " TRUE ", "Yes", "ON"]) {
    test(`"${value}" turns it on`, () => {
      process.env.OIDC_LOGOUT_HINT = value;
      expect(readOidcLogoutHint()).toBe(true);
    });
  }

  test("false, 0, off and no leave it off without a warning", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const value of ["false", "0", "off", "no", " NO "]) {
        process.env.OIDC_LOGOUT_HINT = value;
        expect(readOidcLogoutHint()).toBe(false);
      }
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("an unrecognised value stays off and warns", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.OIDC_LOGOUT_HINT = "sure";
      expect(readOidcLogoutHint()).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('Unrecognized OIDC_LOGOUT_HINT value "sure"');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("the cookie is named oidc-logout-hint and scoped to the logout route under the build's prefix", async () => {
    expect(OIDC_LOGOUT_HINT_COOKIE).toBe("oidc-logout-hint");
    expect(oidcLogoutHintCookiePath()).toBe("/api/auth/logout");
    await withBasePathEnv("/tools/libredb", () => {
      expect(oidcLogoutHintCookiePath()).toBe("/tools/libredb/api/auth/logout");
    });
  });

  test("a token fits the cookie up to 3800 bytes, counted in UTF-8", () => {
    expect(fitsLogoutHintCookie("a".repeat(3800), OIDC_LOGOUT_HINT_COOKIE)).toBe(true);
    expect(fitsLogoutHintCookie("a".repeat(3801), OIDC_LOGOUT_HINT_COOKIE)).toBe(false);
    // 1900 two-byte characters are 3800 bytes; one more is over.
    expect(fitsLogoutHintCookie("é".repeat(1900), OIDC_LOGOUT_HINT_COOKIE)).toBe(true);
    expect(fitsLogoutHintCookie("é".repeat(1901), OIDC_LOGOUT_HINT_COOKIE)).toBe(false);
  });

  // A browser drops a cookie whose name and value together exceed 4096 bytes, so a long __Host- name under a base
  // path counts against the token.
  test("the cookie's name counts: name and value stay within 4096 bytes", () => {
    const longName = `__Host-oidc-logout-hint.${"s".repeat(273)}`;
    expect(longName.length).toBe(297);
    expect(fitsLogoutHintCookie("a".repeat(3800), longName)).toBe(false);
    expect(fitsLogoutHintCookie("a".repeat(3799), longName)).toBe(true);
    expect(fitsLogoutHintCookie("a".repeat(3800), "__Host-oidc-logout-hint.tools.libredb")).toBe(true);
  });
});
