/**
 * A Google external-account credential (Workload Identity Federation), parsed with no Google SDK: the config names a
 * workload identity pool provider and a URL that hands out a subject token, which token-source.ts exchanges at
 * Google's Security Token Service for an access token of the federated identity itself.
 *
 * The parse is a closed world. A field this module does not read is refused, never ignored, so nothing the config
 * carries can change what is sent without this file saying so: the exchange goes to the fixed STS URL, the subject
 * comes from `credential_source.url` and from no file, command or cloud metadata source, the subject is an OIDC token,
 * a workforce pool is refused, and there is no service-account impersonation. A header the transport or the
 * connection sets is refused, as is a name written twice. The subject token is a credential, so its URL is https
 * unless its host is this machine. No refusal repeats a header value or the config's own text; a field name is
 * quoted only when it is shaped like one.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { endpointUrl, type HttpOrigin, httpOrigin, isLoopbackHost } from "@/lib/db/http/endpoint";
import { HEADER_NAME, isHeaderValue, isOwnedHeader } from "@/lib/db/http/node-transport";
import type { DatabaseType } from "@/lib/types";

/** The only exchange URL; a config naming another is refused. */
export const GOOGLE_STS_URL = "https://sts.googleapis.com/v1/token";

/** How the subject token is found in the URL's answer: the whole body, or one string field of a JSON body. */
export type GoogleSubjectFormat = { readonly type: "text" } | { readonly type: "json"; readonly field: string };

/** Where the subject token is read: one URL on one origin, the headers sent with it, and the answer's format. */
export interface GoogleSubjectSource {
  /** Built by endpointUrl from the origin, the path and the query; never the config's own text. */
  readonly url: string;
  readonly origin: HttpOrigin;
  /** Lower-case names; none the transport owns and none written twice. */
  readonly headers: Readonly<Record<string, string>>;
  readonly format: GoogleSubjectFormat;
}

export interface GoogleExternalAccount {
  readonly type: "external_account";
  /** `//iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`. */
  readonly audience: string;
  readonly subjectTokenType: string;
  readonly source: GoogleSubjectSource;
}

const UNIVERSE = "googleapis.com";
const TOKEN_INFO_URL = "https://sts.googleapis.com/v1/introspect";
const SUBJECT_TOKEN_TYPES: readonly string[] = Object.freeze([
  "urn:ietf:params:oauth:token-type:jwt",
  "urn:ietf:params:oauth:token-type:id_token",
]);
/** A workload identity pool provider, by project number. A workforce pool has no project and never matches. */
const AUDIENCE =
  /^\/\/iam\.googleapis\.com\/projects\/[0-9]{1,20}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/;
const WORKFORCE = "workforcePools";
/** A field name safe to quote back: shaped like a config field, never markup or a long string. */
const FIELD_NAME = /^[a-z][a-z_]{0,63}$/;
const MAX_FIELD_NAME_CHARACTERS = 128;
const MAX_URL_CHARACTERS = 2048;

const TOP_FIELDS: readonly string[] = Object.freeze([
  "type",
  "audience",
  "subject_token_type",
  "token_url",
  "credential_source",
  "universe_domain",
  "token_info_url",
]);
const SOURCE_FIELDS: readonly string[] = Object.freeze(["url", "headers", "format"]);
const FORMAT_FIELDS: readonly string[] = Object.freeze(["type", "subject_token_field_name"]);

export const GOOGLE_EXTERNAL_ACCOUNT_SENTENCES = Object.freeze({
  serverWrittenOnly:
    "An external-account credential is accepted only on a connection the server wrote (an operator seed or a governed connection), never on one typed in the browser or read from a seed file in literal mode",
  serverFile:
    "An external-account credential is accepted only as a connection's own credential, never as the server's credentials file",
  unreadField: (field: string) =>
    `The external-account credential carries ${field}, which Studio does not read: remove it, because a field that is not read is refused, not ignored`,
  workforce:
    "The external-account credential names a workforce pool: only a workload identity pool provider is supported",
  audience:
    "The external-account credential's audience must be //iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>",
  subjectTokenType:
    "The external-account credential's subject_token_type must be urn:ietf:params:oauth:token-type:jwt or urn:ietf:params:oauth:token-type:id_token",
  tokenUrl: `The external-account credential's token_url must be ${GOOGLE_STS_URL}`,
  universe: `The external-account credential's universe_domain must be ${UNIVERSE} when present`,
  tokenInfoUrl: `The external-account credential's token_info_url must be ${TOKEN_INFO_URL} when present`,
  sourceUrlOnly:
    "The external-account credential must read its subject token from credential_source.url: file, executable and cloud metadata sources are not supported",
  sourceUrl:
    "The external-account credential's credential_source.url must be an http or https URL of at most 2048 characters, with no user, password or fragment",
  sourceUrlPlaintext:
    "The external-account credential's credential_source.url must use https unless its host is this machine, because the subject token is a credential",
  headersShape:
    "The external-account credential's credential_source.headers must be a record of header names and single-line values of at most 1024 bytes",
  headerOwned: (name: string) =>
    `The external-account credential's credential_source.headers sets ${name}, which the transport sets itself`,
  headerRepeated: (name: string) =>
    `The external-account credential's credential_source.headers names ${name} more than once`,
  format:
    'The external-account credential\'s credential_source.format must be {"type":"text"}, or {"type":"json","subject_token_field_name":"<field>"}',
});

