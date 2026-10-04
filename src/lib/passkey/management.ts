/**
 * The signed-in owner's passkeys: list, add, rename and remove (docs/PASSKEYS.md, "Adding and managing passkeys").
 *
 * Adding and removing ask for the current password, and a current code when the account has TOTP,
 * because a session cookie alone must not be enough to plant or revoke a sign-in factor. Adding and
 * removing are conditional on the session version the service read, so a change that ended the
 * account's sessions in the meantime makes the write refuse instead of landing on the changed account.
 * A rename carries no version condition: it changes only a label and grants nothing.
 * Rename and remove need only the store mode, not a valid PASSKEY_ORIGIN, so passkeys registered
 * under an earlier origin stay manageable.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";
import type { UserPayload } from "@/lib/auth";
import { isRecord } from "@/lib/is-record";
import {
  ACCOUNT_CHANGED,
  AccountError,
  type AccountRefusalReason,
  auditAccountChange,
  auditAccountRefusal,
  confirmOwner,
  requireOwnAccount,
} from "@/lib/local-accounts";
import { PASSKEY_SETUP_EXPIRED as SETUP_EXPIRED } from "@/lib/passkey/api-types";
import type { PasskeyStatus, PublicPasskey } from "@/lib/passkey/api-types";
import { openRegistrationCeremony, spentChallengeWrite, takeRegistrationCeremony } from "@/lib/passkey/ceremony";
import { passkeyAvailability } from "@/lib/passkey/config";
import {
  PASSKEY_DEFAULT_NAME,
  PASSKEY_MAX_PER_ACCOUNT,
  PASSKEY_NAME_MAX_LENGTH,
  PASSKEY_USER_HANDLE_BYTES,
} from "@/lib/passkey/policy";
import { requirePasskeyStoreMode, requireReadyPasskeys } from "@/lib/passkey/readiness";
import { buildRegistrationOptions, PasskeyRefusal, verifyRegistration } from "@/lib/passkey/webauthn";
import {
  PasskeyRegistrationConflict,
  type PasskeyRegistrationConflictReason,
  PasskeyRemovalConflict,
  type PasskeyRemovalConflictReason,
  type ServerStorageProvider,
  type StoredAccount,
  type StoredPasskey,
} from "@/lib/storage/types";

const SIGN_IN_AGAIN = "Sign in again to manage passkeys.";
const NOT_VERIFIED = "The passkey could not be verified. Try again.";
const ALREADY_REGISTERED = "This passkey is already registered.";
const CONCURRENT = "Another passkey was added at the same time. Start again.";
const ACCOUNT_GONE = "This account no longer exists.";
const LIMIT_REACHED = `An account holds at most ${PASSKEY_MAX_PER_ACCOUNT} passkeys. Remove one before adding another.`;
const NAME_INVALID = `Name a passkey with 1 to ${PASSKEY_NAME_MAX_LENGTH} characters.`;
const NOT_FOUND = "No passkey with that id on your account.";
const ID_INVALID = "id must be a string.";

// oxlint-disable-next-line no-control-regex -- control characters are exactly what a name may not hold
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

interface Refusal {
  audit: AccountRefusalReason | null;
  status: number;
  message: string;
}

// Total over the store's reasons with no default, so a new reason fails the typecheck here.
const REGISTRATION_CONFLICTS: Record<PasskeyRegistrationConflictReason, Refusal> = {
  challenge_spent: { audit: "passkey_replayed", status: 400, message: SETUP_EXPIRED },
  account_missing: { audit: null, status: 404, message: ACCOUNT_GONE },
  session_changed: { audit: "passkey_ceremony_invalid", status: 409, message: ACCOUNT_CHANGED },
  passkey_limit: { audit: "account_refused", status: 409, message: LIMIT_REACHED },
  user_handle_changed: { audit: "passkey_ceremony_invalid", status: 409, message: CONCURRENT },
  credential_registered: { audit: "passkey_duplicate", status: 409, message: ALREADY_REGISTERED },
};

const REMOVAL_CONFLICTS: Record<PasskeyRemovalConflictReason, Refusal> = {
  session_changed: { audit: "account_refused", status: 409, message: ACCOUNT_CHANGED },
  credential_missing: { audit: null, status: 404, message: NOT_FOUND },
};

interface OwnAccount {
  provider: ServerStorageProvider;
  current: StoredAccount;
  sessionVersion: number;
}

/** The session's stored account; a session from before the registry carries no version to condition a write on. */
async function storeAccount(session: UserPayload): Promise<OwnAccount> {
  requirePasskeyStoreMode();
  const { username, sessionVersion } = session;
  if (typeof username !== "string" || username === "" || !Number.isSafeInteger(sessionVersion)) {
    throw new AccountError(401, SIGN_IN_AGAIN);
  }
  const { provider, current } = await requireOwnAccount(username);
  return { provider, current, sessionVersion: sessionVersion as number };
}

