import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuthConfigError } from "@/lib/auth-errors";
import { authProvider, authProviderSetting, authProviderValue } from "@/lib/config/auth-provider";

const INVALID_MESSAGE = "NEXT_PUBLIC_AUTH_PROVIDER must be local, oidc or openshift, or unset for local";

describe("config/auth-provider", () => {
  const original = process.env.NEXT_PUBLIC_AUTH_PROVIDER;

  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
    else process.env.NEXT_PUBLIC_AUTH_PROVIDER = original;
  });

  function setMode(value: string | undefined): void {
    if (value === undefined) delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
    else process.env.NEXT_PUBLIC_AUTH_PROVIDER = value;
  }

  test("unset, empty and whitespace read as local", () => {
    for (const value of [undefined, "", "  "]) {
      setMode(value);
      expect(authProviderSetting()).toBe("local");
      expect(authProvider()).toBe("local");
    }
  });

  test("local, oidc and openshift are read trimmed", () => {
    for (const [value, expected] of [
      ["local", "local"],
      [" oidc", "oidc"],
      [" openshift ", "openshift"],
    ] as const) {
      setMode(value);
      expect(authProviderSetting()).toBe(expected);
      expect(authProvider()).toBe(expected);
    }
  });

  test("the value is case-sensitive: OpenShift is invalid", () => {
    setMode("OpenShift");
    expect(authProviderSetting()).toBe("invalid");
    expect(() => authProvider()).toThrow(INVALID_MESSAGE);
    expect(() => authProvider()).toThrow(AuthConfigError);
  });

  test("an unknown value is invalid and the message never quotes it", () => {
    setMode("oauth2");
    expect(authProviderSetting()).toBe("invalid");
    let message = "";
    try {
      authProvider();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(INVALID_MESSAGE);
    expect(message).not.toContain("oauth2");
  });

  test("the value is read on every call", () => {
    setMode("oidc");
    expect(authProviderSetting()).toBe("oidc");
    setMode("openshift");
    expect(authProviderSetting()).toBe("openshift");
    expect(authProvider()).toBe("openshift");
  });

  test("authProviderValue returns the raw value", () => {
    setMode(" Foo ");
    expect(authProviderValue()).toBe(" Foo ");
    setMode(undefined);
    expect(authProviderValue()).toBeUndefined();
  });

  test("the module imports no Node built-in and no openid-client", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/config/auth-provider.ts"), "utf8");
    expect(source).not.toContain('from "node:');
    expect(source).not.toContain('from "openid-client"');
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    expect(imports).toEqual(['import { AuthConfigError } from "@/lib/auth-errors";']);
  });
});
