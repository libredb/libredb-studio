/**
 * The Weaviate error table (#1566 spec 5.6): what an answer that is not a success is, and the sentence a person
 * reads for it and for a request that never completed.
 *
 * Two halves. `answerFailure` and `graphqlFailure` read an answer into a `WeaviateError` with a category, keeping
 * the server's words as `detail`. `toProviderError` words that error, or the shared transport's, as one of the
 * repository's error classes: Studio's sentence first, the server's words after it, and every server text passes
 * `serverText` first, so a text that holds any form of the configured secret is withheld whole.
 *
 * Weaviate answers three error shapes, all measured on 1.37.4 and 1.40.2: `{"error":[{"message"}]}` from its
 * handlers, `{"code","message"}` from the router for a path it does not serve, and `{"errors":[{"message"}]}` from
 * GraphQL, under HTTP 200. Several 404s carry no body at all (a collection, an object, an alias or a tenant that
 * does not exist), so the operation words what was not found. The status decides, the words refine it.
 */
import {
  AuthenticationError,
  ConnectionError,
  DatabaseError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { serverText } from "@/lib/db/utils/server-text";
import type { DatabaseType } from "@/lib/types";
import { type WeaviateAnswer, WeaviateError, type WeaviateErrorCategory, type WeaviateOp } from "./client";

const PROVIDER: DatabaseType = "weaviate";

/** The longest server text a sentence carries; a longer one is cut and says so. */
const MAX_SERVER_TEXT = 2000;
/** An error body longer than this is never parsed: a refusal's body is a sentence, not a result. */
const MAX_ERROR_BODY = 65_536;

export interface WeaviateErrorContext {
  /** `connect` while the provider's connect request runs, `request` after it. */
  readonly phase: "connect" | "request";
  readonly op: WeaviateOp;
  /** The endpoint as configured: the far end under an SSH tunnel. */
  readonly endpoint: { readonly host: string; readonly port: number };
  readonly responseCapBytes: number;
  readonly timeoutMs: number;
  /** `secretForms` of the connection's secret. */
  readonly secretForms: readonly string[];
}

function messagesOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const message =
      typeof entry === "object" && entry !== null ? (entry as { readonly message?: unknown }).message : undefined;
    return typeof message === "string" ? [message] : [];
  });
}

/** The server's own words in an answer: every `message` of its error body, else the body as text. */
export function serverWords(text: string): string {
  if (text.length <= MAX_ERROR_BODY) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) {
        const body = parsed as { readonly error?: unknown; readonly errors?: unknown; readonly message?: unknown };
        const listed = [...messagesOf(body.error), ...messagesOf(body.errors)];
        if (listed.length > 0) return listed.join("; ");
        if (typeof body.message === "string") return body.message;
        if (typeof body.error === "string") return body.error;
      }
    } catch {
      // Not JSON: a proxy's page, which is read as it is.
    }
  }
  return text.trim();
}

const ROUTE_ABSENT = /^path \S+ was not found$/;
const GRAPHQL_SCOPE = "due to GraphQL introspection";
const UNKNOWN_CLASS = /Cannot query field "[^"]*" on type "(?:GetObjectsObj|AggregateObjectsObj)"/;

/** The category of words alone, for a GraphQL `errors` list or the body of a 4xx. */
function wordsCategory(words: string): WeaviateErrorCategory | undefined {
  if (words.includes("tenant not active")) return "tenant-not-active";
  if (words.includes("rest search api is experimental and not enabled")) return "rest-search-disabled";
  if (words.includes("graphql api is disabled")) return "graphql-disabled";
  if (words.includes(GRAPHQL_SCOPE)) return "graphql-scope";
  if (words.includes("could not find collection") || UNKNOWN_CLASS.test(words)) return "collection-not-found";
  if (words.includes("query maximum results exceeded")) return "result-limit";
  if (words.startsWith("Client sent an HTTP request to an HTTPS server")) return "tls-required";
  if (words.startsWith("rbac: authorization, forbidden action")) return "forbidden";
  return undefined;
}

function categoryOf(status: number, words: string): WeaviateErrorCategory {
  if (status === 401) return "unauthenticated";
  if (status === 403) return words.includes(GRAPHQL_SCOPE) ? "graphql-scope" : "forbidden";
  if (status === 404) {
    if (ROUTE_ABSENT.test(words)) return "route-absent";
    return wordsCategory(words) === "collection-not-found" ? "collection-not-found" : "not-found";
  }
  if (status === 429) return "rate-limited";
  if (status === 400 || status === 422) return wordsCategory(words) ?? "input";
  if (status === 503) return "unavailable";
  if (status >= 500) return "server";
  return "unexpected-status";
}

