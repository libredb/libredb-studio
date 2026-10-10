/**
 * Socket-free S3 transports and the capture format.
 *
 * `recordedS3Transport` answers each request with the next exchange of a capture written by tests/live/s3-evidence.ts,
 * in order. It calls `options.signer.sign(...)` exactly where the byte transport does, once per request at send time,
 * and before it answers it compares what was signed and sent with the recording: the method, the wire path and query,
 * every header, the credential scope and the SignedHeaders list. It never compares the signature, which no capture
 * holds: with every signed value equal and the same secret, SigV4 gives the same signature, and the signer is proven
 * on the AWS suite vectors. `scriptedS3Transport` answers synthetic steps for the unit tests, each marked with the
 * document it is built from, and never reads tests/fixtures/s3/captures/. `recordingSigner` is the harness's wrapper.
 *
 * Both transports first build the byte transport itself and close it, which opens no socket, so its build refusals
 * (a link-local origin, a header selection or signer names it refuses) are raised where the byte transport raises
 * them; and each request meets the two checks the byte transport makes before a socket that a recording cannot show:
 * the query grammar, and the rule on every value the signer returns.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { originHost } from "@/lib/db/http/endpoint";
import {
  createNodeByteTransport,
  type NodeByteRequest,
  type NodeByteResponse,
  type NodeByteTransport,
  type NodeByteTransportOptions,
  type RequestSigner,
  type ResponseHeader,
  type SigningInput,
} from "@/lib/db/http/node-transport";

/** The factory shape the provider builds its transport with: `S3ProviderDeps.createTransport`. */
export type S3TransportFactory = (options: NodeByteTransportOptions) => NodeByteTransport;

export interface S3RecordedAuthorization {
  readonly scheme: "AWS4-HMAC-SHA256";
  /** `<access key id>/<yyyymmdd>/<region>/s3/aws4_request`. */
  readonly credential: string;
  readonly signedHeaders: readonly string[];
}

export interface S3RecordedRequest {
  readonly method: "GET" | "HEAD";
  /** The path exactly as sent on the wire. */
  readonly path: string;
  /** The query exactly as sent on the wire, without "?". */
  readonly query: string;
  /** The headers the signer received plus those it returned, lower-case, without authorization. */
  readonly headers: Readonly<Record<string, string>>;
  /** null for an unsigned request. */
  readonly authorization: S3RecordedAuthorization | null;
}

export type S3RecordedBody = { readonly text: string } | { readonly base64: string } | { readonly empty: true };

export interface S3RecordedAnswer {
  readonly status: number;
  /** Exactly the headers the provider asks the transport for (S3_RESPONSE_HEADERS and its prefix). */
  readonly headers: readonly ResponseHeader[];
  readonly headersTruncated: boolean;
  readonly contentType: string | null;
  readonly contentEncoding: string | null;
  readonly retryAfter: string | null;
  readonly truncated: boolean;
  readonly body: S3RecordedBody;
}

export interface S3Exchange {
  /** The scenario step that sent it. */
  readonly step: string;
  readonly request: S3RecordedRequest;
  readonly answer: S3RecordedAnswer;
}

export interface S3Capture {
  /** `<set>/<scenario>.json`, relative to tests/fixtures/s3/captures/. */
  readonly file: string;
  readonly scenario: string;
  readonly target: string;
  /** The scenario's injected clock offset: 0, row A8's +1,200,000 or, on Garage, -90,000,000. */
  readonly clockOffsetMs: number;
  readonly exchanges: readonly S3Exchange[];
  /** The runner's summary of the live run, which the replay must reproduce. */
  readonly result: unknown;
}

export interface S3ScriptedStep {
  /** When present, the request must carry these values. */
  readonly expect?: {
    readonly method?: "GET" | "HEAD";
    readonly path?: string;
    readonly query?: string;
    readonly headers?: Readonly<Record<string, string>>;
  };
  /** The answer, or the error the transport rejects with (a socket reset, a TransportError). */
  readonly answer: S3RecordedAnswer | Error;
  /** Every scripted answer is marked, and never lands under tests/fixtures/s3/captures/, so a capture holds only what a server answered. */
  readonly synthetic: true;
  /** The measurement or document the answer is built from. */
  readonly source: string;
}

