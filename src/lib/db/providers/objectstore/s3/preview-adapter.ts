/**
 * The one seam between the provider's client and the preview's ports: the HEAD's answer as `S3ObjectHead`, and an
 * `S3RangeReader` over the limited client, one `getObjectRange` per read, one permit each, every read of one preview
 * under the call's one deadline.
 *
 * The preview's own per-answer checks (ETag present and equal, total equal to the HEAD's size, start and length) run on
 * the answer this returns; the adapter does not repeat them. A failure that is not a 416 or an unplaceable answer
 * passes unchanged, and the caller maps it with the GetObject rows of errors.ts.
 */
import { QueryError } from "@/lib/db/errors";
import type { GetRangeRequest, ObjectHead, S3CallOptions, S3Client } from "./client";
import { S3_TYPE } from "./constants";
import type { S3ByteRange, S3ObjectHead, S3RangeAnswer, S3RangeReader } from "./preview";

export const S3_PREVIEW_ADAPTER_SENTENCES = Object.freeze({
  noHead: "The server sent no usable Content-Length or ETag for this object, so it cannot be previewed.",
  rangeNotSatisfiable:
    "The server answered 416 Range Not Satisfiable to a range inside the size its HEAD reported, so the object changed while it was previewed; preview it again.",
  noContentRange:
    "The server answered a ranged read without a usable Content-Range, so the preview cannot place the bytes it received.",
  noContentLength:
    "The server answered a read of the whole object without a usable Content-Length, so the preview cannot tell the object's size.",
});

const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/;

/**
 * The HEAD's answer as the preview's S3ObjectHead, or the refusal sentence
 * "The server sent no usable Content-Length or ETag for this object, so it cannot be previewed."
 * when head.size or head.etag is null. Re-adds the quotes the core removed from the ETag: etag is `"${head.etag}"`.
 * contentType and contentEncoding are absent when null.
 */
export function toPreviewHead(head: ObjectHead, bucket: string, key: string): S3ObjectHead | string {
  if (head.size === null || head.etag === null) return S3_PREVIEW_ADAPTER_SENTENCES.noHead;
  return {
    bucket,
    key,
    size: head.size,
    etag: `"${head.etag}"`,
    ...(head.contentType === null ? {} : { contentType: head.contentType }),
    ...(head.contentEncoding === null ? {} : { contentEncoding: head.contentEncoding }),
  };
}

function atLeastOneByte(length: number, kind: S3ByteRange["kind"]): void {
  if (!(length >= 1))
    throw new Error(`A preview "${kind}" range must hold at least 1 byte; this is a defect in the preview`);
}

/** The preview's range (end exclusive) as the client's single range (last inclusive). */
function clientRange(range: S3ByteRange): NonNullable<GetRangeRequest["range"]> {
  switch (range.kind) {
    case "first":
      atLeastOneByte(range.length, range.kind);
      return { first: 0, last: range.length - 1 };
    case "suffix":
      atLeastOneByte(range.length, range.kind);
      return { suffix: range.length };
    case "span":
      atLeastOneByte(range.end - range.start, range.kind);
      return { first: range.start, last: range.end - 1 };
  }
}

function placed(
  status: 200 | 206,
  contentRange: string | null,
  contentLength: number | null,
): { start: number; total: number } {
  if (status === 206) {
    const match = contentRange === null ? null : CONTENT_RANGE.exec(contentRange);
    if (match === null || match[3] === "*") throw new QueryError(S3_PREVIEW_ADAPTER_SENTENCES.noContentRange, S3_TYPE);
    return { start: Number(match[1]), total: Number(match[3]) };
  }
  if (contentLength === null) throw new QueryError(S3_PREVIEW_ADAPTER_SENTENCES.noContentLength, S3_TYPE);
  return { start: 0, total: contentLength };
}

/** The preview's S3RangeReader over the limited client: one getObjectRange per read, one permit each. */
export function rangeReader(client: S3Client, bucket: string, key: string, call: S3CallOptions): S3RangeReader {
  return {
    async read(range: S3ByteRange, maxBytes: number, signal: AbortSignal): Promise<S3RangeAnswer> {
      const answer = await client.getObjectRange(
        { bucket, key, range: clientRange(range), maxBytes, truncateAt: maxBytes },
        { signal: AbortSignal.any([call.signal, signal]), deadline: call.deadline },
      );
      if (answer.status === 416) throw new QueryError(S3_PREVIEW_ADAPTER_SENTENCES.rangeNotSatisfiable, S3_TYPE);
      const { start, total } = placed(answer.status, answer.contentRange, answer.contentLength);
      return {
        bytes: new Uint8Array(answer.bytes.buffer, answer.bytes.byteOffset, answer.bytes.byteLength),
        start,
        total,
        ...(answer.etag === null ? {} : { etag: `"${answer.etag}"` }),
      };
    },
  };
}
