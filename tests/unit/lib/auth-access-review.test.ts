/**
 * getSession() with the Kubernetes access review on (docs/SECURITY.md, control 1.12).
 *
 * An OIDC cookie session is served only while its subject's groups record is live. One that lost it, after a restart
 * or an eviction, is refused: its cookie is cleared, so the browser signs in again silently, and the retry marker
 * remembers the second of that miss. A session minted at or after the marker that misses again trips the loop guard,
 * so the OIDC login route shows the sign-in page instead of another round trip. A live record clears the marker. A
 * session without a subject, the break-glass password sign-in, is served as before, and with the review off nothing
 * changes.
 */
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";

const ISSUER = "https://rancher.example.com/oidc";
const T = Date.parse("2026-10-28T08:00:00.000Z");
const T_SECONDS = T / 1000;

let jar: Record<string, { value: string } | undefined> = {};
let writes: { op: string; name: string; value?: string; options?: Record<string, unknown> }[] = [];

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar[name],
    set: (name: string, value: string, options?: Record<string, unknown>) =>
      writes.push({ op: "set", name, value, options }),
    delete: (cookie: string | { name: string }) =>
      writes.push({ op: "delete", name: typeof cookie === "string" ? cookie : cookie.name }),
  }),
  headers: async () => ({ get: () => null }),
}));

const { getSession, signJWT } = await import("@/lib/auth");
type UserPayload = import("@/lib/auth").UserPayload;
const { recordGroups, resetGroupRecords } = await import("@/lib/kubernetes-access/groups");
const { logger } = await import("@/lib/logger");

const DEV_A = { role: "user" as const, username: "u-rjs2h", idpSubject: "u-rjs2h", idpIssuer: ISSUER };

let info: ReturnType<typeof spyOn>;

beforeEach(() => {
  setSystemTime(new Date(T));
  resetGroupRecords();
  jar = {};
  writes = [];
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
  process.env.KUBERNETES_ACCESS_REVIEW = "on";
  process.env.AUTH_SESSION_TTL_SECONDS = "900";
  info = spyOn(logger, "info").mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  setSystemTime();
  resetGroupRecords();
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
  delete process.env.KUBERNETES_ACCESS_REVIEW;
  delete process.env.AUTH_SESSION_TTL_SECONDS;
});

/** Puts a session minted at `mintedAt` (ms) into the cookie jar. */
async function signedInAt(mintedAt: number, payload: UserPayload = DEV_A): Promise<void> {
  setSystemTime(new Date(mintedAt));
  jar["auth-token"] = { value: await signJWT(payload) };
  setSystemTime(new Date(T));
}

const names = (op: string) => writes.filter((write) => write.op === op).map((write) => write.name);

describe("an OIDC session with the review on", () => {
  test("is served while its subject's groups record is live, and touches no cookie", async () => {
    await signedInAt(T - 60_000);
    recordGroups(ISSUER, "u-rjs2h", [], T - 60_000);
    expect(await getSession()).toMatchObject(DEV_A);
    expect(writes).toEqual([]);
  });

  test("clears a retry marker once its record is live again", async () => {
    await signedInAt(T - 2000);
    recordGroups(ISSUER, "u-rjs2h", [], T - 2000);
    jar["access-review-retry"] = { value: String(T_SECONDS - 3) };
    expect(await getSession()).toMatchObject(DEV_A);
    expect(names("delete")).toEqual(["access-review-retry"]);
  });

  test("without a record, is refused once: its cookie is cleared and the marker armed with the second of the miss", async () => {
    await signedInAt(T - 600_000);
    expect(await getSession()).toBeNull();
    expect(names("delete")).toEqual(["auth-token"]);
    const marker = writes.find((write) => write.op === "set");
    expect(marker).toEqual({
      op: "set",
      name: "access-review-retry",
      value: String(T_SECONDS),
      options: { httpOnly: true, secure: false, sameSite: "lax", maxAge: 300, path: "/" },
    });
    expect(info.mock.calls[0][1]).toEqual({ route: "auth", loop: false });
  });

  test("minted after the marker and missing again, trips the loop guard", async () => {
    await signedInAt(T - 1000);
    jar["access-review-retry"] = { value: String(T_SECONDS - 2) };
    expect(await getSession()).toBeNull();
    expect(writes.find((write) => write.op === "set")?.value).toBe("loop");
    expect(info.mock.calls[0][1]).toEqual({ route: "auth", loop: true });
  });

  test("minted before the marker, another tab after the same restart, leaves the marker alone", async () => {
    await signedInAt(T - 600_000);
    jar["access-review-retry"] = { value: String(T_SECONDS - 2) };
    expect(await getSession()).toBeNull();
    expect(names("set")).toEqual([]);
    expect(names("delete")).toEqual(["auth-token"]);
  });
});

describe("what the review leaves alone", () => {
  test("a session without an identity provider subject, the break-glass password sign-in", async () => {
    await signedInAt(T - 60_000, { role: "admin", username: "admin@libredb.org" });
    expect(await getSession()).toMatchObject({ role: "admin", username: "admin@libredb.org" });
    expect(writes).toEqual([]);
  });

  test("every session while the review is off", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "off";
    await signedInAt(T - 600_000);
    expect(await getSession()).toMatchObject(DEV_A);
    expect(writes).toEqual([]);
  });
});
