/**
 * The S3 provider's lifecycle: the one transport of a session and its options,
 * signing only with typed keys and through the constructor's dependencies, nothing read from the environment, a
 * failed connect that closes its transport, disconnect during a request, the deadline sentence, and maintenance
 * refused before any request. Tasks 19 to 21 and 23 add their cases to this file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { ConnectionError, DatabaseConfigError, QueryError, TimeoutError } from "@/lib/db/errors";
import type { NodeByteRequest, RequestSigner } from "@/lib/db/http/node-transport";
import { S3_SURFACE_DEADLINE_MS } from "@/lib/db/providers/objectstore/s3/constants";
import { encodeS3Cursor } from "@/lib/db/providers/objectstore/s3/cursor";
import { S3_RESPONSE_HEADERS } from "@/lib/db/providers/objectstore/s3/headers";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import { joinVirtualKey } from "@/lib/db/providers/objectstore/s3/names";
import { previewObject, type S3RangeReader } from "@/lib/db/providers/objectstore/s3/preview";
import { S3_PREVIEW_ADAPTER_SENTENCES } from "@/lib/db/providers/objectstore/s3/preview-adapter";
import { previewSourceParts } from "@/lib/db/providers/objectstore/s3/preview-render";
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

describe("an empty Region", () => {
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

describe("the Source tab", () => {
  const CSV = new TextEncoder().encode("id,name\n1,alpha\n2,beta\n3,gamma\n");
  const ETAG = '"e1"';

  /** An object served by byte range, as a server that honours Range answers. */
  function rangedObject(request: NodeByteRequest) {
    if (request.method === "HEAD")
      return {
        status: 200,
        contentType: "text/csv",
        headers: [
          ["content-length", String(CSV.length)],
          ["etag", ETAG],
        ] as const,
      };
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers?.range ?? "");
    if (range === null)
      return {
        status: 200,
        body: CSV,
        headers: [
          ["content-length", String(CSV.length)],
          ["etag", ETAG],
        ] as const,
      };
    const start = range[1] === "" ? CSV.length - Number(range[2]) : Number(range[1]);
    const end = range[1] === "" || range[2] === "" ? CSV.length - 1 : Math.min(Number(range[2]), CSV.length - 1);
    return {
      status: 206,
      body: CSV.subarray(start, end + 1),
      headers: [
        ["content-range", `bytes ${start}-${end}/${CSV.length}`],
        ["etag", ETAG],
      ] as const,
    };
  }

  /** The same object as the preview's reader port, for the expected parts. */
  const servedReader: S3RangeReader = {
    async read(range, maxBytes) {
      const start = range.kind === "first" ? 0 : range.kind === "suffix" ? CSV.length - range.length : range.start;
      const end = range.kind === "span" ? range.end : range.kind === "first" ? range.length : CSV.length;
      return { bytes: CSV.subarray(start, Math.min(end, start + maxBytes)), start, total: CSV.length, etag: ETAG };
    },
  };

  test("an object: the Metadata part, then exactly the parts the preview renders, read with GET ranges only", async () => {
    const { s3, fake } = provider(
      (request) => (request.target.query.includes("list-type=2") ? xmlAnswer(objectsXml({})) : rangedObject(request)),
      { database: "sales" },
    );
    await s3.connect();
    const document = await s3.readObjectSource(["sales/a.csv"], "object");
    const preview = await previewObject({
      head: { bucket: "sales", key: "a.csv", size: CSV.length, etag: ETAG, contentType: "text/csv" },
      reader: servedReader,
      request: {},
      purpose: "source",
      signal: new AbortController().signal,
    });
    expect(document.parts[0].id).toBe("metadata");
    expect(document.parts.slice(1)).toEqual(previewSourceParts(preview, { bucket: "sales", key: "a.csv" }));
    const reads = fake.exchanges.slice(2);
    expect(reads.length).toBeGreaterThan(0);
    for (const exchange of reads) {
      expect(exchange.request.method).toBe("GET");
      expect(exchange.request.headers?.range).toMatch(/^bytes=/);
    }
  });

  test("a HEAD with no ETag: one unavailable Preview part, and no GET", async () => {
    const { s3, fake } = provider(
      (request) =>
        request.method === "HEAD" ? { status: 200, headers: [["content-length", "10"]] } : xmlAnswer(objectsXml({})),
      { database: "sales" },
    );
    await s3.connect();
    const document = await s3.readObjectSource(["sales/a.csv"], "object");
    expect(document.parts[1]).toEqual({
      id: "preview",
      label: "Preview",
      unavailable: S3_PREVIEW_ADAPTER_SENTENCES.noHead,
    });
    expect(fake.lines().slice(1)).toEqual(["HEAD /sales/a.csv"]);
  });

  test("a refused preview read is an unavailable Preview part beside the Metadata part", async () => {
    const { s3 } = provider(
      (request) => {
        if (request.method === "HEAD") return rangedObject(request);
        if (request.target.query.includes("list-type=2")) return xmlAnswer(objectsXml({}));
        return xmlAnswer(errorXml("AccessDenied", "Access Denied."), 403);
      },
      { database: "sales" },
    );
    await s3.connect();
    const document = await s3.readObjectSource(["sales/a.csv"], "object");
    expect(document.parts[0].id).toBe("metadata");
    expect(document.parts[1]).toEqual({
      id: "preview",
      label: "Preview",
      unavailable:
        'This access key may not read object "a.csv" in bucket "sales" (s3:GetObject). The server answers the same way for an object that does not exist, so this does not say that object "a.csv" exists.',
    });
  });

  test("a preview read past the query timeout fails the whole document, not the Preview part", async () => {
    const { s3 } = provider(
      (request) => {
        if (request.target.query.includes("list-type=2")) return xmlAnswer(objectsXml({}));
        if (request.method === "HEAD") return rangedObject(request);
        return new Promise<never>(() => {});
      },
      { database: "sales" },
      1_000,
    );
    await s3.connect();
    const error = await s3.readObjectSource(["sales/a.csv"], "object").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TimeoutError);
  });

  test("a bucket: its creation date from the tree's listing", async () => {
    const { s3 } = provider((request) => {
      if (request.target.path === "/") return xmlAnswer(bucketsXml(["sales"]));
      return request.target.query === "location="
        ? xmlAnswer("<LocationConstraint/>")
        : xmlAnswer("<VersioningConfiguration/>");
    });
    await s3.connect();
    await s3.listObjects([], "bucket");
    const document = await s3.readObjectSource(["sales"], "bucket");
    expect(JSON.parse((document.parts[0] as { text: string }).text)).toMatchObject({
      created: "2026-10-09T13:13:17.442Z",
      pinned: false,
    });
  });
});

