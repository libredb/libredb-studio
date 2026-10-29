import { beforeEach, describe, expect, test } from "bun:test";
import * as tokenStore from "@/lib/openshift-auth/token-store";
import {
  endOpenShiftSession,
  openShiftBearerToken,
  openShiftSessionKey,
  resetOpenShiftSessions,
  storeOpenShiftSession,
} from "@/lib/openshift-auth/token-store";

const ISSUER = "https://oauth-openshift.apps.example.com";
const record = (uid: string, n: number, expiresAtMs = 10_000_000) => ({
  token: `sha256~not-a-real-token-${n}`,
  uid,
  name: `user-${uid}`,
  issuer: ISSUER,
  expiresAtMs,
});
const key = (handle: string, uid: string) => ({ sessionHandle: handle, uid, name: `user-${uid}`, issuer: ISSUER });

beforeEach(() => {
  resetOpenShiftSessions();
});

describe("openshift token store", () => {
  test("a stored record answers its token to the key of its session", () => {
    storeOpenShiftSession("h1", record("u1", 1), 1_000);
    expect(openShiftBearerToken(key("h1", "u1"), 2_000)).toBe("sha256~not-a-real-token-1");
  });

  test("a key whose uid, name or issuer differs answers null and leaves the record", () => {
    storeOpenShiftSession("h1", record("u1", 1), 1_000);
    expect(openShiftBearerToken({ ...key("h1", "u1"), uid: "u2" }, 2_000)).toBeNull();
    expect(openShiftBearerToken({ ...key("h1", "u1"), name: "someone-else" }, 2_000)).toBeNull();
    expect(openShiftBearerToken({ ...key("h1", "u1"), issuer: "https://elsewhere.example.com" }, 2_000)).toBeNull();
    expect(openShiftBearerToken(key("h2", "u1"), 2_000)).toBeNull();
    expect(openShiftBearerToken(key("h1", "u1"), 2_000)).toBe("sha256~not-a-real-token-1");
  });

  test("an expired record answers null and is deleted", () => {
    storeOpenShiftSession("h1", record("u1", 1, 5_000), 1_000);
    expect(openShiftBearerToken(key("h1", "u1"), 5_000)).toBeNull();
    expect(openShiftBearerToken(key("h1", "u1"), 4_000)).toBeNull();
  });

  test("two sessions of one user hold two records; ending one leaves the other", () => {
    storeOpenShiftSession("h1", record("u1", 1), 1_000);
    storeOpenShiftSession("h2", record("u1", 2), 1_000);
    expect(endOpenShiftSession("h1")).toBe(true);
    expect(endOpenShiftSession("h1")).toBe(false);
    expect(openShiftBearerToken(key("h1", "u1"), 2_000)).toBeNull();
    expect(openShiftBearerToken(key("h2", "u1"), 2_000)).toBe("sha256~not-a-real-token-2");
  });

  test("a ninth record of one uid ends the oldest of that uid only", () => {
    storeOpenShiftSession("other", record("u2", 99), 1_000);
    for (let n = 1; n <= 9; n += 1) storeOpenShiftSession(`h${n}`, record("u1", n), 1_000 + n);
    expect(openShiftBearerToken(key("h1", "u1"), 2_000)).toBeNull();
    for (let n = 2; n <= 9; n += 1) expect(openShiftBearerToken(key(`h${n}`, "u1"), 2_000)).not.toBeNull();
    expect(openShiftBearerToken(key("other", "u2"), 2_000)).not.toBeNull();
  });

  test("a full store ends the oldest record written", () => {
    resetOpenShiftSessions({ total: 4 });
    for (let n = 1; n <= 5; n += 1) storeOpenShiftSession(`h${n}`, record(`u${n}`, n), 1_000 + n);
    expect(openShiftBearerToken(key("h1", "u1"), 2_000)).toBeNull();
    for (let n = 2; n <= 5; n += 1) expect(openShiftBearerToken(key(`h${n}`, `u${n}`), 2_000)).not.toBeNull();
  });

  test("a full store drops expired records before it ends a live one", () => {
    resetOpenShiftSessions({ total: 4, perUid: 8 });
    storeOpenShiftSession("old1", record("u1", 1, 1_500), 1_000);
    storeOpenShiftSession("live2", record("u2", 2), 1_000);
    storeOpenShiftSession("old3", record("u3", 3, 1_500), 1_000);
    storeOpenShiftSession("live4", record("u4", 4), 1_000);
    storeOpenShiftSession("live5", record("u5", 5), 2_000);
    for (const [handle, uid] of [
      ["live2", "u2"],
      ["live4", "u4"],
      ["live5", "u5"],
    ]) {
      expect(openShiftBearerToken(key(handle, uid), 2_000)).not.toBeNull();
    }
  });

  test("storing under a handle again replaces its record", () => {
    storeOpenShiftSession("h1", record("u1", 1), 1_000);
    storeOpenShiftSession("h1", record("u1", 2), 1_000);
    expect(openShiftBearerToken(key("h1", "u1"), 2_000)).toBe("sha256~not-a-real-token-2");
  });

  test("reset forgets every record, as a restart does", () => {
    storeOpenShiftSession("h1", record("u1", 1), 1_000);
    resetOpenShiftSessions();
    expect(openShiftBearerToken(key("h1", "u1"), 2_000)).toBeNull();
  });

  test("openShiftSessionKey needs all four fields as non-empty strings", () => {
    const session = { sessionHandle: "h1", idpSubject: "u1", idpIssuer: ISSUER, username: "user-u1" };
    expect(openShiftSessionKey(session)).toEqual(key("h1", "u1"));
    for (const field of ["sessionHandle", "idpSubject", "idpIssuer", "username"] as const) {
      expect(openShiftSessionKey({ ...session, [field]: "" })).toBeNull();
      expect(openShiftSessionKey({ ...session, [field]: undefined })).toBeNull();
    }
  });

  test("no export lists, counts or iterates records", () => {
    expect(Object.keys(tokenStore).sort()).toEqual([
      "endOpenShiftSession",
      "openShiftBearerToken",
      "openShiftSessionKey",
      "resetOpenShiftSessions",
      "storeOpenShiftSession",
    ]);
  });
});
