/**
 * The operation client over a recording fake transport: each operation's method, target and
 * cap; ListBuckets' sort, de-duplication and truncation; ListObjectsV2's page checks; the one HEAD follow-up inside
 * the same permit; caps; compressed and non-S3 answers; GetObject's statuses as data; and nothing ambient on an
 * unsigned client.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { QueryCancelledError, QueryError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  createS3Client,
  limitedS3Client,
  type S3CallOptions,
  type S3Client,
  type S3Operation,
} from "@/lib/db/providers/objectstore/s3/client";
import { S3ServerError, toProviderError } from "@/lib/db/providers/objectstore/s3/errors";
import { engineLimiter, type LimiterTicket, type ProviderLimiter } from "@/lib/db/utils/bounded-limiter";
import {
  bucketsXml,
  errorXml,
  type FakeS3Handler,
  fakeS3Transport,
  objectsXml,
  TEST_TRANSPORT_OPTIONS,
  xmlAnswer,
} from "../../../helpers/s3-fake-transport";

const CALL = { signal: new AbortController().signal, deadline: Date.now() + 60_000 };
const CONTEXT = {
  region: "us-east-1",
  signs: false,
  clock: () => new Date(),
  secretForms: [],
  endpointText: "http://localhost:9000",
};

function clientOf(handler: FakeS3Handler) {
  const fake = fakeS3Transport(handler);
  return { client: createS3Client(fake.createTransport(TEST_TRANSPORT_OPTIONS)), fake };
}

async function failure(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => {
      throw new Error("expected a failure");
    },
    (error: unknown) => error,
  );
}

/** A limiter that grants at once and counts what it granted. */
function countingLimiter(): ProviderLimiter & { granted: number } {
  const limiter = {
    granted: 0,
    async acquire(): Promise<LimiterTicket> {
      limiter.granted += 1;
      return { release() {} };
    },
  };
  return limiter;
}

const ANY: FakeS3Handler = (request) => {
  const { path, query } = request.target;
  if (request.method === "HEAD")
    return {
      status: 200,
      headers: [
        ["content-length", "3"],
        ["etag", '"abc"'],
      ],
    };
  if (path === "/") return xmlAnswer(bucketsXml(["sales"]));
  // One key under the prefix sent, so a level page stays inside its level.
  if (query.includes("list-type=2"))
    return xmlAnswer(objectsXml({ keys: [`${new URLSearchParams(query).get("prefix") ?? ""}a.csv`] }));
  if (query === "location=") return xmlAnswer("<LocationConstraint/>");
  if (query === "versioning=") return xmlAnswer("<VersioningConfiguration/>");
  if (query.includes("versions="))
    return xmlAnswer("<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>");
  if (query === "tagging=") return xmlAnswer("<Tagging><TagSet/></Tagging>");
  return { status: 206, body: "abc", headers: [["content-range", "bytes 0-2/3"]] };
};

