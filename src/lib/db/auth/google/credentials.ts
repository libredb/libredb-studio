/**
 * Google credentials with no Google SDK: the text a user pastes into the password field, and the server's own
 * identity read in Application Default Credentials order. Policy comes in as GoogleCredentialRules (the provider
 * label, the kinds it accepts, the quota-project rule, the server-identity gate), and the environment and files
 * through GoogleCredentialIo.
 *
 * Three pasted kinds exist: a service-account key JSON, an authorized-user JSON and an access token, and a kind the
 * rules do not list is refused even when this module parses it. Every URL a credential JSON carries (token_uri,
 * auth_uri, universe_domain, credential_source and any other) is dropped, so a token request can only go to Google's
 * fixed token endpoint. No refusal repeats a key, a secret, a token or the JSON parser's own message.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { type HttpOrigin, validateHost, validatePort } from "@/lib/db/http/endpoint";
import type { DatabaseConnection, DatabaseType, WithLiteralSeedFile } from "@/lib/types";
import { type AuthEnv, admitServerIdentity, type ServerIdentityGate } from "../server-identity-gate";

/** The kinds a credential text can be. */
export type GooglePastedKind = "service_account" | "authorized_user" | "access_token";

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

/** The members of the given kinds: a provider's own credentials type, which a kind it does not list never widens. */
export type GoogleCredentialsOf<K extends GoogleCredentials["type"]> = Extract<GoogleCredentials, { readonly type: K }>;

/** What the ADC chain reads through. */
export interface GoogleCredentialIo {
  readonly env: AuthEnv;
  /** UTF-8; throws on any failure, with the runtime's errno `code`. */
  readFile(path: string): string;
  homeDir(): string;
  readonly platform: string;
}

/** What the provider decides: its label on every error, the kinds it accepts, its quota-project rule, its gate. */
export interface GoogleCredentialRules<K extends GooglePastedKind> {
  readonly provider: DatabaseType | undefined;
  /** Required and non-empty, no default: a kind not listed is refused even when this module parses it. */
  readonly accepts: readonly [K, ...K[]];
  readonly quotaProjectRefusal: (id: string) => string | null;
  readonly serverIdentity: ServerIdentityGate;
}

/** The sentences that name the accepted kinds. */
export interface AcceptedKindSentences {
  readonly notACredential: string;
  readonly notJson: string;
  readonly noType: string;
  readonly unknownType: string;
  unsupportedType(type: string): string;
}

const CREDENTIALS_FILE_ENV = "GOOGLE_APPLICATION_CREDENTIALS";
const METADATA_HOST_ENV = "GCE_METADATA_HOST";

/** The variables the ADC chain reads, and nothing else. */
export const GOOGLE_ADC_ENV_NAMES: readonly string[] = Object.freeze([
  CREDENTIALS_FILE_ENV,
  METADATA_HOST_ENV,
  "APPDATA",
  "HOME",
]);

const PEM_BEGIN = "-----BEGIN PRIVATE KEY-----";
const PEM_END = "-----END PRIVATE KEY-----";

/** The refusals that name no accepted kind. */
export const GOOGLE_CREDENTIAL_SENTENCES = Object.freeze({
  serviceAccountFields: "The service-account key JSON needs client_email and private_key as non-empty strings",
  privateKeyShape: `The service-account key's private_key is not a PKCS #8 PEM private key (${PEM_BEGIN})`,
  authorizedUserFields:
    "The authorized-user JSON needs client_id, client_secret and refresh_token as non-empty strings",
  quotaProject: (reason: string) =>
    `The authorized-user JSON's quota_project_id is not a valid project id (${reason}): set one with gcloud auth application-default set-quota-project <project>, or remove the field`,
  namedFileUnreadable: `${CREDENTIALS_FILE_ENV} names a file that cannot be read`,
  wellKnownUnreadable: "The gcloud application default credentials file exists but cannot be read",
  fileNotJson: "The application default credentials file is not a credential JSON",
  metadataHost: `${METADATA_HOST_ENV} must be a host name or address with an optional :port and no scheme`,
});

const S = GOOGLE_CREDENTIAL_SENTENCES;

/** Each kind's name in a sentence, in the fixed order every list is worded in. */
const KIND_NAMES = Object.freeze([
  Object.freeze({ kind: "service_account", name: "a service-account key JSON" }),
  Object.freeze({ kind: "authorized_user", name: "an authorized-user JSON" }),
  Object.freeze({ kind: "access_token", name: "an access token" }),
] as const);