describe("object names through the Source tab", () => {
  const PINNED = { database: "sales" };

  /** The pinned probe's listing, then a HEAD of `size` bytes, with an ETag only when one is given. */
  function listOrHead(size: number, etag?: string) {
    return (request: NodeByteRequest) => {
      if (request.target.query.includes("list-type=2")) return xmlAnswer(objectsXml({}));
      const headers: [string, string][] = [["content-length", String(size)]];
      if (etag !== undefined) headers.push(["etag", etag]);
      return { status: 200, headers };
    };
  }

  test.each([
    ["a b+c%/ü.csv", "HEAD /sales/a%20b%2Bc%25/%C3%BC.csv"],
    ["logs//2026/x.csv", "HEAD /sales/logs//2026/x.csv"],
  ])("the key %p is sent encoded once per segment, slashes kept", async (key, line) => {
    const { s3, fake } = provider(listOrHead(10), PINNED);
    await s3.connect();
    const document = await s3.readObjectSource([joinVirtualKey("sales", key)], "object");
    expect(document.parts[0].id).toBe("metadata");
    expect(fake.lines().slice(1)).toEqual([line]);
  });

  test("a zero-byte folder marker opens as an empty object and sends only its HEAD", async () => {
    const etag = '"d41d8cd98f00b204e9800998ecf8427e"';
    const { s3, fake } = provider(listOrHead(0, etag), PINNED);
    await s3.connect();
    const document = await s3.readObjectSource([joinVirtualKey("sales", "logs/")], "object");
    const empty = await previewObject({
      head: { bucket: "sales", key: "logs/", size: 0, etag },
      reader: {
        read: async () => {
          throw new Error("an empty object is never read");
        },
      },
      request: {},
      purpose: "source",
      signal: new AbortController().signal,
    });
    expect(empty).toEqual({ kind: "empty", notices: [] });
    expect(document.parts[0].id).toBe("metadata");
    expect(document.parts.slice(1)).toEqual(previewSourceParts(empty, { bucket: "sales", key: "logs/" }));
    expect(fake.lines().slice(1)).toEqual(["HEAD /sales/logs/"]);
  });
});
