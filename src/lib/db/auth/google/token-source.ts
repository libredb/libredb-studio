/**
 * Google OAuth2 access tokens with no Google SDK: jose signs the service-account assertion, the token endpoint is one
 * form POST to the fixed token URL, a refresh grant carries no scope, and the metadata server hands out the workload's
 * token, and an external account's subject token is read from its URL and exchanged at Google's STS. The scope, the
 * provider label, the response cap, the clock, the deadline and the transport factory come in
 * as GoogleTokenSourceDeps; the lane options come from authLaneOptions, never from the caller.
 *
 * One cached token per source, held by the shared refreshing value (../refresh.ts): refreshed 60 seconds before it
 * expires; concurrent callers share one refresh, which runs on its own 30-second deadline so no caller's abort fails
 * the others; a failed refresh caches nothing. An answer without a usable expires_in lives Google's documented one
 * hour, except an STS answer, which is refused without one. A subject token is read again at every refresh and never
 * kept. No error carries a token, an assertion, a subject token, a key, a key id, a refresh token, a client secret or
 * a subject header's value: a reason quoted from the server passes serverText with the forms of the credential's
 * secrets, and of the subject token an STS answer may echo, before it is cut to 300 characters. Nothing the subject
 * endpoint answers is ever quoted.
 */
import { importPKCS8, SignJWT } from "jose";
import { AuthenticationError } from "@/lib/db/errors";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import type { NodeResponse, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import { secretForms, serverText } from "@/lib/db/utils/server-text";
import type { DatabaseType } from "@/lib/types";
import { type AuthLaneSpec, authLaneOptions } from "../lanes";
import { createRefreshingValue, type Expiring, type RefreshRun } from "../refresh";
import {
  type GoogleCredentials,
  type GoogleCredentialsOf,
  googleCredentialSecrets,
  parseMetadataHost,
} from "./credentials";
import { GOOGLE_STS_URL, type GoogleSubjectSource } from "./external-account";

/** The only token URL; a credential's own `token_uri` is never read. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Which credential endpoint a transport serves: Google's token endpoint, the metadata server, Google's STS, or the
 * URL an external account reads its subject token from.
 */
export type GoogleAuthLane = "token" | "metadata" | "sts" | "subject";

export interface GoogleTokenSource {
  token(signal: AbortSignal): Promise<string>;
  close(): void;
}

export interface GoogleTokenSourceDeps {
  readonly scope: string;
  readonly provider: DatabaseType | undefined;
  /** The cap on a token or metadata answer, in bytes. */
  readonly maxResponseBytes: number;
  now(): number;
  timeoutSignal(ms: number): AbortSignal;
  /** createNodeTransport in production; called at most once per lane kind, with options from authLaneOptions. */
  createTransport(options: NodeTransportOptions, lane: GoogleAuthLane): NodeTransport;
}

export const GOOGLE_TOKEN_SOURCE_SENTENCES = Object.freeze({
  refused: (reason: string) => `Google token request failed: ${reason}`,
  keyUnreadable:
    "The service-account key's private_key could not be read as an RSA PKCS #8 key, so Studio cannot sign with it",
  closed: "The Google token source is closed",
  subjectRefused: (reason: string) => `Subject token request failed: ${reason}`,
  subjectMissing: "the answer holds no subject token",
  stsWithoutExpiry: "Google STS answered with no usable expires_in, so Studio cannot tell when the token ends",
});

const S = GOOGLE_TOKEN_SOURCE_SENTENCES;
const REFRESH_EARLY_MS = 60_000;
const ASSERTION_LIFETIME_S = 3600;
/** Google's documented lifetime of an access token, used when an answer carries no usable expires_in. */
const DEFAULT_TTL_S = 3600;
const REASON_CHARACTERS = 300;
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const METADATA_TOKEN_PATH = "/computeMetadata/v1/instance/service-accounts/default/token";
const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
/** A subject token is one unbroken run of visible ASCII: a JWT, or an opaque token of the same alphabet. */
const SUBJECT_TOKEN = /^[\x21-\x7e]{1,16384}$/;

/** The kinds that refresh: every kind but a pasted access token. */
type RefreshingKind = Exclude<GoogleCredentials["type"], "access_token">;

/**
 * What a strategy reaches: the deps, the refresh, the one lane of a kind, built on first use, and withhold, which
 * adds a secret made during this refresh to the forms a quoted reason is checked against.
 */
interface StrategyContext {
  readonly deps: GoogleTokenSourceDeps;
  readonly run: RefreshRun;
  lane(kind: GoogleAuthLane, spec: () => AuthLaneSpec): NodeTransport;
  withhold(secret: string): void;
}

type Strategy<K extends RefreshingKind> = (
  credentials: GoogleCredentialsOf<K>,
  context: StrategyContext,
) => Promise<NodeResponse>;

function tokenLane(context: StrategyContext): NodeTransport {
  return context.lane("token", () => ({ origin: httpOrigin("https", new URL(GOOGLE_TOKEN_URL).hostname, 443) }));
}

/** A grant to the token endpoint, once its form is built: close() may have landed while it was. */
function postGrant(form: Record<string, string>, context: StrategyContext): Promise<NodeResponse> {
  context.run.throwIfClosed();
  return tokenLane(context).request({
    method: "POST",
    url: GOOGLE_TOKEN_URL,
    form,
    signal: context.run.signal,
    maxResponseBytes: context.deps.maxResponseBytes,
  });
}

/** The JWT-bearer grant's form: an RS256 assertion signed with the service account's key. */
async function assertionForm(
  credentials: GoogleCredentialsOf<"service_account">,
  deps: GoogleTokenSourceDeps,
): Promise<Record<string, string>> {
  let key: CryptoKey;
  try {
    key = await importPKCS8(credentials.privateKey, "RS256");
  } catch {
    throw new AuthenticationError(S.keyUnreadable, deps.provider);
  }
  const iat = Math.floor(deps.now() / 1000);
  const assertion = await new SignJWT({ scope: deps.scope })
    .setProtectedHeader({
      alg: "RS256",
      typ: "JWT",
      ...(credentials.privateKeyId === undefined ? {} : { kid: credentials.privateKeyId }),
    })
    .setIssuer(credentials.clientEmail)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ASSERTION_LIFETIME_S)
    .sign(key);
  return { grant_type: JWT_BEARER, assertion };
}

