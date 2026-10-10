/**
 * Test Connection, health and the overview: the probe is one
 * ListObjectsV2 on the pin, else one ListBuckets, and its answer must parse as the S3 document, so no session is kept
 * for an endpoint that did not answer as S3; a 403 never claims the bucket exists.
 */
import { describe, expect, test } from "bun:test";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import { probeOperation, S3_NO_BUCKETS_WARNING } from "@/lib/db/providers/objectstore/s3/monitoring-reads";
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

const PROBE_LINE = "GET /sales?delimiter=%2F&encoding-type=url&list-type=2&max-keys=1&prefix=";
const HTML = { status: 200, body: "<html><body>MinIO Console</body></html>", contentType: "text/html" };

function provider(handler: FakeS3Handler, overrides: Partial<DatabaseConnection> = {}, queryTimeout?: number) {
  const fake = fakeS3Transport(handler);
  const s3 = new S3Provider(
    s3Connection(overrides),
    queryTimeout === undefined ? {} : { queryTimeout },
    {},
    { createTransport: fake.createTransport },
  );
  return { s3, fake };
}

async function connectFailure(handler: FakeS3Handler, overrides: Partial<DatabaseConnection> = {}) {
  const { s3, fake } = provider(handler, overrides);
  const error = await s3.connect().catch((caught: unknown) => caught);
  expect(s3.isConnected()).toBe(false);
  expect(fake.closed.count).toBe(1);
  return { error: error as Error, fake };
}

describe("the connect probe", () => {
  test("pinned: exactly one ListObjectsV2 with max-keys=1, delimiter=/ and encoding-type=url, and no HeadBucket", async () => {
    const { s3, fake } = provider(() => xmlAnswer(objectsXml({})), { database: "sales" });
    await s3.connect();
    expect(fake.lines()).toEqual([PROBE_LINE]);
    expect(s3.isConnected()).toBe(true);
    expect(probeOperation({ pinnedBucket: "sales" })).toBe("ListObjectsV2");
  });

  test("unpinned: one ListBuckets", async () => {
    const { s3, fake } = provider(() => xmlAnswer(bucketsXml(["sales"])));
    await s3.connect();
    expect(fake.lines()).toEqual(["GET /?max-buckets=10000"]);
    expect(probeOperation({})).toBe("ListBuckets");
  });

  test("a pinned probe answered 200 with HTML is E19 and keeps no session", async () => {
    const { error } = await connectFailure(() => HTML, { database: "sales" });
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      'The endpoint answered list bucket "sales" with something that is not an S3 answer: check that Port is the S3 API port (MinIO and RustFS serve their consoles on another port).',
    );
  });

  test("an unpinned probe answered 200 with HTML is E19 too", async () => {
    const { error } = await connectFailure(() => HTML);
    expect(error.message).toBe(
      "The endpoint answered list buckets with something that is not an S3 answer: check that Port is the S3 API port (MinIO and RustFS serve their consoles on another port).",
    );
  });

  test("a redirect at connect (Review Focus 2)", async () => {
    const { error } = await connectFailure(() => {
      throw new TransportError("redirect", "redirected", {
        redirect: { status: 307, headers: [], headersTruncated: false },
      });
    });
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toStartWith(
      "The endpoint answered list buckets with a redirect (HTTP 307), which Studio does not follow.",
    );
  });

  test("a pinned bucket the server does not have (Review Focus 3)", async () => {
    const { error } = await connectFailure(
      () => xmlAnswer(errorXml("NoSuchBucket", "The specified bucket does not exist"), 404),
      { database: "slaes" },
    );
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe('The server has no bucket "slaes".');
  });

  test("a pinned 403 names s3:ListBucket and never claims the bucket exists; an unpinned one names s3:ListAllMyBuckets", async () => {
    const pinned = await connectFailure(() => xmlAnswer(errorXml("AccessDenied", "Access Denied."), 403), {
      database: "sales",
    });
    expect(pinned.error.message).toBe(
      'This access key may not list bucket "sales" (s3:ListBucket). The server answers the same way for a bucket that does not exist, so this does not say that bucket "sales" exists.',
    );
    const unpinned = await connectFailure(() => xmlAnswer(errorXml("AccessDenied", "Access Denied."), 403));
    expect(unpinned.error.message).toContain("(s3:ListAllMyBuckets)");
  });

  test("Garage's wrong-region 400 to the pinned probe is E9", async () => {
    const { error } = await connectFailure(
      () =>
        xmlAnswer(
          errorXml("AuthorizationHeaderMalformed", "Authorization header malformed, unexpected scope", {
            region: "garage-probe",
          }),
          400,
        ),
      { database: "sales" },
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(
      "This server expects requests signed for region garage-probe, and this connection signs for us-east-1: set Region to garage-probe.",
    );
  });

  test("a wrong secret is E12", async () => {
    const { error } = await connectFailure(() => xmlAnswer(errorXml("SignatureDoesNotMatch", "no"), 403));
    expect(error).toBeInstanceOf(AuthenticationError);
  });

  test("zero buckets gives the connect warning, and none after disconnect", async () => {
    const { s3 } = provider(() => xmlAnswer(bucketsXml([])));
    await s3.connect();
    expect(s3.connectWarnings()).toEqual([{ message: S3_NO_BUCKETS_WARNING }]);
    expect(S3_NO_BUCKETS_WARNING).toBe(
      "This key lists no bucket. A key limited to one bucket may list none: put that bucket under Bucket.",
    );
    await s3.disconnect();
    expect(s3.connectWarnings()).toEqual([]);
  });

  test("a pinned connection and a key that lists buckets have no warning", async () => {
    const pinned = provider(() => xmlAnswer(objectsXml({})), { database: "sales" });
    await pinned.s3.connect();
    expect(pinned.s3.connectWarnings()).toEqual([]);
  });
});

