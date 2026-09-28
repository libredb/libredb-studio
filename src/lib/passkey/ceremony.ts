/**
 * The passkey ceremony token (docs/PASSKEYS.md, "How it works").
 *
 * Each ceremony gets 32 fresh random bytes as its challenge, carried in a token signed with a key derived for this
 * purpose alone, so a ceremony token is not a session and a session is not a ceremony token by construction.
 * The token travels in an HttpOnly cookie rather than a JSON field: the cookie binds the challenge to the browser
 * that started the ceremony, which a value echoed in a request body cannot do, and that binding is the defence
 * against login CSRF. SameSite=Strict keeps another site from carrying the cookie into a verify request.
 * Taking a ceremony deletes its cookie before anything is verified, whatever the outcome, so one cookie serves one
 * attempt; the spent-challenge table makes a second success impossible across replicas.
 */
import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";
import { shouldMarkCookieSecure } from "@/lib/auth";
import { derivedSigningKey } from "@/lib/config/auth-env";
import { getBasePath } from "@/lib/config/base-path";
import {
  PASSKEY_CEREMONY_TTL_SECONDS,
  PASSKEY_CHALLENGE_BYTES,
  PASSKEY_SPENT_GRACE_SECONDS,
  PASSKEY_USER_HANDLE_BYTES,
} from "@/lib/passkey/policy";

const CEREMONY_LABEL = "libredb.passkey.ceremony.v1";
const TOKEN_TYPE = "libredb-passkey+jwt";
const SIGN_IN_COOKIE = "passkey-sign-in";
const REGISTRATION_COOKIE = "passkey-registration";

type Purpose = "sign-in" | "registration";

export interface SignInCeremony {
  challenge: string;
  rpId: string;
  expiresAt: string;
}

export interface RegistrationCeremony extends SignInCeremony {
  email: string;
  sessionVersion: number;
  userHandle: string;
}

function cookiePath(): string {
  return `${getBasePath()}/api/auth/passkey`;
}

/** True when the value is canonical base64url for exactly `bytes` bytes. */
function isBase64UrlOf(value: unknown, bytes: number): boolean {
  if (typeof value !== "string") return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === bytes && decoded.toString("base64url") === value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

async function open(
  purpose: Purpose,
  cookieName: string,
  rpId: string,
  registration: { email: string; sessionVersion: number; userHandle: string } | null,
  clock: () => number,
): Promise<SignInCeremony> {
  // A caller bug fails here, loudly, rather than as a ceremony that no verify can accept.
  if (!isNonEmptyString(rpId)) throw new Error("passkey ceremony needs an RP ID");
  if (registration) {
    if (!isNonEmptyString(registration.email)) throw new Error("passkey registration ceremony needs an email");
    const { sessionVersion } = registration;
    if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) {
      throw new Error("passkey registration ceremony needs a non-negative integer session version");
    }
    if (!isBase64UrlOf(registration.userHandle, PASSKEY_USER_HANDLE_BYTES)) {
      throw new Error(`passkey registration ceremony needs a ${PASSKEY_USER_HANDLE_BYTES}-byte user handle`);
    }
  }
  const challenge = randomBytes(PASSKEY_CHALLENGE_BYTES).toString("base64url");
  const iat = Math.floor(clock() / 1000);
  const exp = iat + PASSKEY_CEREMONY_TTL_SECONDS;
  const jwt = new SignJWT({
    pur: purpose,
    chl: challenge,
    rp: rpId,
    ...(registration ? { uh: registration.userHandle, sv: registration.sessionVersion } : {}),
  }).setProtectedHeader({ alg: "HS256", typ: TOKEN_TYPE });
  if (registration) jwt.setSubject(registration.email);
  const token = await jwt
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(await derivedSigningKey(CEREMONY_LABEL));
  (await cookies()).set(cookieName, token, {
    httpOnly: true,
    secure: await shouldMarkCookieSecure(),
    sameSite: "strict",
    path: cookiePath(),
    maxAge: PASSKEY_CEREMONY_TTL_SECONDS,
  });
  return { challenge, rpId, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Reads and deletes the cookie, then returns the verified claims or null for any token that is not this ceremony. */
async function take(
  purpose: Purpose,
  cookieName: string,
  requiredClaims: string[],
  clock: () => number,
): Promise<Record<string, unknown> | null> {
  const store = await cookies();
  const token = store.get(cookieName)?.value;
  store.delete({ name: cookieName, path: cookiePath() });
  if (!token) return null;
  // Outside the try: a missing or short JWT_SECRET is the server's fault, not a bad token.
  const key = await derivedSigningKey(CEREMONY_LABEL);
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      typ: TOKEN_TYPE,
      requiredClaims: ["pur", "chl", "rp", "iat", "exp", ...requiredClaims],
      currentDate: new Date(clock()),
    }));
  } catch {
    // Forged, expired or malformed: every one of them is simply no ceremony.
    return null;
  }
  const valid =
    payload.pur === purpose && isBase64UrlOf(payload.chl, PASSKEY_CHALLENGE_BYTES) && isNonEmptyString(payload.rp);
  return valid ? payload : null;
}

