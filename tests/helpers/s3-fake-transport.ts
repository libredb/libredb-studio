/**
 * A socket-free byte transport for the S3 provider's unit tests: it answers each request with the test's handler,
 * calls the session's signer exactly where PR 1's transport does (once, at send time, with the same input), honours
 * the request's signal as PR 1 does (a deadline is "timeout", anything else "aborted"), applies `maxResponseBytes`
 * and `truncateAt`, and records every request it was given. `scriptedS3Transport` is the replay
 * harness's own; this helper serves the unit tests that need no capture.
 */
import { originHost } from "@/lib/db/http/endpoint";
import {
  type NodeByteRequest,
  type NodeByteResponse,
  type NodeByteTransport,
  type NodeByteTransportOptions,
  type SigningInput,
  TransportError,
} from "@/lib/db/http/node-transport";
import {
  createS3Client,
  limitedS3Client,
  type S3ClientContext,
  type S3Surface,
} from "@/lib/db/providers/objectstore/s3/client";
import { buildS3ConnectionOptions, s3EndpointText } from "@/lib/db/providers/objectstore/s3/connection-options";
import { toProviderError } from "@/lib/db/providers/objectstore/s3/errors";
import { S3_RESPONSE_HEADERS } from "@/lib/db/providers/objectstore/s3/headers";
import type { ProviderLimiter } from "@/lib/db/utils/bounded-limiter";
import type { DatabaseConnection, WithTunnelFarEnd } from "@/lib/types";
import { s3Connection } from "./s3-connection";

export interface FakeS3Answer {
  readonly status?: number;
  readonly body?: string | Uint8Array;
  readonly headers?: readonly (readonly [string, string])[];
  readonly contentType?: string | null;
  readonly contentEncoding?: string | null;
  readonly headersTruncated?: boolean;
}

/** Answers one request; it may throw (a TransportError, for example) or return a promise that never settles. */
export type FakeS3Handler = (request: NodeByteRequest) => FakeS3Answer | Promise<FakeS3Answer>;

export interface FakeS3Exchange {
  readonly request: NodeByteRequest;
  /** What the signer was given and returned; null on an unsigned transport. */
  readonly signing: { readonly input: SigningInput; readonly headers: Readonly<Record<string, string>> } | null;
}

export interface FakeS3Transport {
  readonly createTransport: (options: NodeByteTransportOptions) => NodeByteTransport;
  /** The options of every transport built, in order. */
  readonly built: NodeByteTransportOptions[];
  readonly exchanges: FakeS3Exchange[];
  readonly closed: { count: number };
  /** Each request as "METHOD path" or "METHOD path?query". */
  lines(): string[];
}

/** The options the provider builds its transport with, for tests that build a client directly. */
export const TEST_TRANSPORT_OPTIONS: NodeByteTransportOptions = {
  origin: { scheme: "http", host: "localhost", port: 9000 },
  tls: null,
  maxSockets: 4,
  headers: {},
  requestHeaderNames: ["range"],
  responseHeaders: S3_RESPONSE_HEADERS,
};

