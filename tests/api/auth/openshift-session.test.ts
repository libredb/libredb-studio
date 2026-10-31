/**
 * Sessions in openshift sign-in mode: a session cookie reads as signed in only while the token record under its
 * handle is live and bound to its uid, name and issuer. A cookie replayed after its record ended, or one whose record
 * belongs to someone else, reads as signed out on every route; a restart (an empty store) refuses each session once
 * and arms the retry marker, and a second miss in a row trips the loop guard. A session of another mode reads as signed
 * out in this one, and an openshift session reads as signed out in the others.
 */
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";

const ISSUER = "https://oauth-openshift.apps.example.com";
const T = Date.parse("2026-10-29T08:00:00.000Z");
const T_SECONDS = T / 1000;

let jar: Record<string, { value: string } | undefined> = {};
let writes: { op: string; name: string; value?: string }[] = [];

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar[name],
    set: (name: string, value: string) => writes.push({ op: "set", name, value }),
    delete: (cookie: string | { name: string }) =>
      writes.push({ op: "delete", name: typeof cookie === "string" ? cookie : cookie.name }),
  }),
  headers: async () => ({ get: () => null }),
}));

const { getSession, signJWT } = await import("@/lib/auth");
type UserPayload = import("@/lib/auth").UserPayload;
const { endOpenShiftSession, resetOpenShiftSessions, storeOpenShiftSession } = await import(
  "@/lib/openshift-auth/token-store"
);
const { logger } = await import("@/lib/logger");
const { GET: auditGET } = await import("@/app/api/admin/audit/route");
const { GET: managedGET } = await import("@/app/api/connections/managed/route");

const KEYS = [
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "JWT_SECRET",
  "KUBERNETES_ACCESS_REVIEW",
  "AUTH_SESSION_TTL_SECONDS",
] as const;
let saved: Record<string, string | undefined>;
let info: ReturnType<typeof spyOn>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  setSystemTime(new Date(T));
  resetOpenShiftSessions();
  jar = {};
  writes = [];
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = "openshift";
  process.env.JWT_SECRET = "a-test-secret-that-is-32-chars!!";
  delete process.env.KUBERNETES_ACCESS_REVIEW;
  delete process.env.AUTH_SESSION_TTL_SECONDS;
  info = spyOn(logger, "info").mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  setSystemTime();
  resetOpenShiftSessions();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const DEV_A = { uid: "0b6f5c1e-4d2a-4c55-9e1f-7a3b2c1d0e9f", name: "dev-a" };

function payload(handle: string, user = DEV_A, issuer = ISSUER): UserPayload {
  return { role: "user", username: user.name, idpSubject: user.uid, idpIssuer: issuer, sessionHandle: handle };
}

/** A sign-in as the callback leaves it: the record under `handle`, and its cookie minted at `mintedAt` in the jar. */
async function signedIn(handle: string, mintedAt = T - 60_000, user = DEV_A): Promise<string> {
  storeOpenShiftSession(handle, {
    token: `sha256~not-a-real-token-${handle}`,
    uid: user.uid,
    name: user.name,
    issuer: ISSUER,
    expiresAtMs: T + 3_600_000,
  });
  setSystemTime(new Date(mintedAt));
  const cookie = await signJWT(payload(handle, user));
  setSystemTime(new Date(T));
  jar["auth-token"] = { value: cookie };
  return cookie;
}

const names = (op: string) => writes.filter((write) => write.op === op).map((write) => write.name);

