/**
 * S3Provider under the agent profiles: `queryReadOnly` only on a handle the agent read-only profile opened, every
 * command outside the closed table refused before anything is sent, and on a handle of either agent profile every
 * surface read through the agent's client, with keys, the endpoint and every value withheld. The fake server answers
 * every listing with a key that carries a marker, every HEAD with an ETag, a version id, user metadata and a tag
 * count that carry one, and every error with a body that names one, so each answer is searched for the marker.
 */
// oxlint-disable no-await-in-loop -- each surface runs after the one before, so each refusal and each recorded request is its own.
import { describe, expect, test } from "bun:test";
import { QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { S3_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/objectstore/s3/agent-metadata-read";
import { S3_AGENT_SENTENCES } from "@/lib/db/providers/objectstore/s3/agent-statement";
import { S3_AGENT_SHAPE, S3_AGENT_WITHHELD } from "@/lib/db/providers/objectstore/s3/agent-surface";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import { TIME_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { s3Connection } from "../../../helpers/s3-connection";
import {
  bucketsXml,
  errorXml,
  type FakeS3Handler,
  fakeS3Transport,
  objectsXml,
  xmlAnswer,
} from "../../../helpers/s3-fake-transport";

const MARKER = "tenant-marker";
const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 200, maxResultBytes: 1_000_000, statementTimeoutMs: 5_000 };
const READ_ONLY: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true, sendsStatements: false };

/** A server whose every answer that could carry a value carries the marker. */
const SERVER: FakeS3Handler = (request) => {
  const { path, query } = request.target;
  if (path === "/") return xmlAnswer(bucketsXml(["archive", "sales"]));
  if (request.method === "HEAD" && path.split("/").length > 2)
    return {
      status: 200,
      headers: [
        ["content-length", "7"],
        ["last-modified", "Fri, 09 Oct 2026 13:13:17 GMT"],
        ["etag", `"${MARKER}-etag"`],
        ["x-amz-version-id", `${MARKER}-version`],
        ["x-amz-meta-owner", `${MARKER}-meta`],
        ["x-amz-tagging-count", "1"],
      ],
    };
  if (request.method === "HEAD") return { status: 200, headers: [["x-amz-bucket-region", "us-east-1"]] };
  if (query.includes("location")) return xmlAnswer("<LocationConstraint>us-east-1</LocationConstraint>");
  if (query.includes("versioning"))
    return xmlAnswer("<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>");
  if (query.includes("list-type=2")) return xmlAnswer(objectsXml({ keys: [{ key: `${MARKER}/a.csv`, size: 3 }] }));
  return xmlAnswer(errorXml("AccessDenied", `no access to ${MARKER}`), 403);
};

async function provider(
  execution: ProviderExecutionContext,
  overrides: Partial<DatabaseConnection> = {},
  handler: FakeS3Handler = SERVER,
) {
  const fake = fakeS3Transport(handler);
  const s3 = new S3Provider(s3Connection(overrides), {}, execution, { createTransport: fake.createTransport });
  await s3.connect();
  const connected = fake.lines().length;
  return { s3, fake, sent: () => fake.lines().slice(connected) };
}

const failureOf = async (work: Promise<unknown>): Promise<Error> => {
  const outcome = await work.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error("expected a failure");
  return outcome;
};

describe("queryReadOnly's profile", () => {
  test.each([
    ["an editor handle", {}],
    ["an operations handle", OPERATIONS],
  ] as const)("is refused on %s, before anything is sent", async (_name, execution) => {
    const { s3, sent } = await provider(execution);
    const failure = await failureOf(s3.queryReadOnly("aws s3api list-buckets", BUDGET));
    expect(failure).toBeInstanceOf(RefusedBeforeSendError);
    expect(failure.message).toBe("Read-only execution requires a provider opened under the agent read-only profile");
    expect(sent()).toEqual([]);
  });

  test("is refused before connect", async () => {
    const s3 = new S3Provider(s3Connection(), {}, READ_ONLY, {
      createTransport: fakeS3Transport(SERVER).createTransport,
    });
    expect((await failureOf(s3.queryReadOnly("aws s3api list-buckets", BUDGET))).message).toContain("connect");
  });

  test("an estimate and a budget out of range are refused before anything is sent", async () => {
    const { s3, sent } = await provider(READ_ONLY);
    expect((await failureOf(s3.queryReadOnly("aws s3api list-buckets", BUDGET, "estimate-plan"))).message).toBe(
      "S3 composes no estimating plan for the agent",
    );
    await failureOf(s3.queryReadOnly("aws s3api list-buckets", { ...BUDGET, maxResultRows: 0 }));
    expect(sent()).toEqual([]);
  });
});

describe("the agent's reads on the agent read-only profile", () => {
  test("each read sends exactly its pinned requests and answers no key, ETag, version, metadata or endpoint", async () => {
    const { s3, sent } = await provider(READ_ONLY);
    const reads: readonly [string, readonly string[]][] = [
      ["aws s3api list-buckets", ["GET /?max-buckets=10000"]],
      ["aws s3api head-bucket --bucket sales", ["HEAD /sales"]],
      ["aws s3api get-bucket-location --bucket sales", ["GET /sales?location="]],
      ["aws s3api get-bucket-versioning --bucket sales", ["GET /sales?versioning="]],
      [
        "aws s3 ls s3://sales --recursive --summarize",
        ["GET /sales?encoding-type=url&list-type=2&max-keys=200&prefix="],
      ],
      [`aws s3api head-object --bucket sales --key ${MARKER}/a.csv`, [`HEAD /sales/${MARKER}/a.csv`]],
    ];
    for (const [statement, requests] of reads) {
      const before = sent().length;
      const result = await s3.queryReadOnly(statement, BUDGET);
      expect(sent().slice(before)).toEqual([...requests]);
      const text = JSON.stringify(result);
      expect(text).not.toContain(MARKER);
      expect(text).not.toContain("localhost");
      expect(text).not.toContain("9000");
    }
    expect(sent().every((line) => line.startsWith("GET ") || line.startsWith("HEAD "))).toBe(true);
  });

  test("the summary and the object head answer their facts", async () => {
    const { s3 } = await provider(READ_ONLY);
    expect((await s3.queryReadOnly("aws s3 ls s3://sales/ --recursive --summarize", BUDGET)).rows).toEqual([
      { bucket: "sales", objects: 1, total_size_bytes: 3 },
    ]);
    expect((await s3.queryReadOnly("aws s3api head-object --bucket sales --key k", BUDGET)).rows).toEqual([
      { bucket: "sales", exists: true, size_bytes: 7, last_modified: "2026-10-09T13:13:17.000Z", storage_class: null },
    ]);
  });

  test.each([
    "aws s3api list-objects-v2 --bucket sales",
    "aws s3api list-objects-v2 --bucket sales --prefix a",
    "aws s3api list-object-versions --bucket sales",
    "aws s3api get-object-tagging --bucket sales --key a",
    "preview s3://sales/a.csv",
    "aws s3api get-object --bucket sales --key a out",
    "aws s3 ls s3://sales/a --recursive --summarize",
    "aws s3api head-object --bucket sales --key a --region us-east-1",
    "aws s3api head-bucket --bucket sales --endpoint-url http://evil.example:9000",
    "aws s3api put-object --bucket sales --key a",
  ])("%s is refused before anything is sent", async (statement) => {
    const { s3, sent } = await provider(READ_ONLY);
    const failure = await failureOf(s3.queryReadOnly(statement, BUDGET));
    expect(failure).toBeInstanceOf(RefusedBeforeSendError);
    expect(failure.message).toContain(S3_AGENT_SENTENCES.reads);
    expect(sent()).toEqual([]);
  });

  test("a pinned connection refuses another bucket and lists its own with no request", async () => {
    const { s3, sent } = await provider(READ_ONLY, { database: "sales" });
    const failure = await failureOf(s3.queryReadOnly("aws s3api head-bucket --bucket archive", BUDGET));
    expect(failure).toBeInstanceOf(RefusedBeforeSendError);
    const listed = await s3.queryReadOnly("aws s3api list-buckets", BUDGET);
    expect(listed.rows).toEqual([{ bucket: "sales", created: null }]);
    expect(sent()).toEqual([]);
  });

  test("a server's refusal is worded by its status, never by its body", async () => {
    const { s3 } = await provider(READ_ONLY, {}, (request) =>
      request.target.path === "/"
        ? xmlAnswer(bucketsXml(["sales"]))
        : xmlAnswer(errorXml("AccessDenied", `Access Denied for ${MARKER}`), 403),
    );
    const failure = await failureOf(s3.queryReadOnly("aws s3api get-bucket-location --bucket sales", BUDGET));
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure.message).toBe(S3_AGENT_FAILURE_SENTENCES.denied);
  });

  test("a server that does not answer within the time budget is the time budget's refusal", async () => {
    const { s3 } = await provider(READ_ONLY, {}, (request) =>
      request.target.path === "/" ? xmlAnswer(bucketsXml(["sales"])) : new Promise(() => undefined),
    );
    const failure = await failureOf(
      s3.queryReadOnly("aws s3api head-bucket --bucket sales", { ...BUDGET, statementTimeoutMs: 20 }),
    );
    expect(failure.message).toBe(`${TIME_BUDGET_PREFIX}: no answer within 20ms`);
  });

  test("nothing of one read reaches the next: each summary starts at the bucket's first page", async () => {
    let page = 0;
    const { s3, sent } = await provider(READ_ONLY, {}, (request) => {
      if (request.target.path === "/") return xmlAnswer(bucketsXml(["sales"]));
      page += 1;
      return xmlAnswer(objectsXml(page % 2 === 1 ? { keys: ["a"], truncated: true, token: "t2" } : { keys: ["b"] }));
    });
    await s3.queryReadOnly("aws s3 ls s3://sales --recursive --summarize", BUDGET);
    await s3.queryReadOnly("aws s3 ls s3://sales --recursive --summarize", BUDGET);
    expect(sent().filter((line) => line.includes("continuation-token"))).toHaveLength(2);
    expect(sent().filter((line) => !line.includes("continuation-token"))).toHaveLength(2);
    expect(S3_AGENT_FAILURE_SENTENCES.summaryOverRows(1)).not.toContain(MARKER);
  });
});