/** Google's own token rule: one unbroken run of URL-safe characters, `ya29.` and its relatives. */
const ACCESS_TOKEN = /^[\w.~+/=-]{20,}$/;
const BEARER = /^Bearer\s+/i;
/** A type value safe to quote back: a credential type name, never markup or a long string. */
const TYPE_NAME = /^[a-z][a-z_]{0,63}$/;
const DEFAULT_METADATA_HOST = "metadata.google.internal";
const POSIX_WELL_KNOWN = "/.config/gcloud/application_default_credentials.json";
const WINDOWS_WELL_KNOWN = "\\gcloud\\application_default_credentials.json";
/** The read failures that mean "there is no such file", which sends the chain on to the metadata server. */
const ABSENT: readonly string[] = Object.freeze(["ENOENT", "ENOTDIR"]);
/** `host`, `host:port` or `[ipv6]:port`, no scheme, no path, no user. */
const METADATA_HOST = /^(\[[^\]]+\]|[^:[\]/@?#\s]+)(?::(\d{1,5}))?$/;

/**
 * notACredential, notJson, noType, unknownType and unsupportedType(type), worded from the kinds in the fixed order
 * service account, authorized user, access token, duplicates removed: two or more kinds read "neither A, B nor C"
 * and "paste A, B or C"; one kind reads "is not A" and "paste A".
 */
export function acceptedKindSentences(
  kinds: readonly [GooglePastedKind, ...GooglePastedKind[]],
): AcceptedKindSentences {
  const names = KIND_NAMES.filter((entry) => kinds.includes(entry.kind)).map((entry) => entry.name);
  const last = names[names.length - 1];
  const list = (conjunction: string) =>
    names.length === 1 ? last : `${names.slice(0, -1).join(", ")} ${conjunction} ${last}`;
  const accepted = `paste ${list("or")}`;
  return Object.freeze({
    notACredential:
      names.length === 1
        ? `The credential is not ${last}: ${accepted}`
        : `The credential is neither ${list("nor")}: ${accepted}`,
    notJson: `The credential starts like JSON but is not valid JSON: ${accepted}`,
    noType: `The credential JSON has no type: ${accepted}`,
    unknownType: `The credential JSON's type is not one Studio recognises: ${accepted}`,
    unsupportedType: (type: string) => `Credentials of type "${type}" are not supported: ${accepted}`,
  });
}

const refuse = (sentence: string, rules: GoogleCredentialRules<GooglePastedKind>) =>
  new DatabaseConfigError(sentence, rules.provider);

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** A kind the parser knows, refused unless the rules list it, before any of its fields is read. */
function admitKind(kind: GooglePastedKind, rules: GoogleCredentialRules<GooglePastedKind>): void {
  if (!rules.accepts.includes(kind)) throw refuse(acceptedKindSentences(rules.accepts).unsupportedType(kind), rules);
}

function serviceAccount(
  json: Readonly<Record<string, unknown>>,
  rules: GoogleCredentialRules<GooglePastedKind>,
): GoogleCredentialsOf<"service_account"> {
  const { client_email: clientEmail, private_key: privateKey, private_key_id: privateKeyId } = json;
  if (!nonEmpty(clientEmail) || !nonEmpty(privateKey)) throw refuse(S.serviceAccountFields, rules);
  if (!privateKey.includes(PEM_BEGIN) || !privateKey.includes(PEM_END)) throw refuse(S.privateKeyShape, rules);
  return { type: "service_account", clientEmail, privateKey, ...(nonEmpty(privateKeyId) ? { privateKeyId } : {}) };
}

function authorizedUser(
  json: Readonly<Record<string, unknown>>,
  rules: GoogleCredentialRules<GooglePastedKind>,
): GoogleCredentialsOf<"authorized_user"> {
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

/** A text that starts with "{": one of the accepted JSON kinds, every other field dropped. */
function parseCredentialJson<K extends GooglePastedKind>(
  text: string,
  rules: GoogleCredentialRules<K>,
): GoogleCredentialsOf<K> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's message can quote the text around the fault, which may be part of the key.
    throw refuse(acceptedKindSentences(rules.accepts).notJson, rules);
  }
  const json = parsed as Readonly<Record<string, unknown>>;
  const type = json.type;
  if (!nonEmpty(type)) throw refuse(acceptedKindSentences(rules.accepts).noType, rules);
  if (type === "service_account" || type === "authorized_user") {
    admitKind(type, rules);
    const credentials = type === "service_account" ? serviceAccount(json, rules) : authorizedUser(json, rules);
    // Admitted above: the kind is one of K.
    return credentials as GoogleCredentialsOf<K>;
  }
  const sentences = acceptedKindSentences(rules.accepts);
  throw refuse(TYPE_NAME.test(type) ? sentences.unsupportedType(type) : sentences.unknownType, rules);
}