describe("a session in openshift mode", () => {
  test("is signed in while its record is live, and touches no cookie", async () => {
    await signedIn("h1");
    expect(await getSession()).toMatchObject(payload("h1"));
    expect(writes).toEqual([]);
  });

  test("never runs the groups check, even with the access review switched on", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "on";
    await signedIn("h1");
    expect(await getSession()).toMatchObject(payload("h1"));
  });

  test("replayed after its record ended, reads as signed out on every route and never regains a record", async () => {
    const cookie = await signedIn("h1");
    expect(endOpenShiftSession("h1")).toBe(true);
    expect((await auditGET(new Request("http://localhost/api/admin/audit"))).status).toBe(401);
    jar["auth-token"] = { value: cookie };
    expect((await managedGET()).status).toBe(401);
    // A new sign-in writes a record under a new handle; the old cookie still names the ended one.
    await signedIn("h2");
    jar["auth-token"] = { value: cookie };
    expect(await getSession()).toBeNull();
    expect(names("delete")).toContain("auth-token");
  });

  test("whose record belongs to another uid, name or issuer reads as signed out and leaves the record", async () => {
    await signedIn("h1");
    for (const forged of [
      payload("h1", { uid: "another-uid", name: DEV_A.name }),
      payload("h1", { uid: DEV_A.uid, name: "dev-b" }),
      payload("h1", DEV_A, "https://elsewhere.example.com"),
    ]) {
      jar["auth-token"] = { value: await signJWT(forged) };
      expect(await getSession()).toBeNull();
    }
    jar["auth-token"] = { value: await signJWT(payload("h1")) };
    expect(await getSession()).toMatchObject(payload("h1"));
  });

  test("two sessions of one user hold two records; ending one leaves the other signed in", async () => {
    const first = await signedIn("h1");
    const second = await signedIn("h2");
    endOpenShiftSession("h1");
    jar["auth-token"] = { value: first };
    expect(await getSession()).toBeNull();
    jar["auth-token"] = { value: second };
    expect(await getSession()).toMatchObject(payload("h2"));
  });

  test("after a restart reads as signed out once and arms the marker; a second miss after it trips the loop", async () => {
    await signedIn("h1", T - 600_000);
    resetOpenShiftSessions();
    expect(await getSession()).toBeNull();
    expect(names("delete")).toEqual(["auth-token"]);
    expect(writes.find((write) => write.op === "set")).toEqual({
      op: "set",
      name: "access-review-retry",
      value: String(T_SECONDS),
    });
    expect(info.mock.calls[0][1]).toEqual({ route: "auth", loop: false });

    // Signed in again after the marker, and the record goes missing again: the loop guard trips.
    writes = [];
    jar["access-review-retry"] = { value: String(T_SECONDS) };
    await signedIn("h2", T + 1_000);
    setSystemTime(new Date(T + 2_000));
    resetOpenShiftSessions();
    expect(await getSession()).toBeNull();
    expect(writes.find((write) => write.op === "set")?.value).toBe("loop");
    expect(info.mock.calls[1][1]).toEqual({ route: "auth", loop: true });
  });

  test("with a live record clears a marker an earlier miss left", async () => {
    await signedIn("h1");
    jar["access-review-retry"] = { value: String(T_SECONDS - 5) };
    expect(await getSession()).toMatchObject(payload("h1"));
    expect(names("delete")).toEqual(["access-review-retry"]);
  });
});

describe("sessions across a mode switch", () => {
  test("a local or OIDC session reads as signed out in openshift mode, and arms no marker", async () => {
    for (const session of [
      { role: "admin" as const, username: "admin@libredb.org" },
      { role: "user" as const, username: "ada@example.com", idpSubject: "kc-1", idpIssuer: "https://sso.example.com" },
    ]) {
      writes = [];
      jar["auth-token"] = { value: await signJWT(session) };
      expect(await getSession()).toBeNull();
      expect(names("delete")).toEqual(["auth-token"]);
      expect(names("set")).toEqual([]);
    }
  });

  test("an openshift session reads as signed out in local and oidc modes, and arms no marker", async () => {
    await signedIn("h1");
    for (const mode of ["local", "oidc"]) {
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = mode;
      writes = [];
      expect(await getSession()).toBeNull();
      expect(names("delete")).toEqual(["auth-token"]);
      expect(names("set")).toEqual([]);
    }
  });
});

// Whenever the auth cookies are Secure, the marker openshift mode settles is __Host-access-review-retry.
describe("the retry marker in openshift mode with host-prefixed names", () => {
  beforeEach(() => {
    process.env.AUTH_COOKIE_SECURE = "true";
  });
  afterEach(() => {
    delete process.env.AUTH_COOKIE_SECURE;
  });

  test("a restart arms __Host-access-review-retry, and a live record clears it", async () => {
    await signedIn("h1", T - 600_000);
    jar["__Host-auth-token"] = jar["auth-token"];
    delete jar["auth-token"];
    resetOpenShiftSessions();
    expect(await getSession()).toBeNull();
    // The refused session is cleared, and with it the plain-named session cookie, which is never read.
    expect(names("delete")).toEqual(["__Host-auth-token", "auth-token"]);
    expect(names("set")).toEqual(["__Host-access-review-retry"]);

    writes = [];
    await signedIn("h2");
    jar["__Host-auth-token"] = jar["auth-token"];
    jar["__Host-access-review-retry"] = { value: String(T_SECONDS - 5) };
    expect(await getSession()).toMatchObject(payload("h2"));
    expect(names("delete")).toEqual(["__Host-access-review-retry"]);
  });
});
