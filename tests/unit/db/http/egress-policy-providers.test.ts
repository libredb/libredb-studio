import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseConfigError } from "@/lib/db/errors";
import { BLOCKED_HOST, EGRESS_DECISION_MISSING } from "@/lib/db/http/egress-policy";
import { ClickHouseProvider } from "@/lib/db/providers/sql/clickhouse";
import { DruidProvider } from "@/lib/db/providers/sql/druid";
import { ElasticsearchProvider, OpenSearchProvider } from "@/lib/db/providers/sql/search";
import { TrinoProvider } from "@/lib/db/providers/sql/trino";
import { DatabendProvider } from "@/lib/db/providers/sql/databend";
import { LibSQLProvider } from "@/lib/db/providers/sql/libsql";
import { LibSQLHranaTransport } from "@/lib/db/providers/sql/libsql/hrana-transport";
import { CouchbaseProvider } from "@/lib/db/providers/document/couchbase";
import { PrometheusProvider } from "@/lib/db/providers/timeseries/prometheus";
import { InfluxDB3Provider, InfluxDBProvider } from "@/lib/db/providers/timeseries/influxdb/index";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import type { DatabaseConnection, ProviderBuildContext } from "@/lib/db/types";
import { ALLOWS_PRIVATE_HOSTS, BLOCKS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";
import { setEgressFlag } from "../../../helpers/egress-flag";

const flag = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const original = process.env[flag];

afterEach(() => {
  setEgressFlag(original);
});

/**
 * The providers whose fetch path takes the egress decision as an argument (FND-2 slice 2b): each is handed a blocking
 * decision while DB_HTTP_BLOCK_PRIVATE_HOSTS is unset, so a refusal shows the handed decision decided, not the variable.
 * `localhost` is a name, which `httpOrigin` lets through whatever the decision, so the refusal comes from the guarded
 * fetch's lookup.
 */
const handedDecision = [
  ["ClickHouse", "clickhouse", ClickHouseProvider],
  ["Druid", "druid", DruidProvider],
  ["Elasticsearch", "elasticsearch", ElasticsearchProvider],
  ["OpenSearch", "opensearch", OpenSearchProvider],
  ["Trino", "trino", TrinoProvider],
  ["libSQL", "libsql", LibSQLProvider],
  ["Couchbase", "couchbase", CouchbaseProvider],
  ["Prometheus", "prometheus", PrometheusProvider],
] as const;

/**
 * The providers that build their origin with the decision they were handed (slice 2b-3b) and still read the process's
 * decision through a node transport, until slice 2b-4: at the name localhost the refusal comes from the node
 * transport's checked lookup, so each is handed a blocking decision and the variable is true too.
 */
const providers = [
  // A user and no password (Databend design 3.14): the plaintext refusal needs a password, so the guard is reached.
  ["Databend", "databend", DatabendProvider],
  // No user (InfluxDB spec 3.3): InfluxDB 3 refuses one, and InfluxDB refuses a user without a password, each before
  // the guard is reached; with neither, the guard's DatabaseConfigError passes through toInfluxError unchanged.
  ["InfluxDB", "influxdb", InfluxDBProvider],
  ["InfluxDB 3", "influxdb3", InfluxDB3Provider],
] as const;

/** A user only where the provider takes one with no password: the two InfluxDB types and S3 refuse that before any guard. */
const USERLESS: ReadonlySet<string> = new Set(["influxdb", "influxdb3", "s3"]);

/** A local HTTP server that counts the requests it receives; `close` stops it. */
async function countingServer(): Promise<{ port: number; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.end("unexpected request");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function connectionTo(
  type: DatabaseConnection["type"],
  host: string,
  port: number,
  secure = false,
): DatabaseConnection {
  return {
    id: `blocked-${type}`,
    name: `Blocked ${type}`,
    type,
    host,
    port,
    ...(USERLESS.has(type) ? {} : { user: "tester" }),
    database: "test",
    createdAt: new Date(),
    ...(secure ? { ssl: { mode: "require" as const } } : {}),
  };
}

for (const [name, type, Provider] of handedDecision) {
  for (const secure of [false, true]) {
    test(`${name} ${secure ? "TLS" : "plain HTTP"} keeps DNS policy refusals as configuration errors`, async () => {
      setEgressFlag(undefined);
      const server = await countingServer();
      try {
        const context: ProviderBuildContext = { egress: BLOCKS_PRIVATE_HOSTS };
        const failure = await Promise.resolve()
          .then(() => new Provider(connectionTo(type, "localhost", server.port, secure), {}, context).connect())
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(DatabaseConfigError);
        expect((failure as Error).message).toContain("blocked by DB_HTTP_BLOCK_PRIVATE_HOSTS");
        expect(server.hits()).toBe(0);
      } finally {
        await server.close();
      }
    });
  }
}

test("ClickHouse refuses the literal 127.0.0.1 with the decision it was handed while DB_HTTP_BLOCK_PRIVATE_HOSTS is unset", async () => {
  setEgressFlag(undefined);
  const server = await countingServer();
  try {
    const provider = new ClickHouseProvider(
      connectionTo("clickhouse", "127.0.0.1", server.port),
      {},
      { egress: BLOCKS_PRIVATE_HOSTS },
    );
    const failure = await provider.connect().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DatabaseConfigError);
    expect((failure as Error).message).toBe(BLOCKED_HOST);
    expect(server.hits()).toBe(0);
  } finally {
    await server.close();
  }
});

test("ClickHouse handed an allowing decision reaches a local server at 127.0.0.1 while DB_HTTP_BLOCK_PRIVATE_HOSTS is true", async () => {
  setEgressFlag("true");
  const server = await countingServer();
  try {
    const provider = new ClickHouseProvider(
      connectionTo("clickhouse", "127.0.0.1", server.port),
      {},
      { egress: ALLOWS_PRIVATE_HOSTS },
    );
    await provider.connect().then(
      () => null,
      (error: unknown) => error,
    );
    expect(server.hits()).toBe(1);
  } finally {
    await server.close();
  }
});

test("ClickHouse built without an egress decision refuses to connect by name and sends nothing", async () => {
  setEgressFlag(undefined);
  const server = await countingServer();
  try {
    const provider = new ClickHouseProvider(connectionTo("clickhouse", "localhost", server.port));
    const failure = await provider.connect().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DatabaseConfigError);
    expect((failure as Error).message).toBe(EGRESS_DECISION_MISSING);
    expect(server.hits()).toBe(0);
  } finally {
    await server.close();
  }
});

