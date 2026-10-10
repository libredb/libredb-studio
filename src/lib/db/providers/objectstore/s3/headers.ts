/**
 * The response headers the S3 provider asks PR 1's byte transport for, and the reader of an object HEAD.
 *
 * `content-type` and `content-encoding` are not in the selection: `NodeByteResponse` carries them as fields.
 * `x-amz-request-id` and `x-request-id` are read only to print in an unclassified failure. The transport hands values
 * as the runtime decoded them, latin1, so a UTF-8 metadata value arrives as mojibake; it is re-decoded here only when
 * that decoding is valid UTF-8, else kept as received.
 *
 * Browser-safe: no Node built-in, no server module and no `Buffer`.
 */
import type { NodeByteResponse, ResponseHeader, ResponseHeaderSelection } from "@/lib/db/http/node-transport";
import type { ObjectHead } from "./client";
import { unquotedEtag } from "./shapes";

export const S3_RESPONSE_HEADERS: ResponseHeaderSelection = Object.freeze({
  names: Object.freeze([
    "content-length",
    "content-range",
    "etag",
    "last-modified",
    "date",
    "accept-ranges",
    "x-amz-version-id",
    "x-amz-delete-marker",
    "x-amz-tagging-count",
    "x-amz-storage-class",
    "x-amz-bucket-region",
    "x-amz-mp-parts-count",
    "x-amz-restore",
    "x-amz-archive-status",
    "x-amz-server-side-encryption",
    "x-amz-missing-meta",
    "x-amz-request-id",
    "x-minio-error-code",
    "x-request-id",
  ]),
  prefixes: Object.freeze(["x-amz-meta-"]),
});

const META_PREFIX = "x-amz-meta-";
const MULTIPART_ETAG = /^"?[0-9a-fA-F]{32}-(\d+)"?$/;
const DIGITS = /^\d+$/;

/** The first value of a selected header, or undefined. */
export function firstHeader(headers: readonly ResponseHeader[], name: string): string | undefined {
  return headers.find(([candidate]) => candidate === name)?.[1];
}

/** A non-negative safe integer, else null. */
export function headerCount(value: string | undefined): number | null {
  if (value === undefined || !DIGITS.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}

/** The latin1 text re-read as UTF-8 when its bytes are valid UTF-8, else the text as received. */
function redecoded(value: string): string {
  const bytes = new Uint8Array(value.length);
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at);
    if (code > 0xff) return value;
    bytes[at] = code;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return value;
  }
}

export function readObjectHead(
  response: Pick<NodeByteResponse, "headers" | "contentType" | "contentEncoding" | "headersTruncated">,
): ObjectHead {
  const header = (name: string) => firstHeader(response.headers, name);
  const etag = header("etag");
  const parts = etag === undefined ? null : MULTIPART_ETAG.exec(etag);
  const lastModified = header("last-modified");
  const modifiedAt = lastModified === undefined ? Number.NaN : Date.parse(lastModified);
  const versionId = header("x-amz-version-id");
  const metadata = new Map<string, string[]>();
  for (const [name, value] of response.headers) {
    if (!name.startsWith(META_PREFIX)) continue;
    const key = name.slice(META_PREFIX.length);
    metadata.set(key, [...(metadata.get(key) ?? []), redecoded(value)]);
  }
  return {
    size: headerCount(header("content-length")),
    etag: etag === undefined ? null : unquotedEtag(etag),
    partsFromEtag: parts === null ? null : Number(parts[1]),
    lastModified:
      lastModified === undefined
        ? null
        : Number.isFinite(modifiedAt)
          ? new Date(modifiedAt).toISOString()
          : lastModified,
    contentType: response.contentType,
    contentEncoding: response.contentEncoding,
    storageClass: header("x-amz-storage-class") ?? null,
    versionId: versionId === undefined || versionId === "null" ? null : versionId,
    deleteMarker: header("x-amz-delete-marker") === "true",
    taggingCount: headerCount(header("x-amz-tagging-count")),
    serverSideEncryption: header("x-amz-server-side-encryption") ?? null,
    restore: header("x-amz-restore") ?? null,
    archiveStatus: header("x-amz-archive-status") ?? null,
    userMetadata: Object.fromEntries(metadata),
    missingMetadata: headerCount(header("x-amz-missing-meta")),
    headersCut: response.headersTruncated,
  };
}
