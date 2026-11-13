/**
 * Google OAuth2 access tokens for BigQuery, with no Google SDK: `jose` signs the
 * service-account assertion, the token endpoint is one form POST, and on GKE/GCE the
 * metadata server hands out the workload's token. An `external_account` config (Workload
 * Identity Federation) reads a subject token from a URL and exchanges it at Google's STS.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { importPKCS8, SignJWT } from "jose";
import { AuthenticationError, DatabaseConfigError } from "@/lib/db/errors";
import { type HttpOrigin, httpOrigin, isLoopbackHost } from "@/lib/db/http/endpoint";
import { logger } from "@/lib/logger";
import { type NodeTransport, TransportError } from "@/lib/db/http/node-transport";

const PROVIDER = "bigquery" as const;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/bigquery";
const REFRESH_EARLY_MS = 60_000;
/** The shared refresh runs on its own deadline, so no single caller's abort fails the others waiting on it. */
const REFRESH_TIMEOUT_MS = 30_000;
const TOKEN_RESPONSE_BYTES = 64 * 1024;
/** Opt-in for the server's own identity (ADC file or metadata server) on connections that carry no key. */
const SERVER_CREDENTIALS_ENV = "BIGQUERY_SERVER_CREDENTIALS";
const METADATA_TOKEN_PATH = "/computeMetadata/v1/instance/service-accounts/default/token";
/** Google's Security Token Service. An external_account config may exchange there and nowhere else. */
const STS_URL = "https://sts.googleapis.com/v1/token";
const STS_ORIGIN: HttpOrigin = { scheme: "https", host: "sts.googleapis.com", port: 443 };
/** Every workload identity pool provider's audience starts with this. */
const WIF_AUDIENCE_PREFIX = "//iam.googleapis.com/";
/** The OIDC subject tokens a url source can hand over; AWS and SAML subjects need sources this provider does not read. */
const SUBJECT_TOKEN_TYPES: ReadonlySet<string> = new Set([
  "urn:ietf:params:oauth:token-type:jwt",
  "urn:ietf:params:oauth:token-type:id_token",
]);
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/** Where an external_account config reads its subject token: one URL, its headers, and how to find the token. */
export interface SubjectTokenSource {
  readonly url: string;
  readonly origin: HttpOrigin;
  readonly headers: Readonly<Record<string, string>>;
  readonly format: { readonly type: "text" } | { readonly type: "json"; readonly field: string };
}

export type GoogleCredentials =
  | { readonly type: "service_account"; readonly client_email: string; readonly private_key: string }
  | {
      readonly type: "authorized_user";
      readonly client_id: string;
      readonly client_secret: string;
      readonly refresh_token: string;
    }
  /** GKE Workload Identity or a GCE/Cloud Run service account, via the metadata server. */
  | { readonly type: "metadata"; readonly host: string }
  /** A bearer token pasted as-is (`gcloud auth print-access-token`): about an hour of life and no refresh. */
  | { readonly type: "access_token"; readonly token: string }
  /** Workload Identity Federation: a subject token from `source`, exchanged at STS for a token of that identity. */
  | {
      readonly type: "external_account";
      readonly audience: string;
      readonly subjectTokenType: string;
      readonly source: SubjectTokenSource;
    };

/** What a Google access token looks like: `ya29.…` and its relatives, one unbroken run of URL-safe characters. */
const ACCESS_TOKEN = /^[\w.~+/=-]{20,}$/;

/**
 * The key JSON, or an access token, pasted into the password field. Without one, and only when the operator set
 * BIGQUERY_SERVER_CREDENTIALS=true, the server's own identity: GOOGLE_APPLICATION_CREDENTIALS, then
 * gcloud's ADC file, then the metadata server (Workload Identity). The opt-in exists because every
 * user who can add a connection would otherwise query as the server.
 */
