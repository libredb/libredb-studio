/**
 * Firestore REST v1 over the shared node transport, the only module that puts a Firestore request on the wire.
 *
 * Every request passes buildRequest, the closed table of spec S1, before a token is asked for or a socket opened.
 * The bearer token is a connection header of the node transport, so each token gets its own API lane; a lane a newer
 * token replaced closes once its in-flight requests finish. Every API lane carries both routing headers and, for an
 * authorized-user credential with a quota project, x-goog-user-project. The API and token lanes refuse link-local
 * addresses; the metadata lane cannot, since the metadata server lives at one. A non-2xx answer is read as Google's
 * error envelope and mapped by errors.ts; a 2xx body that is not JSON is an explicit error.
 */
import { DatabaseError, QueryError } from "@/lib/db/errors";
import { endpointUrl, type HttpOrigin, httpOrigin } from "@/lib/db/http/endpoint";
import { type NodeResponse, type NodeTransport, TransportError } from "@/lib/db/http/node-transport";
import {
  DEFAULT_DATABASE_ID,
  FIRESTORE_API_ORIGIN,
  FIRESTORE_ERROR_PROVIDER,
  FIRESTORE_SCOPE,
  GOOGLE_TOKEN_URL,
  LIMITS,
} from "./constants";
import type { FirestoreAuth } from "./credential-policy";
import { type ErrorContext, type GoogleError, mapGoogleError, mapTransportFailure, readGoogleError } from "./errors";
import { parseMetadataHost } from "./google-credentials";
import { createTokenSource } from "./google-token-source";
import { databaseName, type FirestoreTarget } from "./names";
import { buildRequest, type FirestoreRequest } from "./requests";
import type { FirestoreSeams } from "./seams";

export interface SendOptions {
  readonly signal: AbortSignal;
  readonly context: ErrorContext;
}

export interface FirestoreClient {
  readonly mode: "google" | "emulator";
  readonly target: FirestoreTarget;
  /** The parsed JSON of a 2xx answer; a mapped Studio error otherwise. */
  send(request: FirestoreRequest, options: SendOptions): Promise<unknown>;
  close(): void;
}

export const FIRESTORE_TRANSPORT_SENTENCES = Object.freeze({
  notJson: "Firestore answered with a body that is not JSON",
  closed: "The Firestore connection is closed",
});

const S = FIRESTORE_TRANSPORT_SENTENCES;
const API_MAX_SOCKETS = 8;
const TOKEN_MAX_SOCKETS = 1;

interface Lane {
  readonly bearer: string;
  readonly node: NodeTransport;
  inFlight: number;
}

/** The web SDK's REST routing headers: the project, the database when it is not the default, and the resource prefix. */
export function routingHeaders(target: FirestoreTarget): Readonly<Record<string, string>> {
  const params =
    target.databaseId === DEFAULT_DATABASE_ID
      ? `project_id=${target.projectId}`
      : `project_id=${target.projectId}&database_id=${target.databaseId}`;
  return { "x-goog-request-params": params, "google-cloud-resource-prefix": databaseName(target) };
}

function httpsOrigin(url: string): HttpOrigin {
  return httpOrigin("https", new URL(url).hostname, 443);
}

function tlsFor(origin: HttpOrigin) {
  return origin.scheme === "https" ? { rejectUnauthorized: true, identity: origin.host } : null;
}

/**
 * Google's error envelope plus the Retry-After header as received; errors.ts chooses between RetryInfo's delay and
 * the header and writes the 429 sentence, so this module normalises neither.
 */
function answerError(response: NodeResponse): GoogleError {
  const error = readGoogleError(response.status, response.text);
  return response.retryAfter === null ? error : { ...error, retryAfter: response.retryAfter };
}

/** A Studio error raised on the way (the closed table, a token refusal, a URL refusal) passes; the rest is mapped. */
function failure(error: unknown, context: ErrorContext): unknown {
  return error instanceof DatabaseError && !(error instanceof TransportError)
    ? error
    : mapTransportFailure(error, context);
}

