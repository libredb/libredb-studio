/**
 * The passkey ceremony token: a challenge bound to the browser that started the ceremony by a
 * signed, HttpOnly, SameSite=Strict cookie, read once, and never usable as a session or across purposes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import {
  cookieJar,
  deletedCookies,
  installNextHeadersMock,
  requestHeaders,
  resetCookieJar,
} from "../../../helpers/next-cookie-jar";

installNextHeadersMock();

const {
  challengeHash,
  openRegistrationCeremony,
  openSignInCeremony,
  spentChallengeWrite,
  takeRegistrationCeremony,
  takeSignInCeremony,
} = await import("@/lib/passkey/ceremony");
const { signJWT, verifyJWT } = await import("@/lib/auth");
const { derivedSigningKey } = await import("@/lib/config/auth-env");
const { AuthConfigError } = await import("@/lib/auth-errors");

const SIGN_IN = "passkey-sign-in";
const REGISTRATION = "passkey-registration";
const LABEL = "libredb.passkey.ceremony.v1";
const RP_ID = "localhost";
const USER_HANDLE = randomBytes(64).toString("base64url");
const REGISTRATION_INPUT = { rpId: RP_ID, email: "owner@example.com", sessionVersion: 3, userHandle: USER_HANDLE };
const NOW = Date.now();
const clock = () => NOW;

const ENV = ["NEXT_PUBLIC_BASE_PATH", "NODE_ENV", "AUTH_COOKIE_SECURE", "JWT_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete (process.env as Record<string, string>)[name];
  else (process.env as Record<string, string>)[name] = value;
}

beforeEach(() => {
  resetCookieJar();
  for (const name of ENV) saved[name] = process.env[name];
  setEnv("NEXT_PUBLIC_BASE_PATH", undefined);
  setEnv("AUTH_COOKIE_SECURE", undefined);
});

afterEach(() => {
  for (const name of ENV) setEnv(name, saved[name]);
});

function cookieValue(name: string): string {
  const entry = cookieJar.get(name);
  if (!entry) throw new Error(`cookie ${name} is not set`);
  return entry.value;
}

function putCookie(name: string, value: string): void {
  cookieJar.set(name, { value });
}

/** A token under the ceremony key with any claims, to reach the checks that run after the signature verifies. */
async function forge(claims: Record<string, unknown>, typ = "libredb-passkey+jwt", sub?: string): Promise<string> {
  const iat = Math.floor(NOW / 1000);
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ })
    .setIssuedAt(iat)
    .setExpirationTime(iat + 600);
  if (sub !== undefined) jwt.setSubject(sub);
  return jwt.sign(await derivedSigningKey(LABEL));
}

const GOOD_CHALLENGE = randomBytes(32).toString("base64url");

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The same bytes spelled with a last character whose unused low bits are set: the decoder ignores them. */
function nonCanonical(value: string): string {
  const last = BASE64URL.indexOf(value.at(-1) as string);
  return `${value.slice(0, -1)}${BASE64URL[last ^ 1]}`;
}

