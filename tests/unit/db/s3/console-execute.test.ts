/**
 * Running an accepted console command over the core's client, with a fake client that
 * records every call: the page sizes asked, the 500-row and 50-request stops, the repeated-token failure, the CLI's
 * truncate amount on resume, a foreign token sent as typed to the named bucket only, the pin, one request for every
 * other read, the preview's HEAD then engine, cancellation, and every failure through `surface.fail`.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import type {
  ListObjectsRequest,
  ObjectHead,
  ObjectListing,
  S3CallOptions,
} from "@/lib/db/providers/objectstore/s3/client";
import { type ParsedS3Command, parseS3Command } from "@/lib/db/providers/objectstore/s3/console/commands";
import {
  executeS3Command,
  S3_REPEATED_TOKEN_SENTENCE,
  type S3ExecuteDeps,
} from "@/lib/db/providers/objectstore/s3/console/execute";
import { encodeS3StartingToken } from "@/lib/db/providers/objectstore/s3/console/token";
import type { S3Surface } from "@/lib/db/providers/objectstore/s3/index";

const METHODS = [
  "listBuckets",
  "headBucket",
  "getBucketLocation",
  "getBucketVersioning",
  "listObjectsV2",
  "listObjectVersions",
  "headObject",
  "getObjectRange",
  "getObjectTagging",
] as const;
type Method = (typeof METHODS)[number];
type Answer = (...args: never[]) => unknown;

interface Call {
  readonly method: Method;
  readonly args: readonly unknown[];
}

/** What `surface.fail` answers in these tests: the original error and the operation it named. */
class Failed extends Error {
  constructor(
    readonly original: unknown,
    readonly operation: string,
  ) {
    super(`failed ${operation}`);
  }
}

const OPTIONS = {
  endpoint: { scheme: "http", host: "localhost", port: 9000 },
  region: "us-east-1",
};

function fakeSurface(
  answers: Partial<Record<Method, Answer>>,
  options: Record<string, unknown> = OPTIONS,
): { readonly surface: S3Surface; readonly calls: Call[] } {
  const calls: Call[] = [];
  const client: Record<string, unknown> = { close: () => {} };
  for (const method of METHODS) {
    client[method] = async (...args: unknown[]) => {
      calls.push({ method, args });
      const answer = answers[method] as ((...values: unknown[]) => unknown) | undefined;
      if (answer === undefined) throw new Error(`unexpected ${method}`);
      return answer(...args);
    };
  }
  const surface = { client, options, fail: (error: unknown, operation: string) => new Failed(error, operation) };
  return { surface: surface as unknown as S3Surface, calls };
}

const CALL: S3CallOptions = { signal: new AbortController().signal, deadline: Date.now() + 60_000 };

function parsed(text: string): ParsedS3Command {
  const result = parseS3Command(text, {});
  if (!result.ok) throw new Error(result.refusal.message);
  return result.parsed;
}

/** A server over `keys` that answers at most `perPage` entries and never more than asked; its token is the next index. */
function pagedServer(keys: readonly string[], perPage: number): (request: ListObjectsRequest) => ObjectListing {
  return (request) => {
    const start = request.continuationToken === undefined ? 0 : Number(request.continuationToken);
    const page = keys.slice(start, start + Math.min(request.maxKeys, perPage)).map((key) => ({ key, size: 1 }));
    const next = start + page.length;
    const isTruncated = next < keys.length;
    return {
      keys: page,
      prefixes: [],
      undecodable: 0,
      isTruncated,
      ...(isTruncated ? { nextToken: String(next) } : {}),
    };
  };
}

const letters = (n: number): string[] => Array.from({ length: n }, (_, index) => `k${String(index).padStart(4, "0")}`);
const maxKeysOf = (calls: readonly Call[]): number[] =>
  calls.map((call) => (call.args[0] as ListObjectsRequest).maxKeys);
const keysOf = (outcome: Awaited<ReturnType<typeof executeS3Command>>): string[] =>
  outcome.kind === "objects"
    ? outcome.entries.map((entry) => (entry.kind === "object" ? entry.object.key : entry.prefix))
    : [];