export function createFirestoreClient(
  target: FirestoreTarget,
  auth: Extract<FirestoreAuth, { mode: "google" }>,
  seams: FirestoreSeams,
): FirestoreClient {
  const origin = httpsOrigin(FIRESTORE_API_ORIGIN);
  const tokenOrigin = httpsOrigin(GOOGLE_TOKEN_URL);
  const { credentials } = auth;
  const tokens = createTokenSource(credentials, {
    scope: FIRESTORE_SCOPE,
    provider: FIRESTORE_ERROR_PROVIDER,
    maxResponseBytes: LIMITS.tokenResponseBytes,
    now: () => seams.now(),
    timeoutSignal: (ms) => seams.timeoutSignal(ms),
    tokenTransport: () =>
      seams.createTransport(
        {
          origin: tokenOrigin,
          tls: tlsFor(tokenOrigin),
          maxSockets: TOKEN_MAX_SOCKETS,
          headers: {},
          refusesLinkLocal: true,
          refusesUpgrade: true,
        },
        "token",
      ),
    metadataTransport: (host) =>
      seams.createTransport(
        {
          origin: parseMetadataHost(host, FIRESTORE_ERROR_PROVIDER),
          tls: null,
          maxSockets: TOKEN_MAX_SOCKETS,
          // The metadata server answers only requests that carry this header.
          headers: { "metadata-flavor": "Google" },
          refusesUpgrade: true,
        },
        "metadata",
      ),
  });
  const quota: Readonly<Record<string, string>> =
    credentials.type === "authorized_user" && credentials.quotaProjectId !== undefined
      ? { "x-goog-user-project": credentials.quotaProjectId }
      : {};
  const lanes = new Set<Lane>();
  let current: Lane | null = null;

  // Only a lane this client still owns closes here: close() already closed and dropped every lane it held.
  const retire = (lane: Lane) => {
    if (!lanes.has(lane) || lane === current || lane.inFlight !== 0) return;
    lane.node.close();
    lanes.delete(lane);
  };

  async function laneFor(signal: AbortSignal): Promise<Lane> {
    const bearer = await tokens.token(signal);
    if (current?.bearer !== bearer) {
      const previous = current;
      current = {
        bearer,
        node: seams.createTransport(
          {
            origin,
            tls: tlsFor(origin),
            maxSockets: API_MAX_SOCKETS,
            headers: { authorization: `Bearer ${bearer}`, ...routingHeaders(target), ...quota },
            refusesLinkLocal: true,
            refusesUpgrade: true,
          },
          "api",
        ),
        inFlight: 0,
      };
      lanes.add(current);
      if (previous !== null) retire(previous);
    }
    return current;
  }

  async function exchange(request: FirestoreRequest, signal: AbortSignal): Promise<NodeResponse> {
    // The closed table first: a refused request costs no token and no socket.
    const built = buildRequest(target, request);
    const params = new URLSearchParams(built.query.map(([name, value]) => [name, value]));
    const url = endpointUrl(origin, built.path, built.query.length === 0 ? undefined : params);
    const lane = await laneFor(signal);
    lane.inFlight += 1;
    try {
      return await lane.node.request({
        method: built.method,
        url,
        ...(built.body === undefined ? {} : { body: built.body }),
        signal,
        maxResponseBytes: built.cap === "large" ? LIMITS.largeResponseBytes : LIMITS.smallResponseBytes,
      });
    } finally {
      lane.inFlight -= 1;
      retire(lane);
    }
  }

  return {
    mode: "google",
    target,
    async send(request, { signal, context }) {
      let response: NodeResponse;
      try {
        response = await exchange(request, signal);
      } catch (error) {
        // The request kind lets errors.ts answer a too-large document read with its own sentence (PLAN-1 C8).
        throw failure(error, { ...context, requestKind: request.kind });
      }
      if (response.status < 200 || response.status > 299) {
        throw mapGoogleError(answerError(response), context);
      }
      try {
        return JSON.parse(response.text) as unknown;
      } catch {
        throw new QueryError(S.notJson, FIRESTORE_ERROR_PROVIDER);
      }
    },
    close() {
      current = null;
      for (const lane of lanes) lane.node.close();
      lanes.clear();
      tokens.close();
    },
  };
}
