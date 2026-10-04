/**
 * Passkey limits and algorithm choices, in one place so the services, the routes and the tests agree.
 */

/** How long the browser waits for the authenticator, passed as the WebAuthn timeout. */
export const PASSKEY_TIMEOUT_MS = 300000;

/** Lifetime of a ceremony token: longer than the WebAuthn timeout, so a slow ceremony still completes. */
export const PASSKEY_CEREMONY_TTL_SECONDS = 600;

/** How long a spent challenge outlives its token, so replicas whose clocks differ by up to this much cannot reopen a replay. */
export const PASSKEY_SPENT_GRACE_SECONDS = 600;

/** Random bytes per challenge, twice the WebAuthn minimum of 16. */
export const PASSKEY_CHALLENGE_BYTES = 32;

/** Random bytes per user handle, the WebAuthn maximum, so the handle carries no account data. */
export const PASSKEY_USER_HANDLE_BYTES = 64;

/** The WebAuthn upper bound on a credential ID; a registration whose attested ID is longer is refused, so no stored ID exceeds it. */
export const PASSKEY_CREDENTIAL_ID_MAX_BYTES = 1023;

/** Passkeys one account may hold, which bounds the per-account rows, the list an owner sees and the exclude list of a registration. */
export const PASSKEY_MAX_PER_ACCOUNT = 20;

/** EdDSA, ES256, RS256 in preference order; offered and verified with the same list, so no ML-DSA default depends on the runtime. */
export const PASSKEY_ALGORITHM_IDS: readonly number[] = [-8, -7, -257];

/** The longest name an owner may give a passkey. */
export const PASSKEY_NAME_MAX_LENGTH = 64;

/** The name a new passkey gets when the owner gives none. */
export const PASSKEY_DEFAULT_NAME = "Passkey";

/** The largest request body a passkey route reads; an attestation fits well inside it. */
export const PASSKEY_BODY_MAX_BYTES = 65536;

/** The relying party name authenticators show next to the account. */
export const PASSKEY_RP_NAME = "LibreDB Studio";
