/**
 * Couchbase HTTP transport (issue #262, decisions 1, 3 and 5)
 *
 * The only implementation of the CouchbaseTransport seam. It speaks the two
 * documented REST surfaces - the Query Service (`/query/service`) and the
 * management API (`/pools/default...`) - so the provider needs no native
 * dependency of any kind. This file is the ONLY place that may mention the wire
 * envelope; a guard test fails the build if those identifiers leak out of it.
 *
 * Two transport paths, one seam:
 *
 * - Plaintext clusters go through global `fetch`.
 * - TLS clusters go through `node:https`. Node's `fetch` cannot carry a custom
 *   CA or relax verification without an undici `Agent` passed as `dispatcher`,
 *   and undici is not a dependency of this project (and must not become one).
 *   `node:https` is a built-in that takes `ca`/`cert`/`key`/`rejectUnauthorized`
 *   directly, so self-signed self-hosted clusters work on the Node runtime that
 *   ships in the Docker image.
 */

import { promises as dns, type SrvRecord } from "node:dns";
import { request as httpRequest, type RequestOptions as HttpRequestOptions } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import type { DatabaseConnection } from "@/lib/db/types";
import type { SSLConfig } from "@/lib/types";
import { quoteIdentifier } from "./keyspace";
import {
  CouchbaseError,
  type CouchbaseQueryResult,
  type CouchbaseRow,
  type CouchbaseScanConsistency,
  type CouchbaseTransport,
  type CouchbaseWarning,
  type QueryOpts,
} from "./transport";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_HOST = "localhost";
const DEFAULT_MANAGEMENT_PORT = 8091;
const DEFAULT_MANAGEMENT_TLS_PORT = 18091;
const DEFAULT_QUERY_PORT = 8093;
const DEFAULT_QUERY_TLS_PORT = 18093;
const QUERY_PATH = "/query/service";
const NODE_SERVICES_PATH = "/pools/default/nodeServices";

/** Capella endpoints are SRV records under this prefix. */
const SRV_PREFIX = "_couchbases._tcp.";

/** Server-side statement timeout when a caller does not set one. */
const DEFAULT_QUERY_TIMEOUT_MS = 30000;

/** Read-your-writes by default - see CouchbaseScanConsistency for why. */
const DEFAULT_SCAN_CONSISTENCY: CouchbaseScanConsistency = "request_plus";

const GENERIC_STATEMENT_FAILURE = "Couchbase rejected the statement";

/**
 * SQL++ codes worth retrying: request timeout, bulk KV fetch failure and the
 * CAS mismatch a concurrent mutation produces. Everything else (syntax, missing
 * index, missing privilege) needs a user fix, not another attempt.
 */
const RETRIABLE_CODES = new Set([1080, 12008, 12009]);

const HTTP_MESSAGES: Record<number, string> = {
  401: "Couchbase rejected the credentials (HTTP 401): check the username and password",
  403: "Couchbase denied the request (HTTP 403): the user lacks permission for this operation",
  503: "The Couchbase query service is unavailable (HTTP 503): the node may still be warming up",
};

/** Duration units the cluster emits, expressed in milliseconds. */
const DURATION_UNITS_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3, // micro sign
  μs: 1e-3, // greek small letter mu
  ms: 1,
  s: 1000,
  m: 60000,
  h: 3600000,
};

const DURATION_PATTERN = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/g;

// ============================================================================
// Transport-level types
// ============================================================================

/** TLS material handed to the node request path. */
export interface CouchbaseTlsMaterial {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized: boolean;
}

export interface JsonRequestInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface JsonResponse {
  httpCode: number;
  payload: unknown;
}

export type SecureJsonRequest = (
  url: string,
  init: JsonRequestInit,
  tls: CouchbaseTlsMaterial,
) => Promise<JsonResponse>;

export type SrvResolver = (hostname: string) => Promise<SrvRecord[]>;

/**
 * Injection points. Both default to the real implementation; tests replace them
 * rather than reaching for `mock.module()`, which is process-wide in bun.
 */
export interface CouchbaseHttpTransportDeps {
  resolveSrv?: SrvResolver;
  requestJson?: SecureJsonRequest;
}