function ceremonyOf(payload: Record<string, unknown>): SignInCeremony {
  return {
    challenge: payload.chl as string,
    rpId: payload.rp as string,
    expiresAt: new Date((payload.exp as number) * 1000).toISOString(),
  };
}

export async function openSignInCeremony(rpId: string, clock: () => number = Date.now): Promise<SignInCeremony> {
  return open("sign-in", SIGN_IN_COOKIE, rpId, null, clock);
}

export async function openRegistrationCeremony(
  input: { rpId: string; email: string; sessionVersion: number; userHandle: string },
  clock: () => number = Date.now,
): Promise<RegistrationCeremony> {
  const { rpId, ...registration } = input;
  return { ...(await open("registration", REGISTRATION_COOKIE, rpId, registration, clock)), ...registration };
}

export async function takeSignInCeremony(clock: () => number = Date.now): Promise<SignInCeremony | null> {
  const payload = await take("sign-in", SIGN_IN_COOKIE, [], clock);
  return payload ? ceremonyOf(payload) : null;
}

export async function takeRegistrationCeremony(clock: () => number = Date.now): Promise<RegistrationCeremony | null> {
  const payload = await take("registration", REGISTRATION_COOKIE, ["sub", "sv", "uh"], clock);
  if (!payload) return null;
  const { sub, sv, uh } = payload;
  const valid =
    isNonEmptyString(sub) &&
    typeof sv === "number" &&
    Number.isSafeInteger(sv) &&
    sv >= 0 &&
    isBase64UrlOf(uh, PASSKEY_USER_HANDLE_BYTES);
  return valid ? { ...ceremonyOf(payload), email: sub, sessionVersion: sv, userHandle: uh as string } : null;
}

/** The SHA-256 of the challenge bytes, hex: the key the spent-challenge table stores in place of the challenge. */
export function challengeHash(challenge: string): string {
  return createHash("sha256").update(Buffer.from(challenge, "base64url")).digest("hex");
}

/**
 * The spent-challenge write both ceremonies hand the store. Both purge the one shared table, so the horizon is
 * computed here once: a spent challenge outlives its token by the grace, for replicas whose clocks trail.
 */
export function spentChallengeWrite(
  ceremony: SignInCeremony,
  now: number,
): { challenge: { hash: string; expiresAt: string }; purgeSpentBefore: string } {
  return {
    challenge: { hash: challengeHash(ceremony.challenge), expiresAt: ceremony.expiresAt },
    purgeSpentBefore: new Date(now - PASSKEY_SPENT_GRACE_SECONDS * 1000).toISOString(),
  };
}
