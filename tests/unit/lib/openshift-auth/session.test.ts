import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { newSessionHandle, openShiftRecordCheck, openShiftSessionLifetimeSeconds } from "@/lib/openshift-auth/session";
import { resetOpenShiftSessions, storeOpenShiftSession } from "@/lib/openshift-auth/token-store";

const ISSUER = "https://oauth-openshift.apps.example.com";
const KEYS = ["NEXT_PUBLIC_AUTH_PROVIDER", "AUTH_SESSION_TTL_SECONDS"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = "openshift";
  delete process.env.AUTH_SESSION_TTL_SECONDS;
  resetOpenShiftSessions();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const session = (handle: string | undefined, iat = 1_000) => ({
  username: "dev-a",
  role: "user" as const,
  idpSubject: "u1",
  idpIssuer: ISSUER,
  sessionHandle: handle,
  iat,
});

describe("newSessionHandle", () => {
  test("is 32 random bytes in base64url, 43 characters", () => {
    const first = newSessionHandle();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSessionHandle()).not.toBe(first);
  });
});

describe("openShiftSessionLifetimeSeconds", () => {
  test("is the session lifetime capped by the token's expiry", () => {
    expect(openShiftSessionLifetimeSeconds(31536000)).toBe(28800);
    expect(openShiftSessionLifetimeSeconds(600)).toBe(600);
    expect(openShiftSessionLifetimeSeconds(null)).toBe(28800);
    process.env.AUTH_SESSION_TTL_SECONDS = "600";
    expect(openShiftSessionLifetimeSeconds(31536000)).toBe(600);
    expect(openShiftSessionLifetimeSeconds(null)).toBe(600);
  });
});

describe("openShiftRecordCheck", () => {
  test("a session without a handle is unbound: refused, marker left as it is", () => {
    expect(openShiftRecordCheck(session(undefined), undefined, 2_000_000)).toEqual({ kind: "refused", marker: null });
    expect(openShiftRecordCheck(session(undefined), "1999", 2_000_000)).toEqual({ kind: "refused", marker: null });
  });

  test("a live record keeps the session and clears a marker it carries", () => {
    storeOpenShiftSession(
      "h1",
      { token: "sha256~not-a-real-token-1", uid: "u1", name: "dev-a", issuer: ISSUER, expiresAtMs: 9_000_000 },
      1_000,
    );
    expect(openShiftRecordCheck(session("h1"), undefined, 2_000_000)).toEqual({ kind: "kept", clearMarker: false });
    expect(openShiftRecordCheck(session("h1"), "1999", 2_000_000)).toEqual({ kind: "kept", clearMarker: true });
  });

  test("a missing record arms the marker, and a second miss after it trips the loop", () => {
    expect(openShiftRecordCheck(session("h1"), undefined, 2_000_000)).toEqual({ kind: "refused", marker: "2000" });
    expect(openShiftRecordCheck(session("h1", 2_000), "2000", 2_100_000)).toEqual({ kind: "refused", marker: "loop" });
    expect(openShiftRecordCheck(session("h1", 1_999), "2000", 2_100_000)).toEqual({ kind: "refused", marker: null });
    expect(openShiftRecordCheck(session("h1"), "loop", 2_100_000)).toEqual({ kind: "refused", marker: null });
  });
});
