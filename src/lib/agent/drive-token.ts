/**
 * The credential a machine presents when it asks this server to drive an agent run
 * (#329 T9, epic #325) — the resume seam, verified by `src/proxy.ts` and again by
 * the route itself.
 *
 * Nothing mints one in production yet: no queue produces a drive delivery, so the
 * only callers today are the tests that pin these properties (`docs/BACKLOG.md` B9).
 * The credential exists now because the seam it guards had to be designed with the
 * boundary, not bolted onto it afterwards.
 *
 * `src/proxy.ts` exempts exactly four things — the auth paths, static assets, the
 * health GET and the storage-config GET — and this milestone's constraint is that
 * the drive path does NOT join them. An exemption is path-shaped: anyone who can
 * reach the port gets in. So the drive path is guarded by a credential instead, and
 * this module is that credential:
 *
 *  - **Single purpose.** It names one run and authorizes one thing: driving it. It
 *    is not a session, carries no user and no role, and grants nothing else.
 *  - **Short-lived.** A minute — long enough for a queue delivery and its retries,
 *    short enough that a copy out of a log is worthless by the time it is read.
 *  - **Not a session, by construction rather than by inspection.** The signing key
 *    is DERIVED from `JWT_SECRET` rather than being it, so a drive token simply does
 *    not verify under the session key and a session token does not verify under
 *    this one. That matters in a specific way: `verifyJWT` casts its payload to
 *    `UserPayload` without inspecting it, so a drive token accepted there would
 *    present as a session whose role is undefined — which `proxy.ts` reads as "not
 *    admin", i.e. an ordinary user of the whole application. Separate keys make
 *    that unreachable instead of relying on every future reader to check a claim.
 *
 * What this token does NOT decide is what the run may do. Authorization for a tool
 * call is read from the run's own persisted actor (`run-store.ts`), never from this
 * token and never from a request body — the token says which run to drive, and the
 * ledger says who it acts as.
 */

import { SignJWT, jwtVerify } from "jose";
import { getJwtSecret } from "@/lib/config/auth-env";
import { AGENT_RUN_ID_PATTERN } from "./run-store";

/** The one path this credential opens. */
export const AGENT_DRIVE_PATH = "/api/agent/drive";

/**
 * Carried in its own header rather than the `auth-token` cookie: a cookie would be
 * attached by a browser to every request to this origin, and this credential must
 * only ever travel where its holder deliberately sends it.
 */
export const AGENT_DRIVE_HEADER = "x-libredb-agent-drive";

/**
 * The label the signing key is derived with. Changing it invalidates every
 * outstanding drive token, which is harmless: they live for a minute.
 */
const DRIVE_KEY_LABEL = "libredb.agent.drive.v1";

/** Seconds a minted token stays valid. */
const DRIVE_TOKEN_TTL_SECONDS = 60;

/**
 * HMAC(JWT_SECRET, label) — a key that cannot be used to mint or verify a session,
 * derived through Web Crypto so this module works in the middleware runtime as well
 * as in a route handler. Derived per call rather than cached: it is two symmetric
 * operations on 32 bytes, while a cache would hold a key that outlived a rotated
 * secret.
 */
async function driveSigningKey(): Promise<Uint8Array> {
  const secret = getJwtSecret();
  // Copied into its own buffer: `BufferSource` requires an `ArrayBuffer`, and a
  // Uint8Array's backing store is typed as possibly shared.
  const raw = secret.slice().buffer as ArrayBuffer;
  const base = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", base, new TextEncoder().encode(DRIVE_KEY_LABEL));
  return new Uint8Array(derived);
}

/**
 * Mints a token authorizing one run to be driven.
 *
 * The clock is injected the way every other dated thing in this module tree takes
 * one (`deadline.ts`, `budgets.ts`, `run-store.ts`), so a token's lifetime can be
 * asserted rather than waited out.
 */
export async function mintAgentDriveToken(runId: string, clock: () => number = Date.now): Promise<string> {
  const issuedAt = Math.floor(clock() / 1000);
  return new SignJWT({ runId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + DRIVE_TOKEN_TTL_SECONDS)
    .sign(await driveSigningKey());
}

/**
 * The run id a token authorizes, or `null` for anything that is not a live,
 * well-formed drive token.
 *
 * Minting is permissive and verification is strict on purpose: this is the trust
 * boundary, and the run id it returns is used to name a ledger stream, so it is
 * checked against exactly the charset the store accepts rather than trusted for
 * having been signed.
 */
export async function verifyAgentDriveToken(token: string | null | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, await driveSigningKey());
    const runId = payload.runId;
    if (typeof runId !== "string" || !AGENT_RUN_ID_PATTERN.test(runId)) return null;
    return runId;
  } catch {
    // Every failure is the same answer: expired, forged, signed with the session
    // key, or not a token at all. Telling them apart would only help a forger.
    return null;
  }
}