interface NodeServicesEntry {
  hostname?: string;
  services?: Record<string, number | undefined>;
  alternateAddresses?: { external?: { hostname?: string; ports?: Record<string, number | undefined> } };
}

interface NodeServicesPayload {
  nodesExt?: NodeServicesEntry[];
}

// ============================================================================
// Pure helpers
// ============================================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function readMessage(record: Record<string, unknown>, fallback: string): string {
  if (typeof record.msg === "string") return record.msg;
  if (typeof record.message === "string") return record.message;
  return fallback;
}

/** Bracket a bare IPv6 literal so it can be used in a URL authority. */
function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Parse a Go-style duration ("1.234ms", "1.5s", "2m30s") into milliseconds.
 * Anything unparsable counts as zero rather than NaN.
 */
function parseDurationMs(value: unknown): number {
  if (typeof value !== "string") return 0;
  let total = 0;
  for (const match of value.matchAll(DURATION_PATTERN)) {
    total += Number.parseFloat(match[1]) * DURATION_UNITS_MS[match[2]];
  }
  return total;
}

/**
 * Column names for a statement, or null when the source cannot tell.
 * `SELECT *` advertises a single wildcard, so the caller derives columns from
 * the rows instead of trusting it.
 */
function fieldNamesFromSignature(value: unknown): string[] | null {
  const record = asRecord(value);
  if (!record) return null;
  const keys = Object.keys(record);
  // A wildcard key means the signature does not describe the actual row shape:
  // `SELECT *` signs as { "*": "*" }, and `SELECT META(u).id AS __id, u.*` signs
  // as { id: "json", "*": "*" }. Returning those keys would name a literal "*"
  // column and hide every field the wildcard expanded to, so the caller derives
  // the field list from the rows instead.
  if (keys.includes("*")) return null;
  return keys;
}

function toWarnings(value: unknown): CouchbaseWarning[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const record = asRecord(entry) ?? {};
    return {
      message: readMessage(record, ""),
      // Left out entirely when the entry reported none, rather than defaulted:
      // the code is shown to the user now (#273) and 0 is a code the cluster can
      // genuinely send.
      ...(typeof record.code === "number" ? { code: record.code } : {}),
    };
  });
}

function toQueryResult(payload: unknown): CouchbaseQueryResult {
  const record = asRecord(payload) ?? {};
  const metrics = asRecord(record.metrics) ?? {};
  const duration = typeof metrics.executionTime === "string" ? metrics.executionTime : metrics.elapsedTime;

  return {
    rows: Array.isArray(record.results) ? (record.results as CouchbaseRow[]) : [],
    fieldNames: fieldNamesFromSignature(record.signature),
    executionTimeMs: parseDurationMs(duration),
    mutationCount: typeof metrics.mutationCount === "number" ? metrics.mutationCount : 0,
    warnings: toWarnings(record.warnings),
  };
}

/**
 * A failed statement can arrive inside a 200 response, so the payload is
 * inspected BEFORE the HTTP code (decision 5). Skipping this reports a syntax
 * error as "0 rows".
 */
function payloadError(payload: unknown): CouchbaseError | null {
  const record = asRecord(payload);
  if (!record) return null;

  const errors = Array.isArray(record.errors) ? record.errors : [];
  const first = asRecord(errors[0]);
  if (first) {
    const code = typeof first.code === "number" ? first.code : 0;
    return new CouchbaseError(readMessage(first, GENERIC_STATEMENT_FAILURE), code, RETRIABLE_CODES.has(code));
  }

  if (record.status === "errors") return new CouchbaseError(GENERIC_STATEMENT_FAILURE, 0, false);
  return null;
}

function httpError(httpCode: number): CouchbaseError {
  return new CouchbaseError(
    HTTP_MESSAGES[httpCode] ?? `Couchbase request failed with HTTP ${httpCode}`,
    httpCode,
    httpCode >= 500,
  );
}

function networkError(error: unknown): CouchbaseError {
  const message = error instanceof Error ? error.message : String(error);
  return new CouchbaseError(`Couchbase request failed: ${message}`, 0, true);
}

function throwIfFailed(response: JsonResponse): void {
  const failure = payloadError(response.payload);
  if (failure) throw failure;
  if (response.httpCode >= 200 && response.httpCode < 300) return;
  throw httpError(response.httpCode);
}