describe("ListObjectsV2 runs", () => {
  test("each page asks for min(page size, rows still wanted)", async () => {
    const { surface, calls } = fakeSurface({ listObjectsV2: pagedServer(letters(7), 10) });
    const outcome = await executeS3Command(
      surface,
      parsed("aws s3api list-objects-v2 --bucket b --max-items 5 --page-size 2"),
      { call: CALL },
    );
    expect(maxKeysOf(calls)).toEqual([2, 2, 1]);
    expect(outcome).toMatchObject({ kind: "objects", stop: "rows", nextToken: "5", requests: 3 });
  });

  test("a run with no --max-items stops at 500 rows with the next token", async () => {
    const { surface, calls } = fakeSurface({ listObjectsV2: pagedServer(letters(600), 1_000) });
    const outcome = await executeS3Command(surface, parsed("aws s3 ls s3://b/"), { call: CALL });
    expect(maxKeysOf(calls)).toEqual([500]);
    expect(calls[0].args[0]).toEqual({ bucket: "b", prefix: "", delimiter: "/", maxKeys: 500 });
    expect(outcome).toMatchObject({ kind: "objects", stop: "rows", nextToken: "500" });
    expect(keysOf(outcome)).toHaveLength(500);
  });

  test("--max-items 3 on a server of two entries a page, then the token resumes with none repeated", async () => {
    const server = pagedServer(["a", "b", "c", "d", "e"], 2);
    const first = fakeSurface({ listObjectsV2: server });
    const outcome = await executeS3Command(
      first.surface,
      parsed("aws s3api list-objects-v2 --bucket b --max-items 3"),
      { call: CALL },
    );
    expect(maxKeysOf(first.calls)).toEqual([3, 1]);
    expect(keysOf(outcome)).toEqual(["a", "b", "c"]);
    expect(outcome).toMatchObject({ stop: "rows", nextToken: "3" });
    const second = fakeSurface({ listObjectsV2: server });
    const token = encodeS3StartingToken("3");
    const rest = await executeS3Command(
      second.surface,
      parsed(`aws s3api list-objects-v2 --bucket b --max-items 3 --starting-token ${token}`),
      { call: CALL },
    );
    expect(keysOf(rest)).toEqual(["d", "e"]);
    expect(rest).toMatchObject({ stop: "complete" });
    expect(rest.kind === "objects" ? rest.nextToken : "").toBeUndefined();
  });

  test("the same next token twice fails the run with its sentence", async () => {
    const { surface } = fakeSurface({
      listObjectsV2: () => ({
        keys: [{ key: "a", size: 1 }],
        prefixes: [],
        undecodable: 0,
        isTruncated: true,
        nextToken: "x",
      }),
    });
    const run = executeS3Command(surface, parsed("aws s3api list-objects-v2 --bucket b"), { call: CALL });
    await expect(run).rejects.toThrow(S3_REPEATED_TOKEN_SENTENCE);
    await expect(run).rejects.toBeInstanceOf(QueryError);
    expect(S3_REPEATED_TOKEN_SENTENCE).toBe(
      "The server sent the same next token twice, so reading on would repeat a page: Studio stopped. Report this to the server's maintainers.",
    );
  });

  test("a first page whose next token is the --starting-token sent fails the same way", async () => {
    const { surface, calls } = fakeSurface({
      listObjectsV2: () => ({
        keys: [{ key: "a", size: 1 }],
        prefixes: [],
        undecodable: 0,
        isTruncated: true,
        nextToken: "x",
      }),
    });
    const text = `aws s3api list-objects-v2 --bucket b --starting-token ${encodeS3StartingToken("x")}`;
    await expect(executeS3Command(surface, parsed(text), { call: CALL })).rejects.toThrow(S3_REPEATED_TOKEN_SENTENCE);
    expect(calls).toHaveLength(1);
  });

  test("fifty pages of one entry stop at the page cap with the next token", async () => {
    const { surface, calls } = fakeSurface({ listObjectsV2: pagedServer(letters(60), 1) });
    const outcome = await executeS3Command(surface, parsed("aws s3api list-objects-v2 --bucket b"), { call: CALL });
    expect(calls).toHaveLength(50);
    expect(outcome).toMatchObject({ kind: "objects", stop: "page-cap", nextToken: "50", requests: 50 });
    expect(keysOf(outcome)).toHaveLength(50);
  });

  test("a CLI token's truncate amount skips that many objects of the first page and drops its folders", async () => {
    const pages: ObjectListing[] = [
      {
        keys: ["k1", "k2", "k3", "k4"].map((key) => ({ key, size: 1 })),
        prefixes: ["p/"],
        undecodable: 0,
        isTruncated: true,
        nextToken: "n1",
      },
      { keys: [{ key: "k5", size: 1 }], prefixes: ["q/"], undecodable: 0, isTruncated: false },
    ];
    const { surface, calls } = fakeSurface({ listObjectsV2: () => pages.shift() });
    const token = btoa('{"ContinuationToken":"t0","boto_truncate_amount":2}');
    const outcome = await executeS3Command(
      surface,
      parsed(`aws s3api list-objects-v2 --bucket b --delimiter / --max-items 4 --starting-token ${token}`),
      { call: CALL },
    );
    expect(calls.map((call) => call.args[0])).toEqual([
      { bucket: "b", prefix: "", delimiter: "/", maxKeys: 6, continuationToken: "t0" },
      { bucket: "b", prefix: "", delimiter: "/", maxKeys: 2, continuationToken: "n1" },
    ]);
    expect(keysOf(outcome)).toEqual(["k3", "k4", "q/", "k5"]);
  });

  test("a truncate amount larger than the first page skips that page and nothing on the next", async () => {
    const pages: ObjectListing[] = [
      {
        keys: [
          { key: "k1", size: 1 },
          { key: "k2", size: 1 },
        ],
        prefixes: [],
        undecodable: 0,
        isTruncated: true,
        nextToken: "n1",
      },
      {
        keys: [
          { key: "k3", size: 1 },
          { key: "k4", size: 1 },
        ],
        prefixes: [],
        undecodable: 0,
        isTruncated: false,
      },
    ];
    const { surface } = fakeSurface({ listObjectsV2: () => pages.shift() });
    const token = btoa('{"ContinuationToken":"t0","boto_truncate_amount":5}');
    const outcome = await executeS3Command(
      surface,
      parsed(`aws s3api list-objects-v2 --bucket b --starting-token ${token}`),
      {
        call: CALL,
      },
    );
    expect(keysOf(outcome)).toEqual(["k3", "k4"]);
  });

  test("a foreign --starting-token is sent as typed, to the named bucket only", async () => {
    const { surface, calls } = fakeSurface({ listObjectsV2: pagedServer([], 1) });
    await executeS3Command(
      surface,
      parsed(
        `aws s3api list-objects-v2 --bucket b --prefix 2026/ --starting-token ${encodeS3StartingToken("foreign")}`,
      ),
      { call: CALL },
    );
    expect(calls.map((call) => call.args[0])).toEqual([
      { bucket: "b", prefix: "2026/", maxKeys: 500, continuationToken: "foreign" },
    ]);
  });

  test("undecodable names are summed over the pages read", async () => {
    const pages: ObjectListing[] = [
      { keys: [{ key: "a", size: 1 }], prefixes: [], undecodable: 2, isTruncated: true, nextToken: "n" },
      { keys: [], prefixes: [], undecodable: 1, isTruncated: false },
    ];
    const { surface } = fakeSurface({ listObjectsV2: () => pages.shift() });
    expect(await executeS3Command(surface, parsed("aws s3 ls s3://b/"), { call: CALL })).toMatchObject({
      undecodable: 3,
    });
  });

  test("a client error passes through surface.fail with its operation", async () => {
    const boom = new Error("boom");
    const { surface } = fakeSurface({
      listObjectsV2: () => {
        throw boom;
      },
    });
    const failure = await executeS3Command(surface, parsed("aws s3 ls s3://b/"), { call: CALL }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Failed);
    expect((failure as Failed).original).toBe(boom);
    expect((failure as Failed).operation).toBe("ListObjectsV2");
  });
});

