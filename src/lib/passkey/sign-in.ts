/**
 * The username-less passkey sign-in (docs/PASSKEYS.md, "Signing in").
 *
 * `completePasskeySignIn` performs WebAuthn 7.2 in a fixed order: ceremony token, assertion shape, origin and
 * user handle presence, credential lookup, user handle ownership, stored RP ID, signature (RP ID, UP, UV),
 * backup eligibility, account present and enabled, and only then the store transaction that spends the
 * challenge and advances the counter. State is written last because 7.2 step 24 defers every update until the
 * relying party's own checks pass, so a refused assertion leaves no row behind. The route mints the session
 * from the account returned here.
 *
 * Timing is not equalized: an unknown credential ID is refused before any signature check, so it answers
 * faster than a known one. A caller only learns about random, authenticator-chosen IDs it already holds, which
 * reveals no account.
 */
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { isRecord } from "@/lib/is-record";
import { requireAccountStore } from "@/lib/local-accounts";
import { openSignInCeremony, spentChallengeWrite, takeSignInCeremony } from "@/lib/passkey/ceremony";
import { requireReadyPasskeys } from "@/lib/passkey/readiness";
import {
  buildSignInOptions,
  PasskeyRefusal,
  type PasskeyRefusalReason,
  readAssertionIdentity,
  verifyAssertion,
} from "@/lib/passkey/webauthn";
import { PasskeySignInConflict, type PasskeySignInConflictReason, type StoredAccount } from "@/lib/storage/types";

export interface PasskeySignIn {
  account: StoredAccount;
  passkeyId: string;
}

const CONFLICT_REFUSAL: Record<PasskeySignInConflictReason, PasskeyRefusalReason> = {
  challenge_spent: "passkey_replayed",
  counter_not_increased: "passkey_counter",
  credential_missing: "passkey_unknown",
};

export async function beginPasskeySignIn(
  clock: () => number = Date.now,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const rp = requireReadyPasskeys();
  const ceremony = await openSignInCeremony(rp.rpId, clock);
  return buildSignInOptions({ rp, challenge: ceremony.challenge });
}

export async function completePasskeySignIn(body: unknown, clock: () => number = Date.now): Promise<PasskeySignIn> {
  const rp = requireReadyPasskeys();
  const ceremony = await takeSignInCeremony(clock);
  if (!ceremony || ceremony.rpId !== rp.rpId) throw new PasskeyRefusal("passkey_ceremony_invalid");

  const response = isRecord(body) ? body.response : undefined;
  const identity = readAssertionIdentity(response, rp);

  const provider = await requireAccountStore();
  const match = await provider.findPasskey(identity.credentialId);
  if (!match) throw new PasskeyRefusal("passkey_unknown");

  const context = { email: match.passkey.accountEmail, passkeyId: match.passkey.id };
  if (match.userHandle !== identity.userHandle) throw new PasskeyRefusal("passkey_rejected", context);
  if (match.passkey.rpId !== rp.rpId) throw new PasskeyRefusal("passkey_unknown", context);

  let verified: Awaited<ReturnType<typeof verifyAssertion>>;
  try {
    verified = await verifyAssertion({ response, challenge: ceremony.challenge, rp, credential: match.passkey });
  } catch (error) {
    if (!(error instanceof PasskeyRefusal)) throw error;
    throw new PasskeyRefusal(error.reason, context);
  }
  // Backup eligibility is fixed when a credential is created (WebAuthn 6.1.3), so a change is refused.
  if (verified.backupEligible !== match.passkey.backupEligible) throw new PasskeyRefusal("passkey_rejected", context);

  const account = await provider.getAccount(match.passkey.accountEmail);
  if (!account || account.disabled) throw new PasskeyRefusal("passkey_account_unavailable", context);

  const now = clock();
  try {
    await provider.recordPasskeySignIn({
      id: match.passkey.id,
      signCount: verified.signCount,
      backupState: verified.backupState,
      usedAt: new Date(now).toISOString(),
      ...spentChallengeWrite(ceremony, now),
    });
  } catch (error) {
    if (!(error instanceof PasskeySignInConflict)) throw error;
    throw new PasskeyRefusal(CONFLICT_REFUSAL[error.reason], context);
  }
  return { account, passkeyId: match.passkey.id };
}
