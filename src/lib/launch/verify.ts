/**
 * Verifies a platform launch token (docs/LAUNCH.md): a compact JWS signed with HS256 under
 * LAUNCH_TOKEN_SECRET that names the configured issuer and audience, lives at most 60 seconds and is
 * presented once.
 *
 * The header's typ must be exactly libredb-launch+jwt and is checked first, before the algorithm and the
 * signature (explicit typing, RFC 8725 section 3.11), so no other kind of JWT, such as a Studio session,
 * is ever taken for a launch token.
 *
 * The algorithm is pinned rather than read from the token, so a header naming "none" or any other
 * algorithm is refused before a signature or a claim is looked at: a token never chooses how it is
 * checked. Claims are read only after the signature verified, so nothing a forger writes decides
 * which refusal they get beyond "not signed for this Studio".
 *
 * Each refusal carries one reason from the audit union and a message the launch page shows as it
 * stands. The person holding the link learns whether it expired, was already used or belongs to
 * another Studio, which is what they need to recover, and nothing about any account.
 *
 * One refusal is about this server rather than the token: while the replay memory is full of tokens
 * that could still verify, a valid token is refused (the route answers 503) instead of a spent one
 * being forgotten to make room.
 */
import { decodeProtectedHeader, errors, jwtVerify, type JWTPayload } from "jose";
import type { AuditReason } from "@/lib/audit";
import type { Role } from "@/lib/auth";
import type { ReadyLaunchConfig } from "@/lib/launch/config";
import { claimLaunchJti } from "@/lib/launch/replay";

/** The typ every launch token carries, compared exactly. */
const LAUNCH_TOKEN_TYPE = "libredb-launch+jwt";

/** The longest exp minus iat a launch token may carry. */
export const LAUNCH_MAX_LIFETIME_SECONDS = 60;

/** Clock difference tolerated between the issuing platform and this server. */
export const LAUNCH_CLOCK_TOLERANCE_SECONDS = 5;

/** The connection claim names a seed id, so it takes the seed id rule (src/lib/seed/types.ts). */
const CONNECTION_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

/** The rule readEmail in src/lib/local-accounts.ts applies to an account email. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

/** Bounds what one remembered jti can cost the replay map; a platform's jti is far shorter. */
const MAX_JTI_LENGTH = 128;

export type LaunchTokenFailure = Extract<
  AuditReason,
  | "launch_token_malformed"
  | "launch_token_type"
  | "launch_token_signature"
  | "launch_token_issuer"
  | "launch_token_audience"
  | "launch_token_expired"
  | "launch_token_premature"
  | "launch_token_lifetime"
  | "launch_token_replayed"
  | "launch_capacity_exceeded"
>;

const MESSAGES: Record<LaunchTokenFailure, string> = {
  launch_token_malformed:
    "This launch link does not carry a valid sign-in token. Open Studio again from the platform that sent you.",
  launch_token_type:
    "This launch link does not carry a Studio launch token. Open Studio again from the platform that sent you.",
  launch_token_signature:
    "This launch link was not signed for this Studio. Open Studio again from the platform that manages it; if this keeps happening, the platform and this Studio no longer share a launch secret.",
  launch_token_issuer: "This launch link was issued by a platform this Studio does not trust.",
  launch_token_audience: "This launch link was issued for a different Studio.",
  launch_token_expired: "This launch link has expired. Open Studio again to get a new one.",
  launch_token_premature: "This launch link is not valid yet: the clocks of the platform and this Studio disagree.",
  launch_token_lifetime: "This launch link is valid for longer than this Studio accepts.",
  launch_token_replayed: "This launch link has already been used. Open Studio again to get a new one.",
  launch_capacity_exceeded:
    "Too many launches arrived at this Studio in the last minute. Wait a minute, then open Studio again.",
};

export class LaunchTokenError extends Error {
  readonly reason: LaunchTokenFailure;
  constructor(reason: LaunchTokenFailure) {
    super(MESSAGES[reason]);
    this.name = "LaunchTokenError";
    this.reason = reason;
  }
}

