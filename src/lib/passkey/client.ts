/**
 * Browser-side passkey ceremonies against the passkey routes (docs/PASSKEYS.md, "How it works").
 * Imported only by client components, so `window` is touched inside functions alone.
 */
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { appFetch } from "@/lib/config/base-path";
import { isRecord } from "@/lib/is-record";
import { PASSKEY_SETUP_EXPIRED, type PublicPasskey } from "@/lib/passkey/api-types";
import { PASSKEY_CEREMONY_TTL_SECONDS } from "@/lib/passkey/policy";

export const PAGE_IP_ADDRESS =
  "This page is open at an IP address, and browsers offer passkeys only on a host name: https with your server's name, or http://localhost on this machine.";
export const PAGE_PLAIN_HTTP =
  "This page is plain http, and browsers offer passkeys only on https, or on http://localhost.";

const SIGN_IN_PATH = "/api/auth/passkey/sign-in";
const MANAGE_PATH = "/api/auth/passkey";
const RETRY = "An error occurred. Please try again.";
// Shown only on the configured origin, which is always https or http://localhost, so the browser is the cause.
export const UNSUPPORTED_BROWSER =
  "This browser cannot use passkeys. Try another browser, or sign in with your password.";
const REQUEST_FAILED = "The passkey request failed. Try again.";

const NOT_ALLOWED: Record<"sign-in" | "registration", string> = {
  "sign-in":
    "No passkey was used. The request was cancelled or timed out, or this device has no passkey for this site. Try again, or sign in with your password.",
  registration: "No passkey was created. The request was cancelled or timed out.",
};
const ALREADY_REGISTERED = "This device already holds a passkey for your account.";
const WRONG_ADDRESS =
  "This address cannot use passkeys. Open Studio at the address your administrator set for passkeys.";
const AUTHENTICATOR_LACKS =
  "This authenticator cannot check a PIN, fingerprint or face, or cannot store a passkey. Use another device or security key.";
const ALGORITHMS = "This authenticator does not support the key types Studio accepts.";

// Maps, not object literals, so a code such as "constructor" never matches a prototype key.
const BY_CODE = new Map<string, string>([
  ["ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED", ALREADY_REGISTERED],
  ["ERROR_INVALID_DOMAIN", WRONG_ADDRESS],
  ["ERROR_INVALID_RP_ID", WRONG_ADDRESS],
  ["ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT", AUTHENTICATOR_LACKS],
  ["ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT", AUTHENTICATOR_LACKS],
  ["ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG", ALGORITHMS],
]);
const BY_NAME = new Map<string, string>([
  ["InvalidStateError", ALREADY_REGISTERED],
  ["SecurityError", WRONG_ADDRESS],
  ["ConstraintError", AUTHENTICATOR_LACKS],
  ["NotSupportedError", ALGORITHMS],
]);

/** Passkeys can run on this page: the browser has WebAuthn and the page is on the configured origin. */
export function passkeysUsableHere(origin: string): boolean {
  return browserSupportsWebAuthn() && window.location.origin === origin;
}

/** What about the page itself stops WebAuthn, checked before any server reason. */
export function passkeyPageBlocker(): "ip-address" | "plain-http" | null {
  const host = window.location.hostname;
  // URL keeps an IPv6 literal in brackets, so a leading bracket is enough to tell it apart.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return "ip-address";
  if (window.isSecureContext === false) return "plain-http";
  return null;
}

type Answer = { ok: boolean; body: unknown };

// Only the network round trip is caught: a failure there is a retry, and nothing else is.
async function post(path: string, payload: Record<string, unknown>): Promise<Answer | null> {
  try {
    const res = await appFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, body: await res.json() };
  } catch {
    return null;
  }
}

