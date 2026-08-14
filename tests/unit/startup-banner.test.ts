import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { printStartupBanner } from "@/lib/startup-banner";

const ENV_KEYS = ["LIBREDB_NO_BANNER", "NEXT_PUBLIC_APP_VERSION", "PORT"] as const;

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
    expect(output).toContain("http://localhost:3000");
    expect(output).toContain("Star the project if it helps you");
    expect(output).toContain("https://github.com/libredb/libredb-studio");
  });

  test("reflects a custom PORT", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "1.2.3";
    process.env.PORT = "8080";

    const output = capture();

    expect(output).toContain("http://localhost:8080");
    expect(output).not.toContain("localhost:3000");
  });

  test("falls back to the default port when PORT is blank", () => {
    process.env.PORT = "   ";

    expect(capture()).toContain("http://localhost:3000");
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
