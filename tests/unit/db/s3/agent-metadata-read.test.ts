/**
 * What an agent's S3 read sends and answers (`agent-metadata-read.ts`): each read of the closed table over the agent's
 * client, its answer projected to names, counts and flags, the whole-bucket summary counted in Studio under the row
 * budget and refused past it, and every failure worded by its category alone, never by the server's words.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  runS3AgentRead,
  S3_AGENT_FAILURE_SENTENCES,
  S3_METADATA_ONLY,
  type S3AgentAnswer,
  s3AgentFailure,
  s3AgentResult,
} from "@/lib/db/providers/objectstore/s3/agent-metadata-read";
import type { S3AgentPlan } from "@/lib/db/providers/objectstore/s3/agent-statement";
import { createS3AgentClient } from "@/lib/db/providers/objectstore/s3/client";
import { S3ServerError } from "@/lib/db/providers/objectstore/s3/errors";
import { BYTE_BUDGET_PREFIX, ROW_BUDGET_PREFIX, TIME_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import { MetadataProjectionError } from "@/lib/db/redaction/metadata-only";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import type { LimiterTicket, ProviderLimiter } from "@/lib/db/utils/bounded-limiter";
import {
  bucketsXml,
  type FakeS3Handler,
  fakeS3Transport,
  objectsXml,
  TEST_TRANSPORT_OPTIONS,
  xmlAnswer,
} from "../../../helpers/s3-fake-transport";

const MARKER = "tenant-marker";
const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 5_000, maxResultRows: 100, maxResultBytes: 1_000_000 };

const limiter: ProviderLimiter = {
  async acquire(): Promise<LimiterTicket> {
    return { release: () => undefined };
  },
} as unknown as ProviderLimiter;

function harness(handler: FakeS3Handler) {
  const fake = fakeS3Transport(handler);
  const client = createS3AgentClient(fake.createTransport(TEST_TRANSPORT_OPTIONS), limiter);
  const call = { signal: new AbortController().signal, deadline: Date.now() + 5_000 };
  return {
    fake,
    run: (plan: S3AgentPlan, budget: ReadOnlyStatementBudget = BUDGET, pinnedBucket?: string) =>
      runS3AgentRead(client, plan, { budget, call, ...(pinnedBucket === undefined ? {} : { pinnedBucket }) }),
  };
}

const result = (answer: S3AgentAnswer, budget = BUDGET) => s3AgentResult(answer, budget, "statement", 1);

describe("the bucket listing", () => {
  test("answers every bucket's name and creation time, from one ListBuckets", async () => {
    const { fake, run } = harness(() => xmlAnswer(bucketsXml(["archive", "sales"])));
    const answer = await run({ op: "list-buckets" });
    expect(result(answer)).toEqual({
      fields: ["bucket", "created"],
      rows: [
        { bucket: "archive", created: "2026-10-09T13:13:17.442Z" },
        { bucket: "sales", created: "2026-10-09T13:13:17.442Z" },
      ],
      rowCount: 2,
      executionTime: 1,
    });
    expect(fake.lines()).toEqual(["GET /?max-buckets=10000"]);
  });

  test("a pinned connection answers its bucket with no request, and says the creation time was not read", async () => {
    const { fake, run } = harness(() => xmlAnswer(bucketsXml(["other"])));
    const answered = result(await run({ op: "list-buckets" }, BUDGET, "sales"));
    expect(answered.rows).toEqual([{ bucket: "sales", created: null }]);
    expect(answered.warnings?.[0].message).toContain("pinned to one bucket");
    expect(fake.lines()).toEqual([]);
  });

  test("more buckets than the row budget is refused, never cut; exactly the budget is answered", async () => {
    const names = ["a1", "a2", "a3"];
    const at = harness(() => xmlAnswer(bucketsXml(names)));
    expect(result(await at.run({ op: "list-buckets" }, { ...BUDGET, maxResultRows: 3 })).rowCount).toBe(3);
    const over = harness(() => xmlAnswer(bucketsXml(names)));
    const failure = await over.run({ op: "list-buckets" }, { ...BUDGET, maxResultRows: 2 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(QueryError);
    expect((failure as Error).message.startsWith(ROW_BUDGET_PREFIX)).toBe(true);
  });

  test("a listing the server cut is refused rather than answered in part", async () => {
    const { run } = harness(() => xmlAnswer(bucketsXml(["a"], { continuationToken: "next" })));
    const failure = await run({ op: "list-buckets" }).catch((e: unknown) => e);
    expect((failure as Error).message).toBe(S3_AGENT_FAILURE_SENTENCES.bucketsCut);
  });

  test("names holding a slash are counted in a warning, never listed", async () => {
    const { run } = harness(() => xmlAnswer(bucketsXml(["ok", "bad/name"])));
    const answered = result(await run({ op: "list-buckets" }));
    expect(answered.rows).toEqual([{ bucket: "ok", created: "2026-10-09T13:13:17.442Z" }]);
    expect(answered.warnings?.[0].message).toBe(S3_AGENT_FAILURE_SENTENCES.invalidBucketNames(1));
    expect(JSON.stringify(answered)).not.toContain("bad/name");
  });
});

describe("one bucket's reads", () => {
  test("head-bucket answers existence and the region header", async () => {
    const { fake, run } = harness(() => ({ status: 200, headers: [["x-amz-bucket-region", "eu-central-1"]] }));
    expect(result(await run({ op: "head-bucket", bucket: "sales" })).rows).toEqual([
      { bucket: "sales", exists: true, region: "eu-central-1" },
    ]);
    expect(fake.lines()).toEqual(["HEAD /sales"]);
  });

  test("head-bucket of a missing bucket answers exists false", async () => {
    const { run } = harness(() => ({ status: 404 }));
    expect(result(await run({ op: "head-bucket", bucket: "gone" })).rows).toEqual([
      { bucket: "gone", exists: false, region: null },
    ]);
  });

  test("the location and the versioning status", async () => {
    const location = harness(() => xmlAnswer("<LocationConstraint></LocationConstraint>"));
    expect(result(await location.run({ op: "get-bucket-location", bucket: "sales" })).rows).toEqual([
      { bucket: "sales", location: "us-east-1" },
    ]);
    const never = harness(() => xmlAnswer("<VersioningConfiguration></VersioningConfiguration>"));
    expect(result(await never.run({ op: "get-bucket-versioning", bucket: "sales" })).rows).toEqual([
      { bucket: "sales", status: "never enabled", mfa_delete: null },
    ]);
    const on = harness(() =>
      xmlAnswer(
        "<VersioningConfiguration><Status>Suspended</Status><MfaDelete>Disabled</MfaDelete></VersioningConfiguration>",
      ),
    );
    expect(result(await on.run({ op: "get-bucket-versioning", bucket: "sales" })).rows).toEqual([
      { bucket: "sales", status: "Suspended", mfa_delete: "Disabled" },
    ]);
  });
});

describe("the whole-bucket summary", () => {
  const pages: FakeS3Handler = (request) => {
    const query = request.target.query;
    if (!query.includes("continuation-token"))
      return xmlAnswer(
        objectsXml({
          keys: [
            { key: `${MARKER}/a`, size: 10 },
            { key: `${MARKER}/b`, size: 5 },
          ],
          truncated: true,
          token: "p2",
        }),
      );
    return xmlAnswer(objectsXml({ keys: [{ key: `${MARKER}/c`, size: 1 }] }));
  };

  test("counts and totals every page, never names a key, and sends no prefix", async () => {
    const { fake, run } = harness(pages);
    const answered = result(await run({ op: "summary", bucket: "sales" }));
    expect(answered).toEqual({
      fields: ["bucket", "objects", "total_size_bytes"],
      rows: [{ bucket: "sales", objects: 3, total_size_bytes: 16 }],
      rowCount: 1,
      executionTime: 1,
    });
    expect(JSON.stringify(answered)).not.toContain(MARKER);
    expect(fake.lines()).toEqual([
      "GET /sales?encoding-type=url&list-type=2&max-keys=100&prefix=",
      "GET /sales?continuation-token=p2&encoding-type=url&list-type=2&max-keys=98&prefix=",
    ]);
  });

  test("an empty bucket is zero objects of zero bytes, as the server answered", async () => {
    const { run } = harness(() => xmlAnswer(objectsXml({})));
    expect(result(await run({ op: "summary", bucket: "empty" })).rows).toEqual([
      { bucket: "empty", objects: 0, total_size_bytes: 0 },
    ]);
  });

  test("exactly the row budget of objects is answered; one more is refused, not cut", async () => {
    const at = harness(() => xmlAnswer(objectsXml({ keys: ["a", "b"] })));
    expect(result(await at.run({ op: "summary", bucket: "s" }, { ...BUDGET, maxResultRows: 2 })).rows).toEqual([
      { bucket: "s", objects: 2, total_size_bytes: 2 },
    ]);
    const over = harness(() => xmlAnswer(objectsXml({ keys: ["a", "b"], truncated: true, token: "n" })));
    const failure = await over
      .run({ op: "summary", bucket: "s" }, { ...BUDGET, maxResultRows: 2 })
      .catch((e: unknown) => e);
    expect((failure as Error).message).toBe(S3_AGENT_FAILURE_SENTENCES.summaryOverRows(2));
    expect((failure as Error).message.startsWith(ROW_BUDGET_PREFIX)).toBe(true);
    expect(over.fake.lines()).toHaveLength(1);
  });

  test("a page size never passes the server's page ceiling", async () => {
    const { fake, run } = harness(() => xmlAnswer(objectsXml({ keys: ["a"] })));
    await run({ op: "summary", bucket: "s" }, { ...BUDGET, maxResultRows: 5_000 });
    expect(fake.lines()).toEqual(["GET /s?encoding-type=url&list-type=2&max-keys=1000&prefix="]);
  });

  test("a token the server sends twice is refused rather than read again", async () => {
    const { run } = harness(() => xmlAnswer(objectsXml({ keys: ["a"], truncated: true, token: "same" })));
    const failure = await run({ op: "summary", bucket: "s" }).catch((e: unknown) => e);
    expect((failure as Error).message).toBe(S3_AGENT_FAILURE_SENTENCES.repeatedToken);
  });

  test("a name that is not text refuses the total, which Studio could not add up", async () => {
    const { run } = harness(() => xmlAnswer(objectsXml({ keys: ["%FF"], encoding: "url" })));
    const failure = await run({ op: "summary", bucket: "s" }).catch((e: unknown) => e);
    expect((failure as Error).message).toBe(S3_AGENT_FAILURE_SENTENCES.undecodable);
  });

  test("a folder entry in a whole-bucket page is refused as an answer that is not the listing asked for", async () => {
    const { run } = harness(() => xmlAnswer(objectsXml({ prefixes: [`${MARKER}/`] })));
    const failure = await run({ op: "summary", bucket: "s" }).catch((e: unknown) => e);
    expect((failure as Error).message).toBe(S3_AGENT_FAILURE_SENTENCES.unreadable);
    expect((failure as Error).message).not.toContain(MARKER);
  });

  test("a total past the safe integer range is refused", async () => {
    const { run } = harness(() =>
      xmlAnswer(
        objectsXml({
          keys: [
            { key: "a", size: Number.MAX_SAFE_INTEGER },
            { key: "b", size: 2 },
          ],
        }),
      ),
    );
    const answer = await run({ op: "summary", bucket: "s" });
    expect(() => result(answer)).toThrow(MetadataProjectionError);
  });
});

describe("one object's head", () => {
  test("answers existence, size, last-modified time and storage class, and never the ETag, metadata or version", async () => {
    const { fake, run } = harness(() => ({
      status: 200,
      headers: [
        ["content-length", "42"],
        ["last-modified", "Fri, 09 Oct 2026 13:13:17 GMT"],
        ["x-amz-storage-class", "STANDARD_IA"],
        ["etag", '"0123456789abcdef0123456789abcdef"'],
        ["x-amz-version-id", "version-marker"],
        ["x-amz-meta-owner", MARKER],
        ["x-amz-tagging-count", "2"],
        ["content-type", "text/csv"],
      ],
    }));
    const answered = result(await run({ op: "head-object", bucket: "sales", key: `${MARKER}/x.csv` }));
    expect(answered.fields).toEqual(["bucket", "exists", "size_bytes", "last_modified", "storage_class"]);
    expect(answered.rows).toEqual([
      {
        bucket: "sales",
        exists: true,
        size_bytes: 42,
        last_modified: "2026-10-09T13:13:17.000Z",
        storage_class: "STANDARD_IA",
      },
    ]);
    const text = JSON.stringify(answered);
    for (const withheld of [MARKER, "0123456789abcdef", "version-marker", "text/csv"])
      expect(text).not.toContain(withheld);
    expect(fake.lines()).toEqual([`HEAD /sales/${MARKER}/x.csv`]);
  });

  test("a storage class the server did not send is absent, never filled in", async () => {
    const { run } = harness(() => ({ status: 200, headers: [["content-length", "1"]] }));
    expect(result(await run({ op: "head-object", bucket: "s", key: "k" })).rows).toEqual([
      { bucket: "s", exists: true, size_bytes: 1, last_modified: null, storage_class: null },
    ]);
  });

  test("a last-modified or storage class header that does not parse is answered as null, never as the header's text", async () => {
    const { run } = harness(() => ({
      status: 200,
      headers: [
        ["content-length", "1"],
        ["last-modified", `${MARKER}/x.csv`],
        ["x-amz-storage-class", `${MARKER}/x.csv`],
      ],
    }));
    const answered = result(await run({ op: "head-object", bucket: "s", key: "k" }));
    expect(answered.rows).toEqual([
      { bucket: "s", exists: true, size_bytes: 1, last_modified: null, storage_class: null },
    ]);
    expect(JSON.stringify(answered)).not.toContain(MARKER);
  });

  test("a 404 is exists false, with the note that a HEAD cannot tell a missing bucket from a missing key", async () => {
    const { run } = harness(() => ({ status: 404, headers: [["x-amz-delete-marker", "true"]] }));
    const answered = result(await run({ op: "head-object", bucket: "s", key: "k" }));
    expect(answered.rows).toEqual([
      { bucket: "s", exists: false, size_bytes: null, last_modified: null, storage_class: null },
    ]);
    expect(answered.warnings).toEqual([{ message: S3_AGENT_FAILURE_SENTENCES.notFoundNote }]);
    expect(JSON.stringify(answered)).not.toContain("delete");
  });

  test("a 404 the server names as a missing bucket is refused as one", async () => {
    const { run } = harness(() => ({ status: 404, headers: [["x-minio-error-code", "NoSuchBucket"]] }));
    const failure = await run({ op: "head-object", bucket: "s", key: "k" }).catch((e: unknown) => e);
    expect(s3AgentFailure(failure, BUDGET)?.message).toBe(S3_AGENT_FAILURE_SENTENCES.missingBucket);
  });
});

describe("the budgets of an answer", () => {
  test("an answer of exactly the byte budget is returned; one byte more is refused", async () => {
    const answer: S3AgentAnswer = { op: "get-bucket-location", bucket: "sales", location: "us-east-1" };
    const bytes = Buffer.byteLength(JSON.stringify([{ bucket: "sales", location: "us-east-1" }]), "utf8");
    expect(result(answer, { ...BUDGET, maxResultBytes: bytes }).rowCount).toBe(1);
    const over = (() => {
      try {
        return result(answer, { ...BUDGET, maxResultBytes: bytes - 1 });
      } catch (error) {
        return error;
      }
    })();
    expect((over as Error).message.startsWith(BYTE_BUDGET_PREFIX)).toBe(true);
  });

  test("the capability states every operation's columns and kinds", () => {
    expect(Object.keys(S3_METADATA_ONLY)).toEqual([
      "list-buckets",
      "head-bucket",
      "get-bucket-location",
      "get-bucket-versioning",
      "summary",
      "head-object",
    ]);
    expect(S3_METADATA_ONLY["head-object"]).toEqual([
      { column: "bucket", kind: "name" },
      { column: "exists", kind: "flag" },
      { column: "size_bytes", kind: "count" },
      { column: "last_modified", kind: "name" },
      { column: "storage_class", kind: "name" },
    ]);
  });
});

describe("the wording of a failure", () => {
  const server = (fields: Partial<ConstructorParameters<typeof S3ServerError>[0]>) =>
    new S3ServerError({ operation: "ListObjectsV2", method: "GET", status: 403, ...fields });

  test("a refusal by the server is worded by its status, never its message, key or bucket", () => {
    const failure = s3AgentFailure(
      server({ status: 403, code: "AccessDenied", message: `Access Denied to ${MARKER}`, key: MARKER }),
      BUDGET,
      "statement",
    );
    expect(failure?.message).toBe(S3_AGENT_FAILURE_SENTENCES.denied);
    expect(failure?.query).toBe("statement");
    for (const [status, sentence] of [
      [401, S3_AGENT_FAILURE_SENTENCES.denied],
      [404, S3_AGENT_FAILURE_SENTENCES.missingBucket],
      [301, S3_AGENT_FAILURE_SENTENCES.region],
      [501, S3_AGENT_FAILURE_SENTENCES.unsupported],
      [400, S3_AGENT_FAILURE_SENTENCES.status(400)],
      [503, S3_AGENT_FAILURE_SENTENCES.status(503)],
    ] as const) {
      expect(s3AgentFailure(server({ status, message: MARKER }), BUDGET)?.message).toBe(sentence);
    }
  });

  test("an answer that is not S3 metadata, a cut or defective page included, quotes nothing of it", () => {
    for (const problem of [
      { kind: "not-s3" },
      { kind: "page", what: `the key ${MARKER} twice` },
      { kind: "token" },
      { kind: "compressed", contentEncoding: "gzip" },
    ] as const) {
      const failure = s3AgentFailure(server({ status: 200, problem }), BUDGET);
      expect(failure?.message).toBe(S3_AGENT_FAILURE_SENTENCES.unreadable);
    }
  });

  test("the deadline and a permit wait it ended are the time budget's refusal", () => {
    const expected = `${TIME_BUDGET_PREFIX}: no answer within 5000ms`;
    expect(s3AgentFailure(new TransportError("timeout", "x"), BUDGET)?.message).toBe(expected);
    expect(s3AgentFailure(new DOMException("t", "TimeoutError"), BUDGET)?.message).toBe(expected);
  });

  test("a transport failure is worded by its kind, never by its message", () => {
    expect(s3AgentFailure(new TransportError("unreachable", `connect ${MARKER}`), BUDGET)?.message).toBe(
      S3_AGENT_FAILURE_SENTENCES.unreachable,
    );
    expect(s3AgentFailure(new TransportError("too-large", MARKER), BUDGET)?.message).toBe(
      S3_AGENT_FAILURE_SENTENCES.tooLarge,
    );
    expect(s3AgentFailure(new TransportError("aborted", MARKER), BUDGET)?.message).toBe(
      S3_AGENT_FAILURE_SENTENCES.closed,
    );
    expect(s3AgentFailure(new DOMException("a", "AbortError"), BUDGET)?.message).toBe(
      S3_AGENT_FAILURE_SENTENCES.closed,
    );
  });

  test("an answer that fits no column is the projection's own sentence", () => {
    const error = new MetadataProjectionError("bucket", "name");
    expect(s3AgentFailure(error, BUDGET)?.message).toBe(error.message);
  });

  test("Studio's own refusals and defects pass unchanged", () => {
    expect(s3AgentFailure(new QueryError("own"), BUDGET)).toBeUndefined();
    expect(s3AgentFailure(new Error("defect"), BUDGET)).toBeUndefined();
  });
});
