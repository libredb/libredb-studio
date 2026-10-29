import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import { derivedSigningKey } from "@/lib/config/auth-env";
import {
  decryptOpenShiftState,
  encryptOpenShiftState,
  OPENSHIFT_STATE_COOKIE,
  openShiftStateCookiePath,
} from "@/lib/openshift-auth/state";

const SECRET = "a-test-secret-that-is-32-chars!!";
const STATE = { code_verifier: "verifier-not-a-real-value", state: "state-not-a-real-value" };
const LABEL = "libredb.openshift.state.v1";
const TYP = "libredb-openshift-state+jwt";
const KEYS = ["JWT_SECRET", "NEXT_PUBLIC_BASE_PATH"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  process.env.JWT_SECRET = SECRET;
  delete process.env.NEXT_PUBLIC_BASE_PATH;
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** A token with `payload`, signed with `key` under header `typ`, issued `ageSeconds` ago with a five-minute life. */
async function token(payload: Record<string, unknown>, key: Uint8Array, typ = TYP, ageSeconds = 0): Promise<string> {
  const iat = Math.floor(Date.now() / 1000) - ageSeconds;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ })
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .sign(key);
}

describe("openshift state cookie", () => {
  test("the cookie name is fixed and its path is the narrowest that reaches the callback", () => {
    expect(OPENSHIFT_STATE_COOKIE).toBe("openshift-state");
    expect(openShiftStateCookiePath()).toBe("/api/auth/openshift");
    process.env.NEXT_PUBLIC_BASE_PATH = "/studio";
    expect(openShiftStateCookiePath()).toBe("/studio/api/auth/openshift");
  });

  test("round-trips the verifier, the state and the return path", async () => {
    expect(await decryptOpenShiftState(await encryptOpenShiftState(STATE))).toEqual(STATE);
    const withReturn = { ...STATE, return_to: "/sql" };
    expect(await decryptOpenShiftState(await encryptOpenShiftState(withReturn))).toEqual(withReturn);
  });

  test("a token signed with the session key, the OIDC state label or under another typ is refused", async () => {
    const sessionKey = new TextEncoder().encode(SECRET);
    await expect(decryptOpenShiftState(await token(STATE, sessionKey))).rejects.toThrow();
    const oidcKey = await derivedSigningKey("libredb.oidc.state.v1");
    await expect(decryptOpenShiftState(await token(STATE, oidcKey))).rejects.toThrow();
    const ownKey = await derivedSigningKey(LABEL);
    expect(await decryptOpenShiftState(await token(STATE, ownKey))).toEqual(STATE);
    await expect(decryptOpenShiftState(await token(STATE, ownKey, "libredb-oidc-state+jwt"))).rejects.toThrow();
    await expect(decryptOpenShiftState(await token(STATE, ownKey, "JWT"))).rejects.toThrow();
  });

  test("a token six minutes old is refused", async () => {
    const ownKey = await derivedSigningKey(LABEL);
    await expect(decryptOpenShiftState(await token(STATE, ownKey, TYP, 360))).rejects.toThrow();
  });

  test("a payload without a string verifier or state is refused", async () => {
    const ownKey = await derivedSigningKey(LABEL);
    await expect(decryptOpenShiftState(await token({ state: "s" }, ownKey))).rejects.toThrow("sign-in state");
    await expect(decryptOpenShiftState(await token({ code_verifier: 1, state: "s" }, ownKey))).rejects.toThrow();
    await expect(decryptOpenShiftState(await token({ code_verifier: "v" }, ownKey))).rejects.toThrow();
    const withNumberReturn = await token({ ...STATE, return_to: 5 }, ownKey);
    expect(await decryptOpenShiftState(withNumberReturn)).toEqual(STATE);
  });

  test("a missing JWT_SECRET throws in every environment: no development fallback", async () => {
    delete process.env.JWT_SECRET;
    await expect(encryptOpenShiftState(STATE)).rejects.toThrow("JWT_SECRET");
    await expect(decryptOpenShiftState("x.y.z")).rejects.toThrow("JWT_SECRET");
  });
});
