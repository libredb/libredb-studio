/**
 * The S3 provider's lifecycle: the one transport of a session and its options,
 * signing only with typed keys and through the constructor's dependencies, nothing read from the environment, a
 * failed connect that closes its transport, disconnect during a request, the deadline sentence, and maintenance
 * refused before any request. Tasks 19 to 21 and 23 add their cases to this file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { ConnectionError, DatabaseConfigError, QueryError, TimeoutError } from "@/lib/db/errors";
import type { RequestSigner } from "@/lib/db/http/node-transport";
import { S3_SURFACE_DEADLINE_MS } from "@/lib/db/providers/objectstore/s3/constants";
import { encodeS3Cursor } from "@/lib/db/providers/objectstore/s3/cursor";
import { S3_RESPONSE_HEADERS } from "@/lib/db/providers/objectstore/s3/headers";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import type { DatabaseConnection } from "@/lib/types";
import { s3Connection } from "../../../helpers/s3-connection";
import {
  bucketsXml,
  type FakeS3Handler,
  fakeS3Transport,
  objectsXml,
  xmlAnswer,
} from "../../../helpers/s3-fake-transport";

const BUCKETS: FakeS3Handler = () => xmlAnswer(bucketsXml(["sales"]));
const FIXED = new Date("2026-10-09T13:14:43.000Z");

function provider(handler: FakeS3Handler, overrides: Partial<DatabaseConnection> = {}, queryTimeout?: number) {
  const fake = fakeS3Transport(handler);
  const s3 = new S3Provider(
    s3Connection(overrides),
    queryTimeout === undefined ? {} : { queryTimeout },
    {},
    {
      createTransport: fake.createTransport,
      clock: () => FIXED,
    },
  );
  return { s3, fake };
}

describe("the transport of a session", () => {
  test("built once at connect with the session's options and the provider's signer", async () => {
    const { s3, fake } = provider(BUCKETS);
    await s3.connect();
    expect(fake.built).toHaveLength(1);
    const { signer, ...options } = fake.built[0];
    expect(options).toEqual({
      origin: { scheme: "http", host: "localhost", port: 9000 },
      tls: null,
      maxSockets: 4,
      headers: {},
      requestHeaderNames: ["range"],
      responseHeaders: S3_RESPONSE_HEADERS,
    });
    expect(signer?.headerNames).toEqual(["authorization", "x-amz-date", "x-amz-content-sha256"]);
    expect(fake.exchanges[0].signing?.headers["x-amz-date"]).toBe("20261009T131443Z");
  });

  test("a blank key pair passes no signer, so nothing is signed", async () => {
    const { s3, fake } = provider(BUCKETS, { user: "", password: "" });
    await s3.connect();
    expect(fake.built[0].signer).toBeUndefined();
    expect(fake.exchanges[0].signing).toBeNull();
  });

  test("the signer wrapper sees the signer the provider built", async () => {
    const fake = fakeS3Transport(BUCKETS);
    const wrapped: RequestSigner[] = [];
    const s3 = new S3Provider(
      s3Connection(),
      {},
      {},
      {
        createTransport: fake.createTransport,
        signerWrapper: (signer) => {
          wrapped.push(signer);
          return signer;
        },
      },
    );
    await s3.connect();
    expect(wrapped).toHaveLength(1);
    expect(fake.built[0].signer).toBe(wrapped[0]);
  });

  test("a second connect closes the first session's transport", async () => {
    const { s3, fake } = provider(BUCKETS);
    await s3.connect();
    await s3.connect();
    expect(fake.built).toHaveLength(2);
    expect(fake.closed.count).toBe(1);
    await s3.disconnect();
    expect(fake.closed.count).toBe(2);
    await s3.disconnect();
    expect(fake.closed.count).toBe(2);
  });

  test("a refused connection builds no transport", async () => {
    const { s3, fake } = provider(BUCKETS, { region: "us east" });
    await expect(s3.connect()).rejects.toThrow(
      "Region must be 1 to 64 letters, digits, hyphens or underscores, such as us-east-1. Nothing was sent.",
    );
    expect(fake.built).toHaveLength(0);
  });
});

describe("nothing ambient", () => {
  const names = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_REGION",
  ] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  afterEach(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  test("environment credentials and region change nothing sent", async () => {
    const send = async () => {
      const { s3, fake } = provider(BUCKETS, { user: "", password: "" });
      await s3.connect();
      return {
        lines: fake.lines(),
        signing: fake.exchanges.map((exchange) => exchange.signing),
        headers: fake.exchanges.map((exchange) => exchange.request.headers),
      };
    };
    const before = await send();
    process.env.AWS_ACCESS_KEY_ID = "AKIDFROMENVIRONMENT";
    process.env.AWS_SECRET_ACCESS_KEY = "secret-from-environment";
    process.env.AWS_SESSION_TOKEN = "token-from-environment";
    process.env.AWS_PROFILE = "default";
    process.env.AWS_REGION = "eu-west-1";
    expect(await send()).toEqual(before);
  });
});

describe("deadlines and disconnect", () => {
  test("a surface call past the query timeout is E1, naming the deadline", async () => {
    let calls = 0;
    const { s3 } = provider(
      (request) => {
        calls += 1;
        return calls === 1 ? BUCKETS(request) : new Promise<never>(() => {});
      },
      {},
      1_000,
    );
    await s3.connect();
    const error = await s3.getOverview().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toBe(
      "The S3 server at http://localhost:9000 did not answer list buckets within 1 seconds; nothing was retried.",
    );
  });

  test("disconnect during a request is E3", async () => {
    let calls = 0;
    const { s3 } = provider((request) => {
      calls += 1;
      return calls === 1 ? BUCKETS(request) : new Promise<never>(() => {});
    });
    await s3.connect();
    const pending = s3.getOverview().catch((caught: unknown) => caught);
    await s3.disconnect();
    const error = await pending;
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toBe("The connection was closed while a request to the S3 server was in flight.");
  });
});

test("maintenance is refused in the label's words, with no request", async () => {
  const { s3, fake } = provider(BUCKETS);
  const error = await (s3 as BaseDatabaseProvider).runMaintenance("vacuum").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(QueryError);
  expect((error as Error).message).toBe("Studio sends an S3 server no maintenance: this version only reads.");
  expect(fake.exchanges).toHaveLength(0);
});

describe("PR 3 review focus: an empty Region", () => {
  test.each([[undefined], [""]])("Region %p signs for us-east-1", async (region) => {
    const { s3, fake } = provider(BUCKETS, { region });
    await s3.connect();
    expect(fake.exchanges[0].signing?.headers.authorization).toContain(
      "Credential=AKIDTESTKEY/20261009/us-east-1/s3/aws4_request,",
    );
  });

  test("a typed Region signs for that Region", async () => {
    const { s3, fake } = provider(BUCKETS, { region: "garage" });
    await s3.connect();
    expect(fake.exchanges[0].signing?.headers.authorization).toContain(
      "Credential=AKIDTESTKEY/20261009/garage/s3/aws4_request,",
    );
  });
});

describe("the object surface", () => {
  test("no container level, bucket rows from one ListBuckets, describe with no request", async () => {
    const { s3, fake } = provider(() => xmlAnswer(bucketsXml(["sales", "archive"])));
    await s3.connect();
    expect(await s3.listContainers()).toEqual([]);
    await expect(s3.countObjects(["x"])).rejects.toThrow('An S3 connection has no container level; received ["x"]');
    expect(await s3.countObjects([])).toEqual({ bucket: { count: 2 } });
    expect((await s3.listObjects([], "bucket")).map((row) => row.name)).toEqual(["archive", "sales"]);
    await s3.listObjects([], "bucket");
    expect(await s3.describeObject(["sales"], "bucket")).toEqual({
      path: ["sales"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect(await s3.describeObjects([], "bucket")).toEqual({ details: [] });
    // The connect probe, then one ListBuckets for the count that the first listing reuses, then the second listing's own.
    expect(fake.lines()).toEqual(Array(3).fill("GET /?max-buckets=10000"));
  });

  test("a count hands its bucket list to the next bucket listing once, and never after the surface deadline", async () => {
    let now = Date.parse("2026-10-09T10:00:00Z");
    const fake = fakeS3Transport(() => xmlAnswer(bucketsXml(["sales"])));
    const s3 = new S3Provider(
      s3Connection(),
      {},
      {},
      { createTransport: fake.createTransport, clock: () => new Date(now) },
    );
    await s3.connect();
    const before = fake.exchanges.length;
    await s3.countObjects([]);
    await s3.listObjects([], "bucket");
    expect(fake.exchanges.length - before).toBe(1);
    await s3.listObjects([], "bucket");
    expect(fake.exchanges.length - before).toBe(2);
    await s3.countObjects([]);
    now += S3_SURFACE_DEADLINE_MS + 1;
    await s3.listObjects([], "bucket");
    expect(fake.exchanges.length - before).toBe(4);
    await s3.countObjects([]);
    await s3.disconnect();
    await s3.connect();
    const reconnected = fake.exchanges.length;
    await s3.listObjects([], "bucket");
    expect(fake.exchanges.length - reconnected).toBe(1);
  });

  test("a pinned connection reads its bucket with no request after connect", async () => {
    const { s3, fake } = provider(() => xmlAnswer(objectsXml({})), { database: "sales" });
    await s3.connect();
    expect(await s3.countObjects([])).toEqual({ bucket: { count: 1 } });
    expect(await s3.listObjects([], "bucket")).toEqual([{ path: ["sales"], name: "sales", kind: "bucket" }]);
    expect(fake.exchanges).toHaveLength(1);
  });
});

describe("the Keys panel through the provider", () => {
  test("an option refusal sends nothing", async () => {
    const { s3, fake } = provider(BUCKETS);
    await s3.connect();
    const error = await s3.scanKeysPage({ cursor: "0", count: 0, level: true }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(fake.exchanges).toHaveLength(1);
  });

  test("a cursor written by one provider instance is accepted by another for the same connection", async () => {
    const page = () => xmlAnswer(objectsXml({ keys: ["a.csv"], truncated: true, token: "server-token" }));
    const first = provider(page, { database: "sales" });
    await first.s3.connect();
    const written = await first.s3.scanKeysPage({ cursor: "0", count: 1, pattern: "sales/", level: true });
    expect(written.cursor).toBe(encodeS3Cursor({ bucket: "sales", prefix: "", level: true, token: "server-token" }));
    // Another replica, a restart or an idle eviction: a new instance with no state of the first.
    const second = provider(page, { database: "sales" });
    await second.s3.connect();
    await second.s3.scanKeysPage({ cursor: written.cursor, count: 1, pattern: "sales/", level: true });
    expect(second.fake.lines()[1]).toContain("continuation-token=server-token");
    await first.s3.disconnect();
    await first.s3.connect();
    await first.s3.scanKeysPage({ cursor: written.cursor, count: 1, pattern: "sales/", level: true });
    expect(first.fake.lines().at(-1)).toContain("continuation-token=server-token");
  });
});