export interface S3RecordedTransport {
  /** Passed to the provider as `deps.createTransport`. */
  readonly createTransport: S3TransportFactory;
  /** Every request the provider made, in order, as the capture format records it. */
  readonly sent: readonly S3RecordedRequest[];
  /** The replay clock: passed to the provider as `deps.clock`. */
  readonly clock: () => Date;
  /** Names the scenario step the next requests belong to, for the mismatch message. */
  setStep(step: string): void;
  /** Fails when a recorded exchange was not consumed. */
  assertConsumed(): void;
}

const SIGV4 = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=[0-9a-f]+$/;

/** The authorization header reduced to what a capture keeps: never the signature. */
export function parseAuthorization(value: string): S3RecordedAuthorization {
  const match = SIGV4.exec(value);
  if (match === null) throw new Error("the authorization header is not a SigV4 authorization");
  return { scheme: "AWS4-HMAC-SHA256", credential: match[1], signedHeaders: match[2].split(";") };
}

/** What a capture records of one request: the signer's input headers and its returned headers, the authorization reduced. */
export function recordedRequest(input: SigningInput, returned: Readonly<Record<string, string>>): S3RecordedRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value;
  for (const [name, value] of Object.entries(returned))
    if (name.toLowerCase() !== "authorization") headers[name.toLowerCase()] = value;
  const authorization = Object.entries(returned).find(([name]) => name.toLowerCase() === "authorization")?.[1];
  return {
    method: input.method,
    path: input.path,
    query: input.query,
    headers,
    authorization: authorization === undefined ? null : parseAuthorization(authorization),
  };
}

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

export function recordedBody(bytes: Uint8Array): S3RecordedBody {
  if (bytes.length === 0) return { empty: true };
  try {
    return { text: fatalUtf8.decode(bytes) };
  } catch {
    return { base64: Buffer.from(bytes).toString("base64") };
  }
}

export function bodyBytes(body: S3RecordedBody): Buffer {
  if ("empty" in body) return Buffer.alloc(0);
  if ("text" in body) return Buffer.from(body.text, "utf8");
  return Buffer.from(body.base64, "base64");
}

export function answerOf(response: NodeByteResponse): S3RecordedAnswer {
  return {
    status: response.status,
    headers: response.headers,
    headersTruncated: response.headersTruncated,
    contentType: response.contentType,
    contentEncoding: response.contentEncoding,
    retryAfter: response.retryAfter,
    truncated: response.truncated,
    body: recordedBody(response.bytes),
  };
}

function responseOf(answer: S3RecordedAnswer): NodeByteResponse {
  return {
    status: answer.status,
    contentType: answer.contentType,
    contentEncoding: answer.contentEncoding,
    retryAfter: answer.retryAfter,
    headers: answer.headers,
    headersTruncated: answer.headersTruncated,
    bytes: bodyBytes(answer.body),
    truncated: answer.truncated,
  };
}

/** `20261009T141900Z` as a Date. */
export function amzDate(text: string): Date {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (match === null) throw new Error(`${JSON.stringify(text)} is not an x-amz-date`);
  const [, y, mo, d, h, mi, s] = match;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

/**
 * The replay clock, read at the exchange `current()` names: a signed exchange's recorded
 * x-amz-date, so the signer's date equals the live run's; an unsigned exchange's recorded `date` header plus the
 * capture's clock offset, so a skew sentence's minutes equal the live run's; an exchange recorded without a `date`
 * uses the previous exchange's.
 */
export function replayClock(capture: S3Capture, current: () => number): () => Date {
  return () => {
    const at = Math.min(current(), capture.exchanges.length - 1);
    if (at < 0) return new Date(0);
    const exchange = capture.exchanges[at];
    const signedDate = exchange.request.authorization === null ? undefined : exchange.request.headers["x-amz-date"];
    if (signedDate !== undefined) return amzDate(signedDate);
    for (let index = at; index >= 0; index--) {
      const date = capture.exchanges[index].answer.headers.find(([name]) => name === "date")?.[1];
      if (date !== undefined) return new Date(Date.parse(date) + capture.clockOffsetMs);
    }
    throw new Error(`${capture.scenario}: no exchange up to ${at + 1} recorded a date header`);
  };
}

/**
 * The input the byte transport hands its signer: every header it sets, with lower-case names, the signer's excluded.
 * The harness records an unsigned request with it too, so the replay rebuilds the same headers for both.
 */
export function signingInput(
  options: NodeByteTransportOptions,
  request: NodeByteRequest,
  acceptEncoding: string | undefined,
): SigningInput {
  const host = originHost(options.origin);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers)) headers[name.toLowerCase()] = value;
  for (const [name, value] of Object.entries(request.headers ?? {})) headers[name.toLowerCase()] = value;
  headers.host = host;
  // The byte transport's own accept-encoding is never signed; the recording carries the value it sent.
  if (acceptEncoding !== undefined) headers["accept-encoding"] = acceptEncoding;
  return Object.freeze({
    method: request.method,
    host,
    path: request.target.path,
    query: request.target.query,
    headers: Object.freeze(headers),
  });
}

