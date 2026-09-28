import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseConfigError } from "@/lib/db/errors";
import { ClickHouseProvider } from "@/lib/db/providers/sql/clickhouse";
import { DruidProvider } from "@/lib/db/providers/sql/druid";
import { ElasticsearchProvider, OpenSearchProvider } from "@/lib/db/providers/sql/search";
import { TrinoProvider } from "@/lib/db/providers/sql/trino";
import { LibSQLProvider } from "@/lib/db/providers/sql/libsql";
import { LibSQLHranaTransport } from "@/lib/db/providers/sql/libsql/hrana-transport";
import { CouchbaseProvider } from "@/lib/db/providers/document/couchbase";
import { PrometheusProvider } from "@/lib/db/providers/timeseries/prometheus";
import type { DatabaseConnection } from "@/lib/db/types";

const flag = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const original = process.env[flag];

afterEach(() => {
  if (original === undefined) delete process.env[flag];
  else process.env[flag] = original;
});

const providers = [
  ["ClickHouse", "clickhouse", ClickHouseProvider],
  ["Druid", "druid", DruidProvider],
  ["Elasticsearch", "elasticsearch", ElasticsearchProvider],
  ["OpenSearch", "opensearch", OpenSearchProvider],
  ["Trino", "trino", TrinoProvider],
  ["libSQL", "libsql", LibSQLProvider],
  ["Couchbase", "couchbase", CouchbaseProvider],
  ["Prometheus", "prometheus", PrometheusProvider],
] as const;

for (const [name, type, Provider] of providers) {
  for (const secure of [false, true]) {
    test(`${name} ${secure ? "TLS" : "plain HTTP"} keeps DNS policy refusals as configuration errors`, async () => {
      process.env[flag] = "true";
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
          user: "tester",
          database: "test",
          createdAt: new Date(),
          ...(secure ? { ssl: { mode: "require" as const } } : {}),
        };
        const failure = await Promise.resolve()
          .then(() => new Provider(connection).connect())
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(DatabaseConfigError);
        expect((failure as Error).message).toContain("blocked by DB_HTTP_BLOCK_PRIVATE_HOSTS");
        expect(hits).toBe(0);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    });
  }
}

test("libSQL version discovery also reports a DNS policy refusal", async () => {
  process.env[flag] = "true";
  const transport = new LibSQLHranaTransport({
    id: "blocked-version",
    name: "Blocked version",
    type: "libsql",
    host: "localhost",
    port: 1,
    createdAt: new Date(),
  });
  await expect(transport.serverVersion()).rejects.toThrow(DatabaseConfigError);
});
