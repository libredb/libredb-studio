/**
 * What a verified OIDC session needs while the Kubernetes access review is on: the groups record of its subject.
 *
 * No review ever runs without that record, and the record lives only in this process's memory (groups.ts), so a
 * restart or an eviction leaves live sessions without one. Such a session is refused once: `readSession` clears its
 * cookie, the browser's next sign-in is the silent round trip through the identity provider, and the callback records
 * the groups anew. The retry marker cookie remembers the second of that first miss.
 *
 * A session minted at or after that second which misses again is the second miss in a row: its record went missing
 * right after the sign-in that wrote it, so another round trip would only repeat it (more than one Studio replica, or
 * a store that evicts faster than people sign in). The marker is then set to `loop`, and the OIDC login route answers
 * a `loop` marker with the sign-in page and its `oidc_groups_lost` message instead of the provider, deleting the marker,
 * so a person who signs in by hand gets one more silent attempt. A session minted before the marker, another tab of
 * the same browser refused after the same restart, never escalates it, and a session with a live record clears it.
 *
 * A session without an identity provider subject was signed in by no review, so no review decided its role either: a
 * password session minted before the review was switched on, which may be an admin. It is refused as well, leaving the
 * marker as it is, so it reaches no route while the review is on, as a session without a subject reaches none under
 * governance; the password route refuses to sign anyone in while the review is on.
 */
import { recordedGroups } from "./groups";

/** The retry marker: the epoch second of a first miss, or `loop` once a second miss in a row tripped the guard. */
export const ACCESS_REVIEW_RETRY_COOKIE = "access-review-retry";
/** Long enough for a sign-in that stops at the provider's own sign-in page. */
export const ACCESS_REVIEW_RETRY_MAX_AGE_SECONDS = 300;
const LOOP = "loop";

/** The session fields the check reads: its subject, its issuer and when it was minted, in epoch seconds. */
export interface CheckedSession {
  readonly idpSubject?: string;
  readonly idpIssuer?: string;
  readonly iat?: number;
}

/**
 * Kept, with whether a marker left by an earlier miss is to be cleared; or refused, with the marker value to set, or
 * null to leave the marker as it is.
 */
export type GroupsRecordCheck =
  | { readonly kind: "kept"; readonly clearMarker: boolean }
  | { readonly kind: "refused"; readonly marker: string | null };

/** The epoch second a marker armed at, or null for no marker, a tripped one or one that cannot be read. */
function armedAt(marker: string | undefined): number | null {
  return marker !== undefined && /^\d{1,12}$/.test(marker) ? Number(marker) : null;
}

/**
 * Whether a verified session's server-side record is live, missing, or the session is bound to none (no subject here,
 * no session handle in openshift sign-in mode, src/lib/openshift-auth/session.ts).
 */
export type SessionRecordState = "live" | "missing" | "unbound";

/** The retry marker state machine above, for a session whose record is in `state`, minted at `iat`. */
export function sessionRecordCheck(
  state: SessionRecordState,
  iat: number | undefined,
  marker: string | undefined,
  nowMs = Date.now(),
): GroupsRecordCheck {
  if (state === "unbound") return { kind: "refused", marker: null };
  if (state === "live") return { kind: "kept", clearMarker: marker !== undefined };
  if (marker === LOOP) return { kind: "refused", marker: null };
  const armed = armedAt(marker);
  if (armed === null) return { kind: "refused", marker: String(Math.floor(nowMs / 1000)) };
  return { kind: "refused", marker: (iat ?? 0) >= armed ? LOOP : null };
}

/** What `readSession` does with a verified session while the review is on, given the retry marker it carries. */
export function groupsRecordCheck(
  session: CheckedSession,
  marker: string | undefined,
  nowMs = Date.now(),
): GroupsRecordCheck {
  const recorded = session.idpSubject ? recordedGroups(session.idpIssuer, session.idpSubject, nowMs) !== null : false;
  const state: SessionRecordState = !session.idpSubject ? "unbound" : recorded ? "live" : "missing";
  return sessionRecordCheck(state, session.iat, marker, nowMs);
}

/** Whether the OIDC login route shows the sign-in page instead of going to the provider. */
export function retryLoopTripped(marker: string | undefined): boolean {
  return marker === LOOP;
}