/**
 * The byte transport's query grammar and its sentence, copied from TARGET_QUERY and INVALID_TARGET_QUERY in
 * src/lib/db/http/node-transport.ts, which does not export them: name=value pairs only, so a valueless subresource
 * such as `versions` is refused here as it is refused before any socket on the wire.
 */
const TARGET_QUERY_CHARACTER = "(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})";
const TARGET_QUERY = new RegExp(
  `^(?:${TARGET_QUERY_CHARACTER}+=${TARGET_QUERY_CHARACTER}*(?:&${TARGET_QUERY_CHARACTER}+=${TARGET_QUERY_CHARACTER}*)*)?$`,
);
const INVALID_TARGET_QUERY =
  "Invalid request query: expected name=value pairs of unreserved characters and upper-case percent escapes, joined by &";

function checkQuery(query: string): void {
  if (!TARGET_QUERY.test(query)) throw new DatabaseConfigError(INVALID_TARGET_QUERY);
}

/**
 * The signer's headers for one request, held to the byte transport's rule on every value a signer returns (isHeaderValue
 * in src/lib/db/http/node-transport.ts): visible ASCII or space and at most 1024 bytes, refused by name, never by value.
 */
function signatureOf(options: NodeByteTransportOptions, input: SigningInput): Readonly<Record<string, string>> {
  if (options.signer === undefined) return {};
  const returned = options.signer.sign(input);
  for (const [name, value] of Object.entries(returned))
    if (value.length > 1024 || !/^[\x20-\x7e]*$/.test(value))
      throw new DatabaseConfigError(
        `Invalid signature headers: the value of ${name} must be visible ASCII or space, at most 1024 bytes`,
      );
  return returned;
}

/** Builds the byte transport for its build checks alone and closes it: building opens no socket. */
function buildChecks(options: NodeByteTransportOptions): void {
  createNodeByteTransport(options).close();
}

function abortIfAsked(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError");
}

