import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "@/lib/logger";
import {
  readCspReportOnly,
  readHstsIncludeSubDomains,
  readSecurityHeaderOptions,
  resetSecurityConfigWarnings,
} from "@/lib/security/config";

const MUTATED = ["CSP_REPORT_ONLY", "HSTS_INCLUDE_SUBDOMAINS", "NEXT_PUBLIC_MONACO_VS_PATH"] as const;
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
  test("reports only while the policy is still being verified against Monaco", () => {
    delete process.env.CSP_REPORT_ONLY;

    expect(readCspReportOnly()).toBe(true);
  });

  test("honours an explicit off value so a prebuilt image can be enforced by its operator", () => {
    process.env.CSP_REPORT_ONLY = "false";

    expect(readCspReportOnly()).toBe(false);
  });

  test("honours an explicit on value", () => {
    process.env.CSP_REPORT_ONLY = "TRUE";

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

      expect(readCspReportOnly()).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("treats an empty value as unset, without warning", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      process.env.CSP_REPORT_ONLY = "   ";

      expect(readCspReportOnly()).toBe(true);
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
