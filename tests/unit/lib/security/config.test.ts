import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readCspReportOnly, readHstsIncludeSubDomains, readSecurityHeaderOptions } from "@/lib/security/config";

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

  test("falls back to the default on an unrecognized value rather than guessing", () => {
    process.env.CSP_REPORT_ONLY = "maybe";

    expect(readCspReportOnly()).toBe(true);
  });

  test("treats an empty value as unset", () => {
    process.env.CSP_REPORT_ONLY = "   ";

    expect(readCspReportOnly()).toBe(true);
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
