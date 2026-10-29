/**
 * What a verified OIDC session needs while the Kubernetes access review is on (src/lib/kubernetes-access/session-guard.ts).
 *
 * No review ever runs without the groups record of the session's subject. A session whose record is gone, after a
 * restart or an eviction, is refused once so the browser signs in again silently and the callback records the groups
 * anew; the retry marker cookie remembers when that first miss happened. A session minted at or after that moment that
 * misses again is the second miss in a row: re-authenticating would loop, so the marker is set to `loop`, and the OIDC
 * login route then shows the sign-in page instead of going to the provider. A session minted before the marker,
 * another tab of the same browser after a restart, never escalates it, and a live record clears it. A session without
 * an identity provider subject was signed in by no review, so it is refused without touching the marker.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { recordGroups, resetGroupRecords } from "@/lib/kubernetes-access/groups";
import {
  ACCESS_REVIEW_RETRY_COOKIE,
  groupsRecordCheck,
  retryLoopTripped,
  sessionRecordCheck,
} from "@/lib/kubernetes-access/session-guard";

const ISSUER = "https://rancher.example.com/oidc";
const T = Date.parse("2026-10-28T08:00:00.000Z");
const T_SECONDS = T / 1000;
const SESSION = { role: "user", username: "u-rjs2h", idpSubject: "u-rjs2h", idpIssuer: ISSUER, iat: T_SECONDS - 600 };

beforeEach(() => {
  resetGroupRecords();
  process.env.AUTH_SESSION_TTL_SECONDS = "900";
});

afterEach(() => {
  resetGroupRecords();
  delete process.env.AUTH_SESSION_TTL_SECONDS;
});

test("the marker is a cookie of its own", () => {
  expect(ACCESS_REVIEW_RETRY_COOKIE).toBe("access-review-retry");
});

describe("a session whose subject has a live record", () => {
  test("is kept, and a marker left by an earlier miss is cleared", () => {
    recordGroups(ISSUER, "u-rjs2h", [], T - 1000);
    expect(groupsRecordCheck(SESSION, undefined, T)).toEqual({ kind: "kept", clearMarker: false });
    expect(groupsRecordCheck(SESSION, String(T_SECONDS - 5), T)).toEqual({ kind: "kept", clearMarker: true });
    expect(groupsRecordCheck(SESSION, "loop", T)).toEqual({ kind: "kept", clearMarker: true });
  });
});

describe("a session without an identity provider subject", () => {
  test("is refused, leaving the marker as it is: no review decided its role, so it is no session of this mode", () => {
    expect(groupsRecordCheck({ iat: T_SECONDS - 60 }, undefined, T)).toEqual({ kind: "refused", marker: null });
    expect(groupsRecordCheck({ idpSubject: "", idpIssuer: ISSUER }, String(T_SECONDS - 3), T)).toEqual({
      kind: "refused",
      marker: null,
    });
  });
});

describe("a session whose record is missing", () => {
  test("the first miss is refused and arms the marker with the time of the miss", () => {
    expect(groupsRecordCheck(SESSION, undefined, T)).toEqual({ kind: "refused", marker: String(T_SECONDS) });
  });

  test("an expired record is a missing one", () => {
    recordGroups(ISSUER, "u-rjs2h", [], T - 900_000);
    expect(groupsRecordCheck(SESSION, undefined, T)).toEqual({ kind: "refused", marker: String(T_SECONDS) });
  });

  test("a marker that cannot be read counts as none", () => {
    expect(groupsRecordCheck(SESSION, "soon", T)).toEqual({ kind: "refused", marker: String(T_SECONDS) });
    expect(groupsRecordCheck(SESSION, "", T)).toEqual({ kind: "refused", marker: String(T_SECONDS) });
  });

  test("a session minted at or after the marker missing again is the second miss in a row, which trips the loop", () => {
    const armed = String(T_SECONDS - 3);
    expect(groupsRecordCheck({ ...SESSION, iat: T_SECONDS - 3 }, armed, T)).toEqual({
      kind: "refused",
      marker: "loop",
    });
    expect(groupsRecordCheck({ ...SESSION, iat: T_SECONDS - 1 }, armed, T)).toEqual({
      kind: "refused",
      marker: "loop",
    });
  });

  test("a session minted before the marker, another tab after a restart, leaves the marker as it is", () => {
    expect(groupsRecordCheck({ ...SESSION, iat: T_SECONDS - 4 }, String(T_SECONDS - 3), T)).toEqual({
      kind: "refused",
      marker: null,
    });
    expect(groupsRecordCheck({ idpSubject: "u", idpIssuer: ISSUER }, String(T_SECONDS), T)).toEqual({
      kind: "refused",
      marker: null,
    });
  });

  test("a tripped loop stays tripped until the login route consumes it", () => {
    expect(groupsRecordCheck(SESSION, "loop", T)).toEqual({ kind: "refused", marker: null });
  });
});

test("the login route reads only a tripped marker as the loop", () => {
  expect(retryLoopTripped("loop")).toBe(true);
  expect(retryLoopTripped(String(T_SECONDS))).toBe(false);
  expect(retryLoopTripped(undefined)).toBe(false);
});

// The same state machine, driven by a record state instead of the groups store: openshift sign-in checks its token
// record through it, so a restart there is refused once, then trips the loop guard the same way.
describe("sessionRecordCheck", () => {
  const NOW_MS = 2_000_000;

  test("a live record keeps the session and clears a marker it carries", () => {
    expect(sessionRecordCheck("live", 1_000, undefined, NOW_MS)).toEqual({ kind: "kept", clearMarker: false });
    expect(sessionRecordCheck("live", 1_000, "1999", NOW_MS)).toEqual({ kind: "kept", clearMarker: true });
    expect(sessionRecordCheck("live", 1_000, "loop", NOW_MS)).toEqual({ kind: "kept", clearMarker: true });
  });

  test("an unbound session is refused and leaves the marker as it is", () => {
    expect(sessionRecordCheck("unbound", 1_000, undefined, NOW_MS)).toEqual({ kind: "refused", marker: null });
    expect(sessionRecordCheck("unbound", 1_000, "1999", NOW_MS)).toEqual({ kind: "refused", marker: null });
  });

  test("a missing record arms the marker; a session minted at or after it that misses again trips the loop", () => {
    expect(sessionRecordCheck("missing", 1_000, undefined, NOW_MS)).toEqual({ kind: "refused", marker: "2000" });
    expect(sessionRecordCheck("missing", 2_000, "2000", NOW_MS)).toEqual({ kind: "refused", marker: "loop" });
    expect(sessionRecordCheck("missing", 1_999, "2000", NOW_MS)).toEqual({ kind: "refused", marker: null });
    expect(sessionRecordCheck("missing", undefined, "2000", NOW_MS)).toEqual({ kind: "refused", marker: null });
    expect(sessionRecordCheck("missing", 3_000, "loop", NOW_MS)).toEqual({ kind: "refused", marker: null });
    expect(sessionRecordCheck("missing", 3_000, "not-a-second", NOW_MS)).toEqual({ kind: "refused", marker: "2000" });
    expect(retryLoopTripped("loop")).toBe(true);
  });
});
