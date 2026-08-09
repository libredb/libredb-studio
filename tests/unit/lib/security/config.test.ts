import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  test("enforces by default: a policy that only reports protects nothing", () => {
    delete process.env.CSP_REPORT_ONLY;

    expect(readCspReportOnly()).toBe(false);
  });

  test("honours an explicit on value, the escape hatch for a channel a prebuilt image broke", () => {
    process.env.CSP_REPORT_ONLY = "true";

    expect(readCspReportOnly()).toBe(true);
  });

  test("honours an explicit off value", () => {
    process.env.CSP_REPORT_ONLY = "OFF";

    expect(readCspReportOnly()).toBe(false);
  });

  test("falls back to the default on an unrecognized value rather than guessing", () => {
    process.env.CSP_REPORT_ONLY = "maybe";

    expect(readCspReportOnly()).toBe(false);
  });

  test("treats an empty value as unset", () => {
    process.env.CSP_REPORT_ONLY = "   ";

    expect(readCspReportOnly()).toBe(false);
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
