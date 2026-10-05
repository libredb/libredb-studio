/**
 * Launch tokens are single use (docs/LAUNCH.md): the jti of every accepted token is remembered until
 * the token could no longer verify, and a second presentation inside that window is refused.
 *
 * In process memory, for the reasons src/lib/totp.ts keeps its spent codes there: Studio runs one
 * replica by default, and a shared store would make an availability dependency out of a control that
 * must never be the reason nobody can sign in. With more than one replica each process remembers only
 * the tokens it accepted, so a captured token can be replayed once per replica inside its lifetime,
 * which the 60-second ceiling keeps short.
 */

/**
 * A ceiling on the map. Only a token that verified under this server's secret reaches it, so only the
 * platform holding that secret adds entries, one per launch, and pruning by expiry holds the map at the
 * launches of the last minute. A full map fails closed: a new launch is refused until remembered tokens
 * expire, and no remembered jti is ever dropped early to make room, because a dropped jti would make a
 * captured token replayable while it can still verify.
 */
export const MAX_REMEMBERED_LAUNCHES = 4096;

const remembered = new Map<string, number>();

/**
 * Remembers a jti until `forgetAfter` (epoch milliseconds). Answers "replayed" when the jti is already
 * remembered, and "full", remembering nothing, while the map holds MAX_REMEMBERED_LAUNCHES tokens that
 * could still verify.
 */
export function claimLaunchJti(
  jti: string,
  forgetAfter: number,
  now: number = Date.now(),
): "claimed" | "replayed" | "full" {
  for (const [key, expiry] of remembered) {
    if (expiry <= now) remembered.delete(key);
  }
  if (remembered.has(jti)) return "replayed";
  if (remembered.size >= MAX_REMEMBERED_LAUNCHES) return "full";
  remembered.set(jti, forgetAfter);
  return "claimed";
}

/** Test seam, like clearTotpReplayState. */
export function clearLaunchReplayState(): void {
  remembered.clear();
}
