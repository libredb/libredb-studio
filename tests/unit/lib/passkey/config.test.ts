import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { logger } from "@/lib/logger";
import {
  type PasskeyAvailability,
  passkeyAvailability,
  passkeyOriginIsSet,
  passkeySignInOffer,
  resetPasskeyConfigWarning,
} from "@/lib/passkey/config";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const VARS = ["PASSKEY_ORIGIN", "STORAGE_PROVIDER", "NEXT_PUBLIC_AUTH_PROVIDER"] as const;
const saved: Record<string, string | undefined> = {};

const PASSKEYS_OIDC = "Passkeys for this sign-in are managed by your identity provider.";
const PASSKEYS_LOCAL =
  "Passkeys need STORAGE_PROVIDER=sqlite or postgres: with STORAGE_PROVIDER=local there is no account registry to keep them in.";
const PASSKEYS_OFF =
  "Passkeys are off on this server. An administrator turns them on by setting PASSKEY_ORIGIN to the address people open Studio at, such as https://studio.example.com.";
const ORIGIN_NOT_URL =
  "PASSKEY_ORIGIN is not an absolute URL: set it to the address people open Studio at, such as https://studio.example.com.";
const ORIGIN_SCHEME =
  "PASSKEY_ORIGIN must use https: browsers offer passkeys only on a secure origin, and plain http works only for http://localhost.";
const ORIGIN_CREDENTIALS = "PASSKEY_ORIGIN must not carry a user name or password.";
const ORIGIN_NOT_ORIGIN =
  "PASSKEY_ORIGIN must be an origin (scheme, host and optional port) with no path, query or fragment; a BASE_PATH prefix does not belong in it.";
const ORIGIN_IP = "PASSKEY_ORIGIN must name the host by a domain name: browsers refuse passkeys on an IP address.";
const ORIGIN_TRAILING_DOT = "PASSKEY_ORIGIN must not end its host name with a dot.";

function withStore(origin: string | undefined): void {
  process.env.STORAGE_PROVIDER = "sqlite";
  if (origin === undefined) delete process.env.PASSKEY_ORIGIN;
  else process.env.PASSKEY_ORIGIN = origin;
}