function serverMessage(body: unknown): string {
  const text = isRecord(body) ? (body.message ?? body.error) : undefined;
  return typeof text === "string" ? text : RETRY;
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

export type PasskeySignInResult = { ok: true; role: "admin" | "user" } | { ok: false; message: string | null };

export async function signInWithPasskey(): Promise<PasskeySignInResult> {
  if (!browserSupportsWebAuthn()) return { ok: false, message: UNSUPPORTED_BROWSER };
  const offered = await post(SIGN_IN_PATH, { action: "options" });
  if (offered === null) return { ok: false, message: RETRY };
  if (!offered.ok) return { ok: false, message: serverMessage(offered.body) };

  let response: unknown;
  try {
    const optionsJSON = field(offered.body, "options") as PublicKeyCredentialRequestOptionsJSON;
    response = await startAuthentication({ optionsJSON });
  } catch (error) {
    return { ok: false, message: ceremonyErrorMessage(error, "sign-in") };
  }

  const verified = await post(SIGN_IN_PATH, { action: "verify", response });
  if (verified === null) return { ok: false, message: RETRY };
  if (!verified.ok) return { ok: false, message: serverMessage(verified.body) };
  return { ok: true, role: field(verified.body, "role") as "admin" | "user" };
}

export interface PasskeySetup {
  readonly options: PublicKeyCredentialCreationOptionsJSON;
  readonly startedAt: number;
}

export type PasskeySetupResult =
  | { ok: true; setup: PasskeySetup }
  | { ok: false; message: string; codeRequired: boolean };

/** Confirms the password (and code) once; the setup it returns lets a cancelled prompt be retried without them. */
export async function beginPasskeyCreation(
  input: { password: string; code?: string },
  clock: () => number = Date.now,
): Promise<PasskeySetupResult> {
  const payload: Record<string, unknown> = { action: "register-options", password: input.password };
  if (input.code !== undefined) payload.code = input.code;
  const answer = await post(MANAGE_PATH, payload);
  if (answer === null) return { ok: false, message: RETRY, codeRequired: false };
  if (!answer.ok) {
    return {
      ok: false,
      message: serverMessage(answer.body),
      codeRequired: field(answer.body, "codeRequired") === true,
    };
  }
  const options = field(answer.body, "options") as PublicKeyCredentialCreationOptionsJSON;
  return { ok: true, setup: { options, startedAt: clock() } };
}

export type PasskeyCreateResult =
  | { ok: true; passkey: PublicPasskey }
  | { ok: false; message: string | null; retry: boolean };

export async function finishPasskeyCreation(
  setup: PasskeySetup,
  name?: string,
  clock: () => number = Date.now,
): Promise<PasskeyCreateResult> {
  const fresh = () => clock() - setup.startedAt < PASSKEY_CEREMONY_TTL_SECONDS * 1000;
  // Checked before the prompt: a credential created on a dead ceremony is stored but never registered.
  if (!fresh()) return { ok: false, message: PASSKEY_SETUP_EXPIRED, retry: false };
  if (!browserSupportsWebAuthn()) return { ok: false, message: UNSUPPORTED_BROWSER, retry: false };
  let response: unknown;
  try {
    response = await startRegistration({ optionsJSON: setup.options });
  } catch (error) {
    // The server still holds the ceremony cookie, so only the prompt is retried, and only while it lives.
    return { ok: false, message: ceremonyErrorMessage(error, "registration"), retry: fresh() };
  }

  // A failed verify never retries: the server took the ceremony cookie with the request.
  const answer = await post(MANAGE_PATH, { action: "register-verify", response, name });
  if (answer === null) return { ok: false, message: RETRY, retry: false };
  if (!answer.ok) return { ok: false, message: serverMessage(answer.body), retry: false };
  return { ok: true, passkey: field(answer.body, "passkey") as PublicPasskey };
}

export type PasskeyChangeResult = { ok: true } | { ok: false; message: string; codeRequired: boolean };

async function change(payload: Record<string, unknown>): Promise<PasskeyChangeResult> {
  const answer = await post(MANAGE_PATH, payload);
  if (answer === null) return { ok: false, message: RETRY, codeRequired: false };
  if (!answer.ok) {
    return {
      ok: false,
      message: serverMessage(answer.body),
      codeRequired: field(answer.body, "codeRequired") === true,
    };
  }
  return { ok: true };
}

export function renamePasskey(id: string, name: string): Promise<PasskeyChangeResult> {
  return change({ action: "rename", id, name });
}

/** Asks for the password (and a code when the account has one), like adding does. */
export function removePasskey(input: { id: string; password: string; code?: string }): Promise<PasskeyChangeResult> {
  const payload: Record<string, unknown> = { action: "remove", id: input.id, password: input.password };
  if (input.code !== undefined) payload.code = input.code;
  return change(payload);
}

/**
 * Turns a WebAuthn failure into what the user can do about it; null for an abort the page asked for.
 * Reads `code`, `name` and `cause.name` as properties, because class identity differs under mocks and bundling.
 */
export function ceremonyErrorMessage(error: unknown, ceremony: "sign-in" | "registration"): string | null {
  const code = field(error, "code");
  const names = [field(error, "name"), field(field(error, "cause"), "name")];
  if (code === "ERROR_CEREMONY_ABORTED") return null;
  if (names.includes("NotAllowedError")) return NOT_ALLOWED[ceremony];
  if (typeof code === "string" && BY_CODE.has(code)) return BY_CODE.get(code) as string;
  for (const name of names) {
    if (typeof name === "string" && BY_NAME.has(name)) return BY_NAME.get(name) as string;
  }
  return REQUEST_FAILED;
}
