import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "@/lib/logger";
import {
  readCspReportOnly,
  readHstsIncludeSubDomains,
  readSecurityHeaderOptions,
  readTrustProxyHeaders,
  resetSecurityConfigWarnings,
} from "@/lib/security/config";

const MUTATED = [
  "CSP_REPORT_ONLY",
  "HSTS_INCLUDE_SUBDOMAINS",
  "NEXT_PUBLIC_MONACO_VS_PATH",
  "TRUST_PROXY_HEADERS",
] as const;
const snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of MUTATED) snapshot[key] = process.env[key];
});

afterEach(() => {
  for (const key of MUTATED) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSecurityConfigWarnings();
});

describe("readCspReportOnly", () => {
  test("enforces by default: a policy that only reports protects nothing", () => {
    delete process.env.CSP_REPORT_ONLY;

    expect(readCspReportOnly()).toBe(false);
  });

  test("honours an explicit on value, the escape hatch for a channel a prebuilt image broke", () => {
    process.env.CSP_REPORT_ONLY = "true";

    expect(readCspReportOnly()).toBe(true);
  });

  // "0"/"FALSE" are the two spellings an operator is most likely to type: "0" because
  // AUTH_BOOTSTRAP and AUTH_COOKIE_SECURE both accept it, "FALSE" because shells and .env files
  // are commonly written in all caps.
  test("honours an explicit off value spelled as a bare zero", () => {
    process.env.CSP_REPORT_ONLY = "0";

    expect(readCspReportOnly()).toBe(false);
  });

  test("honours an explicit off value spelled in uppercase", () => {
    process.env.CSP_REPORT_ONLY = "FALSE";

    expect(readCspReportOnly()).toBe(false);
  });

  test("falls back to the default on an unrecognized value rather than guessing", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      process.env.CSP_REPORT_ONLY = "maybe";

      expect(readCspReportOnly()).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("treats an empty value as unset, without warning", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      process.env.CSP_REPORT_ONLY = "   ";

      expect(readCspReportOnly()).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // Same class of typo AUTH_BOOTSTRAP and AUTH_COOKIE_SECURE already warn on: a misspelled
  // security flag must tell the operator, not silently keep the default and look identical to a
  // deliberate choice.
  test("warns once, naming the variable and the bad value, when the value is unrecognized", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      process.env.CSP_REPORT_ONLY = "maybe";

      readCspReportOnly();
      readCspReportOnly();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("CSP_REPORT_ONLY");
      expect(warn.mock.calls[0][0]).toContain("maybe");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("readHstsIncludeSubDomains", () => {
  test("is off by default: a self-hoster must not break unrelated siblings by upgrading Studio", () => {
    delete process.env.HSTS_INCLUDE_SUBDOMAINS;

    expect(readHstsIncludeSubDomains()).toBe(false);
  });

  test("is opt-in", () => {
    process.env.HSTS_INCLUDE_SUBDOMAINS = "true";

    expect(readHstsIncludeSubDomains()).toBe(true);
  });
});

describe("readTrustProxyHeaders", () => {
  test("trusts forwarded headers by default: a route handler has no socket address to fall back to", () => {
    delete process.env.TRUST_PROXY_HEADERS;

    expect(readTrustProxyHeaders()).toBe(true);
  });

  test("honours an explicit off value for a deployment with no reverse proxy in front", () => {
    process.env.TRUST_PROXY_HEADERS = "false";

    expect(readTrustProxyHeaders()).toBe(false);
  });

  test("falls back to the trusted default on an unrecognized value rather than guessing", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      process.env.TRUST_PROXY_HEADERS = "maybe";

      expect(readTrustProxyHeaders()).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("warns once, naming the variable and the bad value, when the value is unrecognized", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    // `bun run test` shares this process (and therefore logger.warn) with every other file. A
    // debounced localStorage write elsewhere in the suite can flush into this spy's history the
    // instant it is installed, so the baseline is cleared before exercising the code under test
    // rather than assumed to start empty (see tests/unit/lib/api/client-address.test.ts, which
    // hit this for real).
    warn.mockClear();
    try {
      process.env.TRUST_PROXY_HEADERS = "maybe";

      readTrustProxyHeaders();
      readTrustProxyHeaders();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("TRUST_PROXY_HEADERS");
      expect(warn.mock.calls[0][0]).toContain("maybe");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("readSecurityHeaderOptions", () => {
  test("carries the deployment's Monaco path so an off-origin bundle stays loadable", () => {
    process.env.NEXT_PUBLIC_MONACO_VS_PATH = "https://assets.example.com/monaco/vs";

    expect(readSecurityHeaderOptions().monacoVsPath).toBe("https://assets.example.com/monaco/vs");
  });

  test("always sends HSTS, with the 180-day max-age", () => {
    delete process.env.HSTS_INCLUDE_SUBDOMAINS;

    expect(readSecurityHeaderOptions().hsts).toEqual({
      maxAgeSeconds: 15552000,
      includeSubDomains: false,
    });
  });
});