describe("bucket listings and the pin", () => {
  const listing = {
    buckets: [{ name: "alpha", created: "2026-01-01T00:00:00.000Z" }, { name: "beta" }, { name: "bravo" }],
    invalidNames: ["a/x", "b/y"],
    truncated: true,
  };

  test("ListBuckets is called once, filtered by --prefix on the client and cut at --max-items, invalid names counted under the prefix", async () => {
    const { surface, calls } = fakeSurface({ listBuckets: () => listing });
    const outcome = await executeS3Command(surface, parsed("aws s3api list-buckets --prefix b --max-items 1"), {
      call: CALL,
    });
    expect(calls).toEqual([{ method: "listBuckets", args: [CALL] }]);
    expect(outcome).toEqual({
      kind: "buckets",
      buckets: [{ name: "beta" }],
      cut: true,
      truncated: true,
      invalidNames: 1,
    });
  });

  test("ls with no path reads every bucket, filtered by --bucket-name-prefix", async () => {
    const { surface } = fakeSurface({ listBuckets: () => listing });
    const outcome = await executeS3Command(surface, parsed("aws s3 ls --bucket-name-prefix al"), { call: CALL });
    expect(outcome).toMatchObject({ buckets: [{ name: "alpha", created: "2026-01-01T00:00:00.000Z" }], cut: false });
  });

  test("a pinned connection sends no ListBuckets and answers its bucket", async () => {
    const { surface, calls } = fakeSurface({});
    for (const text of ["aws s3 ls", "aws s3api list-buckets"]) {
      // oxlint-disable-next-line no-await-in-loop -- one command at a time, against the one fake surface whose calls are read after.
      expect(await executeS3Command(surface, parsed(text), { call: CALL, pinnedBucket: "sales" })).toEqual({
        kind: "buckets",
        buckets: [{ name: "sales" }],
        cut: false,
        truncated: false,
        invalidNames: 0,
        pinned: "sales",
      });
    }
    expect(
      await executeS3Command(surface, parsed("aws s3api list-buckets --prefix x"), {
        call: CALL,
        pinnedBucket: "sales",
      }),
    ).toMatchObject({
      buckets: [],
    });
    expect(calls).toEqual([]);
  });
});

