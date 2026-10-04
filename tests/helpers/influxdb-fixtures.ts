/**
 * The one reader of tests/fixtures/influxdb/ (InfluxDB spec 8, contract section 19): what InfluxDB 1.13.1, 2.9.1 and
 * 3.12.0 Core answered over `node:http` before any provider code ran, one request per file, captured by
 * tests/live/influxdb-evidence.ts from the statement plan of tests/live/influxdb-evidence-plan.ts. A missing or
 * mislabelled file fails the suite that reads it; nothing here falls back.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type InfluxFixtureVersion = "1.13.1" | "2.9.1" | "3.12.0-core";

/** The pinned lines, in the manifest's order. */
export const INFLUX_FIXTURE_VERSIONS: readonly InfluxFixtureVersion[] = ["1.13.1", "2.9.1", "3.12.0-core"];

export const INFLUX_FIXTURES_DIR = join(import.meta.dir, "..", "fixtures", "influxdb");

export interface InfluxCapture {
  readonly version: InfluxFixtureVersion;
  /** The plan's capture name: the file's path under its version directory, without .json. */
  readonly name: string;
  /** tag@digest, as `docker inspect` reported the running container's image. */
  readonly image: string;
  /** ISO date. */
  readonly capturedAt: string;
  readonly request: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly query: Readonly<Record<string, string>>;
    readonly form?: Readonly<Record<string, string>>;
    readonly body?: unknown;
    /** The credential's scheme; its value is never written. */
    readonly auth: "none" | "basic" | "token" | "bearer";
  };
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
  /** The server ended the body before its terminating chunk: nothing, inside a line, or after whole lines (R39). */
  readonly cut?: "zero-byte" | "mid-line" | "line-end";
  /** With `cut`: how many bytes of the body arrived. */
  readonly bytes?: number;
  /** Why a capture no server sent exists: the doc it was written from, or the capture it was sliced from (R39). */
  readonly synthetic?: string;
}

export interface InfluxManifest {
  readonly versions: readonly {
    readonly version: InfluxFixtureVersion;
    readonly image: string;
    readonly capturedAt: string;
  }[];
}

export function loadInfluxCapture(version: InfluxFixtureVersion, name: string): InfluxCapture {
  const file = `${name}.json`;
  const loaded = JSON.parse(readFileSync(join(INFLUX_FIXTURES_DIR, version, file), "utf8")) as InfluxCapture;
  if (loaded.version !== version || loaded.name !== name) {
    throw new Error(`${file} holds ${loaded.version}/${loaded.name}, not ${version}/${name}`);
  }
  return loaded;
}

/** Every capture of the differential corpus (capture 8) of one line, sorted by name. */
export function loadDifferentialCorpus(version: InfluxFixtureVersion): readonly InfluxCapture[] {
  return readdirSync(join(INFLUX_FIXTURES_DIR, version, "differential"))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => loadInfluxCapture(version, `differential/${file.slice(0, -".json".length)}`));
}

/** tests/fixtures/influxdb/manifest.json: the tested lines and digests the provider docs name. */
export function loadInfluxManifest(): InfluxManifest {
  return JSON.parse(readFileSync(join(INFLUX_FIXTURES_DIR, "manifest.json"), "utf8")) as InfluxManifest;
}
