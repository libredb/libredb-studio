import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuditReason } from "@/lib/audit";
import {
  type OpenShiftSignInCode,
  openShiftLoginPageLocation,
  openShiftPublicLocation,
} from "@/lib/openshift-auth/redirect";

const CODES = [
  "openshift_config",
  "openshift_unreachable",
  "openshift_external_oidc",
  "openshift_state_missing",
  "openshift_state_invalid",
  "openshift_denied",
  "openshift_scope",
  "openshift_no_uid",
  "openshift_no_access",
  "openshift_failed",
  "openshift_session_lost",
] as const satisfies readonly OpenShiftSignInCode[];

// Every sign-in code is also an audit reason, so a login_failure line names it.
const AS_AUDIT_REASONS: readonly AuditReason[] = CODES;

const KEYS = ["OPENSHIFT_PUBLIC_URL", "NEXT_PUBLIC_BASE_PATH"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  delete process.env.NEXT_PUBLIC_BASE_PATH;
  process.env.OPENSHIFT_PUBLIC_URL = "https://studio.apps.example.com";
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("openShiftPublicLocation", () => {
  test("is the path at the public URL's origin", () => {
    expect(openShiftPublicLocation("/api/auth/openshift/login")).toBe(
      "https://studio.apps.example.com/api/auth/openshift/login",
    );
  });

  test("is null, never a relative path, when the public URL does not read", () => {
    process.env.OPENSHIFT_PUBLIC_URL = "http://not-https.example.com";
    expect(openShiftPublicLocation("/api/auth/openshift/login")).toBeNull();
    delete process.env.OPENSHIFT_PUBLIC_URL;
    expect(openShiftPublicLocation("/api/auth/openshift/login")).toBeNull();
  });
});

describe("openShiftLoginPageLocation", () => {
  test("is the login page under the public URL, with the code", () => {
    expect(openShiftLoginPageLocation("openshift_scope")).toBe(
      "https://studio.apps.example.com/login?error=openshift_scope",
    );
    expect(AS_AUDIT_REASONS).toHaveLength(11);
    for (const code of CODES) {
      expect(openShiftLoginPageLocation(code)).toBe(`https://studio.apps.example.com/login?error=${code}`);
    }
  });

  test("keeps the base path of the public URL", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/studio";
    process.env.OPENSHIFT_PUBLIC_URL = "https://host/studio";
    expect(openShiftLoginPageLocation("openshift_denied")).toBe("https://host/studio/login?error=openshift_denied");
  });

  test("is a path under the base path when the public URL does not read", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/studio";
    process.env.OPENSHIFT_PUBLIC_URL = "http://not-https.example.com";
    expect(openShiftLoginPageLocation("openshift_config")).toBe("/studio/login?error=openshift_config");
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    delete process.env.OPENSHIFT_PUBLIC_URL;
    expect(openShiftLoginPageLocation("openshift_config")).toBe("/login?error=openshift_config");
  });

  test("takes no request, so no Host or X-Forwarded-Host header can steer it", () => {
    expect(openShiftLoginPageLocation.length).toBe(1);
  });
});