const S = GOOGLE_EXTERNAL_ACCOUNT_SENTENCES;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The first key of `record` that is not in `known`, worded for a refusal; undefined when every key is known. */
function unreadField(record: Readonly<Record<string, unknown>>, known: readonly string[]): string | undefined {
  const unread = Object.keys(record).find((key) => !known.includes(key));
  if (unread === undefined) return undefined;
  return FIELD_NAME.test(unread) ? unread : "a field";
}

function subjectUrl(value: unknown, provider: DatabaseType | undefined): Pick<GoogleSubjectSource, "url" | "origin"> {
  const invalid = new DatabaseConfigError(S.sourceUrl, provider);
  if (typeof value !== "string" || value.length > MAX_URL_CHARACTERS) throw invalid;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid;
  }
  const scheme = parsed.protocol === "https:" ? "https" : parsed.protocol === "http:" ? "http" : null;
  if (scheme === null || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") throw invalid;
  let origin: HttpOrigin;
  try {
    origin = httpOrigin(scheme, parsed.hostname, parsed.port === "" ? (scheme === "https" ? 443 : 80) : parsed.port);
  } catch {
    throw invalid;
  }
  if (scheme === "http" && !isLoopbackHost(origin.host)) throw new DatabaseConfigError(S.sourceUrlPlaintext, provider);
  return { url: endpointUrl(origin, parsed.pathname, parsed.searchParams), origin };
}

function subjectHeaders(value: unknown, provider: DatabaseType | undefined): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) throw new DatabaseConfigError(S.headersShape, provider);
  const headers: Record<string, string> = {};
  for (const [written, text] of Object.entries(value)) {
    const name = written.toLowerCase();
    if (written.length > MAX_FIELD_NAME_CHARACTERS || !HEADER_NAME.test(name) || !isHeaderValue(text)) {
      throw new DatabaseConfigError(S.headersShape, provider);
    }
    if (isOwnedHeader(name)) throw new DatabaseConfigError(S.headerOwned(name), provider);
    if (Object.hasOwn(headers, name)) throw new DatabaseConfigError(S.headerRepeated(name), provider);
    headers[name] = text;
  }
  return Object.freeze(headers);
}

function subjectFormat(value: unknown, provider: DatabaseType | undefined): GoogleSubjectFormat {
  if (value === undefined) return { type: "text" };
  const invalid = new DatabaseConfigError(S.format, provider);
  if (!isRecord(value) || unreadField(value, FORMAT_FIELDS) !== undefined) throw invalid;
  const field = value.subject_token_field_name;
  if (value.type === "text" && field === undefined) return { type: "text" };
  if (value.type === "json" && typeof field === "string" && field !== "" && field.length <= MAX_FIELD_NAME_CHARACTERS) {
    return { type: "json", field };
  }
  throw invalid;
}

function subjectSource(value: unknown, provider: DatabaseType | undefined): GoogleSubjectSource {
  if (!isRecord(value) || value.url === undefined || unreadField(value, SOURCE_FIELDS) !== undefined) {
    throw new DatabaseConfigError(S.sourceUrlOnly, provider);
  }
  return {
    ...subjectUrl(value.url, provider),
    headers: subjectHeaders(value.headers, provider),
    format: subjectFormat(value.format, provider),
  };
}

/**
 * The credential a JSON of type external_account describes, or a DatabaseConfigError labelled with `provider`. The
 * caller has read the type, admitted the kind and checked the connection is server-written; this reads every other
 * field and makes no request.
 */
export function parseExternalAccount(
  json: Readonly<Record<string, unknown>>,
  provider: DatabaseType | undefined,
): GoogleExternalAccount {
  const refuse = (sentence: string) => new DatabaseConfigError(sentence, provider);
  const unread = unreadField(json, TOP_FIELDS);
  if (unread !== undefined) throw refuse(S.unreadField(unread));
  const { audience, subject_token_type: subjectTokenType } = json;
  if (typeof audience === "string" && audience.includes(WORKFORCE)) throw refuse(S.workforce);
  if (typeof audience !== "string" || !AUDIENCE.test(audience)) throw refuse(S.audience);
  if (typeof subjectTokenType !== "string" || !SUBJECT_TOKEN_TYPES.includes(subjectTokenType)) {
    throw refuse(S.subjectTokenType);
  }
  if (json.token_url !== GOOGLE_STS_URL) throw refuse(S.tokenUrl);
  if (json.universe_domain !== undefined && json.universe_domain !== UNIVERSE) throw refuse(S.universe);
  if (json.token_info_url !== undefined && json.token_info_url !== TOKEN_INFO_URL) throw refuse(S.tokenInfoUrl);
  return {
    type: "external_account",
    audience,
    subjectTokenType,
    source: subjectSource(json.credential_source, provider),
  };
}
