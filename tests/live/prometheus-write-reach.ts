/**
 * Measures Prometheus's write reach against the server tests/fixtures/prometheus/v3.13.3/write-reach/run.sh started:
 * the TSDB head's series count is read before and after every provider surface, on a read-only connection and on the
 * agent's handles, and written with every request Studio sent into that run.sh's directory as write-reach.json.
 *
 *   bun tests/live/prometheus-write-reach.ts
 *
 * The environment names the server: PROMETHEUS_WRITE_REACH_URL (its origin), PROMETHEUS_WRITE_REACH_OUT (the directory
 * to write) and PROMETHEUS_WRITE_REACH_IMAGE (the pinned image, recorded). The server runs with the admin API, the
 * remote-write receiver and the lifecycle endpoints on and scrapes nothing, so its series count moves when a new series
 * is written, by remote write or OTLP. The count does not see the admin and lifecycle endpoints (a series deletion, a
 * snapshot or a reload leaves it unchanged), so those are shown absent by the recorded request list, sentByStudio.
 * After Studio's surfaces, this script sends one remote write itself, with `fetch` and never through Studio, and reads
 * the count again: the control that shows a new series would have been seen.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs no file under tests/live/.
 */
// oxlint-disable no-await-in-loop -- each surface runs after the one before, on purpose: the count is read between them.
import { writeFileSync } from "node:fs";
import { posix } from "node:path";
import { createDatabaseProvider } from "@/lib/db/factory";
import { PrometheusProvider } from "@/lib/db/providers/timeseries/prometheus/index";
import { createSendRequest, type SendRequest } from "@/lib/db/providers/timeseries/prometheus/request";
import type { DatabaseProvider, ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const ORIGIN = env("PROMETHEUS_WRITE_REACH_URL");
const OUT = env("PROMETHEUS_WRITE_REACH_OUT");
const DATE = new Date().toISOString().slice(0, 10);
const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 200, maxResultBytes: 1_000_000, statementTimeoutMs: 10_000 };

const url = new URL(ORIGIN);
const CONNECTION: DatabaseConnection = {
  id: "write-reach",
  name: "write reach",
  type: "prometheus",
  host: url.hostname,
  port: Number(url.port),
  readOnly: true,
  createdAt: new Date(),
};

interface SentRecord {
  readonly method: string;
  readonly path: string;
}

const sent: SentRecord[] = [];
const real = createSendRequest(null);
const send: SendRequest = (request) => {
  sent.push({ method: request.method, path: request.url.pathname });
  return real(request);
};

async function seriesCount(): Promise<number> {
  const answer = (await (await fetch(`${ORIGIN}/api/v1/status/tsdb`)).json()) as {
    data: { headStats: { numSeries: number } };
  };
  return answer.data.headStats.numSeries;
}

interface Measured {
  readonly surface: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly seriesBefore: number;
  readonly seriesAfter: number;
}

const measured: Measured[] = [];

async function measure(surface: string, call: () => Promise<unknown>): Promise<unknown> {
  const seriesBefore = await seriesCount();
  let answer: unknown;
  let error: string | undefined;
  try {
    answer = await call();
  } catch (failure) {
    error = (failure as Error).name;
  }
  measured.push({
    surface,
    ok: error === undefined,
    ...(error === undefined ? {} : { error }),
    seriesBefore,
    seriesAfter: await seriesCount(),
  });
  return answer;
}

/** Every surface a handle offers, each object kind listed, described and read as source. */
async function surfaces(label: string, provider: DatabaseProvider): Promise<void> {
  await measure(`${label}: connect`, () => provider.connect());
  for (const kind of provider.getCapabilities().objectKinds ?? []) {
    const objects = await measure(`${label}: listObjects ${kind.id}`, () => provider.listObjects([], kind.id));
    await measure(`${label}: describeObjects ${kind.id}`, () => provider.describeObjects([], kind.id, 5));
    const first = Array.isArray(objects) ? (objects[0] as { path: readonly string[] } | undefined) : undefined;
    if (first !== undefined) {
      await measure(`${label}: describeObject ${kind.id}`, () => provider.describeObject(first.path, kind.id));
      await measure(`${label}: readObjectSource ${kind.id}`, async () =>
        provider.readObjectSource?.(first.path, kind.id),
      );
    }
  }
  await measure(`${label}: listContainers`, () => provider.listContainers());
  await measure(`${label}: countObjects`, () => provider.countObjects([]));
  await measure(`${label}: getHealth`, () => provider.getHealth());
  await measure(`${label}: getOverview`, () => provider.getOverview());
  await measure(`${label}: getPerformanceMetrics`, () => provider.getPerformanceMetrics());
  await measure(`${label}: getSlowQueries`, () => provider.getSlowQueries());
  await measure(`${label}: getActiveSessions`, () => provider.getActiveSessions());
  await measure(`${label}: getTableStats`, () => provider.getTableStats());
  await measure(`${label}: getIndexStats`, () => provider.getIndexStats());
  await measure(`${label}: getStorageStats`, () => provider.getStorageStats());
  await measure(`${label}: getMonitoringData`, () => provider.getMonitoringData());
  for (const type of ["vacuum", "analyze", "reindex", "optimize", "check", "kill"] as const) {
    await measure(`${label}: runMaintenance ${type}`, () => provider.runMaintenance(type, "1"));
  }
}