describe("health and the overview", () => {
  test("health runs the probe and answers the honest shape, with no connection count", async () => {
    const { s3, fake } = provider(() => xmlAnswer(bucketsXml(["sales"])));
    await s3.connect();
    const health = await s3.getHealth();
    expect(health).toEqual({ databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] });
    expect(Object.hasOwn(health, "activeConnections")).toBe(false);
    expect(fake.lines()).toEqual(["GET /?max-buckets=10000", "GET /?max-buckets=10000"]);
  });

  test("health on a provider with no session opens one without the connect probe and keeps it", async () => {
    const { s3, fake } = provider(() => xmlAnswer(objectsXml({})), { database: "sales" });
    await s3.getHealth();
    expect(s3.isConnected()).toBe(true);
    expect(fake.lines()).toEqual([PROBE_LINE]);
    expect(fake.built).toHaveLength(1);
  });

  test("a failed health on a provider with no session closes what it opened", async () => {
    const { s3, fake } = provider(() => HTML);
    expect(await s3.getHealth().catch((caught: unknown) => caught)).toBeInstanceOf(QueryError);
    expect(s3.isConnected()).toBe(false);
    expect(fake.closed.count).toBe(1);
  });

  test("the overview runs the probe and answers no version, size or table", async () => {
    const { s3, fake } = provider(() => xmlAnswer(bucketsXml(["sales"])));
    await s3.connect();
    expect(await s3.getOverview()).toEqual({
      version: "N/A",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 0,
      indexCount: 0,
    });
    expect(fake.lines()).toHaveLength(2);
  });

  test("the empty panels answer [] once connected, and refuse before", async () => {
    const { s3, fake } = provider(() => xmlAnswer(bucketsXml(["sales"])));
    await expect(s3.getStorageStats()).rejects.toThrow("Provider is not connected. Call connect() first.");
    await s3.connect();
    expect(await s3.getStorageStats()).toEqual([]);
    expect(await s3.getTableStats()).toEqual([]);
    expect(await s3.getIndexStats()).toEqual([]);
    expect(await s3.getSlowQueries()).toEqual([]);
    expect(await s3.getActiveSessions()).toEqual([]);
    expect(await s3.getPerformanceMetrics()).toEqual({});
    expect(fake.lines()).toHaveLength(1);
  });
});

describe("PR 3 review focus: bucket names other servers allow", () => {
  test.each(["my.bucket", "Logs_2026", "a"])("the pinned bucket %p is probed by its literal name", async (bucket) => {
    const { s3, fake } = provider(() => xmlAnswer(objectsXml({})), { database: bucket });
    await s3.connect();
    expect(fake.lines()).toEqual([`GET /${bucket}?delimiter=%2F&encoding-type=url&list-type=2&max-keys=1&prefix=`]);
    expect(s3.isConnected()).toBe(true);
  });
});