function toPublic(passkey: StoredPasskey, rpId: string | null): PublicPasskey {
  return {
    id: passkey.id,
    name: passkey.name,
    createdAt: passkey.createdAt,
    lastUsedAt: passkey.lastUsedAt,
    backupEligible: passkey.backupEligible,
    backupState: passkey.backupState,
    usable: rpId === null ? null : passkey.rpId === rpId,
  };
}

/** The RP ID passkeys are judged against, or null while it cannot be known. */
function currentRpId(): string | null {
  const availability = passkeyAvailability();
  return availability.state === "ready" ? availability.rpId : null;
}

function readName(value: unknown): string {
  if (typeof value !== "string" || CONTROL_CHARACTER.test(value)) throw new AccountError(400, NAME_INVALID);
  const name = value.trim();
  if (name.length === 0 || name.length > PASSKEY_NAME_MAX_LENGTH) throw new AccountError(400, NAME_INVALID);
  return name;
}

/** A registration may leave the name out, or send it empty, and gets the default. */
function readOptionalName(value: unknown): string {
  return value === undefined || value === "" ? PASSKEY_DEFAULT_NAME : readName(value);
}

function readId(body: unknown): string {
  const id = isRecord(body) ? body.id : undefined;
  if (typeof id !== "string") throw new AccountError(400, ID_INVALID);
  return id;
}

function refuse(email: string, action: string, refusal: Refusal): never {
  if (refusal.audit) auditAccountRefusal(email, action, refusal.audit);
  throw new AccountError(refusal.status, refusal.message);
}

export async function passkeyStatus(session: UserPayload): Promise<PasskeyStatus> {
  const availability = passkeyAvailability();
  if (availability.state === "no-store") {
    return { available: false, mode: availability.mode, reason: availability.reason };
  }
  const { provider, current } = await storeAccount(session);
  const rpId = availability.state === "ready" ? availability.rpId : null;
  const passkeys = (await provider.listPasskeys(current.email)).map((passkey) => toPublic(passkey, rpId));
  const totpEnabled = current.totpSecret !== null;
  if (availability.state === "ready") {
    return {
      available: true,
      canAdd: true,
      origin: availability.origin,
      rpId: availability.rpId,
      totpEnabled,
      passkeys,
    };
  }
  return { available: true, canAdd: false, reason: availability.reason, totpEnabled, passkeys };
}

export async function beginPasskeyRegistration(
  session: UserPayload,
  body: unknown,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const rp = requireReadyPasskeys();
  const { provider, current, sessionVersion } = await storeAccount(session);
  // A session the account ended since the route guard read it gets no ceremony, so the authenticator is never
  // asked to create a credential that register-verify would then refuse to store.
  if (current.sessionVersion !== sessionVersion || current.disabled) throw new AccountError(409, ACCOUNT_CHANGED);
  const existing = await provider.listPasskeys(current.email);
  // Before the password, so a full account is told so without spending a guess.
  if (existing.length >= PASSKEY_MAX_PER_ACCOUNT) throw new AccountError(409, LIMIT_REACHED);
  await confirmOwner(current, body, "passkey_add", current.totpSecret !== null);
  // Nothing is written yet: a first handle is bound only when the registration completes.
  const userHandle =
    (await provider.getPasskeyUserHandle(current.email)) ??
    randomBytes(PASSKEY_USER_HANDLE_BYTES).toString("base64url");
  const ceremony = await openRegistrationCeremony({
    rpId: rp.rpId,
    email: current.email,
    sessionVersion,
    userHandle,
  });
  return buildRegistrationOptions({
    rp,
    challenge: ceremony.challenge,
    userHandle,
    email: current.email,
    exclude: existing
      .filter((passkey) => passkey.rpId === rp.rpId)
      .map((passkey) => ({ credentialId: passkey.credentialId, transports: passkey.transports })),
  });
}