function buildTlsMaterial(ssl: SSLConfig | undefined): CouchbaseTlsMaterial | null {
  if (!ssl || ssl.mode === "disable") return null;

  // Same rule the PostgreSQL and MySQL providers use: only the verifying modes
  // check the chain, because a self-hosted Couchbase node ships a self-signed
  // certificate by default. An explicit flag always wins.
  const material: CouchbaseTlsMaterial = {
    // `require` encrypts without checking - a self-hosted node ships a self-signed
    // certificate - while every other mode verifies. `verify-system` verifies against the
    // runtime's own trust store, which is what a Capella endpoint needs and all it needs (D26).
    rejectUnauthorized: ssl.rejectUnauthorized ?? ssl.mode !== "require",
  };
  if (ssl.caCert) material.ca = ssl.caCert;
  if (ssl.clientCert) material.cert = ssl.clientCert;
  if (ssl.clientKey) material.key = ssl.clientKey;
  return material;
}

// ============================================================================
// Request paths
// ============================================================================

async function fetchJson(url: string, init: JsonRequestInit): Promise<JsonResponse> {
  let response: Response;
  try {
    response = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  } catch (error) {
    throw networkError(error);
  }
  return { httpCode: response.status, payload: parseJsonBody(await response.text()) };
}

/**
 * TLS-capable request over the Node built-ins. Exported so the TLS path is
 * exercised directly against a local server instead of being mocked away.
 */
export function nodeRequestJson(url: string, init: JsonRequestInit, tls: CouchbaseTlsMaterial): Promise<JsonResponse> {
  const target = new URL(url);
  const options: HttpsRequestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: `${target.pathname}${target.search}`,
    method: init.method,
    headers: init.headers,
    ca: tls.ca,
    cert: tls.cert,
    key: tls.key,
    rejectUnauthorized: tls.rejectUnauthorized,
  };

  return new Promise<JsonResponse>((resolve, reject) => {
    const onResponse = (response: import("node:http").IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          httpCode: response.statusCode ?? 0,
          payload: parseJsonBody(Buffer.concat(chunks).toString("utf8")),
        });
      });
    };

    const clientRequest =
      target.protocol === "https:"
        ? httpsRequest(options, onResponse)
        : httpRequest(options as HttpRequestOptions, onResponse);

    clientRequest.on("error", (error: Error) => reject(networkError(error)));
    if (init.body !== undefined) clientRequest.write(init.body);
    clientRequest.end();
  });
}

// ============================================================================
// Transport
// ============================================================================

export class CouchbaseHttpTransport implements CouchbaseTransport {
  public readonly kind = "http" as const;

  private readonly host: string;
  private readonly explicitPort: number | undefined;
  private readonly managementPort: number;
  private readonly scheme: "http" | "https";
  private readonly tls: CouchbaseTlsMaterial | null;
  private readonly authorization: string;
  private readonly resolveSrv: SrvResolver;
  private readonly requestJson: SecureJsonRequest;
  /** `default:<bucket>`, or undefined when the connection pins no bucket. */
  private readonly queryContext: string | undefined;

  // The in-flight promise is cached, not just its value: concurrent queries on a
  // fresh transport would otherwise each run their own discovery round-trip.
  private hostLookup: Promise<string> | null = null;
  private endpointLookup: Promise<string> | null = null;

  constructor(config: DatabaseConnection, deps: CouchbaseHttpTransportDeps = {}) {
    this.host = config.host ?? DEFAULT_HOST;
    this.explicitPort = config.port;
    this.tls = buildTlsMaterial(config.ssl);
    this.scheme = this.tls ? "https" : "http";
    this.managementPort = config.port ?? (this.tls ? DEFAULT_MANAGEMENT_TLS_PORT : DEFAULT_MANAGEMENT_PORT);
    this.authorization = `Basic ${Buffer.from(`${config.user ?? ""}:${config.password ?? ""}`).toString("base64")}`;
    this.resolveSrv = deps.resolveSrv ?? dns.resolveSrv.bind(dns);
    this.requestJson = deps.requestJson ?? nodeRequestJson;
    this.queryContext = config.database ? `default:${quoteIdentifier(config.database)}` : undefined;
  }

