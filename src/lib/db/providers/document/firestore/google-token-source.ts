/**
 * Google OAuth2 access tokens with no Google SDK, the Google-generic half of this directory: jose signs the
 * service-account assertion, the token endpoint is one form POST to the fixed token URL, a refresh grant carries no
 * scope, and the metadata server hands out the workload's token. The scope, the provider label, the response cap, the
 * clock, the deadline and both transports come in as TokenSourceDeps.
 *
 * One cached token per source, refreshed 60 seconds before it expires; concurrent callers share one refresh, which
 * runs on its own 30-second deadline so no caller's abort fails the others; a failed refresh caches nothing. No error
 * carries a token, an assertion, a key, a key id, a refresh token or a client secret.
 */
import { importPKCS8, SignJWT } from "jose";
import { AuthenticationError } from "@/lib/db/errors";
import { endpointUrl } from "@/lib/db/http/endpoint";
import { type NodeResponse, type NodeTransport, TransportError } from "@/lib/db/http/node-transport";
import type { DatabaseType } from "@/lib/types";
import { GOOGLE_TOKEN_URL } from "./constants";
import { type GoogleCredentials, parseMetadataHost } from "./google-credentials";

export interface TokenSource {
  token(signal: AbortSignal): Promise<string>;
  close(): void;
}

export interface TokenSourceDeps {
  readonly scope: string;
  readonly provider: DatabaseType | undefined;
  /** The cap on a token or metadata answer, in bytes. */
  readonly maxResponseBytes: number;
  now(): number;
  timeoutSignal(ms: number): AbortSignal;
  /** The lane to Google's token endpoint; called at most once, on the first refresh. */
  tokenTransport(): NodeTransport;
  /** The lane to the metadata server at `host[:port]`; called at most once, on the first refresh. */
  metadataTransport(host: string): NodeTransport;
}

export const TOKEN_SOURCE_SENTENCES = Object.freeze({
  refused: (reason: string) => `Google token request failed: ${reason}`,
  keyUnreadable:
    "The service-account key's private_key could not be read as an RSA PKCS #8 key, so Studio cannot sign with it",
  closed: "The Google token source is closed",
});

const S = TOKEN_SOURCE_SENTENCES;
const REFRESH_EARLY_MS = 60_000;
/** The shared refresh runs on its own deadline, so no single caller's abort fails the others waiting on it. */
const REFRESH_TIMEOUT_MS = 30_000;
const ASSERTION_LIFETIME_S = 3600;
const DEFAULT_TTL_S = 3600;
const REASON_CHARACTERS = 300;
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const METADATA_TOKEN_PATH = "/computeMetadata/v1/instance/service-accounts/default/token";

type Granted = Extract<GoogleCredentials, { type: "service_account" | "authorized_user" }>;

async function grantForm(credentials: Granted, deps: TokenSourceDeps): Promise<Record<string, string>> {
  if (credentials.type === "authorized_user") {
    return {
      grant_type: "refresh_token",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
    };
  }
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

function reasonOf(body: Readonly<Record<string, unknown>>, status: number): string {
  const reason = [body.error_description, body.error].find((value) => typeof value === "string" && value !== "");
  return typeof reason === "string" ? reason.slice(0, REASON_CHARACTERS) : `HTTP ${status}`;
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
    const release = () => signal.removeEventListener("abort", onAbort);
    work.then(
      (value) => {
        release();
        resolve(value);
      },
      (error: unknown) => {
        release();
        reject(error);
      },
    );
  });
}

export function createTokenSource(credentials: GoogleCredentials, deps: TokenSourceDeps): TokenSource {
  if (credentials.type === "access_token") {
    const { token } = credentials;
    return { token: async () => token, close() {} };
  }

  const closer = new AbortController();
  let transport: NodeTransport | null = null;
  let cached: { readonly token: string; readonly expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;

  const lane = (): NodeTransport => {
    transport ??= credentials.type === "metadata" ? deps.metadataTransport(credentials.host) : deps.tokenTransport();
    return transport;
  };

  const exchange = async (signal: AbortSignal): Promise<NodeResponse> => {
    if (credentials.type === "metadata") {
      const url = endpointUrl(
        parseMetadataHost(credentials.host, deps.provider),
        METADATA_TOKEN_PATH,
        new URLSearchParams({ scopes: deps.scope }),
      );
      return lane().request({ method: "GET", url, signal, maxResponseBytes: deps.maxResponseBytes });
    }
    const form = await grantForm(credentials, deps);
    if (closer.signal.aborted) throw new TransportError("aborted", S.closed);
    return lane().request({
      method: "POST",
      url: GOOGLE_TOKEN_URL,
      form,
      signal,
      maxResponseBytes: deps.maxResponseBytes,
    });
  };

  const refresh = async (signal: AbortSignal): Promise<string> => {
    const response = await exchange(signal);
    const body = tokenBody(response.text);
    const token = body.access_token;
    if (response.status !== 200 || typeof token !== "string" || token === "") {
      throw new AuthenticationError(S.refused(reasonOf(body, response.status)), deps.provider);
    }
    const expiresIn = body.expires_in;
    const ttl =
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_TTL_S;
    cached = { token, expiresAt: deps.now() + ttl * 1000 };
    return token;
  };

  return {
    token(signal) {
      if (closer.signal.aborted) return Promise.reject(new TransportError("aborted", S.closed));
      if (cached !== null && deps.now() < cached.expiresAt - REFRESH_EARLY_MS) return Promise.resolve(cached.token);
      pending ??= refresh(AbortSignal.any([closer.signal, deps.timeoutSignal(REFRESH_TIMEOUT_MS)])).finally(() => {
        pending = null;
      });
      return untilAborted(pending, signal);
    },
    close() {
      closer.abort();
      cached = null;
      transport?.close();
      transport = null;
    },
  };
}