describe("each operation's method, target and cap", () => {
  test.each([
    ["listBuckets", (c: S3Client) => c.listBuckets(CALL), "GET /?max-buckets=10000", 4 * 1024 * 1024],
    ["headBucket", (c: S3Client) => c.headBucket("sales", CALL), "HEAD /sales", 1],
    ["getBucketLocation", (c: S3Client) => c.getBucketLocation("sales", CALL), "GET /sales?location=", 65_536],
    ["getBucketVersioning", (c: S3Client) => c.getBucketVersioning("sales", CALL), "GET /sales?versioning=", 65_536],
    [
      "listObjectsV2",
      (c: S3Client) =>
        c.listObjectsV2(
          { bucket: "sales", prefix: "2026/", delimiter: "/", maxKeys: 2, continuationToken: "t+1" },
          CALL,
        ),
      "GET /sales?continuation-token=t%2B1&delimiter=%2F&encoding-type=url&list-type=2&max-keys=2&prefix=2026%2F",
      8 * 1024 * 1024,
    ],
    [
      "listObjectVersions",
      (c: S3Client) => c.listObjectVersions({ bucket: "sales", prefix: "", maxKeys: 1000 }, CALL),
      "GET /sales?encoding-type=url&max-keys=1000&prefix=&versions=",
      8 * 1024 * 1024,
    ],
    ["headObject", (c: S3Client) => c.headObject("sales", "a b.csv", CALL), "HEAD /sales/a%20b.csv", 1],
    [
      "getObjectTagging",
      (c: S3Client) => c.getObjectTagging("sales", "a.csv", CALL),
      "GET /sales/a.csv?tagging=",
      65_536,
    ],
  ])("%s", async (_name, run, line, cap) => {
    const { client, fake } = clientOf(ANY);
    await run(client);
    expect(fake.lines()).toEqual([line]);
    expect(fake.exchanges[0].request.maxResponseBytes).toBe(cap);
    expect(fake.exchanges[0].request.headers).toBeUndefined();
  });

  test("GetObject sends one range and the caller's caps", async () => {
    const { client, fake } = clientOf(ANY);
    await client.getObjectRange(
      { bucket: "sales", key: "a.csv", range: { first: 0, last: 9 }, maxBytes: 100, truncateAt: 100 },
      CALL,
    );
    await client.getObjectRange({ bucket: "sales", key: "a.csv", range: { suffix: 8 }, maxBytes: 100 }, CALL);
    await client.getObjectRange({ bucket: "sales", key: "a.csv", range: { first: 5 }, maxBytes: 100 }, CALL);
    await client.getObjectRange({ bucket: "sales", key: "a.csv", maxBytes: 100 }, CALL);
    expect(fake.lines()).toEqual(Array(4).fill("GET /sales/a.csv"));
    expect(fake.exchanges.map((exchange) => exchange.request.headers)).toEqual([
      { range: "bytes=0-9" },
      { range: "bytes=-8" },
      { range: "bytes=5-" },
      undefined,
    ]);
    expect(fake.exchanges[0].request).toMatchObject({ maxResponseBytes: 65_536, truncateAt: 65_536 });
    expect(fake.exchanges[1].request).toMatchObject({ maxResponseBytes: 65_536 });
    expect(fake.exchanges[1].request.truncateAt).toBeUndefined();
  });

  test("the client exposes only its read operations, and close closes the transport", () => {
    const { client, fake } = clientOf(ANY);
    expect(Object.keys(client).sort()).toEqual([
      "close",
      "getBucketLocation",
      "getBucketVersioning",
      "getObjectRange",
      "getObjectTagging",
      "headBucket",
      "headObject",
      "listBuckets",
      "listObjectVersions",
      "listObjectsV2",
    ]);
    client.close();
    expect(fake.closed.count).toBe(1);
  });
});

describe("ListBuckets", () => {
  test("de-duplicates, sorts by UTF-8 byte order, keeps names holding a slash apart and notes an unfollowed token", async () => {
    const names = ["zeta", "alpha", "Alpha", "zeta", "a/b", "\u{1F600}", "\uFF5E"];
    const { client, fake } = clientOf(() => xmlAnswer(bucketsXml(names, { continuationToken: "next" })));
    const listing = await client.listBuckets(CALL);
    expect(listing.buckets.map((bucket) => bucket.name)).toEqual(["Alpha", "alpha", "zeta", "\uFF5E", "\u{1F600}"]);
    expect(listing.invalidNames).toEqual(["a/b"]);
    expect(listing.truncated).toBe(true);
    expect(listing.buckets[0].created).toBe("2026-10-09T13:13:17.442Z");
    expect(fake.exchanges).toHaveLength(1);
  });

  test("an answer over 4 MiB is E4's ListBuckets sentence; one over 100,000 elements is E19's", async () => {
    const big = clientOf(() => xmlAnswer(bucketsXml(["b".repeat(63)]).padEnd(4 * 1024 * 1024 + 1, " ")));
    const tooLarge = toProviderError(await failure(big.client.listBuckets(CALL)), "ListBuckets", CONTEXT) as Error;
    expect(tooLarge.message).toBe(
      "The server's list of buckets passed 4 MiB, the most Studio reads for it: set Bucket on the connection to read one bucket without listing them.",
    );
    const many = clientOf(() => xmlAnswer(bucketsXml(Array.from({ length: 33_334 }, (_, at) => `b${at}`))));
    const tooMany = toProviderError(await failure(many.client.listBuckets(CALL)), "ListBuckets", CONTEXT) as Error;
    expect(tooMany.message).toBe(
      "The server's list of buckets passed 100,000 XML elements, the most Studio reads for it: set Bucket on the connection to read one bucket without listing them.",
    );
  });
});