describe("list-object-versions (one page)", () => {
  const page = {
    entries: [
      { key: "a", versionId: "v2", isLatest: true, deleteMarker: false, size: 1 },
      { key: "a", versionId: "v1", isLatest: false, deleteMarker: true, size: null },
    ],
    prefixes: ["p/"],
    undecodable: 0,
    isTruncated: false,
  };

  test("is called once with maxKeys = --max-items, no marker, and the delimiter only when given", async () => {
    const plain = fakeSurface({ listObjectVersions: () => page });
    await executeS3Command(
      plain.surface,
      parsed("aws s3api list-object-versions --bucket b --prefix p --max-items 7"),
      { call: CALL },
    );
    expect(plain.calls).toEqual([
      { method: "listObjectVersions", args: [{ bucket: "b", prefix: "p", maxKeys: 7 }, CALL] },
    ]);
    const level = fakeSurface({ listObjectVersions: () => page });
    await executeS3Command(level.surface, parsed("aws s3api list-object-versions --bucket b --delimiter /"), {
      call: CALL,
    });
    expect(level.calls[0].args[0]).toEqual({ bucket: "b", prefix: "", delimiter: "/", maxKeys: 500 });
  });

  test("an over-full page is cut client-side, folder rows counted first", async () => {
    const { surface } = fakeSurface({ listObjectVersions: () => page });
    const outcome = await executeS3Command(surface, parsed("aws s3api list-object-versions --bucket b --max-items 2"), {
      call: CALL,
    });
    expect(outcome).toEqual({
      kind: "versions",
      listing: { ...page, prefixes: ["p/"], entries: [page.entries[0]] },
      cut: true,
    });
  });

  test("a page that fits is not cut", async () => {
    const { surface } = fakeSurface({ listObjectVersions: () => page });
    expect(
      await executeS3Command(surface, parsed("aws s3api list-object-versions --bucket b"), { call: CALL }),
    ).toEqual({
      kind: "versions",
      listing: page,
      cut: false,
    });
  });
});

