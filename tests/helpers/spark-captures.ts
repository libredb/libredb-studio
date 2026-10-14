/**
 * Reads the Spark captures of tests/fixtures/spark/ by version and name: the decoder, error, run and explain unit
 * tests read them directly, and the integration replay through tests/helpers/spark-fixtures.ts. A capture is decoded JSON: a `$captured`
 * header, an outcome, and the answer with every bytes field as {"$bytes": "<base64>"}. No bun:test and no Bun global.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SparkCaptureName } from "../live/spark-evidence-plan";
import type { SparkLiveService } from "./spark-live";

export type SparkCaptureVersion = "4.2.0" | "4.1.3";

export interface SparkCaptureHeader {
  readonly service: SparkLiveService;
  readonly image: string;
  readonly digest: string;
  readonly sparkVersion: string;
  readonly date: string;
  readonly runtime: string;
  readonly rpc: string;
  readonly surface: string;
  readonly request: Readonly<Record<string, unknown>>;
}

export type SparkCapture =
  | { readonly $captured: SparkCaptureHeader; readonly outcome: "pass"; readonly payload: unknown }
  | {
      readonly $captured: SparkCaptureHeader;
      readonly outcome: "error";
      readonly code: number;
      readonly details: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    };

const FIXTURES = fileURLToPath(new URL("../fixtures/spark/", import.meta.url));

export function readSparkCapture(version: SparkCaptureVersion, name: SparkCaptureName): SparkCapture {
  const relative = `tests/fixtures/spark/${version}/${name}.json`;
  const file = `${FIXTURES}${version}/${name}.json`;
  if (!existsSync(file)) {
    throw new Error(`${relative} is missing: capture it with bun tests/live/spark-evidence.ts --capture <service>`);
  }
  const capture = JSON.parse(readFileSync(file, "utf8")) as Partial<SparkCapture>;
  if (typeof capture.$captured !== "object" || (capture.outcome !== "pass" && capture.outcome !== "error")) {
    throw new Error(`${relative} is not a capture: it needs a $captured header and an outcome of pass or error`);
  }
  return capture as SparkCapture;
}

/** The bytes a capture writes as {"$bytes": "<base64>"}. */
export function captureBytes(value: unknown): Uint8Array {
  const encoded = (value as { readonly $bytes?: unknown } | null)?.$bytes;
  if (typeof value !== "object" || value === null || typeof encoded !== "string" || Object.keys(value).length !== 1) {
    throw new Error('captureBytes reads a {"$bytes": "<base64>"} value only');
  }
  return new Uint8Array(Buffer.from(encoded, "base64"));
}