for (const [name, type, Provider] of providers) {
  for (const secure of [false, true]) {
    test(`${name} ${secure ? "TLS" : "plain HTTP"} keeps DNS policy refusals as configuration errors`, async () => {
      setEgressFlag("true");
      let hits = 0;
      const server = createServer((_request, response) => {
        hits += 1;
        response.end("unexpected request");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

      try {
        const connection: DatabaseConnection = {
          id: `blocked-${type}`,
          name: `Blocked ${name}`,
          type,
          host: "localhost",
          port: (server.address() as AddressInfo).port,
          ...(USERLESS.has(type) ? {} : { user: "tester" }),
          database: "test",
          createdAt: new Date(),
          ...(secure ? { ssl: { mode: "require" as const } } : {}),
        };
        const failure = await Promise.resolve()
          .then(() => new Provider(connection, {}, { egress: BLOCKS_PRIVATE_HOSTS }).connect())
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(DatabaseConfigError);
        expect((failure as Error).message).toBe(BLOCKED_HOST);
        expect(hits).toBe(0);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    });
  }
}

test("libSQL version discovery also reports a DNS policy refusal", async () => {
  const transport = new LibSQLHranaTransport(
    {
      id: "blocked-version",
      name: "Blocked version",
      type: "libsql",
      host: "localhost",
      port: 1,
      createdAt: new Date(),
    },
    BLOCKS_PRIVATE_HOSTS,
  );
  await expect(transport.serverVersion()).rejects.toThrow(DatabaseConfigError);
});

// S3 builds its origin with the decision it was handed (slice 2b-3a), so it is handed a blocking one; its byte
// transport still reads the process's decision at the lookup of a name until slice 2b-4, so the variable is true too.
// No key pair (the user-less set): an unsigned connection, so the half-pair refusal does not fire first, and `localhost`
// is loopback, so the plain-HTTP refusal does not either; the pinned bucket "test" makes the probe one ListObjectsV2.
for (const secure of [false, true]) {
  test(`S3-compatible object storage ${secure ? "TLS" : "plain HTTP"} keeps DNS policy refusals as configuration errors`, async () => {
    setEgressFlag("true");
    const server = await countingServer();
    try {
      const failure = await Promise.resolve()
        .then(() =>
          new S3Provider(
            connectionTo("s3", "localhost", server.port, secure),
            {},
            { egress: BLOCKS_PRIVATE_HOSTS },
          ).connect(),
        )
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe(BLOCKED_HOST);
      expect(server.hits()).toBe(0);
    } finally {
      await server.close();
    }
  });
}
