/**
 * BigQuery and Snowflake build their origins with the egress decision they were built with, and refuse to connect by
 * name without one (FND-2 slice 2b-3b, docs/SECURITY.md row 0.6).
 *
 * Neither origin admits an address literal: Snowflake's account rule refuses one, and the Google token host is a fixed
 * name, so a blocking decision never refuses either (`snowflake/account.test.ts` and `auth/google/token-source.test.ts`
 * pin that). What this file shows is the other half: a provider built directly, as a test or a live script builds it
 * outside Studio's factory, with no decision, is built and answers its capabilities, and `connect()` refuses with
 * `EGRESS_DECISION_MISSING` before any transport is built.
 *
 * The node transport module is replaced for this process, keeping every other export of the real module: each fake
 * transport records that it was built and answers 401, which neither engine retries. So no case, on any tree, can open
 * a socket to Google or Snowflake, and a regression fails by the count of built transports instead of dialling out.
 * `mock.module()` is process-wide, so the runner gives this file its own process.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type {
  NodeByteResponse,
  NodeByteTransportOptions,
  NodeResponse,
  NodeTransportOptions,
} from "@/lib/db/http/node-transport";
import type { DatabaseProvider } from "@/lib/db/types";

const realNode = { ...(await import("@/lib/db/http/node-transport")) };

/** One line per transport a provider built: its kind and the host of its origin. */
const built: string[] = [];

mock.module("@/lib/db/http/node-transport", () => ({
  ...realNode,
  createNodeTransport: (options: NodeTransportOptions) => {
    built.push(`text ${options.origin.host}`);
    return {
      request: async (): Promise<NodeResponse> => ({
        status: 401,
        contentType: "application/json",
        retryAfter: null,
        text: "{}",
      }),
      close() {},
    };
  },
  createNodeByteTransport: (options: NodeByteTransportOptions) => {
    built.push(`byte ${options.origin.host}`);
    return {
      request: async (): Promise<NodeByteResponse> => ({
        status: 401,
        contentType: "application/json",
        contentEncoding: null,
        retryAfter: null,
        headers: [],
        headersTruncated: false,
        bytes: Buffer.from("{}"),
        truncated: false,
      }),
      close() {},
    };
  },
}));

const { DatabaseConfigError } = await import("@/lib/db/errors");
const { EGRESS_DECISION_MISSING } = await import("@/lib/db/http/egress-policy");
const { BigQueryProvider } = await import("@/lib/db/providers/sql/bigquery/index");
const { SnowflakeProvider } = await import("@/lib/db/providers/sql/snowflake/index");

afterEach(() => {
  built.length = 0;
});

/**
 * A short deadline, so a case whose refusal regressed fails inside the test's time budget instead of waiting out the
 * default one.
 */
const OPTIONS = { queryTimeout: 1500 };

const BUILDS: readonly [string, () => DatabaseProvider][] = [
  [
    "BigQuery",
    // A pasted access token, so no credential file is read and no token is minted.
    () =>
      new BigQueryProvider(
        {
          id: "named-bigquery",
          name: "named bigquery",
          type: "bigquery",
          database: "demo-project",
          password: crypto.randomUUID(),
          createdAt: new Date(),
        },
        OPTIONS,
        {},
      ),
  ],
  [
    "Snowflake",
    // A programmatic access token, so the connect statement would be the first request.
    () =>
      new SnowflakeProvider(
        {
          id: "named-snowflake",
          name: "named snowflake",
          type: "snowflake",
          host: "myorg-myacct",
          user: "studio_svc",
          role: "STUDIO_RO",
          authMethod: "pat",
          password: crypto.randomUUID(),
          createdAt: new Date(),
        },
        OPTIONS,
        {},
      ),
  ],
];

describe("a provider whose origins admit no address literal refuses to connect without the egress decision it was built with (FND-2 slice 2b-3b)", () => {
  test.each(BUILDS)(
    "%s built without an egress decision is built, and refuses to connect by name before any transport is built",
    async (_name, build) => {
      const provider = build();
      expect(provider.getCapabilities().queryLanguage).toBe("sql");
      const failure = await provider.connect().then(
        () => null,
        (error: unknown) => error,
      );
      await provider.disconnect();
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe(EGRESS_DECISION_MISSING);
      expect(built).toEqual([]);
    },
  );
});
