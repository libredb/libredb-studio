/**
 * Studio's fixed WebAuthn policy over `@simplewebauthn/server`, plus the checks the library lacks
 * (docs/SECURITY.md, control 1.8).
 *
 * Every refusal is a `PasskeyRefusal` carrying a closed audit reason. A library error is caught and
 * mapped to a reason; its message is never read, because it can quote a challenge, an origin or a
 * credential ID.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { decodeAttestationObject, decodeClientDataJSON, isoBase64URL } from "@simplewebauthn/server/helpers";
import type { AuditReason } from "@/lib/audit";
import { isRecord } from "@/lib/is-record";
import type { RelyingParty } from "@/lib/passkey/config";
import {
  PASSKEY_ALGORITHM_IDS,
  PASSKEY_CREDENTIAL_ID_MAX_BYTES,
  PASSKEY_RP_NAME,
  PASSKEY_TIMEOUT_MS,
} from "@/lib/passkey/policy";
import { PASSKEY_TRANSPORTS, type PasskeyTransport } from "@/lib/storage/types";

export type PasskeyRefusalReason = Extract<
  AuditReason,
  | "passkey_ceremony_invalid"
  | "passkey_origin_mismatch"
  | "passkey_unknown"
  | "passkey_rejected"
  | "passkey_counter"
  | "passkey_replayed"
  | "passkey_account_unavailable"
>;

export class PasskeyRefusal extends Error {
  constructor(
    readonly reason: PasskeyRefusalReason,
    readonly context: { email?: string; passkeyId?: string } = {},
  ) {
    super(`passkey refused: ${reason}`);
    this.name = "PasskeyRefusal";
  }
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: PasskeyTransport[];
  backupEligible: boolean;
  backupState: boolean;
}

export interface VerifiedAssertion {
  signCount: number;
  backupEligible: boolean;
  backupState: boolean;
}

function rejected(): PasskeyRefusal {
  return new PasskeyRefusal("passkey_rejected");
}

/**
 * The origin checks run here, before the library: a cross-origin or embedded ceremony is refused
 * outright, and a foreign origin gets its own reason an operator can act on.
 */
function checkClientData(clientDataJSON: string, rp: RelyingParty): void {
  let clientData: unknown;
  try {
    clientData = decodeClientDataJSON(clientDataJSON);
  } catch {
    throw rejected();
  }
  if (!isRecord(clientData)) throw rejected();
  if (clientData.crossOrigin === true || clientData.topOrigin !== undefined) throw rejected();
  if (clientData.origin !== rp.origin) throw new PasskeyRefusal("passkey_origin_mismatch");
}

/** Only the two shapes a browser returns under attestation "none"; every other format can make the library fetch a CRL. */
function attestationFormatAllowed(attestationObject: string): boolean {
  try {
    const decoded = decodeAttestationObject(isoBase64URL.toBuffer(attestationObject));
    const fmt = decoded.get("fmt");
    return fmt === "none" || (fmt === "packed" && decoded.get("attStmt").get("x5c") === undefined);
  } catch {
    return false;
  }
}

export async function buildRegistrationOptions(input: {
  rp: RelyingParty;
  challenge: string;
  userHandle: string;
  email: string;
  exclude: { credentialId: string; transports: PasskeyTransport[] }[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: PASSKEY_RP_NAME,
    rpID: input.rp.rpId,
    userName: input.email,
    userDisplayName: input.email,
    userID: isoBase64URL.toBuffer(input.userHandle),
    // Bytes, never a string: the library UTF-8-encodes a string challenge.
    challenge: isoBase64URL.toBuffer(input.challenge),
    timeout: PASSKEY_TIMEOUT_MS,
    attestationType: "none",
    excludeCredentials: input.exclude.map((entry) => ({ id: entry.credentialId, transports: entry.transports })),
    // A literal per call: the library mutates the object it receives.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: [...PASSKEY_ALGORITHM_IDS],
  });
}