describe("ListObjectsV2's page checks", () => {
  const list = (client: S3Client, maxKeys = 2, continuationToken?: string) =>
    client.listObjectsV2(
      {
        bucket: "sales",
        prefix: "",
        delimiter: "/",
        maxKeys,
        ...(continuationToken === undefined ? {} : { continuationToken }),
      },
      CALL,
    );

  test("more entries than asked for", async () => {
    const { client } = clientOf(() => xmlAnswer(objectsXml({ keys: ["a", "b"], prefixes: ["c/"] })));
    const error = (await failure(list(client))) as S3ServerError;
    expect(error.problem).toEqual({ kind: "page", what: "3 entries for a page of at most 2" });
  });

  test("a repeated folder", async () => {
    const { client } = clientOf(() => xmlAnswer(objectsXml({ prefixes: ["c/", "c/"] })));
    expect(((await failure(list(client))) as S3ServerError).problem).toEqual({
      kind: "page",
      what: 'the folder "c/" twice',
    });
  });

  const listUnder = (client: S3Client, prefix: string, delimiter?: "/") =>
    client.listObjectsV2(
      { bucket: "sales", prefix, maxKeys: 10, ...(delimiter === undefined ? {} : { delimiter }) },
      CALL,
    );

  test("a level page holds no repeated key, no key below its level, and no folder outside it", async () => {
    const cases: [string, Parameters<typeof objectsXml>[0], string][] = [
      ["b/", { keys: ["b/a.txt", "b/a.txt"] }, 'the key "b/a.txt" twice'],
      ["b/", { keys: ["b/deep/x.txt"] }, 'the key "b/deep/x.txt" outside the level asked for'],
      ["b/", { keys: ["c/x.txt"] }, 'the key "c/x.txt" outside the level asked for'],
      ["b/a", { prefixes: ["q/r/"] }, 'the folder "q/r/" outside the level asked for'],
      ["b/a", { prefixes: ["b/ab/c/"] }, 'the folder "b/ab/c/" outside the level asked for'],
      ["b/a", { prefixes: ["b/ab"] }, 'the folder "b/ab" outside the level asked for'],
    ];
    for (const [prefix, answer, what] of cases) {
      const { client } = clientOf(() => xmlAnswer(objectsXml(answer)));
      // oxlint-disable-next-line no-await-in-loop -- each answer is checked on its own, one after another.
      expect(((await failure(listUnder(client, prefix, "/"))) as S3ServerError).problem).toEqual({
        kind: "page",
        what,
      });
    }
  });

  test("a level page keeps its folder marker and folders one level down", async () => {
    const { client } = clientOf(() => xmlAnswer(objectsXml({ keys: ["b/", "b/a.txt"], prefixes: ["b/sub/"] })));
    expect(await listUnder(client, "b/", "/")).toMatchObject({ prefixes: ["b/sub/"] });
  });

  test("a walk with no delimiter holds keys at any depth", async () => {
    const { client } = clientOf(() => xmlAnswer(objectsXml({ keys: ["b/a.txt", "b/deep/x.txt"] })));
    expect((await listUnder(client, "b/")).keys.map((entry) => entry.key)).toEqual(["b/a.txt", "b/deep/x.txt"]);
  });

  test("a truncated page with no token", async () => {
    const { client } = clientOf(() => xmlAnswer(objectsXml({ keys: ["a"], truncated: true })));
    expect(((await failure(list(client))) as S3ServerError).problem).toEqual({
      kind: "page",
      what: "a truncated page and no continuation token",
    });
  });

  test("a token over 4,096 characters is E22", async () => {
    const { client } = clientOf(() =>
      xmlAnswer(objectsXml({ keys: ["a"], truncated: true, token: "t".repeat(4_097) })),
    );
    expect(((await failure(list(client))) as S3ServerError).problem).toEqual({ kind: "token" });
  });

  test("a well-formed page with its token, and the request names it sent", async () => {
    const { client } = clientOf(() =>
      xmlAnswer(objectsXml({ keys: ["a"], prefixes: ["b/"], truncated: true, token: "next" })),
    );
    expect(await list(client)).toMatchObject({ prefixes: ["b/"], isTruncated: true, nextToken: "next" });
    const refused = clientOf(() => xmlAnswer(errorXml("InvalidArgument", "Invalid continuation token"), 400));
    const error = (await failure(list(refused.client, 2, "forged"))) as S3ServerError;
    expect(error).toMatchObject({
      operation: "ListObjectsV2",
      status: 400,
      code: "InvalidArgument",
      sentToken: true,
      bucket: "sales",
      prefix: "",
    });
  });

  test("maxKeys outside 1 to 1,000 is a defect, never sent", async () => {
    const { client, fake } = clientOf(ANY);
    await expect(list(client, 0)).rejects.toThrow("maxKeys must be a whole number from 1 to 1000");
    await expect(list(client, 1_001)).rejects.toThrow("maxKeys must be a whole number from 1 to 1000");
    expect(fake.exchanges).toHaveLength(0);
  });
});