export function readCredentials(
  secret: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): GoogleCredentials {
  let text = secret?.trim();
  if (!text) {
    if (env[SERVER_CREDENTIALS_ENV] !== "true") {
      throw new DatabaseConfigError(
        `BigQuery needs a service-account key in the password field. To use the server's own credentials (ADC or Workload Identity) instead, set ${SERVER_CREDENTIALS_ENV}=true on the server.`,
        PROVIDER,
      );
    }
    const explicit = env.GOOGLE_APPLICATION_CREDENTIALS;
    const file = explicit ?? join(env.HOME ?? homedir(), ".config", "gcloud", "application_default_credentials.json");
    try {
      text = readFileSync(file, "utf8");
    } catch {
      // A named file that is missing is a mistake; a missing default file means "use the metadata server".
      if (explicit) {
        logger.warn("GOOGLE_APPLICATION_CREDENTIALS names a file that cannot be read", { route: "bigquery", file });
        throw new DatabaseConfigError("GOOGLE_APPLICATION_CREDENTIALS names a file that cannot be read", PROVIDER);
      }
      return { type: "metadata", host: env.GCE_METADATA_HOST ?? "metadata.google.internal" };
    }
  }

  if (!text.startsWith("{")) {
    const token = text.replace(/^Bearer\s+/i, "");
    if (ACCESS_TOKEN.test(token)) return { type: "access_token", token };
    throw new DatabaseConfigError(
      "BigQuery credentials are neither a service-account key JSON nor an access token",
      PROVIDER,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DatabaseConfigError("BigQuery credentials are not valid JSON", PROVIDER);
  }
  const creds = parsed as Partial<Record<string, unknown>>;
  if (
    creds.type === "service_account" &&
    typeof creds.client_email === "string" &&
    typeof creds.private_key === "string"
  ) {
    return creds as GoogleCredentials;
  }
  if (
    creds.type === "authorized_user" &&
    typeof creds.client_id === "string" &&
    typeof creds.client_secret === "string" &&
    typeof creds.refresh_token === "string"
  ) {
    return creds as GoogleCredentials;
  }
  if (creds.type === "external_account") return readExternalAccount(creds);
  throw new DatabaseConfigError(
    `BigQuery credentials of type "${String(creds.type)}" are not supported: use a service_account key, authorized_user ADC or an external_account config`,
    PROVIDER,
  );
}

function refuse(message: string): DatabaseConfigError {
  return new DatabaseConfigError(`BigQuery external_account ${message}`, PROVIDER);
}

function isRecord(value: unknown): value is Partial<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A url-sourced external_account config, the shape `gcloud iam workload-identity-pools create-cred-config` writes.
 * Narrower than Google's client libraries on purpose: STS is the only exchange, the federated identity is used
 * directly (no service-account impersonation), and the subject token comes from a URL. A refusal names the field,
 * never its value.
 */
function readExternalAccount(raw: Partial<Record<string, unknown>>): GoogleCredentials {
  if (raw.service_account_impersonation_url !== undefined) {
    throw refuse(
      "credentials with service_account_impersonation_url are not supported: grant the federated identity BigQuery access directly",
    );
  }
  if (raw.token_url !== STS_URL) throw refuse(`credentials must exchange at ${STS_URL}`);
  if (typeof raw.audience !== "string" || !raw.audience.startsWith(WIF_AUDIENCE_PREFIX)) {
    throw refuse(`credentials need an audience naming a workload identity pool provider (${WIF_AUDIENCE_PREFIX}...)`);
  }
  if (typeof raw.subject_token_type !== "string" || !SUBJECT_TOKEN_TYPES.has(raw.subject_token_type)) {
    throw refuse("credentials support subject_token_type urn:ietf:params:oauth:token-type:jwt or id_token only");
  }
  return {
    type: "external_account",
    audience: raw.audience,
    subjectTokenType: raw.subject_token_type,
    source: readSubjectSource(raw.credential_source),
  };
}

function readSubjectSource(raw: unknown): SubjectTokenSource {
  const source = isRecord(raw) ? raw : {};
  if (
    source.url === undefined ||
    source.file !== undefined ||
    source.executable !== undefined ||
    source.environment_id !== undefined
  ) {
    throw refuse(
      "credentials read the subject token from credential_source.url only: file, executable and environment sources are not supported",
    );
  }
  const { url, origin } = subjectUrl(source.url);
  return { url, origin, headers: subjectHeaders(source.headers), format: subjectFormat(source.format) };
}

function subjectUrl(value: unknown): { url: string; origin: HttpOrigin } {
  const invalid = refuse("credential_source.url is not a valid http(s) URL");
  let parsed: URL;
  try {
    parsed = new URL(String(value));
  } catch {
    throw invalid;
  }
  const scheme = parsed.protocol.slice(0, -1);
  if (typeof value !== "string" || (scheme !== "http" && scheme !== "https") || parsed.username || parsed.password) {
    throw invalid;
  }
  const origin = httpOrigin(scheme, parsed.hostname, parsed.port || (scheme === "https" ? 443 : 80));
  // The subject token is a credential: it may cross the network only inside TLS.
  if (scheme === "http" && !isLoopbackHost(origin.host)) {
    throw refuse(
      "credential_source.url must use https unless it is on this machine, because the subject token is a credential",
    );
  }
  return { url: parsed.href, origin };
}

function subjectHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  const entries = isRecord(value) ? Object.entries(value) : null;
  if (
    !entries ||
    !entries.every(([name, header]) => HEADER_NAME.test(name) && typeof header === "string" && !/[\r\n]/.test(header))
  ) {
    throw refuse("credential_source.headers must map header names to single-line strings");
  }
  return Object.fromEntries(entries.map(([name, header]) => [name.toLowerCase(), header as string]));
}

function subjectFormat(value: unknown): SubjectTokenSource["format"] {
  if (value === undefined) return { type: "text" };
  if (isRecord(value) && value.type === "text") return { type: "text" };
  if (isRecord(value) && value.type === "json" && typeof value.subject_token_field_name === "string") {
    const field = value.subject_token_field_name;
    if (field) return { type: "json", field };
  }
  throw refuse("credential_source.format must be text, or json with subject_token_field_name");
}

