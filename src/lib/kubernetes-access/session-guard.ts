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
 * A session without an identity provider subject, such as the break-glass password sign-in, was never reviewed and is
 * kept: every reviewed connection is denied to it (gate.ts).
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

/** What `readSession` does with a verified session while the review is on, given the retry marker it carries. */
export function groupsRecordCheck(
  session: CheckedSession,
  marker: string | undefined,
  nowMs = Date.now(),
): GroupsRecordCheck {
  if (!session.idpSubject) return { kind: "kept", clearMarker: false };
  if (recordedGroups(session.idpIssuer, session.idpSubject, nowMs) !== null) {
    return { kind: "kept", clearMarker: marker !== undefined };
  }
  if (marker === LOOP) return { kind: "refused", marker: null };
  const armed = armedAt(marker);
  if (armed === null) return { kind: "refused", marker: String(Math.floor(nowMs / 1000)) };
  return { kind: "refused", marker: (session.iat ?? 0) >= armed ? LOOP : null };
}

/** Whether the OIDC login route shows the sign-in page instead of going to the provider. */
export function retryLoopTripped(marker: string | undefined): boolean {
  return marker === LOOP;
}