/** One remote write of a new series, protobuf framed and snappy-compressed as a single literal, sent by this script. */
async function rawRemoteWrite(): Promise<number> {
  const varint = (value: number): number[] => {
    const bytes: number[] = [];
    let rest = value;
    while (rest >= 0x80) {
      bytes.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    bytes.push(rest);
    return bytes;
  };
  const text = (tag: number, value: string): number[] => {
    const bytes = [...new TextEncoder().encode(value)];
    return [tag, ...varint(bytes.length), ...bytes];
  };
  const message = (tag: number, body: number[]): number[] => [tag, ...varint(body.length), ...body];
  const label = message(0x0a, [...text(0x0a, "__name__"), ...text(0x12, "write_reach_raw_write")]);
  const value = new Uint8Array(new Float64Array([1]).buffer);
  const sample = message(0x12, [0x09, ...value, 0x10, ...varint(Date.now())]);
  const request = message(0x0a, [...label, ...sample]);
  if (request.length > 256) throw new Error("the raw write outgrew the one-byte snappy literal");
  const snappy = Uint8Array.from([...varint(request.length), 60 << 2, request.length - 1, ...request]);
  const response = await fetch(`${ORIGIN}/api/v1/write`, {
    method: "POST",
    body: snappy,
    headers: {
      "content-type": "application/x-protobuf",
      "content-encoding": "snappy",
      "x-prometheus-remote-write-version": "0.1.0",
    },
  });
  return response.status;
}

// The factory's own check: a read-only Prometheus connection is accepted, not refused.
const accepted = await createDatabaseProvider(CONNECTION).then(
  () => true,
  () => false,
);

const editor = new PrometheusProvider(CONNECTION, {}, {}, { send });
await surfaces("read-only connection", editor);
await measure("read-only connection: query", () => editor.query("write_reach_seed"));
await editor.disconnect();

const readOnlyProfile: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const agent = new PrometheusProvider(CONNECTION, {}, readOnlyProfile, { send });
await surfaces("agent read-only profile", agent);
await measure("agent read-only profile: queryReadOnly", () => agent.queryReadOnly("write_reach_seed", BUDGET));
await agent.disconnect();

const operations = new PrometheusProvider(CONNECTION, {}, { readOnly: true }, { send });
await surfaces("agent operations profile", operations);
await operations.disconnect();

const seriesBeforeRawWrite = await seriesCount();
const rawWriteStatus = await rawRemoteWrite();
const seriesAfterRawWrite = await seriesCount();

const paths = [...new Set(sent.map((request) => `${request.method} ${request.path}`))].sort();
const capture = {
  measured: DATE,
  server: `${env("PROMETHEUS_WRITE_REACH_IMAGE")}, --web.enable-admin-api --web.enable-remote-write-receiver --web.enable-lifecycle, no scrape job`,
  readOnlyConnectionAccepted: accepted,
  surfaces: measured,
  studioLeftSeriesUnchanged: measured.every((entry) => entry.seriesBefore === entry.seriesAfter),
  requestsByStudio: sent.length,
  sentByStudio: paths,
  rawWrite: { status: rawWriteStatus, seriesBefore: seriesBeforeRawWrite, seriesAfter: seriesAfterRawWrite },
};

const out = posix.join(OUT.replaceAll("\\", "/"), "write-reach.json");
writeFileSync(out, `${JSON.stringify(capture, null, 2)}\n`);
console.log(`wrote ${out}`);
