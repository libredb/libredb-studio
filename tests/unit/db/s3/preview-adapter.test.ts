/**
 * The one adapter between the client and the preview's ports: the
 * HEAD as `S3ObjectHead` with its ETag quoted again, and a range reader that maps the preview's ranges onto one ranged
 * GET each, passes the cap as both `maxBytes` and `truncateAt`, turns a 416 into a QueryError, and places the
 * bytes from Content-Range or Content-Length.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  createS3Client,
  type GetRangeRequest,
  limitedS3Client,
  type ObjectHead,
  type S3Client,
} from "@/lib/db/providers/objectstore/s3/client";
import { S3_SMALL_RESPONSE_BYTES } from "@/lib/db/providers/objectstore/s3/constants";
import {
  rangeReader,
  S3_PREVIEW_ADAPTER_SENTENCES as S,
  toPreviewHead,
} from "@/lib/db/providers/objectstore/s3/preview-adapter";
import type { LimiterTicket, ProviderLimiter } from "@/lib/db/utils/bounded-limiter";
import { type FakeS3Handler, fakeS3Transport, TEST_TRANSPORT_OPTIONS } from "../../../helpers/s3-fake-transport";

const HEAD: ObjectHead = {
  size: 52,
  etag: "76e272a85b3037c386e8293a9b191c8c",
  partsFromEtag: null,
  lastModified: null,
  contentType: "text/csv",
  contentEncoding: null,
  storageClass: null,
  versionId: null,
  deleteMarker: false,
  taggingCount: null,
  serverSideEncryption: null,
  restore: null,
  archiveStatus: null,
  userMetadata: {},
  missingMetadata: null,
  headersCut: false,
};
const CALL = { signal: new AbortController().signal, deadline: Date.now() + 60_000 };
const NEVER = new AbortController().signal;

function readerOver(handler: FakeS3Handler, limiter?: ProviderLimiter) {
  const fake = fakeS3Transport(handler);
  const raw = createS3Client(fake.createTransport(TEST_TRANSPORT_OPTIONS));
  const requests: GetRangeRequest[] = [];
  const recorded: S3Client = {
    ...raw,
    getObjectRange(request, call) {
      requests.push(request);
      return raw.getObjectRange(request, call);
    },
  };
  const client = limiter === undefined ? recorded : limitedS3Client(recorded, limiter);
  return { reader: rangeReader(client, "sales", "a.csv", CALL), fake, requests };
}

describe("toPreviewHead", () => {
  test("a full head: the ETag quoted again, the size, the stored type", () => {
    expect(toPreviewHead(HEAD, "sales", "a.csv")).toEqual({
      bucket: "sales",
      key: "a.csv",
      size: 52,
      etag: '"76e272a85b3037c386e8293a9b191c8c"',
      contentType: "text/csv",
    });
  });

  test("null content type and encoding are absent; a stored encoding is passed", () => {
    expect(toPreviewHead({ ...HEAD, contentType: null, contentEncoding: "gzip" }, "b", "k")).toEqual({
      bucket: "b",
      key: "k",
      size: 52,
      etag: '"76e272a85b3037c386e8293a9b191c8c"',
      contentEncoding: "gzip",
    });
  });

  test("a null size or ETag is the refusal sentence", () => {
    expect(toPreviewHead({ ...HEAD, size: null }, "b", "k")).toBe(
      "The server sent no usable Content-Length or ETag for this object, so it cannot be previewed.",
    );
    expect(toPreviewHead({ ...HEAD, etag: null }, "b", "k")).toBe(S.noHead);
  });
});

describe("rangeReader", () => {
  test("first, suffix and span map to the client's ranges, the span's end exclusive, the cap twice", async () => {
    const { reader, fake, requests } = readerOver(() => ({
      status: 206,
      body: "ab",
      headers: [
        ["content-range", "bytes 10-11/52"],
        ["etag", '"e"'],
      ],
    }));
    await reader.read({ kind: "first", length: 2 }, 2, NEVER);
    await reader.read({ kind: "suffix", length: 2 }, 2, NEVER);
    await reader.read({ kind: "span", start: 10, end: 12 }, 2, NEVER);
    expect(fake.exchanges.map((exchange) => exchange.request.headers?.range)).toEqual([
      "bytes=0-1",
      "bytes=-2",
      "bytes=10-11",
    ]);
    expect(requests[0]).toMatchObject({ bucket: "sales", key: "a.csv", maxBytes: 2, truncateAt: 2 });
    // The client reads at least its small-response bound so an error body arrives whole, and cuts data answers itself.
    expect(fake.exchanges[0].request).toMatchObject({
      maxResponseBytes: S3_SMALL_RESPONSE_BYTES,
      truncateAt: S3_SMALL_RESPONSE_BYTES,
    });
  });

  test.each([
    [{ kind: "first", length: 0 } as const],
    [{ kind: "suffix", length: 0 } as const],
    [{ kind: "span", start: 5, end: 5 } as const],
  ])("a range below 1 byte is a plain Error, never sent", async (range) => {
    const { reader, fake } = readerOver(() => ({ status: 206 }));
    const error = await reader.read(range, 10, NEVER).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(QueryError);
    expect(fake.exchanges).toHaveLength(0);
  });

  test("a 206 places the bytes from Content-Range, and the answer's ETag is quoted by the head's rule", async () => {
    const { reader } = readerOver(() => ({
      status: 206,
      body: "ab",
      headers: [
        ["content-range", "bytes 10-11/52"],
        ["etag", '"e"'],
      ],
    }));
    const answer = await reader.read({ kind: "span", start: 10, end: 12 }, 2, NEVER);
    expect(answer).toEqual({ bytes: new Uint8Array([0x61, 0x62]), start: 10, total: 52, etag: '"e"' });
    expect(answer.bytes).toBeInstanceOf(Uint8Array);
  });

  test("a 200 places the bytes at 0 with the total from Content-Length; no ETag is absent", async () => {
    const { reader } = readerOver(() => ({ status: 200, body: "abcdef", headers: [["content-length", "52"]] }));
    expect(await reader.read({ kind: "first", length: 4 }, 4, NEVER)).toEqual({
      bytes: new Uint8Array([0x61, 0x62, 0x63, 0x64]),
      start: 0,
      total: 52,
    });
  });

  test.each([
    [
      { status: 416 },
      "The server answered 416 Range Not Satisfiable to a range inside the size its HEAD reported, so the object changed while it was previewed; preview it again.",
    ],
    [
      { status: 206, body: "ab", headers: [["content-range", "bytes 0-1/*"]] as const },
      "The server answered a ranged read without a usable Content-Range, so the preview cannot place the bytes it received.",
    ],
    [{ status: 206, body: "ab" }, S.noContentRange],
    [
      { status: 200, body: "ab" },
      "The server answered a read of the whole object without a usable Content-Length, so the preview cannot tell the object's size.",
    ],
  ])("%p is a QueryError", async (answer, sentence) => {
    const { reader } = readerOver(() => answer);
    const error = await reader.read({ kind: "first", length: 2 }, 2, NEVER).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(sentence);
  });

  test("an aborted reader signal aborts the request", async () => {
    const { reader } = readerOver(() => new Promise<never>(() => {}));
    const controller = new AbortController();
    const pending = reader.read({ kind: "first", length: 2 }, 2, controller.signal).catch((caught: unknown) => caught);
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe("aborted");
  });

  test("each read takes its own permit", async () => {
    let granted = 0;
    const limiter: ProviderLimiter = {
      async acquire(): Promise<LimiterTicket> {
        granted += 1;
        return { release() {} };
      },
    };
    const { reader } = readerOver(
      () => ({ status: 206, body: "a", headers: [["content-range", "bytes 0-0/52"]] }),
      limiter,
    );
    await reader.read({ kind: "first", length: 1 }, 1, NEVER);
    await reader.read({ kind: "first", length: 1 }, 1, NEVER);
    expect(granted).toBe(2);
  });
});