/** What an answer that is not a 2xx is, or undefined for a success. The answer's text is kept, never shown here. */
export function answerFailure(answer: WeaviateAnswer): WeaviateError | undefined {
  if (answer.status >= 200 && answer.status <= 299) return undefined;
  const words = serverWords(answer.text);
  const category = categoryOf(answer.status, words);
  return new WeaviateError(category, words, answer.status, category === "rate-limited" ? answer.retryAfter : null);
}

/**
 * The failure a GraphQL answer carries in its `errors` list, whatever its status, or undefined where it holds none.
 * GraphQL answers a refusal under HTTP 200 with `errors` beside `data` (spec A.4), so a 200 is not a success here.
 */
export function graphqlFailure(answer: WeaviateAnswer): WeaviateError | undefined {
  const http = answerFailure(answer);
  if (http !== undefined) return http;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.text);
  } catch {
    return new WeaviateError("unexpected-status", "", answer.status);
  }
  const errors =
    typeof parsed === "object" && parsed !== null ? (parsed as { readonly errors?: unknown }).errors : undefined;
  const messages = messagesOf(errors);
  if (messages.length === 0) return undefined;
  const words = messages.join("; ");
  return new WeaviateError(wordsCategory(words) ?? "input", words, answer.status);
}

const DELAY_SECONDS = /^\d{1,9}$/;

/** The wait a Retry-After header names, in whole seconds, when it is 1 to 9 digits; undefined otherwise, never echoed. */
export function retryAfterSeconds(retryAfter: string | null): number | undefined {
  if (retryAfter === null || !DELAY_SECONDS.test(retryAfter)) return undefined;
  return Number(retryAfter);
}

/** The server's words after Studio's, withheld whole when they hold any form of the secret. */
function after(detail: string, context: WeaviateErrorContext): string {
  if (detail === "") return "";
  const text = serverText(detail, context.secretForms);
  const shown = text.length > MAX_SERVER_TEXT ? `${text.slice(0, MAX_SERVER_TEXT)} (cut)` : text;
  return ` (Weaviate: ${shown})`;
}

function endpointOf(context: WeaviateErrorContext): string {
  const { host, port } = context.endpoint;
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function formatBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes.toLocaleString("en-US")} bytes`;
}

/** What a 404 with no words means, by the operation that met it. */
const NOT_FOUND: Partial<Record<WeaviateOp, string>> = {
  collection: "The collection does not exist or is not visible to this credential.",
  shards: "The collection does not exist or is not visible to this credential.",
  tenants: "The collection does not exist or is not visible to this credential.",
  tenant: "The tenant does not exist in this collection.",
  alias: "The alias does not exist.",
  objects: "The collection does not exist or is not visible to this credential.",
  object: "No object has this id in this collection.",
  collection_nodes: "The collection does not exist or is not visible to this credential.",
};

function answerError(error: WeaviateError, context: WeaviateErrorContext): Error {
  const words = after(error.detail, context);
  switch (error.category) {
    case "unauthenticated":
      return new AuthenticationError(`Weaviate refused the API key or token.${words}`, PROVIDER);
    case "forbidden":
      return context.phase === "connect"
        ? new AuthenticationError(`The credential is not allowed to read this server's meta.${words}`, PROVIDER)
        : new QueryError(`The credential is not allowed to run this request.${words}`, PROVIDER);
    case "graphql-scope":
      return new QueryError(
        "This credential's role is scoped to some collections, and Weaviate allows GraphQL only to a role that may read every collection, so this server version (below 1.39.7, which serves REST search) cannot run the search for it.",
        PROVIDER,
      );
    case "collection-not-found":
      return new QueryError("The collection does not exist or is not visible to this credential.", PROVIDER);
    case "route-absent":
      return new QueryError(`This Weaviate server has no such route.${words}`, PROVIDER);
    case "not-found":
      return new QueryError(
        error.detail === ""
          ? (NOT_FOUND[context.op] ?? "Weaviate found nothing at the name or id the request gives.")
          : `Weaviate found nothing at the name or id the request gives.${words}`,
        PROVIDER,
      );
    case "tenant-not-active":
      return new QueryError(
        `The tenant is not active, and Studio does not activate a tenant by reading it.${words}`,
        PROVIDER,
      );
    case "rest-search-disabled":
      return new QueryError(
        `This Weaviate server keeps its REST search behind EXPERIMENTAL_REST_SEARCH_ENABLED, and GraphQL is not available either.${words}`,
        PROVIDER,
      );
    case "graphql-disabled":
      return new QueryError(`This Weaviate server has GraphQL disabled.${words}`, PROVIDER);
    case "result-limit":
      return new QueryError(
        `The request asks for more objects than the server's QUERY_MAXIMUM_RESULTS.${words}`,
        PROVIDER,
      );
    case "tls-required":
      return new ConnectionError(
        `Weaviate at ${endpointOf(context)} speaks TLS on this port, and the connection sent plain HTTP: choose an SSL mode under SSL / TLS.`,
        PROVIDER,
        context.endpoint.host,
        context.endpoint.port,
      );
    case "input":
      return new QueryError(`Weaviate did not accept the request as written.${words}`, PROVIDER);
    case "rate-limited": {
      const wait = retryAfterSeconds(error.retryAfter);
      const again = wait === undefined ? "try again later" : `try again in ${wait} s`;
      return new QueryError(`Weaviate rate-limited the request; ${again}. It was not sent again.${words}`, PROVIDER);
    }
    case "server":
      return new QueryError(`Weaviate failed to run the request (HTTP ${error.status}).${words}`, PROVIDER);
    case "unavailable":
      return new ConnectionError(
        `Weaviate is not ready to serve the request (HTTP ${error.status}).${words}`,
        PROVIDER,
        context.endpoint.host,
        context.endpoint.port,
      );
    case "unexpected-status":
      return new QueryError(`Weaviate answered HTTP ${error.status}, which Studio does not read.${words}`, PROVIDER);
  }
}