describe("the HEAD follow-up", () => {
  test("a bucket HEAD error with no code: one ListObjectsV2 follow-up, its code classified, never a second HEAD", async () => {
    const { client, fake } = clientOf((request) =>
      request.method === "HEAD" ? { status: 403 } : xmlAnswer(errorXml("SignatureDoesNotMatch", "signature"), 403),
    );
    const error = (await failure(client.headBucket("sales", CALL))) as S3ServerError;
    expect(fake.lines()).toEqual(["HEAD /sales", "GET /sales?encoding-type=url&list-type=2&max-keys=1&prefix="]);
    expect(error).toMatchObject({
      operation: "HeadBucket",
      method: "HEAD",
      status: 403,
      code: "SignatureDoesNotMatch",
    });
  });

  test("an object follow-up carries truncateAt at its cap, so a 200 with a whole object classifies the HEAD's status", async () => {
    const { client, fake } = clientOf((request) =>
      request.method === "HEAD" ? { status: 404 } : { status: 200, body: "x".repeat(1024 * 1024) },
    );
    const error = (await failure(client.headObject("sales", "a.csv", CALL))) as S3ServerError;
    expect(fake.exchanges[1].request).toMatchObject({
      method: "GET",
      headers: { range: "bytes=0-0" },
      maxResponseBytes: 65_536,
      truncateAt: 65_536,
    });
    expect(error).toMatchObject({ operation: "HeadObject", status: 404 });
    expect(error.code).toBeUndefined();
    expect((toProviderError(error, "HeadObject", CONTEXT) as Error).message).toBe(
      'The server answered 404 Not Found for "a.csv" in bucket "sales": the object, or the bucket, does not exist.',
    );
  });

  test("an object HEAD 403 with no code: the follow-up 403's XML code gives that code's sentence", async () => {
    const { client, fake } = clientOf((request) =>
      request.method === "HEAD"
        ? { status: 403 }
        : xmlAnswer(errorXml("SignatureDoesNotMatch", "The request signature we calculated does not match"), 403),
    );
    const error = (await failure(client.headObject("sales", "a.csv", CALL))) as S3ServerError;
    expect(fake.lines()).toEqual(["HEAD /sales/a.csv", "GET /sales/a.csv"]);
    expect(error).toMatchObject({
      operation: "HeadObject",
      method: "HEAD",
      status: 403,
      code: "SignatureDoesNotMatch",
      bucket: "sales",
      key: "a.csv",
    });
    expect((toProviderError(error, "HeadObject", CONTEXT) as Error).message).toBe(
      "The server refused the request signature: check Secret access key. A proxy between Studio and the server that changes the Host header or the request path causes the same refusal.",
    );
  });

  test("a HEAD error carrying x-minio-error-code needs no follow-up", async () => {
    const { client, fake } = clientOf(() => ({
      status: 404,
      headers: [
        ["x-minio-error-code", "NoSuchKey"],
        ["x-amz-delete-marker", "true"],
      ],
    }));
    const error = (await failure(client.headObject("sales", "a.csv", CALL))) as S3ServerError;
    expect(fake.exchanges).toHaveLength(1);
    expect(error).toMatchObject({ code: "NoSuchKey", deleteMarker: true });
  });

  test("the follow-up runs inside the HEAD's one permit", async () => {
    const limiter = countingLimiter();
    const fake = fakeS3Transport((request) =>
      request.method === "HEAD"
        ? { status: 400 }
        : xmlAnswer(errorXml("AuthorizationHeaderMalformed", "scope", { region: "garage-probe" }), 400),
    );
    const client = limitedS3Client(createS3Client(fake.createTransport(TEST_TRANSPORT_OPTIONS)), limiter);
    await failure(client.headBucket("sales", CALL));
    expect(fake.exchanges).toHaveLength(2);
    expect(limiter.granted).toBe(1);
  });

  test("a follow-up the transport fails leaves the HEAD's status to be classified", async () => {
    const { client, fake } = clientOf((request) => {
      if (request.method === "HEAD") return { status: 403 };
      throw new TransportError("network", "The request failed (ECONNRESET)");
    });
    const error = (await failure(client.headBucket("sales", CALL))) as S3ServerError;
    expect(fake.exchanges).toHaveLength(2);
    expect(error).toBeInstanceOf(S3ServerError);
    expect(error).toMatchObject({ operation: "HeadBucket", method: "HEAD", status: 403, bucket: "sales" });
    expect(error.code).toBeUndefined();
  });

  test("a follow-up the call's deadline ended rejects with its own failure, noted with the request's names", async () => {
    const controller = new AbortController();
    const { client } = clientOf((request) => {
      if (request.method === "HEAD") return { status: 403 };
      controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
      return new Promise<never>(() => {});
    });
    const error = await failure(
      client.headObject("sales", "a.csv", { signal: controller.signal, deadline: Date.now() }),
    );
    expect(error).toBeInstanceOf(TransportError);
    expect((toProviderError(error, "HeadObject", CONTEXT, { timeoutMs: 10_000 }) as Error).message).toBe(
      'The S3 server at http://localhost:9000 did not answer read object "a.csv" in bucket "sales" within 10 seconds; nothing was retried.',
    );
  });
});