describe("the reads of one request each", () => {
  const HEAD = { size: 3, etag: "e" } as unknown as ObjectHead;

  test.each([
    [
      "aws s3api head-bucket --bucket b",
      "headBucket",
      ["b"],
      { bucketRegion: null },
      { kind: "bucket-head", head: { bucketRegion: null } },
    ],
    ["aws s3api head-object --bucket b --key k", "headObject", ["b", "k"], HEAD, { kind: "object-head", head: HEAD }],
    ["aws s3api get-object-tagging --bucket b --key k", "getObjectTagging", ["b", "k"], [], { kind: "tags", tags: [] }],
    [
      "aws s3api get-bucket-location --bucket b",
      "getBucketLocation",
      ["b"],
      "eu-west-1",
      { kind: "location", region: "eu-west-1" },
    ],
    [
      "aws s3api get-bucket-versioning --bucket b",
      "getBucketVersioning",
      ["b"],
      { status: null, mfaDelete: null },
      { kind: "versioning", state: { status: null, mfaDelete: null } },
    ],
  ] as const)("%s calls %s once with the typed values", async (text, method, args, answer, outcome) => {
    const { surface, calls } = fakeSurface({ [method]: () => answer } as Partial<Record<Method, Answer>>);
    expect(await executeS3Command(surface, parsed(text), { call: CALL })).toEqual(outcome);
    expect(calls).toEqual([{ method, args: [...args, CALL] }]);
  });

  test("each read's failure names its operation", async () => {
    const operations: [string, Method, string][] = [
      ["aws s3api head-bucket --bucket b", "headBucket", "HeadBucket"],
      ["aws s3api head-object --bucket b --key k", "headObject", "HeadObject"],
      ["aws s3api get-object-tagging --bucket b --key k", "getObjectTagging", "GetObjectTagging"],
      ["aws s3api get-bucket-location --bucket b", "getBucketLocation", "GetBucketLocation"],
      ["aws s3api get-bucket-versioning --bucket b", "getBucketVersioning", "GetBucketVersioning"],
      ["aws s3api list-object-versions --bucket b", "listObjectVersions", "ListObjectVersions"],
      ["aws s3api list-buckets", "listBuckets", "ListBuckets"],
    ];
    for (const [text, method, operation] of operations) {
      const { surface } = fakeSurface({
        [method]: () => {
          throw new Error("no");
        },
      } as Partial<Record<Method, Answer>>);
      // oxlint-disable-next-line no-await-in-loop -- one method at a time, so a failure names its operation.
      const failure = await executeS3Command(surface, parsed(text), { call: CALL }).catch((error: unknown) => error);
      expect((failure as Failed).operation).toBe(operation);
    }
  });
});