beforeEach(() => {
  for (const name of VARS) saved[name] = process.env[name];
  for (const name of VARS) delete process.env[name];
  resetPasskeyConfigWarning();
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("passkeyAvailability", () => {
  test("OIDC mode reports that the identity provider manages passkeys", () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    withStore("https://studio.example.com");
    expect(passkeyAvailability()).toEqual({ state: "no-store", mode: "oidc", reason: PASSKEYS_OIDC });
  });

  test("STORAGE_PROVIDER=local reports that passkeys need a server store", () => {
    process.env.PASSKEY_ORIGIN = "https://studio.example.com";
    const expected: PasskeyAvailability = { state: "no-store", mode: "local-storage", reason: PASSKEYS_LOCAL };
    expect(passkeyAvailability()).toEqual(expected);
    process.env.STORAGE_PROVIDER = "local";
    expect(passkeyAvailability()).toEqual(expected);
  });

  test("PASSKEY_ORIGIN unset keeps passkeys off with the reason naming the variable", () => {
    withStore(undefined);
    expect(passkeyAvailability()).toEqual({ state: "off", reason: PASSKEYS_OFF });
    withStore("   ");
    expect(passkeyAvailability()).toEqual({ state: "off", reason: PASSKEYS_OFF });
  });

  test("an https origin is ready with its host as the RP ID", () => {
    const expected: PasskeyAvailability = {
      state: "ready",
      origin: "https://studio.example.com",
      rpId: "studio.example.com",
    };
    withStore("https://Studio.Example.com");
    expect(passkeyAvailability()).toEqual(expected);
    withStore("https://studio.example.com/");
    expect(passkeyAvailability()).toEqual(expected);
  });

  test("default ports are dropped and the host is lowercased, as the browser serializes an origin", () => {
    withStore("https://studio.example.com:443");
    expect(passkeyAvailability()).toEqual({
      state: "ready",
      origin: "https://studio.example.com",
      rpId: "studio.example.com",
    });
    withStore("https://studio.example.com:8443");
    expect(passkeyAvailability()).toEqual({
      state: "ready",
      origin: "https://studio.example.com:8443",
      rpId: "studio.example.com",
    });
  });

  test("http is accepted only for the exact host localhost", () => {
    withStore("http://localhost:3000");
    expect(passkeyAvailability()).toEqual({ state: "ready", origin: "http://localhost:3000", rpId: "localhost" });
    for (const value of ["http://studio.example.com", "http://app.localhost:3000", "ftp://x.example"]) {
      withStore(value);
      expect(passkeyAvailability()).toEqual({ state: "misconfigured", reason: ORIGIN_SCHEME });
    }
    withStore("https://localhost");
    expect(passkeyAvailability()).toEqual({ state: "ready", origin: "https://localhost", rpId: "localhost" });
  });

  test("an IP-address host, a path, a query, credentials or a trailing dot is misconfigured, and the problem never quotes the value", () => {
    const cases: Array<[string, string]> = [
      ["https://192.168.1.10", ORIGIN_IP],
      ["https://[::1]", ORIGIN_IP],
      ["https://studio.example.com/tools", ORIGIN_NOT_ORIGIN],
      ["https://studio.example.com/?a=1", ORIGIN_NOT_ORIGIN],
      ["https://studio.example.com#x", ORIGIN_NOT_ORIGIN],
      // URL reports an empty query or fragment as "", so only the raw text shows these two.
      ["https://studio.example.com/?", ORIGIN_NOT_ORIGIN],
      ["https://studio.example.com/#", ORIGIN_NOT_ORIGIN],
      ["https://user:pw@studio.example.com", ORIGIN_CREDENTIALS],
      ["https://studio.example.com.", ORIGIN_TRAILING_DOT],
      ["not a url", ORIGIN_NOT_URL],
    ];
    for (const [value, reason] of cases) {
      withStore(value);
      const availability = passkeyAvailability();
      expect(availability).toEqual({ state: "misconfigured", reason });
      expect(JSON.stringify(availability)).not.toContain(value);
    }
  });
});

describe("passkeySignInOffer and passkeyOriginIsSet", () => {
  test("passkeySignInOffer answers the origin only when ready", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      withStore("https://studio.example.com");
      expect(passkeySignInOffer()).toEqual({ origin: "https://studio.example.com" });
      withStore(undefined);
      expect(passkeySignInOffer()).toBeNull();
      withStore("https://192.168.1.10");
      expect(passkeySignInOffer()).toBeNull();
      process.env.STORAGE_PROVIDER = "local";
      expect(passkeySignInOffer()).toBeNull();
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
      expect(passkeySignInOffer()).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  test("passkeyOriginIsSet is true for any non-blank value, valid or not", () => {
    expect(passkeyOriginIsSet()).toBe(false);
    process.env.PASSKEY_ORIGIN = "  ";
    expect(passkeyOriginIsSet()).toBe(false);
    process.env.PASSKEY_ORIGIN = "https://studio.example.com";
    expect(passkeyOriginIsSet()).toBe(true);
    process.env.PASSKEY_ORIGIN = "not a url";
    expect(passkeyOriginIsSet()).toBe(true);
  });

  test("passkeySignInOffer warns once per process when PASSKEY_ORIGIN is set but unusable", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      withStore("https://user:secret@studio.example.com");
      passkeySignInOffer();
      passkeySignInOffer();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain("PASSKEY_ORIGIN");
      expect(message).toContain(ORIGIN_CREDENTIALS);
      expect(message).not.toContain("secret");

      warn.mockClear();
      resetPasskeyConfigWarning();
      process.env.STORAGE_PROVIDER = "local";
      process.env.PASSKEY_ORIGIN = "https://studio.example.com";
      passkeySignInOffer();
      passkeySignInOffer();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(PASSKEYS_LOCAL);

      warn.mockClear();
      resetPasskeyConfigWarning();
      withStore(undefined);
      passkeySignInOffer();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("module boundary", () => {
  test("the reading the proxy uses imports no account or storage module", () => {
    const config = readFileSync(path.join(ROOT, "src/lib/passkey/config.ts"), "utf8");
    const providerType = readFileSync(path.join(ROOT, "src/lib/storage/provider-type.ts"), "utf8");
    // Every static module reference: named and type imports, side-effect imports and re-exports.
    const imports = [...config.matchAll(/^(import|export)\s+(type\s+)?(?:[^;"]*?from\s+)?"([^"]+)";/gm)];
    const valueImports = imports.filter((match) => !match[2]).map((match) => match[3]);
    const typeImports = imports.filter((match) => match[2]).map((match) => match[3]);
    expect(valueImports.sort()).toEqual(["@/lib/logger", "@/lib/storage/provider-type", "node:net"]);
    expect(typeImports).toEqual(["@/lib/passkey/api-types"]);
    expect(config).not.toMatch(/\brequire\(|\bimport\(/);
    expect(providerType).not.toMatch(/^\s*import\b|\brequire\(|\bimport\(/m);
  });
});