describe("the other surfaces of an agent-mode handle", () => {
  test.each([
    ["the read-only profile", READ_ONLY],
    ["the operations profile", OPERATIONS],
  ] as const)(
    "on %s, buckets are listed by name and keys, sources, the console and readings are withheld",
    async (_name, execution) => {
      const { s3, sent } = await provider(execution);
      expect(await s3.countObjects([])).toEqual({ bucket: { count: 2 } });
      expect((await s3.listObjects([], "bucket")).map((object) => object.name)).toEqual(["archive", "sales"]);
      // Nothing is handed from the count to the listing: each read the bucket list itself.
      expect(sent()).toEqual(["GET /?max-buckets=10000", "GET /?max-buckets=10000"]);
      const before = sent().length;
      const refusals: [Promise<unknown>, string][] = [
        [s3.listObjects([], "object"), S3_AGENT_WITHHELD.objects],
        [s3.listObjects([], "table"), S3_AGENT_SHAPE.kind],
        [s3.listObjects(["x"], "bucket"), S3_AGENT_SHAPE.container],
        [s3.countObjects(["x"]), S3_AGENT_SHAPE.container],
        [s3.readObjectSource(["sales"], "bucket"), S3_AGENT_WITHHELD.source],
        [s3.readObjectSource([`sales/${MARKER}`], "object"), S3_AGENT_WITHHELD.source],
        [s3.scanKeysPage({ count: 10 } as never), S3_AGENT_WITHHELD.keys],
        [s3.query("aws s3 ls s3://sales/"), S3_AGENT_WITHHELD.query],
        [s3.getOverview(), S3_AGENT_WITHHELD.overview],
        [s3.getStorageStats(), S3_AGENT_WITHHELD.storage],
        [s3.getTableStats(), S3_AGENT_WITHHELD.tableStats],
        [s3.getIndexStats(), S3_AGENT_WITHHELD.indexStats],
        [s3.getSlowQueries(), S3_AGENT_WITHHELD.slowQueries],
        [s3.getActiveSessions(), S3_AGENT_WITHHELD.sessions],
        [s3.getPerformanceMetrics(), S3_AGENT_WITHHELD.performance],
      ];
      for (const [work, sentence] of refusals) {
        const failure = await failureOf(work);
        expect(failure).toBeInstanceOf(QueryError);
        expect(failure.message).toBe(sentence);
      }
      expect(sent().slice(before)).toEqual([]);
      expect(await s3.getHealth()).toEqual({
        databaseSize: S3_AGENT_WITHHELD.databaseSize,
        cacheHitRatio: "N/A",
        slowQueries: [],
        activeSessions: [],
      });
      expect(sent().slice(before)).toEqual(["GET /?max-buckets=10000"]);
    },
  );

  test("the editor's console refusal is Studio's, raised before anything is sent", async () => {
    const { s3 } = await provider(READ_ONLY);
    expect(await failureOf(s3.query("aws s3 ls s3://sales/"))).toBeInstanceOf(RefusedBeforeSendError);
  });

  test("a pinned agent handle probes its bucket with a whole-bucket page of one entry and counts it with no request", async () => {
    const fake = fakeS3Transport(SERVER);
    const s3 = new S3Provider(s3Connection({ database: "sales" }), {}, OPERATIONS, {
      createTransport: fake.createTransport,
    });
    await s3.connect();
    expect(fake.lines()).toEqual(["GET /sales?encoding-type=url&list-type=2&max-keys=1&prefix="]);
    expect(await s3.countObjects([])).toEqual({ bucket: { count: 1 } });
    expect(await s3.listObjects([], "bucket")).toEqual([{ path: ["sales"], name: "sales", kind: "bucket" }]);
    await s3.getHealth();
    expect(fake.lines()).toEqual([
      "GET /sales?encoding-type=url&list-type=2&max-keys=1&prefix=",
      "GET /sales?encoding-type=url&list-type=2&max-keys=1&prefix=",
    ]);
  });

  test("a sessionless health check on an agent handle opens with the agent's probe", async () => {
    const fake = fakeS3Transport(SERVER);
    const s3 = new S3Provider(s3Connection(), {}, OPERATIONS, { createTransport: fake.createTransport });
    expect((await s3.getHealth()).databaseSize).toBe(S3_AGENT_WITHHELD.databaseSize);
    expect(fake.lines()).toEqual(["GET /?max-buckets=10000"]);
  });

  test("a surface's server failure is worded by its status, never by the server's words", async () => {
    let calls = 0;
    const { s3 } = await provider(OPERATIONS, {}, () => {
      calls += 1;
      return calls === 1
        ? xmlAnswer(bucketsXml(["sales"]))
        : xmlAnswer(errorXml("AccessDenied", `Access Denied for ${MARKER}`), 403);
    });
    const failure = await failureOf(s3.countObjects([]));
    expect(failure.message).toBe(S3_AGENT_FAILURE_SENTENCES.denied);
  });

  test("the capability states the metadata-only projection, and the editor handle keeps every surface", async () => {
    const { s3 } = await provider({});
    expect(Object.keys(s3.getCapabilities().metadataOnly ?? {})).toEqual([
      "list-buckets",
      "head-bucket",
      "get-bucket-location",
      "get-bucket-versioning",
      "summary",
      "head-object",
    ]);
    expect(await s3.getStorageStats()).toEqual([]);
    expect((await s3.readObjectSource(["sales"], "bucket")).parts.map((part) => part.id)).toEqual([
      "bucket",
      "location",
      "versioning",
    ]);
  });
});

describe("the connect probe of an agent-mode handle", () => {
  test("a refused probe is worded by its status, never by the server's words or the endpoint", async () => {
    const fake = fakeS3Transport(() => xmlAnswer(errorXml("AccessDenied", `Access Denied for ${MARKER}`), 403));
    const s3 = new S3Provider(s3Connection(), {}, READ_ONLY, { createTransport: fake.createTransport });
    const failure = await failureOf(s3.connect());
    expect(failure.message).toBe(S3_AGENT_FAILURE_SENTENCES.denied);
    expect(fake.closed.count).toBe(1);
  });

  test("a defect in the probe is passed on as the editor's error table words it", async () => {
    const fake = fakeS3Transport(() => {
      throw new Error("a defect of ours");
    });
    const s3 = new S3Provider(s3Connection(), {}, OPERATIONS, { createTransport: fake.createTransport });
    const failure = await failureOf(s3.getHealth());
    expect(failure.message).not.toBe(S3_AGENT_FAILURE_SENTENCES.denied);
  });
});
