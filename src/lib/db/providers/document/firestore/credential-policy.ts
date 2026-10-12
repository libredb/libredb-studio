/**
 * Firestore's credential policy over the Google-generic half: which credential a connection uses, and when.
 *
 * - FIRESTORE_EMULATOR_HOST set (server environment only): every connection talks to that emulator, a credential in
 *   the field is refused, and nothing else is read, FIRESTORE_SERVER_CREDENTIALS included.
 * - A credential in the field: it is parsed and used.
 * - An empty field: refused for a connection a browser sent; for an operator seed (`managed: true`, which
 *   resolveConnection forces false on every browser-sent connection) refused unless FIRESTORE_SERVER_CREDENTIALS is
 *   exactly "true", and then the server's own identity in ADC order.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { validateHost, validatePort } from "@/lib/db/http/endpoint";
import type { DatabaseConnection } from "@/lib/types";
import { ENV, FIRESTORE_TYPE } from "./constants";
import {
  type CredentialRules,
  type GoogleCredentials,
  parseCredentialText,
  readServerIdentity,
} from "./google-credentials";
import { projectIdRefusal } from "./names";
import type { FirestoreEnv, FirestoreSeams } from "./seams";

export interface EmulatorAddress {
  /** URL form: lower case, an IPv6 address in brackets. */
  readonly host: string;
  readonly port: number;
  /** `http://host:port`. */
  readonly origin: string;
  /** `host:port`, as the sentences name it. */
  readonly display: string;
}

export type FirestoreAuth =
  | { readonly mode: "emulator"; readonly emulator: EmulatorAddress }
  | { readonly mode: "google"; readonly credentials: GoogleCredentials };

export const FIRESTORE_CREDENTIAL_RULES: CredentialRules = Object.freeze({
  provider: FIRESTORE_TYPE,
  quotaProjectRefusal: projectIdRefusal,
});

export const FIRESTORE_CREDENTIAL_SENTENCES = Object.freeze({
  browserEmpty:
    "Paste a service-account key JSON, an authorized-user JSON or an access token: the server's own Google identity is used only for operator-seeded connections",
  seedWithoutOptIn: `Set ${ENV.serverCredentials}=true on the server to let this seeded connection use the server's own Google identity`,
  emulatorCredential: (display: string) =>
    `This server sends every Firestore connection to the emulator at ${display} (${ENV.emulatorHost}): clear the credential field, or ask the operator to unset the variable`,
  emulatorHost: `${ENV.emulatorHost} must be host:port or [ipv6]:port with no scheme, such as 127.0.0.1:8080`,
});

const S = FIRESTORE_CREDENTIAL_SENTENCES;
/** `host:port` or `[ipv6]:port`: no scheme, no path, no user, a port always. */
const EMULATOR_HOST = /^(\[[^\]]+\]|[^:[\]/@?#\s]+):(\d{1,5})$/;

export function parseEmulatorHost(value: string): EmulatorAddress {
  const match = EMULATOR_HOST.exec(value.trim());
  if (match === null) throw new DatabaseConfigError(S.emulatorHost, FIRESTORE_TYPE);
  let host: string;
  let port: number;
  try {
    host = validateHost(match[1]);
    port = validatePort(match[2]);
  } catch {
    throw new DatabaseConfigError(S.emulatorHost, FIRESTORE_TYPE);
  }
  return { host, port, origin: `http://${host}:${port}`, display: `${host}:${port}` };
}

/**
 * The emulator FIRESTORE_EMULATOR_HOST names; null when it is unset or blank; a malformed value is refused.
 * The one place the mode is decided: resolveFirestoreAuth and the provider's constructor both call it.
 */
export function emulatorAddressOf(env: FirestoreEnv): EmulatorAddress | null {
  const value = env[ENV.emulatorHost]?.trim();
  return value ? parseEmulatorHost(value) : null;
}

export function resolveFirestoreAuth(
  connection: Pick<DatabaseConnection, "password" | "managed">,
  seams: FirestoreSeams,
): FirestoreAuth {
  const password = connection.password?.trim() ?? "";
  const emulator = emulatorAddressOf(seams.env);
  if (emulator !== null) {
    if (password !== "") throw new DatabaseConfigError(S.emulatorCredential(emulator.display), FIRESTORE_TYPE);
    return { mode: "emulator", emulator };
  }
  if (password !== "")
    return { mode: "google", credentials: parseCredentialText(password, FIRESTORE_CREDENTIAL_RULES) };
  if (connection.managed !== true) throw new DatabaseConfigError(S.browserEmpty, FIRESTORE_TYPE);
  if (seams.env[ENV.serverCredentials] !== "true") throw new DatabaseConfigError(S.seedWithoutOptIn, FIRESTORE_TYPE);
  return { mode: "google", credentials: readServerIdentity(seams, FIRESTORE_CREDENTIAL_RULES) };
}