describe("passkey ceremony", () => {
  test("a sign-in ceremony sets one HttpOnly SameSite=Strict cookie scoped to the passkey API path under the base path", async () => {
    await openSignInCeremony(RP_ID);

    expect([...cookieJar.keys()]).toEqual([SIGN_IN]);
    expect(cookieJar.get(SIGN_IN)?.options).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: "strict",
      path: "/api/auth/passkey",
      maxAge: 600,
    });

    resetCookieJar();
    setEnv("NEXT_PUBLIC_BASE_PATH", "/tools/libredb");
    await openSignInCeremony(RP_ID);

    expect(cookieJar.get(SIGN_IN)?.options?.path).toBe("/tools/libredb/api/auth/passkey");
  });

  test("a registration ceremony sets its own cookie", async () => {
    await openRegistrationCeremony(REGISTRATION_INPUT);

    expect([...cookieJar.keys()]).toEqual([REGISTRATION]);
    expect(cookieJar.get(REGISTRATION)?.options).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: "strict",
      path: "/api/auth/passkey",
      maxAge: 600,
    });
  });

  test("a ceremony cookie is Secure exactly when the session cookie would be", async () => {
    setEnv("NODE_ENV", "production");
    await openSignInCeremony(RP_ID);

    expect(cookieJar.get(SIGN_IN)?.options?.secure).toBe(true);

    resetCookieJar();
    requestHeaders.set("host", "localhost:3000");
    await openSignInCeremony(RP_ID);

    expect(cookieJar.get(SIGN_IN)?.options?.secure).toBe(false);
  });

  test("the challenge is 32 random bytes and its digest is the SHA-256 of those bytes", async () => {
    const first = await openSignInCeremony(RP_ID);
    const second = await openSignInCeremony(RP_ID);

    expect(Buffer.from(first.challenge, "base64url").length).toBe(32);
    expect(first.challenge).not.toBe(second.challenge);
    expect(challengeHash(first.challenge)).toBe(
      createHash("sha256").update(Buffer.from(first.challenge, "base64url")).digest("hex"),
    );
  });

  test("a spent challenge is written as its digest and expiry, and the purge keeps the grace past it", async () => {
    const opened = await openSignInCeremony(RP_ID, clock);
    expect(spentChallengeWrite(opened, NOW)).toEqual({
      challenge: { hash: challengeHash(opened.challenge), expiresAt: opened.expiresAt },
      // PASSKEY_SPENT_GRACE_SECONDS, spelled out so a change to the horizon is a visible change here.
      purgeSpentBefore: new Date(NOW - 600_000).toISOString(),
    });
  });

  test("taking a ceremony returns its claims and clears its cookie", async () => {
    const opened = await openSignInCeremony(RP_ID, clock);
    const taken = await takeSignInCeremony(clock);

    expect(taken).toEqual(opened);
    expect(taken?.rpId).toBe(RP_ID);
    expect(taken?.expiresAt).toBe(new Date((Math.floor(NOW / 1000) + 600) * 1000).toISOString());
    expect(cookieJar.has(SIGN_IN)).toBe(false);
    expect(deletedCookies).toEqual([{ name: SIGN_IN, path: "/api/auth/passkey" }]);
  });

  test("taking a ceremony clears its cookie whether or not it verifies", async () => {
    putCookie(SIGN_IN, "garbage");

    expect(await takeSignInCeremony()).toBeNull();
    expect(cookieJar.has(SIGN_IN)).toBe(false);
    expect(deletedCookies).toEqual([{ name: SIGN_IN, path: "/api/auth/passkey" }]);
  });

  test("a missing cookie reads as no ceremony", async () => {
    expect(await takeSignInCeremony()).toBeNull();
    expect(await takeRegistrationCeremony()).toBeNull();
    expect(deletedCookies).toEqual([
      { name: SIGN_IN, path: "/api/auth/passkey" },
      { name: REGISTRATION, path: "/api/auth/passkey" },
    ]);
  });

  test("a registration token is refused as a sign-in ceremony and the reverse", async () => {
    await openRegistrationCeremony(REGISTRATION_INPUT);
    putCookie(SIGN_IN, cookieValue(REGISTRATION));

    expect(await takeSignInCeremony()).toBeNull();

    resetCookieJar();
    await openSignInCeremony(RP_ID);
    putCookie(REGISTRATION, cookieValue(SIGN_IN));

    expect(await takeRegistrationCeremony()).toBeNull();
  });

  test("an expired, tampered or claim-missing token reads as no ceremony", async () => {
    await openSignInCeremony(RP_ID, clock);

    expect(await takeSignInCeremony(() => NOW + 601_000)).toBeNull();

    await openSignInCeremony(RP_ID);
    const [header, payload, signature] = cookieValue(SIGN_IN).split(".");
    const flipped = signature[10] === "A" ? "B" : "A";
    putCookie(SIGN_IN, `${header}.${payload}.${signature.slice(0, 10)}${flipped}${signature.slice(11)}`);

    expect(await takeSignInCeremony()).toBeNull();

    putCookie(SIGN_IN, await forge({ pur: "sign-in", rp: RP_ID }));

    expect(await takeSignInCeremony(clock)).toBeNull();
  });

  test("a token with the right key but the wrong header type or malformed claims reads as no ceremony", async () => {
    const cases = [
      await forge({ pur: "sign-in", chl: GOOD_CHALLENGE, rp: RP_ID }, "JWT"),
      await forge({ pur: "sign-in", chl: randomBytes(16).toString("base64url"), rp: RP_ID }),
      await forge({ pur: "sign-in", chl: `${GOOD_CHALLENGE.slice(0, -1)}*`, rp: RP_ID }),
      await forge({ pur: "sign-in", chl: nonCanonical(GOOD_CHALLENGE), rp: RP_ID }),
      await forge({ pur: "sign-in", chl: 42, rp: RP_ID }),
      await forge({ pur: "sign-in", chl: GOOD_CHALLENGE, rp: "" }),
      await forge({ pur: "sign-in", chl: GOOD_CHALLENGE, rp: 7 }),
    ];
    for (const token of cases) {
      putCookie(SIGN_IN, token);
      // oxlint-disable-next-line no-await-in-loop -- the cases share one cookie jar, so each take follows its put.
      expect(await takeSignInCeremony(clock)).toBeNull();
    }

    putCookie(SIGN_IN, await forge({ pur: "sign-in", chl: GOOD_CHALLENGE, rp: RP_ID }));

    expect(await takeSignInCeremony(clock)).toEqual({
      challenge: GOOD_CHALLENGE,
      rpId: RP_ID,
      expiresAt: new Date((Math.floor(NOW / 1000) + 600) * 1000).toISOString(),
    });
  });

  test("a token signed with the session key, or a session token, is not a ceremony", async () => {
    putCookie(SIGN_IN, await signJWT({ role: "user", username: "u" }));

    expect(await takeSignInCeremony()).toBeNull();

    const ceremony = await openSignInCeremony(RP_ID);
    expect(ceremony.challenge.length).toBeGreaterThan(0);

    expect(await verifyJWT(cookieValue(SIGN_IN))).toBeNull();
  });

  test("a registration ceremony carries its account, session version and user handle", async () => {
    const opened = await openRegistrationCeremony(REGISTRATION_INPUT, clock);
    const taken = await takeRegistrationCeremony(clock);

    expect(taken).toEqual(opened);
    expect(taken).toMatchObject({ email: "owner@example.com", sessionVersion: 3, userHandle: USER_HANDLE });

    const base = { pur: "registration", chl: GOOD_CHALLENGE, rp: RP_ID, sv: 0, uh: USER_HANDLE };
    putCookie(REGISTRATION, await forge(base, undefined, "owner@example.com"));

    expect(await takeRegistrationCeremony(clock)).toMatchObject({ sessionVersion: 0 });

    const refused = [
      await forge({ ...base, sv: -1 }, undefined, "owner@example.com"),
      await forge({ ...base, sv: 1.5 }, undefined, "owner@example.com"),
      await forge({ ...base, sv: "3" }, undefined, "owner@example.com"),
      await forge({ ...base, sv: Number.MAX_SAFE_INTEGER + 2 }, undefined, "owner@example.com"),
      await forge({ ...base, uh: randomBytes(32).toString("base64url") }, undefined, "owner@example.com"),
      await forge(base, undefined, ""),
      await forge(base),
    ];
    for (const token of refused) {
      putCookie(REGISTRATION, token);
      // oxlint-disable-next-line no-await-in-loop -- the cases share one cookie jar, so each take follows its put.
      expect(await takeRegistrationCeremony(clock)).toBeNull();
    }
  });

  test("the non-canonical challenge decodes to the same 32 bytes, so only the round trip refuses it", () => {
    const value = nonCanonical(GOOD_CHALLENGE);
    expect(value).not.toBe(GOOD_CHALLENGE);
    expect(Buffer.from(value, "base64url")).toEqual(Buffer.from(GOOD_CHALLENGE, "base64url"));
  });

  test("opening a ceremony with input no ceremony could carry throws and sets no cookie", async () => {
    await expect(openSignInCeremony("")).rejects.toThrow("passkey ceremony needs an RP ID");
    const cases: Array<[Partial<typeof REGISTRATION_INPUT> | Record<string, unknown>, string]> = [
      [{ rpId: "" }, "passkey ceremony needs an RP ID"],
      [{ email: "" }, "passkey registration ceremony needs an email"],
      [{ sessionVersion: -1 }, "passkey registration ceremony needs a non-negative integer session version"],
      [{ sessionVersion: 1.5 }, "passkey registration ceremony needs a non-negative integer session version"],
      [
        { userHandle: randomBytes(32).toString("base64url") },
        "passkey registration ceremony needs a 64-byte user handle",
      ],
      [{ userHandle: nonCanonical(USER_HANDLE) }, "passkey registration ceremony needs a 64-byte user handle"],
    ];
    for (const [override, message] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- each case checks the shared cookie jar after it.
      await expect(
        openRegistrationCeremony({ ...REGISTRATION_INPUT, ...override } as typeof REGISTRATION_INPUT),
      ).rejects.toThrow(message);
    }
    expect(cookieJar.size).toBe(0);
  });

  test("a missing JWT_SECRET is a server error, not a missing ceremony", async () => {
    await openSignInCeremony(RP_ID);
    setEnv("JWT_SECRET", undefined);
    setEnv("NODE_ENV", "production");

    await expect(takeSignInCeremony()).rejects.toThrow(AuthConfigError);
  });
});