describe("answers that are not what was asked for", () => {
  test("a compressed listing is refused before any XML is read, even when it would parse", async () => {
    const { client } = clientOf(() => ({ ...xmlAnswer(objectsXml({ keys: ["a"] })), contentEncoding: "gzip" }));
    const error = (await failure(
      client.listObjectsV2({ bucket: "sales", prefix: "", maxKeys: 1 }, CALL),
    )) as S3ServerError;
    expect(error.problem).toEqual({ kind: "compressed", contentEncoding: "gzip" });
  });

  test("a 2xx that is not XML, and one that is another document", async () => {
    const html = clientOf(() => ({ status: 200, body: "<!doctype html><html></html>", contentType: "text/html" }));
    expect(((await failure(html.client.getBucketLocation("sales", CALL))) as S3ServerError).problem).toEqual({
      kind: "not-s3",
      xml: "markup",
    });
    const other = clientOf(() => xmlAnswer("<Other/>"));
    expect(((await failure(other.client.getBucketLocation("sales", CALL))) as S3ServerError).problem).toEqual({
      kind: "not-s3",
    });
  });

  test("an error status with an S3 error document gives its fields; with another body, the not-S3 problem", async () => {
    const s3 = clientOf(() => ({
      ...xmlAnswer(errorXml("AccessDenied", "Access Denied.", { region: "eu-central-1" }), 403),
      headers: [
        ["x-amz-bucket-region", "eu-central-1"],
        ["date", "Fri, 09 Oct 2026 13:14:43 GMT"],
        ["x-amz-request-id", "18DCDEC3B735E7CB"],
      ],
    }));
    expect(await failure(s3.client.getBucketVersioning("sales", CALL))).toMatchObject({
      operation: "GetBucketVersioning",
      status: 403,
      code: "AccessDenied",
      serverMessage: "Access Denied.",
      region: "eu-central-1",
      bucketRegion: "eu-central-1",
      serverDate: "Fri, 09 Oct 2026 13:14:43 GMT",
      requestId: "18DCDEC3B735E7CB",
      bucket: "sales",
    });
    const html = clientOf(() => ({ status: 502, body: "<html></html>" }));
    expect(((await failure(html.client.getBucketVersioning("sales", CALL))) as S3ServerError).problem).toEqual({
      kind: "not-s3",
    });
  });

  test("a compressed error body is E7b too", async () => {
    const { client } = clientOf(() => ({ ...xmlAnswer(errorXml("AccessDenied", "no"), 403), contentEncoding: "br" }));
    expect(((await failure(client.getObjectTagging("sales", "a.csv", CALL))) as S3ServerError).problem).toEqual({
      kind: "compressed",
      contentEncoding: "br",
    });
  });

  test("a transport failure keeps its instance, and the names of its request are noted", async () => {
    const network = new TransportError("network", "The request failed (ECONNRESET)");
    const { client } = clientOf(() => {
      throw network;
    });
    expect(await failure(client.listObjectsV2({ bucket: "sales", prefix: "p/", maxKeys: 1 }, CALL))).toBe(network);
    expect((toProviderError(network, "ListObjectsV2", CONTEXT) as Error).message).toBe(
      "Could not reach the S3 server at http://localhost:9000: The request failed (ECONNRESET)",
    );
  });

  test("a too-large answer to a named operation is worded with its names and its cap", async () => {
    const { client } = clientOf(() => xmlAnswer("<LocationConstraint/>".padEnd(65_537, " ")));
    const error = await failure(client.getBucketLocation("sales", CALL));
    expect(error).toBeInstanceOf(TransportError);
    expect((toProviderError(error, "GetBucketLocation", CONTEXT) as Error).message).toBe(
      'The server\'s answer to read the location of bucket "sales" passed 64 KiB, the most Studio reads for it, so it was dropped; narrow the prefix.',
    );
  });
});