function abortFailure(signal: AbortSignal): TransportError {
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? new TransportError("timeout", "The request did not finish within its time limit")
    : new TransportError("aborted", "The request was cancelled");
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortFailure(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function toResponse(answer: FakeS3Answer, request: NodeByteRequest): NodeByteResponse {
  const body =
    typeof answer.body === "string" ? Buffer.from(answer.body, "utf8") : Buffer.from(answer.body ?? new Uint8Array());
  const kept = request.method === "HEAD" ? Buffer.alloc(0) : body;
  const limit = request.truncateAt;
  if (limit === undefined && kept.length > request.maxResponseBytes)
    throw new TransportError("too-large", `The response exceeded ${request.maxResponseBytes} bytes`);
  const cut = limit !== undefined && kept.length > limit;
  return {
    status: answer.status ?? 200,
    contentType: answer.contentType ?? null,
    contentEncoding: answer.contentEncoding ?? null,
    retryAfter: null,
    headers: (answer.headers ?? []).map(([name, value]) => [name.toLowerCase(), value] as const),
    headersTruncated: answer.headersTruncated ?? false,
    bytes: cut ? kept.subarray(0, limit) : kept,
    truncated: cut,
  };
}

export function fakeS3Transport(handler: FakeS3Handler): FakeS3Transport {
  const built: NodeByteTransportOptions[] = [];
  const exchanges: FakeS3Exchange[] = [];
  const closed = { count: 0 };
  const createTransport = (options: NodeByteTransportOptions): NodeByteTransport => {
    built.push(options);
    let open = true;
    return {
      async request(request) {
        if (!open) throw new TransportError("aborted", "The transport is closed");
        if (request.signal.aborted) throw abortFailure(request.signal);
        const host = originHost(options.origin);
        const base = { ...options.headers, ...(request.headers ?? {}), host, "accept-encoding": "identity" };
        const input: SigningInput = {
          method: request.method,
          host,
          path: request.target.path,
          query: request.target.query,
          headers: Object.freeze({ ...base }),
        };
        const signing = options.signer === undefined ? null : { input, headers: options.signer.sign(input) };
        exchanges.push({ request, signing });
        const answer = await raceAbort(
          Promise.resolve().then(() => handler(request)),
          request.signal,
        );
        return toResponse(answer, request);
      },
      close() {
        open = false;
        closed.count += 1;
      },
    };
  };
  return {
    createTransport,
    built,
    exchanges,
    closed,
    lines: () =>
      exchanges.map(({ request }) => {
        const { path, query } = request.target;
        return `${request.method} ${path}${query === "" ? "" : `?${query}`}`;
      }),
  };
}

/** A surface over a fake transport, the way the provider builds one, for module-level tests. */
export function fakeS3Surface(
  handler: FakeS3Handler,
  overrides: Partial<DatabaseConnection> = {},
  limiter?: ProviderLimiter,
): { readonly surface: S3Surface; readonly fake: FakeS3Transport; readonly context: S3ClientContext } {
  const options = buildS3ConnectionOptions(s3Connection(overrides) as DatabaseConnection & WithTunnelFarEnd, {
    executionReadOnly: false,
    queryTimeout: 30_000,
  });
  const fake = fakeS3Transport(handler);
  const raw = createS3Client(
    fake.createTransport({ ...TEST_TRANSPORT_OPTIONS, origin: options.origin, tls: options.tls }),
  );
  const client = limiter === undefined ? raw : limitedS3Client(raw, limiter);
  const context: S3ClientContext = {
    region: options.region,
    signs: options.credentials !== null,
    clock: () => new Date(),
    secretForms: options.secretForms,
    endpointText: s3EndpointText(options),
  };
  return {
    surface: { client, options, fail: (error, operation) => toProviderError(error, operation, context) },
    fake,
    context,
  };
}

const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function bucketsXml(names: readonly string[], options: { readonly continuationToken?: string } = {}): string {
  const buckets = names
    .map((name) => `<Bucket><Name>${escape(name)}</Name><CreationDate>2026-10-09T13:13:17.442Z</CreationDate></Bucket>`)
    .join("");
  const token =
    options.continuationToken === undefined
      ? ""
      : `<ContinuationToken>${escape(options.continuationToken)}</ContinuationToken>`;
  return `<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Buckets>${buckets}</Buckets>${token}</ListAllMyBucketsResult>`;
}

export interface FakeListing {
  /** Names as the server writes them: already encoded when `encoding` is "url". */
  readonly keys?: readonly (string | { readonly key: string; readonly size: number })[];
  readonly prefixes?: readonly string[];
  readonly truncated?: boolean;
  readonly token?: string;
  readonly encoding?: "url";
}

export function objectsXml(listing: FakeListing): string {
  const keys = (listing.keys ?? []).map((entry) => (typeof entry === "string" ? { key: entry, size: 1 } : entry));
  const prefixes = listing.prefixes ?? [];
  return [
    '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
    `<KeyCount>${keys.length + prefixes.length}</KeyCount>`,
    `<IsTruncated>${listing.truncated === true}</IsTruncated>`,
    listing.token === undefined ? "" : `<NextContinuationToken>${escape(listing.token)}</NextContinuationToken>`,
    ...keys.map(
      ({ key, size }) =>
        `<Contents><Key>${escape(key)}</Key><LastModified>2026-10-09T13:13:17.578Z</LastModified><ETag>"937ec4c10eb20c1f3324ef927697ea66"</ETag><Size>${size}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
    ),
    ...prefixes.map((prefix) => `<CommonPrefixes><Prefix>${escape(prefix)}</Prefix></CommonPrefixes>`),
    listing.encoding === undefined ? "" : `<EncodingType>${listing.encoding}</EncodingType>`,
    "</ListBucketResult>",
  ].join("");
}

export function errorXml(code: string, message: string, extra: { readonly region?: string } = {}): string {
  const region = extra.region === undefined ? "" : `<Region>${escape(extra.region)}</Region>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${escape(code)}</Code><Message>${escape(message)}</Message>${region}</Error>`;
}

export function xmlAnswer(body: string, status = 200): FakeS3Answer {
  return { status, body, contentType: "application/xml" };
}
