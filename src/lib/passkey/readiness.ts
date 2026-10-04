/**
 * Turns the passkey availability states into the errors the passkey services raise.
 */

import { AuthConfigError } from "@/lib/auth-errors";
import { AccountError } from "@/lib/local-accounts";
import { passkeyAvailability, type RelyingParty } from "@/lib/passkey/config";

/**
 * The relying party for a ceremony. The passkey services call it first, before any account is read:
 * a mode without passkeys is a 409 with its reason, a misconfigured PASSKEY_ORIGIN an operator error.
 */
export function requireReadyPasskeys(): RelyingParty {
  const availability = passkeyAvailability();
  if (availability.state === "misconfigured") throw new AuthConfigError(availability.reason);
  if (availability.state !== "ready") throw new AccountError(409, availability.reason);
  return { origin: availability.origin, rpId: availability.rpId };
}

/**
 * Refuses OIDC mode and local storage only. The passkey services call it first where stored passkeys stay
 * listable and removable while PASSKEY_ORIGIN is unset or invalid.
 */
export function requirePasskeyStoreMode(): void {
  const availability = passkeyAvailability();
  if (availability.state === "no-store") throw new AccountError(409, availability.reason);
}