describe("preview", () => {
  const HEAD = { size: 3, etag: "e" } as unknown as ObjectHead;
  const PREVIEW_HEAD = { bucket: "b", key: "k.csv", size: 3, etag: '"e"' };
  const READER = { read: async () => ({ bytes: new Uint8Array(), start: 0, total: 3 }) };

  function deps(
    record: unknown[],
    previewHead: unknown = PREVIEW_HEAD,
    preview: () => Promise<unknown> = async () => ({ kind: "empty", notices: [] }),
  ): S3ExecuteDeps {
    return {
      toPreviewHead: ((...args: unknown[]) => {
        record.push(["toPreviewHead", ...args]);
        return previewHead;
      }) as S3ExecuteDeps["toPreviewHead"],
      rangeReader: ((...args: unknown[]) => {
        record.push(["rangeReader", ...args.slice(1)]);
        return READER;
      }) as S3ExecuteDeps["rangeReader"],
      previewObject: ((input: unknown) => {
        record.push(["previewObject", input]);
        return preview();
      }) as S3ExecuteDeps["previewObject"],
    };
  }

  test("runs HEAD, then the preview engine with purpose console and the mapped request", async () => {
    const record: unknown[] = [];
    const { surface, calls } = fakeSurface({ headObject: () => HEAD });
    const outcome = await executeS3Command(
      surface,
      parsed("preview s3://b/k.csv --format csv --max-rows 20"),
      { call: CALL },
      deps(record),
    );
    expect(calls).toEqual([{ method: "headObject", args: ["b", "k.csv", CALL] }]);
    expect(record).toEqual([
      ["toPreviewHead", HEAD, "b", "k.csv"],
      ["rangeReader", "b", "k.csv", CALL],
      [
        "previewObject",
        {
          head: PREVIEW_HEAD,
          reader: READER,
          request: { format: "csv", maxRows: 20 },
          purpose: "console",
          signal: CALL.signal,
        },
      ],
    ]);
    expect(outcome).toEqual({ kind: "preview", preview: { kind: "empty", notices: [] } });
  });

  test("a HEAD without a usable size or ETag is refused with the adapter's sentence and sends no GET", async () => {
    const record: unknown[] = [];
    const sentence = "The server sent no usable Content-Length or ETag for this object, so it cannot be previewed.";
    const { surface } = fakeSurface({ headObject: () => HEAD });
    const run = executeS3Command(surface, parsed("preview s3://b/k.csv"), { call: CALL }, deps(record, sentence));
    await expect(run).rejects.toThrow(sentence);
    await expect(run).rejects.toBeInstanceOf(QueryError);
    expect(record.map((entry) => (entry as unknown[])[0])).toEqual(["toPreviewHead"]);
  });

  test("a preview failure passes through surface.fail as GetObject", async () => {
    const boom = new Error("decode");
    const { surface } = fakeSurface({ headObject: () => HEAD });
    const failure = await executeS3Command(
      surface,
      parsed("preview s3://b/k.csv"),
      { call: CALL },
      deps([], PREVIEW_HEAD, async () => {
        throw boom;
      }),
    ).catch((error: unknown) => error);
    expect((failure as Failed).operation).toBe("GetObject");
    expect((failure as Failed).original).toBe(boom);
  });
});

describe("cancellation", () => {
  test("a run cancelled before its first request sends nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const call = { signal: controller.signal, deadline: Date.now() + 60_000 };
    for (const [text, operation] of [
      ["aws s3 ls s3://b/", "ListObjectsV2"],
      ["aws s3api head-object --bucket b --key k", "HeadObject"],
      ["aws s3api list-buckets", "ListBuckets"],
    ] as const) {
      const { surface, calls } = fakeSurface({
        listObjectsV2: pagedServer(["a"], 1),
        headObject: () => ({}),
        listBuckets: () => ({}),
      });
      // oxlint-disable-next-line no-await-in-loop -- one command at a time, so a failure names its operation.
      const failure = await executeS3Command(surface, parsed(text), { call }).catch((error: unknown) => error);
      expect((failure as Failed).operation).toBe(operation);
      expect(calls).toEqual([]);
    }
  });

  test("a run cancelled while the first ListObjectsV2 page answers sends no second page and fails naming ListObjectsV2", async () => {
    const controller = new AbortController();
    const call = { signal: controller.signal, deadline: Date.now() + 60_000 };
    const server = pagedServer(letters(5), 1);
    const { surface, calls } = fakeSurface({
      listObjectsV2: (request: ListObjectsRequest) => {
        controller.abort();
        return server(request);
      },
    });
    const failure = await executeS3Command(surface, parsed("aws s3 ls s3://b/"), { call }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Failed);
    expect((failure as Failed).operation).toBe("ListObjectsV2");
    expect(calls.map((each) => each.method)).toEqual(["listObjectsV2"]);
  });
});
