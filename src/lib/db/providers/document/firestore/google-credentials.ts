/**
 * Google credentials with no Google SDK, the Google-generic half of this directory: the text a user pastes into the
 * password field, and the server's own identity read in Application Default Credentials order. Nothing here names
 * Firestore: the provider label and the quota-project rule come in as CredentialRules, and the environment and files
 * through CredentialIo.
 *
 * Three pasted shapes are accepted: a service-account key JSON, an authorized-user JSON and an access token. Every
 * other credential type is refused, and every URL a credential JSON carries (token_uri, auth_uri, universe_domain,
 * credential_source and any other) is dropped, so a token request can only go to Google's fixed token endpoint. No
 * refusal repeats a key, a secret, a token or the JSON parser's own message.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { type HttpOrigin, validateHost, validatePort } from "@/lib/db/http/endpoint";
import type { DatabaseType } from "@/lib/types";
import { ENV } from "./constants";
import type { FirestoreEnv } from "./seams";

export type GoogleCredentials =
  | {
      readonly type: "service_account";
      readonly clientEmail: string;
      readonly privateKey: string;
      readonly privateKeyId?: string;
    }
  | {
      readonly type: "authorized_user";
      readonly clientId: string;
      readonly clientSecret: string;
      readonly refreshToken: string;
      /** Sent as x-goog-user-project; present only after it passed the rules' project id rule. */
      readonly quotaProjectId?: string;
    }
  /** Pasted as is (gcloud auth print-access-token): about an hour of life and no refresh. */
  | { readonly type: "access_token"; readonly token: string }
  /** GKE Workload Identity or a GCE or Cloud Run service account, through the metadata server at `host[:port]`. */
  | { readonly type: "metadata"; readonly host: string };

/** What the ADC chain reads through: the seams satisfy it. */
export interface CredentialIo {
  readonly env: FirestoreEnv;
  readFile(path: string): string;
  homeDir(): string;
  readonly platform: string;
}

/** What the engine using this half decides: its label on every error, and the rule a quota project must pass. */
export interface CredentialRules {
  readonly provider: DatabaseType | undefined;
  readonly quotaProjectRefusal: (id: string) => string | null;
}

const ACCEPTED = "paste a service-account key JSON, an authorized-user JSON or an access token";
const PEM_BEGIN = "-----BEGIN PRIVATE KEY-----";
const PEM_END = "-----END PRIVATE KEY-----";

export const GOOGLE_CREDENTIAL_SENTENCES = Object.freeze({
  notACredential: `The credential is neither a service-account key JSON, an authorized-user JSON nor an access token: ${ACCEPTED}`,
  notJson: `The credential starts like JSON but is not valid JSON: ${ACCEPTED}`,
  noType: `The credential JSON has no type: ${ACCEPTED}`,
  unknownType: `The credential JSON's type is not one Studio recognises: ${ACCEPTED}`,
  unsupportedType: (type: string) => `Credentials of type "${type}" are not supported: ${ACCEPTED}`,
  serviceAccountFields: "The service-account key JSON needs client_email and private_key as non-empty strings",
  privateKeyShape: `The service-account key's private_key is not a PKCS #8 PEM private key (${PEM_BEGIN})`,
  authorizedUserFields:
    "The authorized-user JSON needs client_id, client_secret and refresh_token as non-empty strings",
  quotaProject: (reason: string) =>
    `The authorized-user JSON's quota_project_id is not a valid project id (${reason}): set one with gcloud auth application-default set-quota-project <project>, or remove the field`,
  namedFileUnreadable: `${ENV.credentialsFile} names a file that cannot be read`,
  wellKnownUnreadable: "The gcloud application default credentials file exists but cannot be read",
  fileNotJson: "The application default credentials file is not a credential JSON",
  metadataHost: `${ENV.metadataHost} must be a host name or address with an optional :port and no scheme`,
});

const S = GOOGLE_CREDENTIAL_SENTENCES;

