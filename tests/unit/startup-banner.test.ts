import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { printStartupBanner } from "@/lib/startup-banner";

const ENV_KEYS = [
  "LIBREDB_NO_BANNER",
  "NEXT_PUBLIC_APP_VERSION",
  "PORT",
  "HOSTNAME",
  "PASSKEY_ORIGIN",
  "STORAGE_PROVIDER",
  "NEXT_PUBLIC_AUTH_PROVIDER",
] as const;

/** The printed lines, trimmed, so a line-start check ignores the block's indentation. */
function lines(output: string): string[] {
  return output.split("\n").map((line) => line.trim());
}

/** Run the banner with console.log captured and return everything it printed. */
function capture(): string {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    printStartupBanner();
    // Read the recorded calls before mockRestore(): bun clears them on restore.
    return log.mock.calls.flat().join("\n");
  } finally {
    log.mockRestore();
  }
}

describe("printStartupBanner", () => {
  let orig: Record<string, string | undefined>;

  beforeEach(() => {
    orig = {};
    for (const key of ENV_KEYS) {
      orig[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (orig[key] === undefined) delete process.env[key];
      else process.env[key] = orig[key];
    }
  });

  test("prints the version, the local URL and the repository invitation", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "1.2.3";

    const output = capture();

    expect(output).toContain("LibreDB Studio 1.2.3");
    expect(output).toContain("http://127.0.0.1:3000");
    expect(output).toContain("Star the project if it helps you");
    expect(output).toContain("https://github.com/libredb/libredb-studio");
  });

  test("reflects a custom PORT", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "1.2.3";
    process.env.PORT = "8080";

    const output = capture();

    expect(output).toContain("http://127.0.0.1:8080");
    expect(output).not.toContain("127.0.0.1:3000");
  });

  test("falls back to the default port when PORT is blank", () => {
    process.env.PORT = "   ";

    expect(capture()).toContain("http://127.0.0.1:3000");
  });

  test("prints the bind address from HOSTNAME instead of inventing localhost", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "1.2.3";
    process.env.HOSTNAME = "studio.internal";

    const output = capture();

    expect(output).toContain("http://studio.internal:3000");
    expect(output).not.toContain("localhost");
  });

  test("prints a loopback URL for the 0.0.0.0 wildcard bind", () => {
    process.env.HOSTNAME = "0.0.0.0";

    expect(capture()).toContain("http://127.0.0.1:3000");
  });

  // Same convention as startupUrl (tests/unit/launcher-utils.test.ts): the
  // dual-stack wildcard bind answers on ::1, and both spellings of it must
  // produce the same URL so the two copies cannot drift apart.
  test("prints an IPv6 loopback URL for the :: wildcard bind", () => {
    process.env.HOSTNAME = "::";

    expect(capture()).toContain("http://[::1]:3000");
  });

  test("prints an IPv6 loopback URL for the bracketed [::] wildcard bind", () => {
    process.env.HOSTNAME = "[::]";

    expect(capture()).toContain("http://[::1]:3000");
  });

  test("brackets a bare IPv6 bind address", () => {
    process.env.HOSTNAME = "fe80::1";

    expect(capture()).toContain("http://[fe80::1]:3000");
  });

  test("never prints 'undefined' when the version is missing", () => {
    const output = capture();

    expect(output).toContain("LibreDB Studio");
    expect(output).not.toContain("undefined");
    expect(output).toContain("https://github.com/libredb/libredb-studio");
  });

  test("prints nothing when LIBREDB_NO_BANNER=1", () => {
    process.env.LIBREDB_NO_BANNER = "1";

    expect(capture()).toBe("");
  });

  test("prints nothing when LIBREDB_NO_BANNER=true (any case)", () => {
    process.env.LIBREDB_NO_BANNER = "TRUE";

    expect(capture()).toBe("");
  });

  // `LIBREDB_NO_BANNER: " 1"` is what a compose file or an env file with a
  // trailing space produces; an operator who explicitly opted out must be obeyed.
  test("honours an opt-out that carries surrounding whitespace", () => {
    for (const value of [" 1 ", " true ", "\ttrue\n"]) {
      process.env.LIBREDB_NO_BANNER = value;
      expect(capture()).toBe("");
    }
  });

  test("still prints for values that are not an opt-out", () => {
    for (const value of ["0", "false", "", "yes"]) {
      process.env.LIBREDB_NO_BANNER = value;
      expect(capture()).toContain("LibreDB Studio");
    }
  });

  test("names the passkey origin, or why passkeys are unavailable, when PASSKEY_ORIGIN is set", () => {
    process.env.STORAGE_PROVIDER = "sqlite";
    process.env.PASSKEY_ORIGIN = "http://localhost:3000";
    const ready = capture();
    expect(ready).toContain("Passkeys  ->  http://localhost:3000");
    expect(ready).not.toContain("Passkeys are unavailable");

    process.env.STORAGE_PROVIDER = "local";
    const localStore = capture();
    expect(localStore).toContain(
      "Passkeys are unavailable: Passkeys need STORAGE_PROVIDER=sqlite or postgres: with STORAGE_PROVIDER=local there is no account registry to keep them in.",
    );
    expect(localStore).not.toContain("Passkeys  ->");

    process.env.STORAGE_PROVIDER = "sqlite";
    // A marker host no reason text contains, so the no-leak check cannot collide with the example domain.
    process.env.PASSKEY_ORIGIN = "https://passkeys.internal.test/studio";
    const invalid = capture();
    expect(invalid).toContain(
      "Passkeys are unavailable: PASSKEY_ORIGIN must be an origin (scheme, host and optional port) with no path, query or fragment; a BASE_PATH prefix does not belong in it.",
    );
    expect(invalid).not.toContain("passkeys.internal.test");
  });

  test("says nothing about passkeys when PASSKEY_ORIGIN is unset", () => {
    process.env.STORAGE_PROVIDER = "sqlite";

    const output = capture();

    expect(output).toContain("LibreDB Studio");
    expect(lines(output).some((line) => line.startsWith("Passkeys"))).toBe(false);
  });

  test("LIBREDB_NO_BANNER still silences everything", () => {
    process.env.LIBREDB_NO_BANNER = "1";
    process.env.STORAGE_PROVIDER = "sqlite";
    process.env.PASSKEY_ORIGIN = "http://localhost:3000";

    expect(capture()).toBe("");
  });

  test("never throws when console.log fails", () => {
    const log = spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout is gone");
    });
    try {
      expect(() => printStartupBanner()).not.toThrow();
    } finally {
      log.mockRestore();
    }
  });
});