function transportError(error: TransportError, context: WeaviateErrorContext): Error {
  const { host, port } = context.endpoint;
  const connection = (sentence: string) => new ConnectionError(sentence, PROVIDER, host, port);
  switch (error.kind) {
    case "timeout":
      return new TimeoutError(
        `The request to Weaviate did not finish within ${context.timeoutMs} ms, so Studio stopped waiting.`,
        PROVIDER,
        context.timeoutMs,
      );
    case "unreachable":
      return connection(error.message);
    case "aborted":
      return new QueryCancelledError("The request to Weaviate was cancelled.", PROVIDER);
    case "too-large":
      return new QueryError(
        `Weaviate's answer is larger than the ${formatBytes(context.responseCapBytes)} Studio reads for one response, so it was not read. Ask for fewer objects, fewer properties, or no vectors.`,
        PROVIDER,
      );
    case "redirect":
      return connection(
        `Weaviate at ${endpointOf(context)} answered with a redirect, which Studio never follows. ${serverText(error.message, context.secretForms)}`,
      );
    case "encoding":
      return connection(
        `Weaviate at ${endpointOf(context)} answered in an encoding Studio does not read. ${serverText(error.message, context.secretForms)}`,
      );
    case "tls":
      return connection(
        `The TLS connection to Weaviate at ${endpointOf(context)} failed: check the SSL mode, the CA and the client certificate under SSL / TLS. ${error.message}`,
      );
    case "network":
      return connection(
        `No complete answer arrived from Weaviate at ${endpointOf(context)}, and the request was not sent again. ${error.message}`,
      );
  }
}

/**
 * What a person reads for a failure. A `WeaviateError` and a `TransportError` are worded by the table; any other
 * error of the repository's own classes (a refusal raised before the wire) is returned as it is; anything else is a
 * failure this provider did not expect, reported without its text.
 */
export function toProviderError(error: unknown, context: WeaviateErrorContext): Error {
  if (error instanceof WeaviateError) return answerError(error, context);
  if (error instanceof TransportError) return transportError(error, context);
  if (error instanceof DatabaseError) return error;
  return new QueryError("The request to Weaviate failed in a way Studio does not recognise.", PROVIDER);
}

/** The answer when it is a success; otherwise its failure, worded, is thrown. */
export function expectOk(answer: WeaviateAnswer, context: WeaviateErrorContext): WeaviateAnswer {
  const failure = context.op === "graphql" ? graphqlFailure(answer) : answerFailure(answer);
  if (failure !== undefined) throw toProviderError(failure, context);
  return answer;
}
