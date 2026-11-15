/**
 * Google OAuth2 access tokens with no Google SDK: jose signs the service-account assertion, the token endpoint is one
 * form POST to the fixed token URL, a refresh grant carries no scope, and the metadata server hands out the workload's
 * token. The scope, the provider label, the response cap, the clock, the deadline and the transport factory come in
 * as GoogleTokenSourceDeps; the lane options come from authLaneOptions, never from the caller.
 *
 * One cached token per source, held by the shared refreshing value (../refresh.ts): refreshed 60 seconds before it
 * expires; concurrent callers share one refresh, which runs on its own 30-second deadline so no caller's abort fails
 * the others; a failed refresh caches nothing. An answer without a usable expires_in lives Google's documented one
 * hour. No error carries a token, an assertion, a key, a key id, a refresh token or a client secret: a reason quoted
 * from the server passes serverText with the forms of the credential's secrets before it is cut to 300 characters.
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

/** The only token URL; a credential's own `token_uri` is never read. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Which credential endpoint a transport serves: Google's token endpoint or the metadata server. */
export type GoogleAuthLane = "token" | "metadata";

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
});

const S = GOOGLE_TOKEN_SOURCE_SENTENCES;
const REFRESH_EARLY_MS = 60_000;
const ASSERTION_LIFETIME_S = 3600;
/** Google's documented lifetime of an access token, used when an answer carries no usable expires_in. */
const DEFAULT_TTL_S = 3600;
const REASON_CHARACTERS = 300;
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const METADATA_TOKEN_PATH = "/computeMetadata/v1/instance/service-accounts/default/token";

/** The kinds that refresh: every kind but a pasted access token. */
type RefreshingKind = Exclude<GoogleCredentials["type"], "access_token">;

/** What a strategy reaches: the deps, the refresh, and the one lane of a kind, built on first use. */
interface StrategyContext {
  readonly deps: GoogleTokenSourceDeps;
  readonly run: RefreshRun;
  lane(kind: GoogleAuthLane, spec: () => AuthLaneSpec): NodeTransport;
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

/** One strategy per refreshing kind: a kind without one does not compile. */
const STRATEGIES: { readonly [K in RefreshingKind]: Strategy<K> } = Object.freeze({
  service_account: jwtBearerGrant,
  authorized_user: refreshTokenGrant,
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

  const forms = secretForms(googleCredentialSecrets(credentials));
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
    const response = await exchange(credentials.type, credentials, { deps, run, lane });
    const body = tokenBody(response.text);
    const token = body.access_token;
    if (response.status !== 200 || typeof token !== "string" || token === "") {
      throw new AuthenticationError(S.refused(reasonOf(body, response.status, forms)), deps.provider);
    }
    const expiresIn = body.expires_in;
    const ttl =
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_TTL_S;
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
