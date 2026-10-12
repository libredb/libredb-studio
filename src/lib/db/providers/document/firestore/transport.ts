/**
 * Firestore REST v1 over the shared node transport, the only module that puts a Firestore request on the wire.
 *
 * Every request passes buildRequest, the closed table of spec S1, before a token is asked for or a socket opened.
 * The bearer token is a connection header of the node transport, so each token gets its own API lane; a lane a newer
 * token replaced closes once its in-flight requests finish. Every API lane carries both routing headers and, for an
 * authorized-user credential with a quota project, x-goog-user-project. The API and token lanes refuse link-local
 * addresses; the metadata lane cannot, since the metadata server lives at one. A non-2xx answer is read as Google's
 * error envelope and mapped by errors.ts; a 2xx body that is not JSON is an explicit error.
 * Against the emulator, one plain-HTTP lane whose only authorization header is the literal `Bearer owner` serves every
 * request, and no token source, token request or metadata request is ever built.
 * Every request runs under one signal: the caller's cancel, the client's close and a deadline of the connection's query
 * timeout plus LIMITS.deadlineGraceMs; close() aborts what is in flight, closes every lane and the token source, and
 * refuses every later send.
 */
import { DatabaseError, QueryError } from "@/lib/db/errors";
import { endpointUrl, type HttpOrigin, httpOrigin } from "@/lib/db/http/endpoint";
import { type NodeResponse, type NodeTransport, TransportError } from "@/lib/db/http/node-transport";
import { DEFAULT_QUERY_TIMEOUT } from "@/lib/db/types";
import {
  DEFAULT_DATABASE_ID,
  FIRESTORE_API_ORIGIN,
  FIRESTORE_TYPE,
  FIRESTORE_SCOPE,
  GOOGLE_TOKEN_URL,
  LIMITS,
} from "./constants";
import type { FirestoreAuth } from "./credential-policy";
import {
  type ErrorContext,
  endsInError,
  type GoogleError,
  mapGoogleError,
  mapTransportFailure,
  readGoogleError,
} from "./errors";
import { parseMetadataHost } from "./google-credentials";
import { createTokenSource } from "./google-token-source";
import { databaseName, type FirestoreTarget } from "./names";
import { buildRequest, type FirestoreRequest } from "./requests";
import type { FirestoreSeams } from "./seams";

export interface SendOptions {
  readonly signal: AbortSignal;
  readonly context: ErrorContext;
}

export interface FirestoreClientOptions {
  /** The connection's query timeout; DEFAULT_QUERY_TIMEOUT when absent. */
  readonly queryTimeoutMs?: number;
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
const EMULATOR_BEARER = "owner";
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
  auth: FirestoreAuth,
  seams: FirestoreSeams,
  options: FirestoreClientOptions = {},
): FirestoreClient {
  const deadlineMs = (options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT) + LIMITS.deadlineGraceMs;
  const closer = new AbortController();
  const origin =
    auth.mode === "emulator"
      ? httpOrigin("http", auth.emulator.host, auth.emulator.port)
      : httpsOrigin(FIRESTORE_API_ORIGIN);
  const tokenOrigin = httpsOrigin(GOOGLE_TOKEN_URL);
  const tokens =
    auth.mode === "emulator"
      ? null
      : createTokenSource(auth.credentials, {
          scope: FIRESTORE_SCOPE,
          provider: FIRESTORE_TYPE,
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
                origin: parseMetadataHost(host, FIRESTORE_TYPE),
                tls: null,
                maxSockets: TOKEN_MAX_SOCKETS,
                // The metadata server answers only requests that carry this header.
                headers: { "metadata-flavor": "Google" },
                refusesUpgrade: true,
              },
              "metadata",
            ),
        });
  // The emulator lane carries Bearer owner alone: no routing header and no quota project, since no credential exists.
  const extraHeaders: Readonly<Record<string, string>> =
    auth.mode === "emulator"
      ? {}
      : {
          ...routingHeaders(target),
          ...(auth.credentials.type === "authorized_user" && auth.credentials.quotaProjectId !== undefined
            ? { "x-goog-user-project": auth.credentials.quotaProjectId }
            : {}),
        };
  const lanes = new Set<Lane>();
  let current: Lane | null = null;

  // Only a lane this client still owns closes here: close() already closed and dropped every lane it held.
  const retire = (lane: Lane) => {
    if (!lanes.has(lane) || lane === current || lane.inFlight !== 0) return;
    lane.node.close();
    lanes.delete(lane);
  };

  async function laneFor(signal: AbortSignal): Promise<Lane> {
    const bearer = tokens === null ? EMULATOR_BEARER : await tokens.token(signal);
    // Checked after the await too: close() may land while the token is on its way.
    if (closer.signal.aborted) throw new TransportError("aborted", S.closed);
    if (current?.bearer !== bearer) {
      const previous = current;
      current = {
        bearer,
        node: seams.createTransport(
          {
            origin,
            tls: tlsFor(origin),
            maxSockets: API_MAX_SOCKETS,
            headers: { authorization: `Bearer ${bearer}`, ...extraHeaders },
            refusesLinkLocal: true,
            refusesUpgrade: true,
          },
          tokens === null ? "emulator" : "api",
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
    mode: auth.mode,
    target,
    async send(request, { signal, context }) {
      if (closer.signal.aborted) {
        throw mapTransportFailure(new TransportError("aborted", S.closed), { ...context, requestKind: request.kind });
      }
      // One signal for the token wait and the request: the caller's cancel, this client's close, and the deadline.
      const bounded = AbortSignal.any([signal, closer.signal, seams.timeoutSignal(deadlineMs)]);
      let response: NodeResponse;
      try {
        response = await exchange(request, bounded);
      } catch (error) {
        // The request kind lets errors.ts answer a too-large document read with its own sentence.
        throw failure(error, { ...context, requestKind: request.kind });
      }
      if (response.status < 200 || response.status > 299) {
        throw mapGoogleError(answerError(response), context);
      }
      let answer: unknown;
      try {
        answer = JSON.parse(response.text) as unknown;
      } catch {
        throw new QueryError(S.notJson, FIRESTORE_TYPE);
      }
      // A stream that fails after its first element still answers 2xx: its error element names the failure, and the
      // elements before it are never shown as a whole answer.
      if (endsInError(answer)) throw mapGoogleError(answerError(response), context);
      return answer;
    },
    close() {
      if (closer.signal.aborted) return;
      closer.abort();
      current = null;
      for (const lane of lanes) lane.node.close();
      lanes.clear();
      tokens?.close();
    },
  };
}
