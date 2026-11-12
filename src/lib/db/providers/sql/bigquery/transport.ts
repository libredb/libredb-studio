/**
 * BigQuery REST v2 over the shared node transport. The only file that knows the wire envelope.
 */

import { DatabaseConfigError } from "@/lib/db/errors";
import { createNodeTransport, type NodeTransport, TransportError } from "@/lib/db/http/node-transport";
import { createTokenSource, type GoogleCredentials, tokenOrigin } from "./auth";

const API_HOST = "bigquery.googleapis.com";
const RESPONSE_BYTES = 64 * 1024 * 1024;
const PAGE_ROWS = 10_000;

export interface BigQueryField {
  readonly name: string;
  readonly type: string;
  readonly mode?: "NULLABLE" | "REQUIRED" | "REPEATED";
  readonly fields?: readonly BigQueryField[];
}

export interface BigQueryQueryOptions {
  readonly dryRun?: boolean;
  readonly jobTimeoutMs: number;
  readonly maxRows: number;
  readonly defaultDataset?: string;
  /** Where the job runs. Absent, BigQuery infers it from the referenced tables and falls back to US. */
  readonly location?: string;
  readonly signal: AbortSignal;
}

export interface BigQueryQueryResult {
  readonly fields: readonly BigQueryField[];
  readonly rows: Record<string, unknown>[];
  readonly totalBytesProcessed: number | null;
  readonly totalBytesBilled: number | null;
  readonly cacheHit: boolean;
  readonly affectedRows: number | null;
  readonly executionTimeMs: number;
}

export interface BigQueryTableRef {
  readonly id: string;
  readonly type: string;
}

export interface BigQueryDatasetRef {
  readonly id: string;
  /** The emulator lists none. */
  readonly location?: string;
}

export interface BigQueryTable {
  readonly fields: readonly BigQueryField[];
}

export class BigQueryApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null,
    message: string,
  ) {
    super(message);
    this.name = "BigQueryApiError";
  }
}

export interface BigQueryTransport {
  query(sql: string, options: BigQueryQueryOptions): Promise<BigQueryQueryResult>;
  listDatasets(signal: AbortSignal): Promise<BigQueryDatasetRef[]>;
  listTables(dataset: string, signal: AbortSignal): Promise<BigQueryTableRef[]>;
  getTable(dataset: string, table: string, signal: AbortSignal): Promise<BigQueryTable>;
  close(): void;
}

type Wire = Record<string, unknown>;

/** `v` of a wire cell, undefined for anything that is not one. */
const cellValue = (cell: unknown): unknown => (cell as { v?: unknown } | null | undefined)?.v;

/** A wire `fields` list, or undefined when the answer carries none (or something that is not a list). */
function fieldsOf(holder: unknown): BigQueryField[] | undefined {
  const fields = (holder as { fields?: unknown } | null | undefined)?.fields;
  return Array.isArray(fields) ? (fields as BigQueryField[]) : undefined;
}

function num(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** One cell as JS. INT64/NUMERIC stay strings so precision survives the grid. A malformed cell decodes to null. */
export function decodeCell(field: BigQueryField, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (field.mode === "REPEATED") {
    if (!Array.isArray(value)) return null;
    return value.map((item) => decodeCell({ ...field, mode: "NULLABLE" }, cellValue(item)));
  }
  switch (field.type) {
    case "RECORD":
    case "STRUCT": {
      const cells = (value as { f?: unknown }).f;
      if (!Array.isArray(cells)) return null;
      return Object.fromEntries(
        (fieldsOf(field) ?? []).map((sub, i) => [sub.name, decodeCell(sub, cellValue(cells[i]))]),
      );
    }
    case "FLOAT":
    case "FLOAT64":
      return Number(value);
    case "BOOLEAN":
    case "BOOL":
      return value === "true";
    case "TIMESTAMP": {
      // ponytail: microseconds truncated to milliseconds; keep the raw string if sub-ms matters.
      const ms = /^-?\d+$/.test(String(value)) ? Number(BigInt(String(value)) / BigInt(1000)) : Number.NaN;
      // Beyond ±8.64e15 ms a Date is invalid and toISOString throws.
      return Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
    }
    default:
      return value;
  }
}

/** A wire list of objects; entries that are not objects come back as undefined for the caller to skip. */
function listed(value: unknown): (Wire | undefined)[] {
  return Array.isArray(value)
    ? value.map((item) => (item && typeof item === "object" ? (item as Wire) : undefined))
    : [];
}

function decodeRows(fields: readonly BigQueryField[], rows: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const cells = (row as { f?: unknown } | null | undefined)?.f;
    return Object.fromEntries(
      fields.map((field, i) => [field.name, decodeCell(field, Array.isArray(cells) ? cellValue(cells[i]) : undefined)]),
    );
  });
}

const emulatorHost = (env: Readonly<Record<string, string | undefined>>) => env.BIGQUERY_EMULATOR_HOST?.trim() || null;

