/**
 * The agent's S3 client (`createS3AgentClient` in `client.ts`): six reads and no other member, each pinned to the full
 * request it sends (method, path and query), the two HEADs sent alone with no follow-up GET, and one limiter permit
 * per read.
 */
import { describe, expect, test } from "bun:test";
import {
  createS3AgentClient,
  S3_AGENT_CLIENT_MEMBERS,
  type S3AgentClient,
} from "@/lib/db/providers/objectstore/s3/client";
import { S3ServerError } from "@/lib/db/providers/objectstore/s3/errors";
import type { LimiterTicket, ProviderLimiter } from "@/lib/db/utils/bounded-limiter";
import {
  bucketsXml,
  type FakeS3Handler,
  fakeS3Transport,
  objectsXml,
  TEST_TRANSPORT_OPTIONS,
  xmlAnswer,
} from "../../../helpers/s3-fake-transport";

function countingLimiter(): ProviderLimiter & { granted: number } {
  const limiter = {
    granted: 0,
    async acquire(): Promise<LimiterTicket> {
      limiter.granted += 1;
      return { release: () => undefined };
    },
  };
  return limiter as unknown as ProviderLimiter & { granted: number };
}

const call = () => ({ signal: new AbortController().signal, deadline: Date.now() + 10_000 });

function agentClient(handler: FakeS3Handler) {
  const fake = fakeS3Transport(handler);
  const limiter = countingLimiter();
  const client: S3AgentClient = createS3AgentClient(fake.createTransport(TEST_TRANSPORT_OPTIONS), limiter);
  return { client, fake, limiter };
}

const ok =
  (body: string): FakeS3Handler =>
  () =>
    xmlAnswer(body);

describe("the agent client's members", () => {
  test("are the six reads, and no write, object read, listing filter, tagging or version read", () => {
    const { client } = agentClient(ok(""));
    expect(Object.keys(client).sort()).toEqual([...S3_AGENT_CLIENT_MEMBERS].sort());
    expect([...S3_AGENT_CLIENT_MEMBERS]).toEqual([
      "listBuckets",
      "headBucket",
      "getBucketLocation",
      "getBucketVersioning",
      "listBucketPage",
      "headObject",
    ]);
    expect(Object.isFrozen(client)).toBe(true);
  });
});

describe("the full request of each read", () => {
  test("the bucket listing", async () => {
    const { client, fake, limiter } = agentClient(ok(bucketsXml(["a", "b"])));
    const listing = await client.listBuckets(call());
    expect(listing.buckets.map((bucket) => bucket.name)).toEqual(["a", "b"]);
    expect(fake.lines()).toEqual(["GET /?max-buckets=10000"]);
    expect(limiter.granted).toBe(1);
  });

  test("a bucket's head is one HEAD, with the region header read", async () => {
    const { client, fake } = agentClient(() => ({ status: 200, headers: [["x-amz-bucket-region", "eu-central-1"]] }));
    expect(await client.headBucket("sales", call())).toEqual({ bucketRegion: "eu-central-1" });
    expect(fake.lines()).toEqual(["HEAD /sales"]);
  });

  test("a region header that is not a region name is answered as no region, never as the header's text", async () => {
    const { client } = agentClient(() => ({ status: 200, headers: [["x-amz-bucket-region", "tenant-marker/x.csv"]] }));
    expect(await client.headBucket("sales", call())).toEqual({ bucketRegion: null });
  });

  test("a failed bucket head sends no follow-up GET", async () => {
    const { client, fake } = agentClient(() => ({ status: 404 }));
    const failure = await client.headBucket("sales", call()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(S3ServerError);
    expect((failure as S3ServerError).status).toBe(404);
    expect(fake.lines()).toEqual(["HEAD /sales"]);
  });

  test("a bucket's location and versioning", async () => {
    const location = agentClient(ok('<?xml version="1.0"?><LocationConstraint>eu-central-1</LocationConstraint>'));
    expect(await location.client.getBucketLocation("sales", call())).toBe("eu-central-1");
    expect(location.fake.lines()).toEqual(["GET /sales?location="]);

    const versioning = agentClient(
      ok('<?xml version="1.0"?><VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>'),
    );
    expect(await versioning.client.getBucketVersioning("sales", call())).toEqual({
      status: "Enabled",
      mfaDelete: null,
    });
    expect(versioning.fake.lines()).toEqual(["GET /sales?versioning="]);
  });

  test("a whole-bucket page carries an empty prefix, no delimiter, and the token Studio holds", async () => {
    const { client, fake } = agentClient(ok(objectsXml({ keys: ["a"], truncated: true, token: "t+1" })));
    await client.listBucketPage({ bucket: "sales", maxKeys: 1000 }, call());
    await client.listBucketPage({ bucket: "sales", maxKeys: 7, continuationToken: "t+1" }, call());
    expect(fake.lines()).toEqual([
      "GET /sales?encoding-type=url&list-type=2&max-keys=1000&prefix=",
      "GET /sales?continuation-token=t%2B1&encoding-type=url&list-type=2&max-keys=7&prefix=",
    ]);
  });

  test("an object's head is one HEAD of the exact key, encoded, with no Range and no follow-up GET", async () => {
    const { client, fake } = agentClient(() => ({ status: 200, headers: [["content-length", "12"]] }));
    const head = await client.headObject("sales", "a b/../%2e%2e/x.txt", call());
    expect(head.size).toBe(12);
    expect(fake.lines()).toEqual(["HEAD /sales/a%20b/../%252e%252e/x.txt"]);
    expect(fake.exchanges[0].request.headers).toBeUndefined();

    const missing = agentClient(() => ({ status: 403 }));
    const failure = await missing.client.headObject("sales", "a.txt", call()).catch((error: unknown) => error);
    expect((failure as S3ServerError).status).toBe(403);
    expect(missing.fake.lines()).toEqual(["HEAD /sales/a.txt"]);
  });

  test("a MinIO error code on a HEAD is read from its header", async () => {
    const { client } = agentClient(() => ({ status: 404, headers: [["x-minio-error-code", "NoSuchBucket"]] }));
    const failure = (await client
      .headObject("sales", "a.txt", call())
      .catch((error: unknown) => error)) as S3ServerError;
    expect(failure.code).toBe("NoSuchBucket");
  });

  test("a failed HEAD with a body is read as one with no body", async () => {
    const { client } = agentClient(() => ({ status: 500, body: "<Error><Code>X</Code></Error>" }));
    const failure = (await client
      .headObject("sales", "a.txt", call())
      .catch((error: unknown) => error)) as S3ServerError;
    expect(failure.status).toBe(500);
  });
});
