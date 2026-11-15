/**
 * Firestore's credential policy, composed over the shared Google auth (src/lib/db/auth/google): which credential a
 * connection uses, and when.
 *
 * - FIRESTORE_EMULATOR_HOST set (server environment only): every connection talks to that emulator, a credential in
 *   the field is refused, and nothing else is read, FIRESTORE_SERVER_CREDENTIALS included.
 * - A credential in the field: it is parsed and used.
 * - An empty field: refused for a connection a browser sent and for a row of a seed file read in literal mode
 *   (SEED_LITERAL_VALUES, the record carries the literal-mode marker); for an operator seed (`managed: true`, which
 *   resolveConnection forces false on every browser-sent connection) refused unless FIRESTORE_SERVER_CREDENTIALS is
 *   exactly "true", and then the server's own identity in ADC order. The resolver passes the record it was given, so
 *   the marker reaches the shared gate.
 */
import {
  type GoogleCredentialRules,
  type GoogleCredentialsOf,
  resolveGoogleCredential,
} from "@/lib/db/auth/google/credentials";
import { DatabaseConfigError } from "@/lib/db/errors";
import { validateHost, validatePort } from "@/lib/db/http/endpoint";
import type { DatabaseConnection, WithLiteralSeedFile } from "@/lib/types";
import { ENV, FIRESTORE_TYPE } from "./constants";
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

const FIRESTORE_KINDS = Object.freeze(["service_account", "authorized_user", "access_token"] as const);
type FirestoreKind = (typeof FIRESTORE_KINDS)[number];
/** Firestore's credentials: a kind another provider lists never reaches this type. */
export type FirestoreCredentials = GoogleCredentialsOf<FirestoreKind | "metadata">;

export type FirestoreAuth =
  | { readonly mode: "emulator"; readonly emulator: EmulatorAddress }
  | { readonly mode: "google"; readonly credentials: FirestoreCredentials };

export const FIRESTORE_CREDENTIAL_SENTENCES = Object.freeze({
  browserEmpty:
    "Paste a service-account key JSON, an authorized-user JSON or an access token: the server's own Google identity is used only for operator-seeded connections",
  seedWithoutOptIn: `Set ${ENV.serverCredentials}=true on the server to let this seeded connection use the server's own Google identity`,
  literalSeedFile:
    "Paste a service-account key JSON, an authorized-user JSON or an access token: the server's own Google identity is not used for a connection read from a seed file in literal mode (SEED_LITERAL_VALUES)",
  emulatorCredential: (display: string) =>
    `This server sends every Firestore connection to the emulator at ${display} (${ENV.emulatorHost}): clear the credential field, or ask the operator to unset the variable`,
  emulatorHost: `${ENV.emulatorHost} must be host:port or [ipv6]:port with no scheme, such as 127.0.0.1:8080`,
});

const S = FIRESTORE_CREDENTIAL_SENTENCES;

export const FIRESTORE_CREDENTIAL_RULES: GoogleCredentialRules<FirestoreKind> = Object.freeze({
  provider: FIRESTORE_TYPE,
  accepts: FIRESTORE_KINDS,
  quotaProjectRefusal: projectIdRefusal,
  serverIdentity: Object.freeze({
    optIn: ENV.serverCredentials,
    unmanaged: S.browserEmpty,
    literalSeedFile: S.literalSeedFile,
    withoutOptIn: S.seedWithoutOptIn,
  }),
});

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
  connection: Pick<DatabaseConnection, "password" | "managed"> & WithLiteralSeedFile,
  seams: FirestoreSeams,
): FirestoreAuth {
  const password = connection.password?.trim() ?? "";
  const emulator = emulatorAddressOf(seams.env);
  if (emulator !== null) {
    if (password !== "") throw new DatabaseConfigError(S.emulatorCredential(emulator.display), FIRESTORE_TYPE);
    return { mode: "emulator", emulator };
  }
  return {
    mode: "google",
    credentials: resolveGoogleCredential(connection, FIRESTORE_CREDENTIAL_RULES, seams),
  };
}