const NO_SUCH_KEY_SENTENCE = 'The server has no object "a.parquet" in bucket "sales".';
const TOO_LARGE_SENTENCE =
  'The server\'s answer to read object "a.csv" in bucket "sales" passed 4 bytes, the most Studio reads for it, so it was dropped; narrow the prefix.';

describe("GetObject", () => {
  test("200, 206 and 416 are data, with the ETag unquoted and the length read", async () => {
    const answers = [
      {
        status: 200,
        body: "abc",
        headers: [
          ["etag", '"e1"'],
          ["content-length", "3"],
        ] as const,
      },
      {
        status: 206,
        body: "b",
        headers: [
          ["etag", '"e1"'],
          ["content-range", "bytes 1-1/3"],
          ["content-length", "1"],
        ] as const,
      },
      { status: 416, body: errorXml("InvalidRange", "range") },
    ];
    let at = 0;
    const { client } = clientOf(() => answers[at++]);
    const request = { bucket: "sales", key: "a.csv", range: { first: 1, last: 1 }, maxBytes: 1024 };
    expect(await client.getObjectRange(request, CALL)).toEqual({
      status: 200,
      bytes: Buffer.from("abc"),
      truncated: false,
      contentRange: null,
      contentType: null,
      contentEncoding: null,
      etag: "e1",
      contentLength: 3,
    });
    expect(await client.getObjectRange(request, CALL)).toMatchObject({
      status: 206,
      contentRange: "bytes 1-1/3",
      contentLength: 1,
    });
    expect(await client.getObjectRange(request, CALL)).toMatchObject({
      status: 416,
      bytes: Buffer.alloc(0),
      etag: null,
      contentLength: null,
    });
  });

  test("a stored Content-Encoding is reported, never decoded; another status is an error", async () => {
    const gz = clientOf(() => ({ status: 200, body: new Uint8Array([0x1f, 0x8b]), contentEncoding: "gzip" }));
    expect(await gz.client.getObjectRange({ bucket: "sales", key: "a.gz", maxBytes: 10 }, CALL)).toMatchObject({
      bytes: Buffer.from([0x1f, 0x8b]),
      contentEncoding: "gzip",
    });
    const missing = clientOf(() => xmlAnswer(errorXml("NoSuchKey", "gone"), 404));
    expect(
      await failure(missing.client.getObjectRange({ bucket: "sales", key: "a.csv", maxBytes: 1024 }, CALL)),
    ).toMatchObject({ code: "NoSuchKey", key: "a.csv" });
  });

  test.each([
    ["with truncateAt", 8],
    ["without truncateAt", undefined],
  ])("a small read %s answered with an S3 error document reads its code whole", async (_name, truncateAt) => {
    const { client } = clientOf(() => xmlAnswer(errorXml("NoSuchKey", "The specified key does not exist."), 404));
    const request = {
      bucket: "sales",
      key: "a.parquet",
      range: { suffix: 8 },
      maxBytes: 8,
      ...(truncateAt === undefined ? {} : { truncateAt }),
    };
    const error = (await failure(client.getObjectRange(request, CALL))) as S3ServerError;
    expect(error).toMatchObject({ operation: "GetObject", status: 404, code: "NoSuchKey", key: "a.parquet" });
    expect((toProviderError(error, "GetObject", CONTEXT) as Error).message).toBe(NO_SUCH_KEY_SENTENCE);
  });

  test.each([200, 206])(
    "a %d longer than the caller's truncateAt is cut there and marked truncated",
    async (status) => {
      const { client } = clientOf(() => ({ status, body: "abcdefghij" }));
      const request = { bucket: "sales", key: "a.csv", range: { first: 0, last: 9 }, maxBytes: 4, truncateAt: 4 };
      expect(await client.getObjectRange(request, CALL)).toMatchObject({
        status,
        bytes: Buffer.from("abcd"),
        truncated: true,
      });
    },
  );

  test.each([200, 206])(
    "a %d longer than the caller's maxBytes with no truncateAt is too large, worded with that cap",
    async (status) => {
      const { client } = clientOf(() => ({ status, body: "abcdefghij" }));
      const error = await failure(client.getObjectRange({ bucket: "sales", key: "a.csv", maxBytes: 4 }, CALL));
      expect(error).toBeInstanceOf(TransportError);
      expect(error).toMatchObject({ kind: "too-large" });
      expect((toProviderError(error, "GetObject", CONTEXT) as Error).message).toBe(TOO_LARGE_SENTENCE);
    },
  );
});

