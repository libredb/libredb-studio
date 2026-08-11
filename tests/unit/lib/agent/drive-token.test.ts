/**
 * The drive token (#329 T9): the credential the durable transport presents when it
 * asks the server to drive a run.
 *
 * The property that matters most is NEGATIVE and is asserted in both directions: a
 * drive token must not be usable as a session, and a session must not be usable as a
 * drive token. `verifyJWT` casts its payload to `UserPayload` without inspecting it,
 * so a drive token that verified under the session key would present as a session
 * with an undefined role — which `src/proxy.ts` reads as "not admin", i.e. an
 * ordinary user of the whole application. Key separation is what makes that
 * impossible rather than merely unlikely.
 */

import { describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import { mintAgentDriveToken, verifyAgentDriveToken } from "@/lib/agent/drive-token";
import { signJWT, verifyJWT } from "@/lib/auth";
import { getJwtSecret } from "@/lib/config/auth-env";

const RUN_ID = "arun_0123456789abcdef";

describe("agent drive token", () => {
  test("a minted token verifies back to the run it was minted for", async () => {
    const token = await mintAgentDriveToken(RUN_ID);

    expect(await verifyAgentDriveToken(token)).toBe(RUN_ID);
  });

  test("a token minted for one run does not authorize another", async () => {
    const token = await mintAgentDriveToken(RUN_ID);

    expect(await verifyAgentDriveToken(token)).not.toBe("arun_other");
  });

  test("nothing at all is refused", async () => {
    expect(await verifyAgentDriveToken(null)).toBeNull();
    expect(await verifyAgentDriveToken(undefined)).toBeNull();
    expect(await verifyAgentDriveToken("")).toBeNull();
  });

  test("a value that is not a token is refused", async () => {
    expect(await verifyAgentDriveToken("not-a-jwt")).toBeNull();
  });

  // ── Key separation, both directions ──────────────────────────────────────────

  test("a user session token is not accepted as a drive token", async () => {
    const session = await signJWT({ role: "admin", username: "admin@example.com" });

    expect(await verifyAgentDriveToken(session)).toBeNull();
  });

  test("a drive token is not accepted as a user session", async () => {
    const token = await mintAgentDriveToken(RUN_ID);

    expect(await verifyJWT(token)).toBeNull();
  });

  test("a token signed with the session secret itself is refused", async () => {
    // The forgery a shared key would have permitted: correct claims, correct
    // algorithm, signed with the secret every session token is signed with.
    const forged = await new SignJWT({ runId: RUN_ID })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(getJwtSecret());

    expect(await verifyAgentDriveToken(forged)).toBeNull();
  });

  // ── Lifetime and shape ───────────────────────────────────────────────────────

  test("a token that has outlived its short life is refused", async () => {
    const twoMinutesAgo = (): number => Date.now() - 120_000;

    const stale = await mintAgentDriveToken(RUN_ID, twoMinutesAgo);

    expect(await verifyAgentDriveToken(stale)).toBeNull();
  });

  test("a token still inside its life is accepted", async () => {
    const tenSecondsAgo = (): number => Date.now() - 10_000;

    const token = await mintAgentDriveToken(RUN_ID, tenSecondsAgo);

    expect(await verifyAgentDriveToken(token)).toBe(RUN_ID);
  });

  test("a run id that is not usable as a ledger name is refused at the boundary", async () => {
    // Minting stays permissive and verification is strict, because verification is
    // the trust boundary: the run id reaches the ledger, whose stream names accept
    // exactly this charset.
    expect(await verifyAgentDriveToken(await mintAgentDriveToken(""))).toBeNull();
    expect(await verifyAgentDriveToken(await mintAgentDriveToken("../etc/passwd"))).toBeNull();
    expect(await verifyAgentDriveToken(await mintAgentDriveToken("a".repeat(65)))).toBeNull();
  });
});