/** Google's own token rule, as BigQuery's: one unbroken run of URL-safe characters, `ya29.` and its relatives. */
const ACCESS_TOKEN = /^[\w.~+/=-]{20,}$/;
const BEARER = /^Bearer\s+/i;
/** A type value safe to quote back: a credential type name, never markup or a long string. */
const TYPE_NAME = /^[a-z][a-z_]{0,63}$/;
const DEFAULT_METADATA_HOST = "metadata.google.internal";
const POSIX_WELL_KNOWN = "/.config/gcloud/application_default_credentials.json";
const WINDOWS_WELL_KNOWN = "\\gcloud\\application_default_credentials.json";
/** The read failures that mean "there is no such file", which sends the chain on to the metadata server. */
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);
/** `host`, `host:port` or `[ipv6]:port`, no scheme, no path, no user. */
const METADATA_HOST = /^(\[[^\]]+\]|[^:[\]/@?#\s]+)(?::(\d{1,5}))?$/;

const refuse = (sentence: string, rules: CredentialRules) => new DatabaseConfigError(sentence, rules.provider);

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function serviceAccount(json: Readonly<Record<string, unknown>>, rules: CredentialRules): GoogleCredentials {
  const { client_email: clientEmail, private_key: privateKey, private_key_id: privateKeyId } = json;
  if (!nonEmpty(clientEmail) || !nonEmpty(privateKey)) throw refuse(S.serviceAccountFields, rules);
  if (!privateKey.includes(PEM_BEGIN) || !privateKey.includes(PEM_END)) throw refuse(S.privateKeyShape, rules);
  return { type: "service_account", clientEmail, privateKey, ...(nonEmpty(privateKeyId) ? { privateKeyId } : {}) };
}

function authorizedUser(json: Readonly<Record<string, unknown>>, rules: CredentialRules): GoogleCredentials {
  const {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    quota_project_id: quota,
  } = json;
  if (!nonEmpty(clientId) || !nonEmpty(clientSecret) || !nonEmpty(refreshToken)) {
    throw refuse(S.authorizedUserFields, rules);
  }
  if (quota === undefined) return { type: "authorized_user", clientId, clientSecret, refreshToken };
  if (typeof quota !== "string") throw refuse(S.quotaProject("it is not a string"), rules);
  const reason = rules.quotaProjectRefusal(quota);
  if (reason !== null) throw refuse(S.quotaProject(reason), rules);
  return { type: "authorized_user", clientId, clientSecret, refreshToken, quotaProjectId: quota };
}

/** A text that starts with "{": one of the two accepted JSON types, every other field dropped. */
function parseCredentialJson(text: string, rules: CredentialRules): GoogleCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's message can quote the text around the fault, which may be part of the key.
    throw refuse(S.notJson, rules);
  }
  const json = parsed as Readonly<Record<string, unknown>>;
  const type = json.type;
  if (!nonEmpty(type)) throw refuse(S.noType, rules);
  if (type === "service_account") return serviceAccount(json, rules);
  if (type === "authorized_user") return authorizedUser(json, rules);
  throw refuse(TYPE_NAME.test(type) ? S.unsupportedType(type) : S.unknownType, rules);
}

/**
 * The password field: a credential JSON or an access token. Line feeds and carriage returns are removed from a JSON
 * text first, as the browser's password input removes them, so a pretty-printed, CRLF or terminal-wrapped key parses
 * the same whichever way it arrived; a key's own line breaks are `\n` escapes and survive.
 */
export function parseCredentialText(text: string, rules: CredentialRules): GoogleCredentials {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    const token = trimmed.replace(BEARER, "");
    if (ACCESS_TOKEN.test(token)) return { type: "access_token", token };
    throw refuse(S.notACredential, rules);
  }
  return parseCredentialJson(trimmed.replace(/[\r\n]/g, ""), rules);
}

function parseCredentialFile(text: string, rules: CredentialRules): GoogleCredentials {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) throw refuse(S.fileNotJson, rules);
  return parseCredentialJson(trimmed, rules);
}

function wellKnownPath(io: CredentialIo): string | null {
  if (io.platform === "win32") {
    const appData = io.env.APPDATA?.trim();
    return appData ? `${appData}${WINDOWS_WELL_KNOWN}` : null;
  }
  return `${io.env.HOME?.trim() || io.homeDir()}${POSIX_WELL_KNOWN}`;
}

/**
 * The metadata server's address from GCE_METADATA_HOST or its default, validated; the scheme is always http. The
 * provider labels the refusal, as every other error of this module is labelled.
 */
export function parseMetadataHost(value: string, provider?: DatabaseType): HttpOrigin {
  const match = METADATA_HOST.exec(value);
  if (match === null) throw new DatabaseConfigError(S.metadataHost, provider);
  try {
    return { scheme: "http", host: validateHost(match[1]), port: match[2] === undefined ? 80 : validatePort(match[2]) };
  } catch {
    throw new DatabaseConfigError(S.metadataHost, provider);
  }
}

/**
 * The server's own identity, in ADC order: the file GOOGLE_APPLICATION_CREDENTIALS names (an unreadable one is an
 * error, never a fallback), gcloud's well-known file, then the metadata server. Only an absent well-known file moves
 * the chain on; one that exists and cannot be read is an error.
 */
export function readServerIdentity(io: CredentialIo, rules: CredentialRules): GoogleCredentials {
  const named = io.env[ENV.credentialsFile]?.trim();
  if (named) {
    let text: string;
    try {
      text = io.readFile(named);
    } catch {
      throw refuse(S.namedFileUnreadable, rules);
    }
    return parseCredentialFile(text, rules);
  }
  const wellKnown = wellKnownPath(io);
  if (wellKnown !== null) {
    let text: string | null = null;
    try {
      text = io.readFile(wellKnown);
    } catch (error) {
      if (!ABSENT.has(errnoOf(error) ?? "")) throw refuse(S.wellKnownUnreadable, rules);
    }
    if (text !== null) return parseCredentialFile(text, rules);
  }
  const host = io.env[ENV.metadataHost]?.trim() || DEFAULT_METADATA_HOST;
  parseMetadataHost(host, rules.provider);
  return { type: "metadata", host };
}