/** The refresh-token grant's form: no scope, which the user's consent fixed. */
async function refreshTokenForm(credentials: GoogleCredentialsOf<"authorized_user">): Promise<Record<string, string>> {
  return {
    grant_type: "refresh_token",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
  };
}

const jwtBearerGrant: Strategy<"service_account"> = async (credentials, context) =>
  postGrant(await assertionForm(credentials, context.deps), context);

const refreshTokenGrant: Strategy<"authorized_user"> = async (credentials, context) =>
  postGrant(await refreshTokenForm(credentials), context);

/** The metadata server: a GET for the scope, on a lane that carries the flavor header the server requires. */
const metadataToken: Strategy<"metadata"> = async (credentials, context) => {
  const origin = parseMetadataHost(credentials.host, context.deps.provider);
  const url = endpointUrl(origin, METADATA_TOKEN_PATH, new URLSearchParams({ scopes: context.deps.scope }));
  const lane = context.lane("metadata", () => ({
    origin,
    headers: { "metadata-flavor": "Google" },
    linkLocalEndpoint: true,
  }));
  return lane.request({
    method: "GET",
    url,
    signal: context.run.signal,
    maxResponseBytes: context.deps.maxResponseBytes,
  });
};

/**
 * The subject token of an external account: one GET to its URL, on a lane of its own origin carrying its headers.
 * Only a 200 is read, as the whole body or as one string field of a JSON body. A refusal names the status or that
 * the token was missing and never the answer, which may be the token.
 */
async function subjectToken(source: GoogleSubjectSource, context: StrategyContext): Promise<string> {
  const lane = context.lane("subject", () => ({ origin: source.origin, headers: source.headers }));
  const response = await lane.request({
    method: "GET",
    url: source.url,
    signal: context.run.signal,
    maxResponseBytes: context.deps.maxResponseBytes,
  });
  const failed = (reason: string) => new AuthenticationError(S.subjectRefused(reason), context.deps.provider);
  if (response.status !== 200) throw failed(`HTTP ${response.status}`);
  const token = source.format.type === "text" ? response.text.trim() : tokenBody(response.text)[source.format.field];
  if (typeof token !== "string" || !SUBJECT_TOKEN.test(token)) throw failed(S.subjectMissing);
  return token;
}