async function grantForm(
  creds: Exclude<GoogleCredentials, { type: "metadata" | "access_token" | "external_account" }>,
  now: number,
): Promise<Record<string, string>> {
  if (creds.type === "authorized_user") {
    return {
      grant_type: "refresh_token",
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
    };
  }
  const iat = Math.floor(now / 1000);
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(creds.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(await importPKCS8(creds.private_key, "RS256"));
  return { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion };
}

/**
 * The subject token an external_account source hands out. A refusal names the status or what was missing, never the
 * body, which may carry the very credential being fetched.
 */
async function subjectToken(
  source: SubjectTokenSource,
  transport: NodeTransport,
  signal: AbortSignal,
): Promise<string> {
  const failed = (reason: string) => new AuthenticationError(`Subject token request failed: ${reason}`, PROVIDER);
  const response = await transport.request({
    method: "GET",
    url: source.url,
    signal,
    maxResponseBytes: TOKEN_RESPONSE_BYTES,
  });
  if (response.status !== 200) throw failed(`HTTP ${response.status}`);
  let token: unknown = response.text.trim();
  if (source.format.type === "json") {
    let body: unknown;
    try {
      body = JSON.parse(response.text);
    } catch {
      throw failed("the answer is not JSON");
    }
    token = isRecord(body) ? body[source.format.field] : undefined;
  }
  if (typeof token !== "string" || !token) throw failed("the answer holds no subject token");
  return token;
}

/** Where tokens for these credentials come from: Google's token endpoint, the metadata server, or STS. */
export function tokenOrigin(creds: GoogleCredentials): { scheme: "http" | "https"; host: string; port: number } {
  if (creds.type === "external_account") return STS_ORIGIN;
  if (creds.type !== "metadata") return { scheme: "https", host: new URL(TOKEN_URL).hostname, port: 443 };
  const [host, port] = creds.host.split(":");
  return { scheme: "http", host, port: port ? Number(port) : 80 };
}

/**
 * A cached bearer token, refreshed a minute before Google says it expires. An external_account source also needs
 * `subjectTokens`, the transport to its `source.origin`.
 */
export function createTokenSource(
  creds: GoogleCredentials,
  tokens: NodeTransport,
  now: () => number = Date.now,
  subjectTokens?: NodeTransport,
): (signal: AbortSignal) => Promise<string> {
  if (creds.type === "external_account" && !subjectTokens) {
    throw new Error("BigQuery external_account credentials need a subject token transport");
  }
  if (creds.type === "access_token") {
    const { token } = creds;
    return async () => token;
  }

  let cached: { token: string; expiresAt: number } | null = null;
  // Concurrent callers share one refresh; a 401 does not invalidate the cache (expiry only).
  let pending: Promise<string> | null = null;

  const refresh = async (signal: AbortSignal): Promise<string> => {
    const response =
      creds.type === "metadata"
        ? await tokens.request({
            method: "GET",
            url: `http://${creds.host}${METADATA_TOKEN_PATH}?${new URLSearchParams({ scopes: SCOPE })}`,
            signal,
            maxResponseBytes: TOKEN_RESPONSE_BYTES,
          })
        : creds.type === "external_account"
          ? await tokens.request({
              method: "POST",
              url: STS_URL,
              form: {
                grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                audience: creds.audience,
                scope: SCOPE,
                requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
                subject_token_type: creds.subjectTokenType,
                // Checked above: an external_account source never reaches here without its subject transport.
                subject_token: await subjectToken(creds.source, subjectTokens as NodeTransport, signal),
              },
              signal,
              maxResponseBytes: TOKEN_RESPONSE_BYTES,
            })
          : await tokens.request({
              method: "POST",
              url: TOKEN_URL,
              form: await grantForm(creds, now()),
              signal,
              maxResponseBytes: TOKEN_RESPONSE_BYTES,
            });
    let body: { access_token?: unknown; expires_in?: unknown; error_description?: unknown; error?: unknown } = {};
    try {
      body = JSON.parse(response.text);
    } catch {
      // Falls through to the status check with an empty body.
    }
    if (response.status !== 200 || typeof body.access_token !== "string") {
      const reason = body.error_description ?? body.error ?? `HTTP ${response.status}`;
      throw new AuthenticationError(`Google token request failed: ${String(reason)}`, PROVIDER);
    }
    const ttlSeconds = typeof body.expires_in === "number" ? body.expires_in : 3600;
    cached = { token: body.access_token, expiresAt: now() + ttlSeconds * 1000 };
    return cached.token;
  };

  return async (signal) => {
    if (cached && now() < cached.expiresAt - REFRESH_EARLY_MS) return cached.token;
    pending ??= refresh(AbortSignal.timeout(REFRESH_TIMEOUT_MS)).finally(() => {
      pending = null;
    });
    return untilAborted(pending, signal);
  };
}

/** The shared work, or this caller's own abort as the node transport reports one, whichever comes first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(
        signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
          ? new TransportError("timeout", "The request did not finish within its time limit")
          : new TransportError("aborted", "The request was cancelled"),
      );
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
