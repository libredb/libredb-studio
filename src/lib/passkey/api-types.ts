/**
 * The passkey response shapes the browser reads, declared once for the routes and the pages.
 * Import-free, so the server and the browser share it without pulling either side's modules.
 */

/** The server's answer once the ceremony cookie is gone; the browser says the same when it sees the setup expire. */
export const PASSKEY_SETUP_EXPIRED = "The passkey setup expired or belongs to another sign-in. Start again.";

export interface PublicPasskey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  backupEligible: boolean;
  backupState: boolean;
  /** Registered for the RP ID this server uses now; null while passkeys are off or misconfigured, when that cannot be judged. */
  usable: boolean | null;
}

export type PasskeyStatus =
  | { available: false; mode: "oidc" | "local-storage"; reason: string }
  | { available: true; canAdd: true; origin: string; rpId: string; totpEnabled: boolean; passkeys: PublicPasskey[] }
  | { available: true; canAdd: false; reason: string; totpEnabled: boolean; passkeys: PublicPasskey[] };

export interface PasskeySignInOffer {
  origin: string;
}