  public async query(stmt: string, o: QueryOpts = {}): Promise<CouchbaseQueryResult> {
    const endpoint = await this.getQueryEndpoint();

    const body: Record<string, unknown> = {
      statement: stmt,
      timeout: `${o.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS}ms`,
      metrics: true,
      scan_consistency: o.scanConsistency ?? DEFAULT_SCAN_CONSISTENCY,
    };
    // The bucket is pinned by the connection, so the schema explorer shows a
    // collection as `scope.collection`. SQL++ reads a bare two-part name as
    // bucket.collection, which would send `inventory.hotel` looking for a BUCKET
    // named inventory. Pinning the query context to the connection's bucket makes
    // the displayed name directly runnable, and leaves fully qualified three-part
    // paths resolving exactly as before.
    if (this.queryContext) body.query_context = this.queryContext;
    if (o.args && o.args.length > 0) body.args = o.args;
    if (o.readonly !== undefined) body.readonly = o.readonly;
    if (o.profile !== undefined) body.profile = o.profile;

    const response = await this.send(endpoint, {
      method: "POST",
      headers: { ...this.baseHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    throwIfFailed(response);
    return toQueryResult(response.payload);
  }

  public async manage<T>(path: string): Promise<T> {
    const host = await this.getHost();
    const response = await this.send(`${this.scheme}://${formatHost(host)}:${this.managementPort}${path}`, {
      method: "GET",
      headers: this.baseHeaders(),
    });
    throwIfFailed(response);
    return response.payload as T;
  }

  public async close(): Promise<void> {
    this.hostLookup = null;
    this.endpointLookup = null;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private baseHeaders(): Record<string, string> {
    return { accept: "application/json", authorization: this.authorization };
  }

  private send(url: string, init: JsonRequestInit): Promise<JsonResponse> {
    return this.tls ? this.requestJson(url, init, this.tls) : fetchJson(url, init);
  }

  /**
   * Capella advertises its endpoint as an SRV record, so a host with no port is
   * looked up before use. A DNS failure is never fatal: the host is then used
   * as a plain A record, which is what every self-hosted cluster needs anyway.
   */
  private getHost(): Promise<string> {
    this.hostLookup ??= this.resolveHost();
    return this.hostLookup;
  }

  private async resolveHost(): Promise<string> {
    if (this.explicitPort !== undefined) return this.host;

    const records = await this.resolveSrv(`${SRV_PREFIX}${this.host}`).catch(() => [] as SrvRecord[]);
    return records.length > 0 ? records[0].name : this.host;
  }

  /**
   * `DatabaseConnection` carries one port, so the query endpoint is discovered
   * rather than configured (decision 3). Cached for the transport's lifetime -
   * but a FAILED discovery is not, or one unreachable moment would poison every
   * later query on the same connection.
   */
  private getQueryEndpoint(): Promise<string> {
    this.endpointLookup ??= this.discoverQueryEndpoint().catch((error: unknown) => {
      this.endpointLookup = null;
      throw error;
    });
    return this.endpointLookup;
  }

  private async discoverQueryEndpoint(): Promise<string> {
    const host = await this.getHost();
    const payload = await this.manage<NodeServicesPayload>(NODE_SERVICES_PATH);
    return this.pickQueryEndpoint(payload, host);
  }

  private pickQueryEndpoint(payload: NodeServicesPayload, host: string): string {
    const nodes = Array.isArray(payload.nodesExt) ? payload.nodesExt : [];
    const serviceKey = this.tls ? "n1qlSSL" : "n1ql";

    for (const node of nodes) {
      // A NAT/Docker/Capella deployment advertises the reachable address here,
      // so it wins over the node's internal hostname when it carries the port.
      const external = node.alternateAddresses?.external;
      const externalPort = external?.ports?.[serviceKey];
      if (typeof externalPort === "number") {
        return this.queryUrl(external?.hostname ?? node.hostname ?? host, externalPort);
      }

      const port = node.services?.[serviceKey];
      if (typeof port === "number") return this.queryUrl(node.hostname ?? host, port);
    }

    return this.queryUrl(host, this.tls ? DEFAULT_QUERY_TLS_PORT : DEFAULT_QUERY_PORT);
  }

  private queryUrl(host: string, port: number): string {
    return `${this.scheme}://${formatHost(host)}:${port}${QUERY_PATH}`;
  }
}