export async function verifyRegistration(input: {
  response: unknown;
  challenge: string;
  rp: RelyingParty;
}): Promise<VerifiedRegistration> {
  const { response, challenge, rp } = input;
  if (
    !isRecord(response) ||
    typeof response.id !== "string" ||
    response.rawId !== response.id ||
    response.type !== "public-key" ||
    !isRecord(response.response) ||
    typeof response.response.clientDataJSON !== "string" ||
    typeof response.response.attestationObject !== "string"
  ) {
    throw rejected();
  }
  checkClientData(response.response.clientDataJSON, rp);
  if (!attestationFormatAllowed(response.response.attestationObject)) throw rejected();

  let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    result = await verifyRegistrationResponse({
      // The shape was checked above; the library reads the rest itself.
      response: response as unknown as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [...PASSKEY_ALGORITHM_IDS],
    });
  } catch {
    throw rejected();
  }
  const info = result.registrationInfo;
  if (result.verified !== true || info === undefined || info.userVerified !== true) throw rejected();

  // The attested ID is the one that is stored and checked for uniqueness; the library neither bounds
  // it nor compares it with the response's id (WebAuthn 7.1 steps 25 to 27).
  const credentialId = info.credential.id;
  const idBytes = isoBase64URL.toBuffer(credentialId).length;
  if (credentialId !== response.id || idBytes < 1 || idBytes > PASSKEY_CREDENTIAL_ID_MAX_BYTES) throw rejected();

  // Transports are unsigned hints, filtered and de-duplicated here once, at registration.
  const offered: unknown[] = Array.isArray(info.credential.transports) ? info.credential.transports : [];
  return {
    credentialId,
    publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
    signCount: info.credential.counter,
    transports: PASSKEY_TRANSPORTS.filter((transport) => offered.includes(transport)),
    backupEligible: info.credentialDeviceType === "multiDevice",
    backupState: info.credentialBackedUp,
  };
}

export async function buildSignInOptions(input: {
  rp: RelyingParty;
  challenge: string;
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  // No allowCredentials: sign-in is username-less over discoverable credentials.
  return generateAuthenticationOptions({
    rpID: input.rp.rpId,
    challenge: isoBase64URL.toBuffer(input.challenge),
    timeout: PASSKEY_TIMEOUT_MS,
    userVerification: "required",
  });
}

export function readAssertionIdentity(
  response: unknown,
  rp: RelyingParty,
): { credentialId: string; userHandle: string } {
  if (
    !isRecord(response) ||
    typeof response.id !== "string" ||
    response.rawId !== response.id ||
    response.type !== "public-key" ||
    !isRecord(response.response) ||
    typeof response.response.clientDataJSON !== "string" ||
    typeof response.response.authenticatorData !== "string" ||
    typeof response.response.signature !== "string"
  ) {
    throw rejected();
  }
  const handle = response.response.userHandle;
  if (handle !== undefined && handle !== null && typeof handle !== "string") throw rejected();
  checkClientData(response.response.clientDataJSON, rp);
  if (typeof handle !== "string") throw new PasskeyRefusal("passkey_unknown");
  // isBase64URL strips every '=' wherever it sits, so padding is allowed only at the end.
  if (!/^[^=]*=*$/.test(handle) || !isoBase64URL.isBase64URL(handle)) throw rejected();
  // One canonical spelling, so padding or unused trailing bits cannot make one handle look like two.
  const userHandle = isoBase64URL.fromBuffer(isoBase64URL.toBuffer(isoBase64URL.trimPadding(handle)));
  if (userHandle === "") throw new PasskeyRefusal("passkey_unknown");
  return { credentialId: response.id, userHandle };
}

export async function verifyAssertion(input: {
  response: unknown;
  challenge: string;
  rp: RelyingParty;
  credential: { credentialId: string; publicKey: string; transports: PasskeyTransport[] };
}): Promise<VerifiedAssertion> {
  const { response, challenge, rp, credential } = input;
  // The same shape and origin checks as the lookup, so this call is safe on its own, and the
  // response must be for the credential the caller looked up.
  if (readAssertionIdentity(response, rp).credentialId !== credential.credentialId) throw rejected();

  let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    result = await verifyAuthenticationResponse({
      response: response as unknown as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      credential: {
        id: credential.credentialId,
        publicKey: isoBase64URL.toBuffer(credential.publicKey),
        // Always 0: the library checks the counter before the signature and only throws, so the
        // store's guarded UPDATE applies the counter rule after the signature verified.
        counter: 0,
        transports: credential.transports,
      },
      requireUserVerification: true,
    });
  } catch {
    throw rejected();
  }
  const info = result.authenticationInfo;
  if (result.verified !== true || info.userVerified !== true) throw rejected();
  return {
    signCount: info.newCounter,
    backupEligible: info.credentialDeviceType === "multiDevice",
    backupState: info.credentialBackedUp,
  };
}
