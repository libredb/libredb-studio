/**
 * The S3 provider's lifecycle: the one transport of a session and its options,
 * signing only with typed keys and through the constructor's dependencies, nothing read from the environment, a
 * failed connect that closes its transport, disconnect during a request, the deadline sentence, and maintenance
 * refused before any request. Tasks 19 to 21 and 23 add their cases to this file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { ConnectionError, QueryError, TimeoutError } from "@/lib/db/errors";
import type { RequestSigner } from "@/lib/db/http/node-transport";
import { S3_RESPONSE_HEADERS } from "@/lib/db/providers/objectstore/s3/headers";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import type { DatabaseConnection } from "@/lib/types";
import { s3Connection } from "../../../helpers/s3-connection";
import { bucketsXml, type FakeS3Handler, fakeS3Transport, xmlAnswer } from "../../../helpers/s3-fake-transport";

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
