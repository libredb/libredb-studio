import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { readOidcAutoRedirect, resetOidcAutoRedirectWarning } from "@/lib/config/oidc-auto-redirect";

describe("config/oidc-auto-redirect readOidcAutoRedirect", () => {
  const original = process.env.OIDC_AUTO_REDIRECT;

  afterEach(() => {
    if (original === undefined) delete process.env.OIDC_AUTO_REDIRECT;
    else process.env.OIDC_AUTO_REDIRECT = original;
    resetOidcAutoRedirectWarning();
  });

  test("unset or empty leaves it off", () => {
    delete process.env.OIDC_AUTO_REDIRECT;
    expect(readOidcAutoRedirect()).toBe(false);
    process.env.OIDC_AUTO_REDIRECT = "  ";
    expect(readOidcAutoRedirect()).toBe(false);
  });

  for (const value of ["true", "1", "on", "yes", " TRUE ", "Yes", "ON"]) {
    test(`"${value}" turns it on`, () => {
      process.env.OIDC_AUTO_REDIRECT = value;
      expect(readOidcAutoRedirect()).toBe(true);
    });
  }

  test("false, 0, off and no leave it off without a warning", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const value of ["false", "0", "off", "no", " NO "]) {
        process.env.OIDC_AUTO_REDIRECT = value;
        expect(readOidcAutoRedirect()).toBe(false);
      }
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("an unrecognised value stays off and warns once", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.OIDC_AUTO_REDIRECT = "sure";
      expect(readOidcAutoRedirect()).toBe(false);
      expect(readOidcAutoRedirect()).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('Unrecognized OIDC_AUTO_REDIRECT value "sure"');
    } finally {
      warnSpy.mockRestore();
    }
  });

  // src/proxy.ts imports this module, and the proxy must not pull the OIDC client library in.
  test("imports nothing from openid-client", () => {
    const source = readFileSync("src/lib/config/oidc-auto-redirect.ts", "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual(["@/lib/logger"]);
  });
});
