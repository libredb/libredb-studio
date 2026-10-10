/**
 * Format detection of the S3 preview. Browser-safe and pure. Detection runs from the head and
 * the key before any GET; the first bytes read may confirm or overturn it; Content-Type is a hint only, consulted for
 * an object no extension placed, and never selects Parquet.
 */
import type { S3PreviewFormat } from "./preview";

export type EncodingLayer =
  | { readonly kind: "none" }
  | { readonly kind: "gzip" }
  | { readonly kind: "other"; readonly coding: string };

const PLAIN_CODING = /^[A-Za-z0-9._+-]{1,40}$/;

/** Step 2: the stored Content-Encoding as at most one layer the preview decodes. */
export function encodingLayer(contentEncoding: string | undefined): EncodingLayer {
  const raw = contentEncoding?.trim() ?? "";
  const value = raw.toLowerCase();
  if (value === "" || value === "identity") return { kind: "none" };
  if (value === "gzip" || value === "x-gzip") return { kind: "gzip" };
  return { kind: "other", coding: PLAIN_CODING.test(raw) ? raw : "of an unrecognised form" };
}

const EXTENSIONS: ReadonlyMap<string, S3PreviewFormat> = new Map([
  ["parquet", "parquet"],
  ["parq", "parquet"],
  ["pq", "parquet"],
  ["json", "json"],
  ["ndjson", "ndjson"],
  ["jsonl", "ndjson"],
  ["ldjson", "ndjson"],
  ["csv", "csv"],
  ["tsv", "tsv"],
  ["tab", "tsv"],
]);

/** Step 3: the format the key's last segment names; `.gz` or `.gzip` marks one layer and names the inner format. */
export function extensionOf(key: string): { readonly gzip: boolean; readonly format?: S3PreviewFormat } {
  const segment = key.slice(key.lastIndexOf("/") + 1);
  const dot = segment.lastIndexOf(".");
  if (dot < 0) return { gzip: false };
  const extension = segment.slice(dot + 1).toLowerCase();
  if (extension === "gz" || extension === "gzip")
    return { gzip: true, format: extensionOf(segment.slice(0, dot)).format };
  return { gzip: false, format: EXTENSIONS.get(extension) };
}

/** Step 4: `1f 8b` starts a gzip layer; `PAR1` at offset 0 sends the object down the Parquet path. */
export function sniffMagic(bytes: Uint8Array): "gzip" | "parquet" | undefined {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  if (bytes[0] === 0x50 && bytes[1] === 0x41 && bytes[2] === 0x52 && bytes[3] === 0x31) return "parquet";
  return undefined;
}

const MEDIA_TYPES: ReadonlyMap<string, "json" | "ndjson" | "csv" | "tsv"> = new Map([
  ["application/json", "json"],
  ["application/x-ndjson", "ndjson"],
  ["application/jsonl", "ndjson"],
  ["application/x-jsonlines", "ndjson"],
  ["text/csv", "csv"],
  ["text/tab-separated-values", "tsv"],
]);

/** Step 5: the Content-Type hint for printable bytes no extension placed. */
export function contentTypeHint(contentType: string | undefined): "text" | "json" | "ndjson" | "csv" | "tsv" {
  const media = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return MEDIA_TYPES.get(media) ?? "text";
}

/** Step 6's validity check: the value is discarded, so nothing is rounded or collapsed. */
export function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