/** Env only, never a connection field: a user must not point a connection's token at another host. */
export function apiOrigin(env: Readonly<Record<string, string | undefined>> = process.env): {
  scheme: "http" | "https";
  host: string;
  port: number;
} {
  const emulator = emulatorHost(env);
  if (!emulator) return { scheme: "https", host: API_HOST, port: 443 };
  const url = new URL(emulator.includes("://") ? emulator : `http://${emulator}`);
  const scheme = url.protocol === "https:" ? "https" : "http";
  return { scheme, host: url.hostname, port: url.port ? Number(url.port) : scheme === "https" ? 443 : 80 };
}

export function createBigQueryTransport(
  project: string,
  creds: GoogleCredentials,
  env: Readonly<Record<string, string | undefined>> = process.env,
): BigQueryTransport {
  // encodeURIComponent keeps "." and "..", which would climb out of /projects/ in the URL path.
  if (!/^[a-z][a-z0-9:.-]{0,200}$/i.test(project) || project === "." || project === "..") {
    throw new DatabaseConfigError("BigQuery project id is not a valid project id", "bigquery");
  }
  const tls = (identity: string) => ({ rejectUnauthorized: true, identity });
  const api = apiOrigin(env);
  const origin = tokenOrigin(creds);
  // The emulator checks no credential, so none is minted and none leaves the process.
  const oauth = emulatorHost(env)
    ? null
    : createNodeTransport({
        origin,
        tls: origin.scheme === "https" ? tls(origin.host) : null,
        maxSockets: 1,
        // The metadata server answers only requests that carry this header.
        headers: creds.type === "metadata" ? { "metadata-flavor": "Google" } : {},
      });
  // An external_account config reads its subject token from a second origin, through its own transport.
  const subject =
    oauth && creds.type === "external_account"
      ? createNodeTransport({
          origin: creds.source.origin,
          tls: creds.source.origin.scheme === "https" ? tls(creds.source.origin.host) : null,
          maxSockets: 1,
          headers: creds.source.headers,
        })
      : undefined;
  const token = oauth ? createTokenSource(creds, oauth, Date.now, subject) : async () => null;
  const base = `${new URL(`${api.scheme}://${api.host}:${api.port}`).origin}/bigquery/v2/projects/${encodeURIComponent(project)}`;

  // The node transport owns Authorization as a connection header, so each token gets its own transport.
  // A replaced one closes once its in-flight requests finish, since close() aborts them.
  type Lane = { readonly token: string | null; readonly node: NodeTransport; inFlight: number };
  const lanes = new Set<Lane>();
  let current: Lane | null = null;
  let closed = false;
  const laneTransport = (bearer: string | null) =>
    createNodeTransport({
      origin: api,
      tls: api.scheme === "https" ? tls(api.host) : null,
      maxSockets: 8,
      headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
    });
  const retire = (lane: Lane) => {
    if (lane !== current && lane.inFlight === 0) {
      lane.node.close();
      lanes.delete(lane);
    }
  };
  async function lane(signal: AbortSignal): Promise<Lane> {
    const bearer = await token(signal);
    // Checked after the await too: close() may land while the token is on its way.
    if (closed) throw new TransportError("aborted", "The BigQuery connection is closed");
    if (current?.token !== bearer) {
      const previous = current;
      current = { token: bearer, node: laneTransport(bearer), inFlight: 0 };
      lanes.add(current);
      if (previous) retire(previous);
    }
    return current;
  }

  const send = (node: NodeTransport, method: "GET" | "POST", path: string, signal: AbortSignal, body?: Wire) =>
    node.request({
      method,
      url: `${base}${path}`,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
      maxResponseBytes: RESPONSE_BYTES,
    });

  async function call(method: "GET" | "POST", path: string, signal: AbortSignal, body?: Wire): Promise<Wire> {
    const held = await lane(signal);
    held.inFlight += 1;
    let response: Awaited<ReturnType<NodeTransport["request"]>>;
    try {
      response = await send(held.node, method, path, signal, body);
    } finally {
      held.inFlight -= 1;
      retire(held);
    }
    let parsed: Wire = {};
    try {
      const value: unknown = JSON.parse(response.text);
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Wire;
    } catch {
      // Non-JSON (proxy page): reported by status below.
    }
    if (response.status >= 400) {
      const error = (parsed.error ?? {}) as { message?: unknown; errors?: unknown };
      const reason = Array.isArray(error.errors) ? (error.errors[0] as { reason?: unknown } | null)?.reason : undefined;
      throw new BigQueryApiError(
        response.status,
        typeof reason === "string" ? reason : null,
        typeof error.message === "string" ? error.message : `BigQuery answered HTTP ${response.status}`,
      );
    }
    return parsed;
  }

  /**
   * Best effort, on its own deadline (the caller's signal is spent) and its own transport, closed straight after,
   * so it still goes out when close() is what aborted the query.
   */
  async function cancelJob(jobId: string, location: string | undefined): Promise<void> {
    const signal = AbortSignal.timeout(5000);
    const query = location ? `?${new URLSearchParams({ location })}` : "";
    try {
      const node = laneTransport(await token(signal));
      try {
        await send(node, "POST", `/jobs/${encodeURIComponent(jobId)}/cancel${query}`, signal);
      } finally {
        node.close();
      }
    } catch {
      // The job's own jobTimeoutMs still bounds it.
    }
  }

  return {
    async query(sql, options) {
      const started = performance.now();
      let job: { jobId: string; location?: string } | undefined;
      try {
        // An abort while this POST is still in flight cannot name the job (jobs.query takes no client job id), so
        // that job runs on, bounded by jobTimeoutMs; jobs.insert with our own id would close it.
        let page = await call("POST", "/queries", options.signal, {
          query: sql,
          ...(options.location ? { location: options.location } : {}),
          useLegacySql: false,
          dryRun: options.dryRun ?? false,
          maxResults: Math.min(options.maxRows, PAGE_ROWS),
          timeoutMs: options.jobTimeoutMs,
          // int64 is a JSON string in the REST schema; the emulator refuses a number.
          jobTimeoutMs: String(options.jobTimeoutMs),
          formatOptions: { useInt64Timestamp: true },
          ...(options.defaultDataset
            ? { defaultDataset: { projectId: project, datasetId: options.defaultDataset } }
            : {}),
        });
        const first = page;
        const ref = page.jobReference as { jobId?: unknown; location?: unknown } | undefined;
        if (typeof ref?.jobId === "string") {
          job = { jobId: ref.jobId, ...(typeof ref.location === "string" ? { location: ref.location } : {}) };
        }

        // Poll until complete, then follow pageToken up to maxRows.
        let fields = fieldsOf(page.schema) ?? [];
        const rows: Record<string, unknown>[] = page.jobComplete === false ? [] : decodeRows(fields, page.rows);
        const pending = () =>
          page.jobComplete === false || (typeof page.pageToken === "string" && rows.length < options.maxRows);
        if (job) {
          while (pending()) {
            const params = new URLSearchParams({
              maxResults: String(Math.min(options.maxRows - rows.length, PAGE_ROWS)),
              timeoutMs: String(options.jobTimeoutMs),
              "formatOptions.useInt64Timestamp": "true",
              ...(job.location ? { location: job.location } : {}),
              ...(typeof page.pageToken === "string" && page.jobComplete !== false
                ? { pageToken: page.pageToken }
                : {}),
            });
            page = await call("GET", `/queries/${encodeURIComponent(job.jobId)}?${params}`, options.signal);
            fields = fieldsOf(page.schema) ?? fields;
            if (page.jobComplete !== false) rows.push(...decodeRows(fields, page.rows));
          }
        }

        return {
          fields,
          rows: rows.slice(0, options.maxRows),
          totalBytesProcessed: num(first.totalBytesProcessed ?? page.totalBytesProcessed),
          totalBytesBilled: num(first.totalBytesBilled ?? page.totalBytesBilled),
          cacheHit: (first.cacheHit ?? page.cacheHit) === true,
          affectedRows: num(first.numDmlAffectedRows ?? page.numDmlAffectedRows),
          executionTimeMs: performance.now() - started,
        };
      } catch (error) {
        if (job) await cancelJob(job.jobId, job.location);
        throw error;
      }
    },

    async listDatasets(signal) {
      const ids: BigQueryDatasetRef[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ maxResults: "1000", ...(pageToken ? { pageToken } : {}) });
        const page = await call("GET", `/datasets?${params}`, signal);
        for (const d of listed(page.datasets)) {
          const id = (d?.datasetReference as Wire | undefined)?.datasetId;
          if (typeof id !== "string") continue;
          ids.push({ id, ...(typeof d?.location === "string" ? { location: d.location } : {}) });
        }
        pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
      } while (pageToken);
      return ids;
    },

    async listTables(dataset, signal) {
      const tables: BigQueryTableRef[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ maxResults: "1000", ...(pageToken ? { pageToken } : {}) });
        const page = await call("GET", `/datasets/${encodeURIComponent(dataset)}/tables?${params}`, signal);
        for (const t of listed(page.tables)) {
          const id = (t?.tableReference as Wire | undefined)?.tableId;
          if (typeof id === "string" && typeof t?.type === "string") tables.push({ id, type: t.type });
        }
        pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
      } while (pageToken);
      return tables;
    },

    async getTable(dataset, table, signal) {
      const t = await call(
        "GET",
        `/datasets/${encodeURIComponent(dataset)}/tables/${encodeURIComponent(table)}`,
        signal,
      );
      return { fields: fieldsOf(t.schema) ?? [] };
    },

    close() {
      closed = true;
      current = null;
      for (const held of lanes) held.node.close();
      lanes.clear();
      oauth?.close();
      subject?.close();
    },
  };
}
