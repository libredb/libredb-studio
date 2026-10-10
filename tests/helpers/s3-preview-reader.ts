/**
 * A fake S3RangeReader for the preview's unit tests: it serves an object's bytes by range, records every call, and
 * can answer like a server that ignores Range (a 200 from offset 0) or let a case rewrite an answer. The real reader is
 * the provider's rangeReader over the byte transport; this one never opens a socket.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  S3ByteRange,
  S3ObjectHead,
  S3RangeAnswer,
  S3RangeReader,
} from "@/lib/db/providers/objectstore/s3/preview";

export const PREVIEW_FIXTURES = path.join(import.meta.dir, "..", "fixtures", "s3", "preview");

/** A committed fixture's bytes. */
export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(PREVIEW_FIXTURES, name)));
}

/** The HEAD a preview of `object` starts from: bucket `studio-demo`, ETag `"fixture"`. */
export function headOf(object: Uint8Array, key: string, changes: Partial<S3ObjectHead> = {}): S3ObjectHead {
  return { bucket: "studio-demo", key, size: object.length, etag: '"fixture"', ...changes };
}

export interface FakeReader extends S3RangeReader {
  readonly calls: { readonly range: S3ByteRange; readonly maxBytes: number }[];
}

export function fakeReader(
  object: Uint8Array,
  options: {
    readonly etag?: string;
    readonly ignoreRange?: boolean;
    readonly override?: (call: number, answer: S3RangeAnswer) => S3RangeAnswer;
  } = {},
): FakeReader {
  const calls: { range: S3ByteRange; maxBytes: number }[] = [];
  return {
    calls,
    async read(range, maxBytes, signal) {
      signal.throwIfAborted();
      calls.push({ range, maxBytes });
      const size = object.length;
      let start = 0;
      let end = size;
      if (!options.ignoreRange) {
        if (range.kind === "first") end = Math.min(range.length, size);
        else if (range.kind === "suffix") start = Math.max(0, size - range.length);
        else {
          start = range.start;
          end = Math.min(range.end, size);
        }
      }
      const answer: S3RangeAnswer = {
        bytes: object.slice(start, Math.min(end, start + maxBytes)),
        start,
        total: size,
        etag: options.etag ?? '"fixture"',
      };
      return options.override === undefined ? answer : options.override(calls.length - 1, answer);
    },
  };
}
