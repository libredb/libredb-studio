/**
 * Session rules of openshift sign-in: the random handle that keys a token record, the session lifetime, and the record
 * check `readSession` runs on every verified openshift session.
 *
 * The lifetime is the configured session lifetime (8 hours by default in this mode) capped by the token's own expiry,
 * one value for the JWT `exp`, the cookie `Max-Age` and the record. A session reads as signed in only while its record
 * is live; the first miss (a restart, an eviction) refuses it and arms the access review's retry marker, so the next
 * sign-in meets the OAuth server's login page, and a second miss in a row trips the loop guard (session-guard.ts).
 */

import type { UserPayload } from "@/lib/auth";
import { sessionTtlSeconds } from "@/lib/config/auth-env";
import {
  type GroupsRecordCheck,
  type SessionRecordState,
  sessionRecordCheck,
} from "@/lib/kubernetes-access/session-guard";
import { openShiftBearerToken, openShiftSessionKey } from "@/lib/openshift-auth/token-store";

/** 32 random bytes in base64url: 43 characters no one can guess. */
export function newSessionHandle(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** The session lifetime, capped by the access token's expiry when it has one. */
export function openShiftSessionLifetimeSeconds(expiresIn: number | null): number {
  const lifetime = sessionTtlSeconds();
  return expiresIn === null ? lifetime : Math.min(lifetime, expiresIn);
}

/** What `readSession` does with a verified session in openshift mode, given the retry marker it carries. */
export function openShiftRecordCheck(
  session: UserPayload & { iat?: number },
  marker: string | undefined,
  nowMs = Date.now(),
): GroupsRecordCheck {
  const key = openShiftSessionKey(session);
  const live = key !== null && openShiftBearerToken(key, nowMs) !== null;
  const state: SessionRecordState = key === null ? "unbound" : live ? "live" : "missing";
  return sessionRecordCheck(state, session.iat, marker, nowMs);
}