export interface LaunchClaims {
  readonly sub: string;
  readonly email: string;
  readonly role: Role;
  readonly conn?: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

function failureOf(error: errors.JOSEError): LaunchTokenFailure {
  if (error instanceof errors.JOSEAlgNotAllowed || error instanceof errors.JWSSignatureVerificationFailed) {
    return "launch_token_signature";
  }
  // maxTokenAge reports an iat older than the lifetime while exp still holds, which only a token
  // issued for longer than the lifetime can reach.
  if (error instanceof errors.JWTExpired) {
    return error.claim === "iat" ? "launch_token_lifetime" : "launch_token_expired";
  }
  if (error instanceof errors.JWTClaimValidationFailed && error.reason === "check_failed") {
    if (error.claim === "iss") return "launch_token_issuer";
    if (error.claim === "aud") return "launch_token_audience";
    if (error.claim === "iat" || error.claim === "nbf") return "launch_token_premature";
  }
  return "launch_token_malformed";
}

function headerTypeOf(token: string): unknown {
  try {
    return decodeProtectedHeader(token).typ;
  } catch {
    // jose reports text that is not a compact JWS with a JSON object header as a TypeError, not a JOSEError.
    throw new LaunchTokenError("launch_token_malformed");
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(value);
}

function claimsOf(payload: JWTPayload, audience: string): LaunchClaims {
  // jose accepts an audience array that merely contains ours; a launch token names exactly one.
  // requiredClaims already guarantees numeric iat and exp: the defaults only satisfy the type, and
  // would refuse the token as too long-lived if they were ever used.
  const { aud, sub, email, role, conn, jti, iat = 0, exp = Number.POSITIVE_INFINITY } = payload;
  if (aud !== audience) throw new LaunchTokenError("launch_token_audience");
  if (exp - iat > LAUNCH_MAX_LIFETIME_SECONDS) throw new LaunchTokenError("launch_token_lifetime");
  if (
    !isNonEmptyString(sub) ||
    !isEmail(email) ||
    (role !== "admin" && role !== "user") ||
    (conn !== undefined && (typeof conn !== "string" || !CONNECTION_ID_PATTERN.test(conn))) ||
    !isNonEmptyString(jti) ||
    jti.length > MAX_JTI_LENGTH
  ) {
    throw new LaunchTokenError("launch_token_malformed");
  }
  return { sub, email, role, jti, iat, exp, ...(conn === undefined ? {} : { conn }) };
}

/**
 * The verified claims of a launch token, or a LaunchTokenError naming why it is refused. The jti is
 * spent only once everything else holds, and it stays spent until the token could no longer verify,
 * its expiry plus the clock tolerance.
 */
export async function verifyLaunchToken(
  token: string,
  config: ReadyLaunchConfig,
  now: number = Date.now(),
): Promise<LaunchClaims> {
  // Before jwtVerify, so a token of another type is refused before its signature is checked.
  if (headerTypeOf(token) !== LAUNCH_TOKEN_TYPE) throw new LaunchTokenError("launch_token_type");
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, config.secret, {
      algorithms: ["HS256"],
      issuer: config.issuer,
      audience: config.audience,
      clockTolerance: LAUNCH_CLOCK_TOLERANCE_SECONDS,
      maxTokenAge: LAUNCH_MAX_LIFETIME_SECONDS,
      requiredClaims: ["sub", "jti", "iat", "exp"],
      currentDate: new Date(now),
    }));
  } catch (error) {
    if (error instanceof errors.JOSEError) throw new LaunchTokenError(failureOf(error));
    throw error;
  }
  const claims = claimsOf(payload, config.audience);
  // jose floors the current time, so a fractional exp verifies until ceil(exp) plus the tolerance.
  const spentUntil = (Math.ceil(claims.exp) + LAUNCH_CLOCK_TOLERANCE_SECONDS) * 1000;
  const claim = claimLaunchJti(claims.jti, spentUntil, now);
  if (claim === "replayed") throw new LaunchTokenError("launch_token_replayed");
  if (claim === "full") throw new LaunchTokenError("launch_capacity_exceeded");
  return claims;
}
