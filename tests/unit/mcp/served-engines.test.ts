/**
 * The one served-engine resolver: an MCP statement tool serves an engine only when agent
 * mode executes statements on it, MCP_EXPOSABLE offers it, MCP_STATEMENT_READ opens it and its statement language is
 * the tool's. The records are passed in as well as read, so the case no shipped engine is in yet, an agent engine whose
 * MCP read row is still false, is pinned here rather than waiting for the first joiner.
 */
import { describe, expect, test } from "bun:test";
import { AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { MCP_EXPOSABLE, MCP_STATEMENT_READ } from "@/lib/db/compatibility";
import { mcpStatementEngines, type McpExposure } from "@/lib/mcp/tools/served-engines";
import { RUN_READ_QUERY_TYPES } from "../../helpers/run-read-query";

const SHIPPED: McpExposure = {
  executes: AGENT_EXECUTION_ENGINES,
  exposable: MCP_EXPOSABLE,
  statementRead: MCP_STATEMENT_READ,
  language: AGENT_STATEMENT_LANGUAGE,
};

describe("mcpStatementEngines", () => {
  test("RUN_READ_QUERY_TYPES is exactly the SQL engines every exposure record lets through", () => {
    expect(RUN_READ_QUERY_TYPES).toEqual(mcpStatementEngines("sql"));
    expect(RUN_READ_QUERY_TYPES).toEqual(
      AGENT_EXECUTION_ENGINES.filter(
        (type) => MCP_EXPOSABLE[type] && MCP_STATEMENT_READ[type] && AGENT_STATEMENT_LANGUAGE[type] === "sql",
      ),
    );
  });

  test("serves ClickHouse, libSQL, InfluxDB 3, Elasticsearch, OpenSearch, Oracle, Db2, Cassandra and Couchbase beside the five SQL engines it served before MCP_STATEMENT_READ existed", () => {
    expect(RUN_READ_QUERY_TYPES).toEqual([
      "postgres",
      "sqlite",
      "duckdb",
      "mssql",
      "mysql",
      "clickhouse",
      "libsql",
      "influxdb3",
      "elasticsearch",
      "opensearch",
      "oracle",
      "db2",
      "cassandra",
      "couchbase",
    ]);
  });

  // Opening ClickHouse, libSQL, InfluxDB 3, Elasticsearch, OpenSearch, Oracle, Db2, Cassandra, Couchbase, LibreDB and
  // RabbitMQ moved no other engine: every other language still serves exactly what it did.
  test("opening ClickHouse, libSQL, InfluxDB 3, Elasticsearch, OpenSearch, Oracle, Db2, Cassandra, Couchbase, LibreDB and RabbitMQ leaves every other language's served set as it was", () => {
    const languages = [...new Set(Object.values(AGENT_STATEMENT_LANGUAGE))].filter(
      (language): language is NonNullable<typeof language> => language !== null && language !== "sql",
    );
    const served = Object.fromEntries(languages.map((language) => [language, mcpStatementEngines(language)]));
    expect(served).toEqual({
      ...Object.fromEntries(languages.map((language) => [language, []])),
      mongo: ["mongodb"],
      kubectl: ["kubernetes"],
      cypher: ["neo4j"],
      rediscli: ["redis"],
      libredbkv: ["libredb"],
      qdrantapi: ["qdrant"],
      etcdctl: ["etcd"],
      rabbitread: ["rabbitmq"],
      kafkaread: ["kafka"],
      weaviateapi: ["weaviate"],
      mtconnectread: ["mtconnect"],
      milvusrpc: ["milvus"],
    });
  });

  test("reads the shipped records when none are passed", () => {
    for (const language of [
      "sql",
      "mongo",
      "kubectl",
      "cypher",
      "libredbkv",
      "qdrantapi",
      "etcdctl",
      "rabbitread",
      "kafkaread",
      "rediscli",
      "weaviateapi",
      "mtconnectread",
      "milvusrpc",
    ] as const) {
      expect(mcpStatementEngines(language)).toEqual(mcpStatementEngines(language, SHIPPED));
    }
  });

  test("serves MongoDB, Kubernetes, Neo4j, Redis, LibreDB, Qdrant, etcd, RabbitMQ, Kafka, Weaviate, MTConnect and Milvus each in its own language", () => {
    // MongoDB opened with run_mongo_command, Kubernetes with run_kubectl_read, offered only machine-redacted, Neo4j
    // with run_cypher_read, Redis with run_redis_read, metadata only, LibreDB with run_libredb_read, on a read-only
    // handle per command, Qdrant with run_qdrant_read, metadata only, etcd with run_etcd_read, metadata only, RabbitMQ
    // with run_rabbitmq_read, metadata only, Kafka with run_kafka_read, answered metadata-only, Weaviate with
    // run_weaviate_read, metadata only, MTConnect with run_mtconnect_read, its adapter connections withheld, and Milvus
    // with run_milvus_read, answered metadata-only.
    expect(mcpStatementEngines("mongo")).toEqual(["mongodb"]);
    expect(mcpStatementEngines("kubectl")).toEqual(["kubernetes"]);
    expect(mcpStatementEngines("cypher")).toEqual(["neo4j"]);
    expect(mcpStatementEngines("rediscli")).toEqual(["redis"]);
    expect(mcpStatementEngines("libredbkv")).toEqual(["libredb"]);
    expect(mcpStatementEngines("qdrantapi")).toEqual(["qdrant"]);
    expect(mcpStatementEngines("etcdctl")).toEqual(["etcd"]);
    expect(mcpStatementEngines("rabbitread")).toEqual(["rabbitmq"]);
    expect(mcpStatementEngines("kafkaread")).toEqual(["kafka"]);
    expect(mcpStatementEngines("weaviateapi")).toEqual(["weaviate"]);
    expect(mcpStatementEngines("mtconnectread")).toEqual(["mtconnect"]);
    expect(mcpStatementEngines("milvusrpc")).toEqual(["milvus"]);
  });

  test("an agent engine whose MCP read row is false is not served, though every other record lets it through", () => {
    const closed = { ...MCP_STATEMENT_READ, duckdb: false };
    expect(MCP_EXPOSABLE.duckdb).toBe(true);
    expect(AGENT_EXECUTION_ENGINES).toContain("duckdb");
    expect(mcpStatementEngines("sql", { ...SHIPPED, statementRead: closed })).toEqual([
      "postgres",
      "sqlite",
      "mssql",
      "mysql",
      "clickhouse",
      "libsql",
      "influxdb3",
      "elasticsearch",
      "opensearch",
      "oracle",
      "db2",
      "cassandra",
      "couchbase",
    ]);
  });

  // InfluxDB 3's SQL shares a provider directory with InfluxDB's InfluxQL, and opening the first left the second shut.
  test("opening InfluxDB 3 leaves InfluxDB over InfluxQL unserved by every statement tool", () => {
    expect(MCP_STATEMENT_READ.influxdb).toBe(false);
    expect(AGENT_STATEMENT_LANGUAGE.influxdb).toBe("influxql");
    expect(mcpStatementEngines("influxql")).toEqual([]);
    expect(RUN_READ_QUERY_TYPES).not.toContain("influxdb");
  });

  // One provider directory serves Elasticsearch and OpenSearch, and each opened by a row of its own: the two rows are
  // separate, so opening OpenSearch moved Elasticsearch's membership nowhere.
  test("OpenSearch is served by run_read_query alone, through its own row, beside Elasticsearch's", () => {
    expect(MCP_STATEMENT_READ.opensearch).toBe(true);
    expect(MCP_EXPOSABLE.opensearch).toBe(true);
    expect(AGENT_EXECUTION_ENGINES).toContain("opensearch");
    expect(AGENT_STATEMENT_LANGUAGE.opensearch).toBe("sql");
    expect(RUN_READ_QUERY_TYPES).toContain("opensearch");
    expect(RUN_READ_QUERY_TYPES).toContain("elasticsearch");
    expect(
      mcpStatementEngines("sql", { ...SHIPPED, statementRead: { ...MCP_STATEMENT_READ, opensearch: false } }),
    ).toEqual(RUN_READ_QUERY_TYPES.filter((type) => type !== "opensearch"));
  });

  test("an engine MCP is not offered for is not served, whatever its MCP read row says", () => {
    const withheld = { ...MCP_EXPOSABLE, sqlite: false };
    expect(mcpStatementEngines("sql", { ...SHIPPED, exposable: withheld })).not.toContain("sqlite");
  });

  test("an engine agent mode does not execute on is not served, whatever its rows say", () => {
    const executes = AGENT_EXECUTION_ENGINES.filter((type) => type !== "mysql");
    expect(mcpStatementEngines("sql", { ...SHIPPED, executes })).not.toContain("mysql");
  });
});