export function recordedS3Transport(capture: S3Capture): S3RecordedTransport {
  const sent: S3RecordedRequest[] = [];
  let next = 0;
  let current = 0;
  let step = "";
  const fail = (index: number, what: string, actual: unknown, recorded: unknown): never => {
    throw new Error(
      `${capture.scenario} step ${capture.exchanges[index]?.step ?? step} (exchange ${index + 1}): ${what} sent ${JSON.stringify(actual)}, recorded ${JSON.stringify(recorded)}`,
    );
  };
  const createTransport: S3TransportFactory = (options) => {
    buildChecks(options);
    return {
      async request(request) {
        abortIfAsked(request.signal);
        checkQuery(request.target.query);
        const index = next++;
        const exchange = capture.exchanges[index];
        if (exchange === undefined)
          throw new Error(
            `${capture.scenario}: request ${index + 1} has no recorded exchange: ${request.method} ${request.target.path}${request.target.query === "" ? "" : `?${request.target.query}`}`,
          );
        current = index;
        const recorded = exchange.request;
        const input = signingInput(options, request, recorded.headers["accept-encoding"]);
        const actual = recordedRequest(input, signatureOf(options, input));
        sent.push(actual);
        if (actual.method !== recorded.method) fail(index, "method", actual.method, recorded.method);
        if (actual.path !== recorded.path) fail(index, "path", actual.path, recorded.path);
        if (actual.query !== recorded.query) fail(index, "query", actual.query, recorded.query);
        if ((actual.authorization === null) !== (recorded.authorization === null))
          fail(
            index,
            "authorization",
            actual.authorization === null ? "none" : "signed",
            recorded.authorization === null ? "none" : "signed",
          );
        const names = new Set([...Object.keys(actual.headers), ...Object.keys(recorded.headers)]);
        for (const name of [...names].sort())
          if (actual.headers[name] !== recorded.headers[name])
            fail(index, `header ${name}`, actual.headers[name] ?? null, recorded.headers[name] ?? null);
        if (actual.authorization !== null && recorded.authorization !== null) {
          if (actual.authorization.credential !== recorded.authorization.credential)
            fail(index, "credential", actual.authorization.credential, recorded.authorization.credential);
          if (actual.authorization.signedHeaders.join(";") !== recorded.authorization.signedHeaders.join(";"))
            fail(index, "signedHeaders", actual.authorization.signedHeaders, recorded.authorization.signedHeaders);
          for (const name of Object.keys(actual.headers))
            if (name.startsWith("x-amz-") && !actual.authorization.signedHeaders.includes(name))
              throw new Error(
                `${capture.scenario} step ${exchange.step} (exchange ${index + 1}): ${name} is sent but not signed`,
              );
          if (actual.headers["x-amz-content-sha256"] === undefined)
            throw new Error(
              `${capture.scenario} step ${exchange.step} (exchange ${index + 1}): a signed request carries no x-amz-content-sha256`,
            );
        }
        return responseOf(exchange.answer);
      },
      close() {},
    };
  };
  return {
    createTransport,
    sent,
    clock: replayClock(capture, () => current),
    setStep(name) {
      step = name;
    },
    assertConsumed() {
      const left = capture.exchanges.length - next;
      if (left > 0) {
        const first = capture.exchanges[next].request;
        throw new Error(
          `${capture.scenario}: ${left} recorded exchange(s) were not sent, the first ${first.method} ${first.path}`,
        );
      }
    },
  };
}

export function scriptedS3Transport(steps: readonly S3ScriptedStep[]): S3RecordedTransport {
  for (const step of steps) if (step.synthetic !== true) throw new Error("a scripted step must be marked synthetic");
  const sent: S3RecordedRequest[] = [];
  let next = 0;
  let stepName = "";
  const createTransport: S3TransportFactory = (options) => {
    buildChecks(options);
    return {
      async request(request) {
        abortIfAsked(request.signal);
        checkQuery(request.target.query);
        const index = next++;
        const step = steps[index];
        if (step === undefined)
          throw new Error(
            `scripted: request ${index + 1} (${stepName}) has no scripted step: ${request.method} ${request.target.path}`,
          );
        // The byte transport always hands its signer accept-encoding: identity.
        const input = signingInput(options, request, "identity");
        const actual = recordedRequest(input, signatureOf(options, input));
        sent.push(actual);
        const wanted = step.expect ?? {};
        for (const field of ["method", "path", "query"] as const)
          if (wanted[field] !== undefined && actual[field] !== wanted[field])
            throw new Error(
              `scripted step ${index + 1} (${step.source}): ${field} sent ${JSON.stringify(actual[field])}, scripted ${JSON.stringify(wanted[field])}`,
            );
        for (const [name, value] of Object.entries(wanted.headers ?? {}))
          if (actual.headers[name] !== value)
            throw new Error(
              `scripted step ${index + 1} (${step.source}): header ${name} sent ${JSON.stringify(actual.headers[name] ?? null)}, scripted ${JSON.stringify(value)}`,
            );
        if (step.answer instanceof Error) throw step.answer;
        return responseOf(step.answer);
      },
      close() {},
    };
  };
  return {
    createTransport,
    sent,
    clock: () => new Date("2026-10-09T12:00:00Z"),
    setStep(name) {
      stepName = name;
    },
    assertConsumed() {
      if (next < steps.length)
        throw new Error(`scripted: ${steps.length - next} step(s) were not sent, the first from ${steps[next].source}`);
    },
  };
}

/** The harness's signer wrapper: hands each input and the headers the signer returned to `sink`, unchanged. */
export function recordingSigner(
  signer: RequestSigner,
  sink: (input: SigningInput, headers: Readonly<Record<string, string>>) => void,
): RequestSigner {
  return {
    headerNames: signer.headerNames,
    sign(input) {
      const headers = signer.sign(input);
      sink(input, headers);
      return headers;
    },
  };
}