/**
 * The password field: a credential JSON or an access token of a kind the rules accept. Line feeds and carriage
 * returns are removed from a JSON text first, as the browser's password input removes them, so a pretty-printed, CRLF
 * or terminal-wrapped key parses the same whichever way it arrived; a key's own line breaks are `\n` escapes and
 * survive. No server effect.
 */
export function parseGoogleCredentialText<K extends GooglePastedKind>(
  text: string,
  rules: GoogleCredentialRules<K>,
): GoogleCredentialsOf<K> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    const token = trimmed.replace(BEARER, "");
    if (!ACCESS_TOKEN.test(token)) throw refuse(acceptedKindSentences(rules.accepts).notACredential, rules);
    admitKind("access_token", rules);
    // Admitted above: access_token is one of K.
    return { type: "access_token", token } as GoogleCredentialsOf<K>;
  }
  return parseCredentialJson(trimmed.replace(/[\r\n]/g, ""), rules);
}

function parseCredentialFile<K extends GooglePastedKind>(
  text: string,
  rules: GoogleCredentialRules<K>,
): GoogleCredentialsOf<K> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) throw refuse(S.fileNotJson, rules);
  return parseCredentialJson(trimmed, rules);
}

function wellKnownPath(io: GoogleCredentialIo): string | null {
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
 * the chain on; one that exists and cannot be read is an error. Not exported: resolveGoogleCredential, which runs the
 * server-identity gate first, is the only way here.
 */
function readServerIdentity<K extends GooglePastedKind>(
  io: GoogleCredentialIo,
  rules: GoogleCredentialRules<K>,
): GoogleCredentialsOf<K> | GoogleCredentialsOf<"metadata"> {
  const named = io.env[CREDENTIALS_FILE_ENV]?.trim();
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
      if (!ABSENT.includes(errnoOf(error) ?? "")) throw refuse(S.wellKnownUnreadable, rules);
    }
    if (text !== null) return parseCredentialFile(text, rules);
  }
  const host = io.env[METADATA_HOST_ENV]?.trim() || DEFAULT_METADATA_HOST;
  parseMetadataHost(host, rules.provider);
  return { type: "metadata", host };
}

/**
 * A non-blank password is parsed; an empty one goes through admitServerIdentity(rules.serverIdentity, connection, ...),
 * then the ADC chain. The only way to the ADC chain: its reader is module-private. createGoogleTokenSource accepts any
 * credential, so a provider passes it only what this returns and never builds a metadata credential itself.
 * The provider passes the record it was given, never a copy built field by field, so the literal-mode marker it
 * may carry reaches the gate.
 */
export function resolveGoogleCredential<K extends GooglePastedKind>(
  connection: Pick<DatabaseConnection, "password" | "managed"> & WithLiteralSeedFile,
  rules: GoogleCredentialRules<K>,
  io: GoogleCredentialIo,
): GoogleCredentialsOf<K> | GoogleCredentialsOf<"metadata"> {
  const text = connection.password?.trim() ?? "";
  if (text !== "") return parseGoogleCredentialText(text, rules);
  admitServerIdentity(rules.serverIdentity, connection, io.env, rules.provider);
  return readServerIdentity(io, rules);
}

/**
 * The secrets a credential holds, for secretForms: an access token's token; a service account's private key, then its
 * key id when present; an authorized user's client secret, then its refresh token; nothing for the metadata server.
 * An exhaustive switch, so a new kind does not compile without its row.
 */
export function googleCredentialSecrets(credentials: GoogleCredentials): readonly string[] {
  switch (credentials.type) {
    case "access_token":
      return [credentials.token];
    case "service_account":
      return [credentials.privateKey, ...(credentials.privateKeyId === undefined ? [] : [credentials.privateKeyId])];
    case "authorized_user":
      return [credentials.clientSecret, credentials.refreshToken];
    case "metadata":
      return [];
  }
}

/** { "x-goog-user-project": id } for an authorized user with a quota project, else {}. */
export function quotaProjectHeaders(credentials: GoogleCredentials): Readonly<Record<string, string>> {
  return credentials.type === "authorized_user" && credentials.quotaProjectId !== undefined
    ? { "x-goog-user-project": credentials.quotaProjectId }
    : {};
}