export async function completePasskeyRegistration(session: UserPayload, body: unknown): Promise<PublicPasskey> {
  const rp = requireReadyPasskeys();
  // Taken first, so the cookie is cleared on every path below.
  const ceremony = await takeRegistrationCeremony();
  const { provider, current, sessionVersion } = await storeAccount(session);
  if (
    ceremony === null ||
    ceremony.rpId !== rp.rpId ||
    ceremony.email !== current.email ||
    ceremony.sessionVersion !== sessionVersion
  ) {
    auditAccountRefusal(current.email, "passkey_add", "passkey_ceremony_invalid");
    throw new AccountError(400, SETUP_EXPIRED);
  }
  const fields = isRecord(body) ? body : {};
  const name = readOptionalName(fields.name);
  let verified: Awaited<ReturnType<typeof verifyRegistration>>;
  try {
    verified = await verifyRegistration({ response: fields.response, challenge: ceremony.challenge, rp });
  } catch (error) {
    if (!(error instanceof PasskeyRefusal)) throw error;
    // Registration yields only these two; any library failure is a rejection.
    const reason = error.reason === "passkey_origin_mismatch" ? "passkey_origin_mismatch" : "passkey_rejected";
    auditAccountRefusal(current.email, "passkey_add", reason);
    throw new AccountError(400, NOT_VERIFIED);
  }
  const now = Date.now();
  const passkey: StoredPasskey = {
    id: randomUUID(),
    credentialId: verified.credentialId,
    accountEmail: current.email,
    publicKey: verified.publicKey,
    signCount: verified.signCount,
    transports: verified.transports,
    backupEligible: verified.backupEligible,
    backupState: verified.backupState,
    rpId: rp.rpId,
    name,
    createdAt: new Date(now).toISOString(),
    lastUsedAt: null,
  };
  try {
    await provider.insertPasskey({
      passkey,
      userHandle: ceremony.userHandle,
      expectedSessionVersion: ceremony.sessionVersion,
      maxPasskeys: PASSKEY_MAX_PER_ACCOUNT,
      ...spentChallengeWrite(ceremony, now),
    });
  } catch (error) {
    if (!(error instanceof PasskeyRegistrationConflict)) throw error;
    refuse(current.email, "passkey_add", REGISTRATION_CONFLICTS[error.reason]);
  }
  auditAccountChange(current.email, "passkey_add", current.email, passkey.id);
  return toPublic(passkey, rp.rpId);
}

export async function renameOwnPasskey(session: UserPayload, body: unknown): Promise<PublicPasskey> {
  const { provider, current } = await storeAccount(session);
  const id = readId(body);
  const name = readName(isRecord(body) ? body.name : undefined);
  const found = (await provider.listPasskeys(current.email)).find((passkey) => passkey.id === id);
  if (!found || !(await provider.renamePasskey(current.email, id, name))) throw new AccountError(404, NOT_FOUND);
  auditAccountChange(current.email, "passkey_rename", current.email, id);
  return toPublic({ ...found, name }, currentRpId());
}

/** Removes the passkey and ends the account's other sessions; resolves to the session version the caller moves to. */
export async function removeOwnPasskey(session: UserPayload, body: unknown): Promise<number> {
  const { provider, current, sessionVersion } = await storeAccount(session);
  const id = readId(body);
  await confirmOwner(current, body, "passkey_remove", current.totpSecret !== null);
  const next = sessionVersion + 1;
  try {
    await provider.deletePasskey({
      email: current.email,
      id,
      expectedSessionVersion: sessionVersion,
      nextSessionVersion: next,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (!(error instanceof PasskeyRemovalConflict)) throw error;
    refuse(current.email, "passkey_remove", REMOVAL_CONFLICTS[error.reason]);
  }
  auditAccountChange(current.email, "passkey_remove", current.email, id);
  return next;
}