/** The token exchange: a fresh subject token, then one form POST to the fixed STS URL for the provider's scope. */
const tokenExchange: Strategy<"external_account"> = async (credentials, context) => {
  const subject = await subjectToken(credentials.source, context);
  context.withhold(subject);
  context.run.throwIfClosed();
  const lane = context.lane("sts", () => ({ origin: httpOrigin("https", new URL(GOOGLE_STS_URL).hostname, 443) }));
  return lane.request({
    method: "POST",
    url: GOOGLE_STS_URL,
    form: {
      grant_type: TOKEN_EXCHANGE,
      audience: credentials.audience,
      scope: context.deps.scope,
      requested_token_type: ACCESS_TOKEN_TYPE,
      subject_token_type: credentials.subjectTokenType,
      subject_token: subject,
    },
    signal: context.run.signal,
    maxResponseBytes: context.deps.maxResponseBytes,
  });
};

/** One strategy per refreshing kind: a kind without one does not compile. */
const STRATEGIES: { readonly [K in RefreshingKind]: Strategy<K> } = Object.freeze({
  service_account: jwtBearerGrant,
  authorized_user: refreshTokenGrant,
  external_account: tokenExchange,
  metadata: metadataToken,
});

function exchange<K extends RefreshingKind>(
  kind: K,
  credentials: GoogleCredentialsOf<K>,
  context: StrategyContext,
): Promise<NodeResponse> {
  return STRATEGIES[kind](credentials, context);
}

function tokenBody(text: string): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** error_description, then error, each withheld whole when it holds a form of the credential; else the status. */
function reasonOf(body: Readonly<Record<string, unknown>>, status: number, forms: readonly string[]): string {
  const reason = [body.error_description, body.error].find((value) => typeof value === "string" && value !== "");
  return typeof reason === "string" ? serverText(reason, forms).slice(0, REASON_CHARACTERS) : `HTTP ${status}`;
}

export function createGoogleTokenSource(
  credentials: GoogleCredentials,
  deps: GoogleTokenSourceDeps,
): GoogleTokenSource {
  if (credentials.type === "access_token") {
    const { token } = credentials;
    return { token: async () => token, close() {} };
  }

  const secrets = googleCredentialSecrets(credentials);
  const forms = secretForms(secrets);
  const lanes = new Map<GoogleAuthLane, NodeTransport>();

  const lane = (kind: GoogleAuthLane, spec: () => AuthLaneSpec): NodeTransport => {
    let transport = lanes.get(kind);
    if (transport === undefined) {
      transport = deps.createTransport(authLaneOptions(spec()), kind);
      lanes.set(kind, transport);
    }
    return transport;
  };

  const refresh = async (run: RefreshRun): Promise<Expiring<string>> => {
    const made: string[] = [];
    const withhold = (secret: string) => void made.push(secret);
    const response = await exchange(credentials.type, credentials, { deps, run, lane, withhold });
    const body = tokenBody(response.text);
    const token = body.access_token;
    if (response.status !== 200 || typeof token !== "string" || token === "") {
      const withheld = made.length === 0 ? forms : secretForms([...secrets, ...made]);
      throw new AuthenticationError(S.refused(reasonOf(body, response.status, withheld)), deps.provider);
    }
    const expiresIn = body.expires_in;
    const usable = typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0;
    // The other kinds have Google's documented hour to fall back on; an exchanged token ends with its subject.
    if (!usable && credentials.type === "external_account") {
      throw new AuthenticationError(S.refused(S.stsWithoutExpiry), deps.provider);
    }
    const ttl = usable ? expiresIn : DEFAULT_TTL_S;
    return { value: token, expiresAt: deps.now() + ttl * 1000 };
  };

  const cached = createRefreshingValue({
    refresh,
    earlyMs: REFRESH_EARLY_MS,
    now: () => deps.now(),
    timeoutSignal: (ms) => deps.timeoutSignal(ms),
    sentences: { closed: S.closed },
  });

  return {
    token: (signal) => cached.get(signal),
    close() {
      cached.close();
      for (const transport of lanes.values()) transport.close();
      lanes.clear();
    },
  };
}