describe("nothing ambient", () => {
  const saved = {
    id: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
    profile: process.env.AWS_PROFILE,
  };
  afterEach(() => {
    for (const [name, value] of [
      ["AWS_ACCESS_KEY_ID", saved.id],
      ["AWS_SECRET_ACCESS_KEY", saved.secret],
      ["AWS_PROFILE", saved.profile],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("an unsigned client sends no x-amz-* header and signs nothing, whatever the environment holds", async () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIDFROMENVIRONMENT";
    process.env.AWS_SECRET_ACCESS_KEY = "secret-from-environment";
    process.env.AWS_PROFILE = "default";
    const { client, fake } = clientOf(ANY);
    await client.listBuckets(CALL);
    await client.headObject("sales", "a.csv", CALL);
    await client.getObjectRange({ bucket: "sales", key: "a.csv", range: { first: 0, last: 0 }, maxBytes: 10 }, CALL);
    for (const exchange of fake.exchanges) {
      expect(exchange.signing).toBeNull();
      expect(Object.keys(exchange.request.headers ?? {}).filter((name) => name !== "range")).toEqual([]);
    }
  });
});

test("a limited client's permit wait that the call's signal ended rejects with that reason", async () => {
  const limiter: ProviderLimiter = { acquire: (signal) => Promise.reject(signal.reason) };
  const fake = fakeS3Transport(ANY);
  const client = limitedS3Client(createS3Client(fake.createTransport(TEST_TRANSPORT_OPTIONS)), limiter);
  const controller = new AbortController();
  controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
  const error = await failure(client.getBucketLocation("sales", { signal: controller.signal, deadline: Date.now() }));
  const mapped = toProviderError(error, "GetBucketLocation", CONTEXT, { timeoutMs: 10_000 }) as Error;
  expect(mapped.message).toBe(
    'The S3 server at http://localhost:9000 did not answer read the location of bucket "sales" within 10 seconds; nothing was retried.',
  );
  expect(fake.exchanges).toHaveLength(0);
  expect(mapped).not.toBeInstanceOf(QueryError);
});

describe("the limited client", () => {
  const ops: readonly (readonly [S3Operation, (c: S3Client, call: S3CallOptions) => Promise<unknown>, string])[] = [
    ["ListBuckets", (c, call) => c.listBuckets(call), "list buckets"],
    ["HeadBucket", (c, call) => c.headBucket("sales", call), 'list bucket "sales"'],
    ["GetBucketLocation", (c, call) => c.getBucketLocation("sales", call), 'read the location of bucket "sales"'],
    ["GetBucketVersioning", (c, call) => c.getBucketVersioning("sales", call), 'read the versioning of bucket "sales"'],
    [
      "ListObjectsV2",
      (c, call) => c.listObjectsV2({ bucket: "sales", prefix: "", maxKeys: 1 }, call),
      'list bucket "sales"',
    ],
    [
      "ListObjectVersions",
      (c, call) => c.listObjectVersions({ bucket: "sales", prefix: "", maxKeys: 1 }, call),
      'list object versions in bucket "sales"',
    ],
    ["HeadObject", (c, call) => c.headObject("sales", "a.csv", call), 'read object "a.csv" in bucket "sales"'],
    [
      "GetObject",
      (c, call) => c.getObjectRange({ bucket: "sales", key: "a.csv", maxBytes: 10 }, call),
      'read object "a.csv" in bucket "sales"',
    ],
    ["GetObjectTagging", (c, call) => c.getObjectTagging("sales", "a.csv", call), 'read the tags of object "a.csv"'],
  ];

  test("every operation takes exactly one permit and answers as the client does; close passes through", async () => {
    const limiter = countingLimiter();
    const fake = fakeS3Transport(ANY);
    const client = limitedS3Client(createS3Client(fake.createTransport(TEST_TRANSPORT_OPTIONS)), limiter);
    await Promise.all(ops.map(([, run]) => run(client, CALL)));
    expect(limiter.granted).toBe(ops.length);
    expect(fake.exchanges).toHaveLength(ops.length);
    client.close();
    expect(fake.closed.count).toBe(1);
  });

  test.each(ops)(
    "a %s permit wait the deadline ended is worded with the operation's names",
    async (operation, run, words) => {
      const limiter: ProviderLimiter = {
        acquire: () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
      };
      const fake = fakeS3Transport(ANY);
      const client = limitedS3Client(createS3Client(fake.createTransport(TEST_TRANSPORT_OPTIONS)), limiter);
      const error = await failure(run(client, CALL));
      expect((toProviderError(error, operation, CONTEXT, { timeoutMs: 10_000 }) as Error).message).toBe(
        `The S3 server at http://localhost:9000 did not answer ${words} within 10 seconds; nothing was retried.`,
      );
      expect(fake.exchanges).toHaveLength(0);
    },
  );

  test("two operations whose permit wait one deadline ended are each worded with their own names", async () => {
    const limiter = engineLimiter("s3-client-test-shared-reason", { perProvider: 1, perEngine: 1, queueDepth: 4 })();
    const held = await limiter.acquire(new AbortController().signal);
    const fake = fakeS3Transport(ANY);
    const client = limitedS3Client(createS3Client(fake.createTransport(TEST_TRANSPORT_OPTIONS)), limiter);
    const controller = new AbortController();
    const call = { signal: controller.signal, deadline: Date.now() + 60_000 };
    const bucketWait = failure(client.headBucket("sales", call));
    const objectWait = failure(client.headObject("archive", "b.csv", call));
    controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const [bucketError, objectError] = await Promise.all([bucketWait, objectWait]);
    held.release();
    expect((toProviderError(bucketError, "HeadBucket", CONTEXT, { timeoutMs: 10_000 }) as Error).message).toBe(
      'The S3 server at http://localhost:9000 did not answer list bucket "sales" within 10 seconds; nothing was retried.',
    );
    expect((toProviderError(objectError, "HeadObject", CONTEXT, { timeoutMs: 10_000 }) as Error).message).toBe(
      'The S3 server at http://localhost:9000 did not answer read object "b.csv" in bucket "archive" within 10 seconds; nothing was retried.',
    );
    expect(bucketError).not.toBe(objectError);
    expect(fake.exchanges).toHaveLength(0);
  });

  test("a permit wait a cancel ended rejects with the cancel's own reason, the same instance", async () => {
    const limiter: ProviderLimiter = { acquire: (signal) => Promise.reject(signal.reason) };
    const fake = fakeS3Transport(ANY);
    const client = limitedS3Client(createS3Client(fake.createTransport(TEST_TRANSPORT_OPTIONS)), limiter);
    const controller = new AbortController();
    const cancel = new QueryCancelledError("The query was cancelled.");
    controller.abort(cancel);
    const error = await failure(client.headBucket("sales", { signal: controller.signal, deadline: Date.now() }));
    expect(error).toBe(cancel);
    expect(toProviderError(error, "HeadBucket", CONTEXT, { signal: controller.signal })).toBe(cancel);
    expect(fake.exchanges).toHaveLength(0);
  });
});
