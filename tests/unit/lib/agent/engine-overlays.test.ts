import { describe, expect, test } from "bun:test";
import { AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";
import { composeEstimatingExplain } from "@/lib/agent/composed-sql";
import { languageClientPack } from "@/lib/agent/languages/client";
import { engineClientPack, enginesSupporting } from "@/lib/agent/languages/engines/client";
import { agentEnginePack } from "@/lib/agent/languages/engines/index";
import { engineServerDialect, engineServerOverlay } from "@/lib/agent/languages/engines/server";
import * as KUBECTL_CLIENT_OVERLAYS from "@/lib/agent/languages/kubectl/engines/client";
import * as KUBERNETES from "@/lib/agent/languages/kubectl/engines/kubernetes";
import * as LIBREDBKV_CLIENT_OVERLAYS from "@/lib/agent/languages/libredbkv/engines/client";
import * as LIBREDB from "@/lib/agent/languages/libredbkv/engines/libredb";
import { KUBECTL_PACK } from "@/lib/agent/languages/kubectl/index";
import { LIBREDBKV_PACK } from "@/lib/agent/languages/libredbkv/index";
import * as MONGO_CLIENT_OVERLAYS from "@/lib/agent/languages/mongo/engines/client";
import * as MONGODB from "@/lib/agent/languages/mongo/engines/mongodb";
import { MONGO_PACK } from "@/lib/agent/languages/mongo/index";
import { defineOverlay, dialectOnly, ENGINE_OVERRIDABLE_SERVER_MEMBERS } from "@/lib/agent/languages/overlay";
import type { AgentEngineClientDialect, AgentEngineServerDialect } from "@/lib/agent/languages/pack";
import { languageServerPack } from "@/lib/agent/languages/server";
import * as CASSANDRA from "@/lib/agent/languages/sql/engines/cassandra";
import * as CLICKHOUSE from "@/lib/agent/languages/sql/engines/clickhouse";
import * as COUCHBASE from "@/lib/agent/languages/sql/engines/couchbase";
import * as DRUID from "@/lib/agent/languages/sql/engines/druid";
import * as ELASTICSEARCH from "@/lib/agent/languages/sql/engines/elasticsearch";
import * as INFLUXDB3 from "@/lib/agent/languages/sql/engines/influxdb3";
import * as LIBSQL from "@/lib/agent/languages/sql/engines/libsql";
import * as SQL_CLIENT_OVERLAYS from "@/lib/agent/languages/sql/engines/client";
import * as DUCKDB from "@/lib/agent/languages/sql/engines/duckdb";
import * as MSSQL from "@/lib/agent/languages/sql/engines/mssql";
import * as MYSQL from "@/lib/agent/languages/sql/engines/mysql";
import * as DB2 from "@/lib/agent/languages/sql/engines/db2";
import * as OPENSEARCH from "@/lib/agent/languages/sql/engines/opensearch";
import * as ORACLE from "@/lib/agent/languages/sql/engines/oracle";
import * as POSTGRES from "@/lib/agent/languages/sql/engines/postgres";
import * as SQLITE from "@/lib/agent/languages/sql/engines/sqlite";
import { SQL_PACK } from "@/lib/agent/languages/sql/index";
import { createDatabaseProvider, executionContextFor } from "@/lib/db/factory";
import { getExplainStrategy } from "@/lib/explain";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";

/**
 * The engine overlays (#1821): one engine's pack is its family's pack with the engine's dialect laid on, and nothing
 * else. Held member for member against the family pack, so a reader moved from `agentLanguagePack` onto
 * `agentEnginePack` reads what it read before.
 */

const ALL_TYPES = Object.keys(AGENT_STATEMENT_LANGUAGE) as DatabaseType[];
const ENGINES = ALL_TYPES.filter((type) => AGENT_STATEMENT_LANGUAGE[type] !== null);
const SQL_ENGINES = ENGINES.filter((type) => AGENT_STATEMENT_LANGUAGE[type] === "sql");

/** The merged view's members: every dialect-bound member of every family. */
const SERVER_DIALECT_MEMBERS: readonly (keyof AgentEngineServerDialect)[] = [
  "catalogRead",
  "planEstimate",
  "profileComposition",
  "statistics",
  "catalogCapture",
];

/** The client view's members: the server members a browser asks about, each only as present or not. */
const CLIENT_DIALECT_MEMBERS: readonly (keyof AgentEngineClientDialect)[] = [
  "catalogRead",
  "planEstimate",
  "catalogCapture",
];

const ENGINE_MODULES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "sql/engines/postgres": POSTGRES,
  "sql/engines/sqlite": SQLITE,
  "sql/engines/duckdb": DUCKDB,
  "sql/engines/mssql": MSSQL,
  "sql/engines/mysql": MYSQL,
  "sql/engines/clickhouse": CLICKHOUSE,
  "sql/engines/libsql": LIBSQL,
  "sql/engines/influxdb3": INFLUXDB3,
  "sql/engines/elasticsearch": ELASTICSEARCH,
  "sql/engines/opensearch": OPENSEARCH,
  "sql/engines/oracle": ORACLE,
  "sql/engines/db2": DB2,
  "sql/engines/cassandra": CASSANDRA,
  "sql/engines/couchbase": COUCHBASE,
  "sql/engines/druid": DRUID,
  "sql/engines/client": SQL_CLIENT_OVERLAYS,
  "mongo/engines/mongodb": MONGODB,
  "mongo/engines/client": MONGO_CLIENT_OVERLAYS,
  "kubectl/engines/kubernetes": KUBERNETES,
  "kubectl/engines/client": KUBECTL_CLIENT_OVERLAYS,
  "libredbkv/engines/libredb": LIBREDB,
  "libredbkv/engines/client": LIBREDBKV_CLIENT_OVERLAYS,
};

/** Every overlay an engine module exports, named `<module>#<export>`. */
const exportedOverlays = (): readonly (readonly [string, object])[] =>
  Object.entries(ENGINE_MODULES)
    .flatMap(([module, exports]) =>
      Object.entries(exports).map(([name, overlay]) => [`${module}#${name}`, overlay as object] as const),
    )
    .filter(([name]) => /_(SERVER|CLIENT)_OVERLAY$/.test(name));

const without = (facet: object, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(facet).filter(([name]) => name !== key));

describe("the engine registry", () => {
  test("holds the engines that speak a statement language, in registry order", () => {
    expect(ENGINES).toEqual([
      "postgres",
      "mysql",
      "sqlite",
      "libsql",
      "duckdb",
      "oracle",
      "db2",
      "mssql",
      "clickhouse",
      "druid",
      "cassandra",
      "elasticsearch",
      "opensearch",
      "mongodb",
      "couchbase",
      "influxdb3",
      "kubernetes",
      "libredb",
    ]);
    expect(SQL_ENGINES).toEqual([
      "postgres",
      "mysql",
      "sqlite",
      "libsql",
      "duckdb",
      "oracle",
      "db2",
      "mssql",
      "clickhouse",
      "druid",
      "cassandra",
      "elasticsearch",
      "opensearch",
      "couchbase",
      "influxdb3",
    ]);
  });

  test.each(ALL_TYPES)("%s has a client pack exactly when it speaks a language, over that language's facet", (type) => {
    const language = AGENT_STATEMENT_LANGUAGE[type];
    if (language === null) {
      expect(() => engineClientPack(type)).toThrow(new Error(`no engine pack for ${type}`));
    } else if (language === "sql") {
      // A SQL engine's client overlay holds its client dialect, laid over SQL's own facet member for member.
      const pack = engineClientPack(type);
      const client = languageClientPack(language);
      expect(Object.keys(without(pack, "dialect"))).toEqual(Object.keys(client));
      for (const [member, value] of Object.entries(without(pack, "dialect"))) {
        expect(value).toBe((client as unknown as Record<string, unknown>)[member]);
      }
      expect(pack.dialect).toBeDefined();
    } else {
      // A family with no client dialect gives its engines an empty overlay, so the facet is the family's own object.
      expect(engineClientPack(type)).toBe(languageClientPack(language));
    }
  });

  test("a name that is no engine has no pack, inherited names included", () => {
    expect(() => engineClientPack("toString" as DatabaseType)).toThrow(new Error("no engine pack for toString"));
    expect(() => agentEnginePack("toString" as DatabaseType)).toThrow(new Error("no engine pack for toString"));
    expect(() => agentEnginePack("spark")).toThrow(new Error("no engine pack for spark"));
  });

  test("every engine module's server overlay holds a dialect and overridable members, its client one a dialect alone (ruling 2)", () => {
    const exported = exportedOverlays();
    expect(exported).toHaveLength(36);
    // The one other export is the PostgreSQL retry's rewrite, which its tests call directly.
    expect(
      Object.entries(ENGINE_MODULES)
        .flatMap(([module, exports]) => Object.keys(exports).map((name) => `${module}#${name}`))
        .filter((name) => !/_(SERVER|CLIENT)_OVERLAY$/.test(name)),
    ).toEqual(["sql/engines/postgres#withoutExtensionOwnershipTest"]);
    const overridable: readonly string[] = ENGINE_OVERRIDABLE_SERVER_MEMBERS;
    for (const [name, overlay] of exported) {
      const others = Object.keys(overlay).filter((key) => key !== "dialect");
      expect(others.filter((key) => !(name.endsWith("_SERVER_OVERLAY") && overridable.includes(key)))).toEqual([]);
    }
  });

  const GROUNDING_OVERLAYS = [
    "sql/engines/cassandra#CASSANDRA_SERVER_OVERLAY",
    "sql/engines/couchbase#COUCHBASE_SERVER_OVERLAY",
  ];

  test("Cassandra's and Couchbase's overlays alone override a Shared member, their grounding, which keeps the SQL grounding and adds the dialect's rules", () => {
    for (const [name, overlay] of exportedOverlays()) {
      const shared = Object.keys(overlay).filter((key) => key !== "dialect");
      expect(shared).toEqual(GROUNDING_OVERLAYS.includes(name) ? ["grounding"] : []);
    }
    for (const type of ENGINES) {
      const shared = Object.keys(engineServerOverlay(type)).filter((key) => key !== "dialect");
      expect(shared).toEqual(type === "cassandra" || type === "couchbase" ? ["grounding"] : []);
    }
    const base = languageServerPack("sql").grounding;
    const grounding = agentEnginePack("cassandra").server.grounding;
    expect(grounding).toEqual({
      ...base,
      relations: false,
      planningRules: [
        "CQL reads one table per statement: there is no JOIN, no subquery, no UNION and no OFFSET, and GROUP BY and ORDER BY take only primary key columns in key order.",
        "Restrict the partition key with = or IN, then clustering columns in key order; a predicate on any other column needs ALLOW FILTERING, which scans the table, and ALLOW FILTERING goes last, after LIMIT.",
        "Name each table with its keyspace, as keyspace.table.",
      ],
    });
    expect(Object.isFrozen(grounding)).toBe(true);
    const couchbase = agentEnginePack("couchbase").server.grounding;
    expect(couchbase).toEqual({
      ...base,
      relations: false,
      planningRules: [
        "Name a collection as scope.collection with each part in backticks (`_default`.`_default` for the bucket's default collection): the query context is the connection's bucket, and a bare name reads as a collection of the _default scope.",
        "Documents are JSON: reach a nested field with a dot (d.address.city) and an array element with brackets, and alias the collection (FROM `s`.`c` AS d) so META(d).id names the document key.",
      ],
    });
    expect(Object.isFrozen(couchbase)).toBe(true);
    // A plan run drafts any statement, a write included, for the owner to run in the editor: the agent path's
    // one-SELECT fence is the provider's to enforce and never a planning rule.
    expect(couchbase.planningRules?.some((rule) => /\bSELECT\b/.test(rule))).toBe(false);
  });
});

describe("the engine packs", () => {
  test("an engine whose overlays are empty is its family's pack itself", () => {
    expect(agentEnginePack("mongodb")).toBe(MONGO_PACK);
    expect(agentEnginePack("kubernetes")).toBe(KUBECTL_PACK);
    expect(agentEnginePack("mongodb")).toEqual(MONGO_PACK);
    expect(agentEnginePack("kubernetes")).toEqual(KUBECTL_PACK);
    expect(agentEnginePack("libredb")).toBe(LIBREDBKV_PACK);
  });

  test.each(SQL_ENGINES)("%s is the SQL pack member for member, with its own dialect on the server facet", (type) => {
    const pack = agentEnginePack(type);
    const server = languageServerPack("sql");
    const overridden = Object.keys(engineServerOverlay(type)).filter((key) => key !== "dialect");
    expect(pack.id).toBe("sql");
    expect(pack.execution).toBe(SQL_PACK.execution);
    expect(Object.keys(without(pack.server, "dialect"))).toEqual(Object.keys(server));
    for (const [member, value] of Object.entries(without(pack.server, "dialect"))) {
      // A member the engine's overlay overrides is its own, held by the test above; every other is the family's.
      if (overridden.includes(member)) continue;
      expect(value).toBe((server as unknown as Record<string, unknown>)[member]);
    }
    const client = languageClientPack(AGENT_STATEMENT_LANGUAGE[type] as "sql");
    expect(Object.keys(without(pack.client, "dialect"))).toEqual(Object.keys(client));
    for (const [member, value] of Object.entries(without(pack.client, "dialect"))) {
      expect(value).toBe((client as unknown as Record<string, unknown>)[member]);
    }
    expect(pack.server.dialect).toBe(engineServerDialect(type));
    expect(pack.client.dialect).toBe(engineClientPack(type).dialect);
    expect(Object.isFrozen(pack)).toBe(true);
    expect(Object.isFrozen(pack.server)).toBe(true);
    expect(Object.isFrozen(pack.client)).toBe(true);
  });
});

describe("engineServerDialect", () => {
  test.each([...ALL_TYPES, "toString" as DatabaseType])("%s answers a frozen dialect with every member", (type) => {
    const dialect = engineServerDialect(type);
    expect(Object.isFrozen(dialect)).toBe(true);
    // The overlay holding it is frozen too, so no caller can swap an engine's dialect for the whole process.
    expect(Object.isFrozen(engineServerOverlay(type))).toBe(true);
    expect(Object.keys(dialect).sort()).toEqual([...SERVER_DIALECT_MEMBERS].sort());
    if (!SQL_ENGINES.includes(type)) {
      for (const member of SERVER_DIALECT_MEMBERS) expect(dialect[member]).toBe("unsupported");
    }
  });

  test("a type with no overlay holds an empty one, so its server facet is its family's own", () => {
    for (const type of ["spark", "toString", "mongodb", "kubernetes", "libredb"] as DatabaseType[]) {
      expect(Object.keys(engineServerOverlay(type))).toEqual([]);
    }
    expect(engineServerOverlay("postgres").dialect).toBe(engineServerDialect("postgres"));
  });

  test("profileComposition is supplied on exactly the five verified engines, and DuckDB declares it unsupported (B111)", () => {
    const supplied = SQL_ENGINES.filter((type) => engineServerDialect(type).profileComposition !== "unsupported");
    expect(supplied).toEqual(["postgres", "mysql", "sqlite", "libsql", "mssql"]);
    expect(engineServerDialect("duckdb").profileComposition).toBe("unsupported");
    const counted = supplied.filter((type) => {
      const composition = engineServerDialect(type).profileComposition;
      return composition !== "unsupported" && composition.uncountableType !== undefined;
    });
    expect(counted).toEqual(["mssql"]);
    for (const type of supplied) {
      const composition = engineServerDialect(type).profileComposition;
      expect(Object.isFrozen(composition)).toBe(true);
      if (composition !== "unsupported") expect(Object.isFrozen(composition.shapeTests)).toBe(true);
    }
  });

  test("planEstimate is supplied on every SQL engine but the two search engines, Oracle and Db2: a prefix on seven, SQL Server's session mode", () => {
    expect(Object.fromEntries(SQL_ENGINES.map((type) => [type, engineServerDialect(type).planEstimate]))).toEqual({
      postgres: { kind: "prefix", prefix: "EXPLAIN (FORMAT JSON)" },
      mysql: { kind: "prefix", prefix: "EXPLAIN FORMAT=JSON" },
      sqlite: { kind: "prefix", prefix: "EXPLAIN QUERY PLAN" },
      duckdb: { kind: "prefix", prefix: "EXPLAIN (FORMAT JSON)" },
      mssql: { kind: "session-mode", mode: "estimate-plan" },
      clickhouse: { kind: "prefix", prefix: "EXPLAIN json = 1, indexes = 1" },
      // Its EXPLAIN answers the engine's own plan text, which no explain strategy reads.
      elasticsearch: "unsupported",
      // It answers no EXPLAIN the provider reads.
      opensearch: "unsupported",
      // Its EXPLAIN PLAN writes into PLAN_TABLE, which the read-only user is refused.
      oracle: "unsupported",
      // Its EXPLAIN writes into the explain tables, which the agent user may not write.
      db2: "unsupported",
      // CQL has no EXPLAIN.
      cassandra: "unsupported",
      // The agent path sends only a SELECT, never an EXPLAIN.
      couchbase: "unsupported",
      // The agent path sends only a SELECT, never an EXPLAIN PLAN FOR.
      druid: "unsupported",
      libsql: { kind: "prefix", prefix: "EXPLAIN QUERY PLAN" },
      influxdb3: { kind: "prefix", prefix: "EXPLAIN" },
    });
    for (const type of SQL_ENGINES) {
      const planEstimate = engineServerDialect(type).planEstimate;
      if (planEstimate !== "unsupported") expect(Object.isFrozen(planEstimate)).toBe(true);
    }
  });

  test("catalogRead is supplied on every SQL engine, with SQLite's and libSQL's relation read their object read", () => {
    const composers = (type: DatabaseType) => {
      const catalogRead = engineServerDialect(type).catalogRead;
      if (catalogRead === "unsupported") throw new Error(`${type} has no catalog read`);
      return catalogRead.compose;
    };
    for (const type of SQL_ENGINES) {
      const compose = composers(type);
      expect(Object.keys(compose).sort()).toEqual(["columns", "indexes", "relations", "statistics"]);
      expect(Object.isFrozen(engineServerDialect(type).catalogRead)).toBe(true);
      expect(Object.isFrozen(compose)).toBe(true);
    }
    expect(composers("sqlite").relations).toBe(composers("sqlite").columns);
    expect(composers("libsql").relations).toBe(composers("libsql").columns);
    for (const type of [
      "postgres",
      "duckdb",
      "mssql",
      "mysql",
      "clickhouse",
      "influxdb3",
      "elasticsearch",
      "opensearch",
      "db2",
    ] as const) {
      expect(composers(type).relations).not.toBe(composers(type).columns);
    }
  });

  test("only SQLite and libSQL fold the declared schema, only PostgreSQL retries a failed catalog read, and only the two search engines map their catalog rows and read their catalog with a command", () => {
    const supplied = (member: "declaredSchema" | "retry" | "mapRows" | "commandShaped") =>
      SQL_ENGINES.filter((type) => {
        const catalogRead = engineServerDialect(type).catalogRead;
        return catalogRead !== "unsupported" && catalogRead[member] !== undefined;
      });
    expect(supplied("declaredSchema")).toEqual(["sqlite", "libsql"]);
    expect(supplied("retry")).toEqual(["postgres"]);
    expect(supplied("mapRows")).toEqual(["elasticsearch", "opensearch"]);
    expect(supplied("commandShaped")).toEqual(["elasticsearch", "opensearch"]);
    const sqlite = engineServerDialect("sqlite").catalogRead;
    const postgres = engineServerDialect("postgres").catalogRead;
    if (sqlite === "unsupported" || postgres === "unsupported") throw new Error("catalog read missing");
    expect(sqlite.declaredSchema?.("MAIN")).toBe("main");
    const libsql = engineServerDialect("libsql").catalogRead;
    if (libsql === "unsupported") throw new Error("catalog read missing");
    expect(libsql.declaredSchema?.("MAIN")).toBe("main");
    expect(Object.isFrozen(postgres.retry)).toBe(true);
    expect(postgres.retry?.matches('relation "pg_depend" does not exist')).toBe(true);
    expect(postgres.retry?.matches('relation "PG_EXTENSION" does not exist')).toBe(true);
    expect(postgres.retry?.matches("permission denied for table orders")).toBe(false);
    expect(postgres.retry?.rewrite).toBe(POSTGRES.withoutExtensionOwnershipTest);
  });
  test("statistics is supplied on PostgreSQL, SQLite, SQL Server and libSQL, and only SQLite and libSQL probe first or note a limit", () => {
    const supplied = SQL_ENGINES.filter((type) => engineServerDialect(type).statistics !== "unsupported");
    expect(supplied).toEqual(["postgres", "sqlite", "libsql", "mssql"]);
    expect(engineServerDialect("duckdb").statistics).toBe("unsupported");
    expect(engineServerDialect("mysql").statistics).toBe("unsupported");
    expect(engineServerDialect("clickhouse").statistics).toBe("unsupported");
    expect(engineServerDialect("influxdb3").statistics).toBe("unsupported");
    expect(engineServerDialect("elasticsearch").statistics).toBe("unsupported");
    expect(engineServerDialect("opensearch").statistics).toBe("unsupported");
    const reading = (type: DatabaseType) => {
      const statistics = engineServerDialect(type).statistics;
      if (statistics === "unsupported") throw new Error(`${type} has no statistics`);
      return statistics;
    };
    expect(supplied.map((type) => reading(type).probe)).toEqual([
      null,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'",
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'",
      null,
    ]);
    expect(supplied.filter((type) => reading(type).limitNote !== undefined)).toEqual(["sqlite", "libsql"]);
    for (const type of supplied) {
      expect(Object.isFrozen(reading(type))).toBe(true);
      expect(typeof reading(type).build).toBe("function");
    }
    expect(new Set(supplied.map((type) => reading(type).build)).size).toBe(4);
  });

  test("an engine that reads statistics also reads its catalog, since the statistics read is a catalog kind", () => {
    for (const type of [...ALL_TYPES, "toString" as DatabaseType]) {
      const dialect = engineServerDialect(type);
      if (dialect.statistics !== "unsupported") expect(dialect.catalogRead).not.toBe("unsupported");
    }
  });

  test("catalogCapture is supplied on PostgreSQL and SQLite, each with its own kinds, builder and kind words", () => {
    const supplied = SQL_ENGINES.filter((type) => engineServerDialect(type).catalogCapture !== "unsupported");
    expect(supplied).toEqual(["postgres", "sqlite"]);
    for (const type of [
      "duckdb",
      "mssql",
      "mysql",
      "clickhouse",
      "libsql",
      "influxdb3",
      "elasticsearch",
      "opensearch",
      "db2",
    ] as const) {
      expect(engineServerDialect(type).catalogCapture).toBe("unsupported");
    }
    const capture = (type: DatabaseType) => {
      const catalogCapture = engineServerDialect(type).catalogCapture;
      if (catalogCapture === "unsupported") throw new Error(`${type} has no catalog capture`);
      return catalogCapture;
    };
    expect(capture("postgres").kinds).toEqual(["columns", "relations", "indexes"]);
    expect(capture("sqlite").kinds).toEqual(["columns", "indexes"]);
    expect(capture("postgres").kindWords).toEqual({
      r: "table",
      p: "table",
      v: "view",
      m: "materialized_view",
      S: "sequence",
    });
    expect(capture("sqlite").kindWords).toEqual({ table: "table", view: "view", index: "index", trigger: "trigger" });
    for (const type of supplied) {
      expect(Object.isFrozen(capture(type))).toBe(true);
      expect(Object.isFrozen(capture(type).kinds)).toBe(true);
      expect(Object.isFrozen(capture(type).kindWords)).toBe(true);
      expect(typeof capture(type).build).toBe("function");
    }
    expect(capture("postgres").build).not.toBe(capture("sqlite").build);
  });

  test("an engine that captures its catalog also composes every kind it captures", () => {
    for (const type of [...ALL_TYPES, "toString" as DatabaseType]) {
      const dialect = engineServerDialect(type);
      if (dialect.catalogCapture === "unsupported") continue;
      if (dialect.catalogRead === "unsupported") throw new Error(`${type} captures a catalog it cannot read`);
      for (const kind of dialect.catalogCapture.kinds) expect(Object.keys(dialect.catalogRead.compose)).toContain(kind);
    }
  });
});

describe("the client dialect", () => {
  const clientDialect = (type: DatabaseType): AgentEngineClientDialect => {
    const dialect = engineClientPack(type).dialect;
    if (dialect === undefined) throw new Error(`${type} has no client dialect`);
    return dialect;
  };

  test("each SQL engine says which of its server members it supplies, and nothing it does not", () => {
    expect(Object.fromEntries(SQL_ENGINES.map((type) => [type, clientDialect(type)]))).toEqual({
      postgres: { catalogRead: "supported", planEstimate: "supported", catalogCapture: "supported" },
      mysql: { catalogRead: "supported", planEstimate: "supported", catalogCapture: "unsupported" },
      sqlite: { catalogRead: "supported", planEstimate: "supported", catalogCapture: "supported" },
      duckdb: { catalogRead: "supported", planEstimate: "supported", catalogCapture: "unsupported" },
      mssql: { catalogRead: "supported", planEstimate: "supported", catalogCapture: "unsupported" },
      clickhouse: { catalogRead: "supported", planEstimate: "supported", catalogCapture: "unsupported" },
      elasticsearch: { catalogRead: "supported", planEstimate: "unsupported", catalogCapture: "unsupported" },
      opensearch: { catalogRead: "supported", planEstimate: "unsupported", catalogCapture: "unsupported" },
      oracle: { catalogRead: "supported", planEstimate: "unsupported", catalogCapture: "unsupported" },
      db2: { catalogRead: "supported", planEstimate: "unsupported", catalogCapture: "unsupported" },
      cassandra: { catalogRead: "supported", planEstimate: "unsupported", catalogCapture: "unsupported" },
      couchbase: { catalogRead: "supported", planEstimate: "unsupported", catalogCapture: "unsupported" },
      druid: { catalogRead: "supported", planEstimate: "unsupported", catalogCapture: "unsupported" },
      libsql: { catalogRead: "supported", planEstimate: "supported", catalogCapture: "unsupported" },
      influxdb3: { catalogRead: "supported", planEstimate: "supported", catalogCapture: "unsupported" },
    });
    for (const type of SQL_ENGINES) expect(Object.isFrozen(clientDialect(type))).toBe(true);
    for (const type of ["mongodb", "kubernetes", "libredb"] as const) {
      expect(engineClientPack(type).dialect).toBeUndefined();
    }
  });

  test.each(ENGINES)("%s holds each client member exactly when its server dialect supplies it", (type) => {
    const server = engineServerDialect(type);
    const presence = Object.fromEntries(
      CLIENT_DIALECT_MEMBERS.map((member) => [member, server[member] === "unsupported" ? "unsupported" : "supported"]),
    );
    const client = engineClientPack(type).dialect;
    if (client === undefined) {
      // An engine with no client dialect supplies no server member a client asks about.
      expect(Object.values(presence).every((value) => value === "unsupported")).toBe(true);
    } else {
      expect({ ...client } as Record<string, string>).toEqual(presence);
    }
  });

  test("enginesSupporting answers frozen, in registry order, the engines supplying every member asked", () => {
    const composers = enginesSupporting("catalogRead", "planEstimate");
    expect(composers).toEqual(["postgres", "sqlite", "duckdb", "mssql", "mysql", "clickhouse", "libsql", "influxdb3"]);
    expect(Object.isFrozen(composers)).toBe(true);
    const capture = enginesSupporting("catalogCapture");
    expect(capture).toEqual(["postgres", "sqlite"]);
    expect(Object.isFrozen(capture)).toBe(true);
    expect(enginesSupporting("catalogRead", "catalogCapture")).toEqual(["postgres", "sqlite"]);
  });
});

/**
 * The estimating EXPLAIN prefix is restated in the agent rather than read from the provider (#1821 ruling 4): MySQL
 * measures its format on the agent connection too, so the format is not known until connect. What is known before
 * connect is the format each provider declares, and the editor's strategy for that format must build the same
 * estimating statement the agent composes. SQL Server is the one exception: its plan is a session mode, and its
 * provider declares no EXPLAIN at all.
 */
describe("the estimating EXPLAIN agrees with the editor's strategy", () => {
  test.each(["postgres", "sqlite", "duckdb", "mysql", "clickhouse", "libsql"] as const)(
    "%s composes what the strategy of its declared format builds",
    async (type) => {
      const provider = await createDatabaseProvider(
        CENSUS_CONNECTION[type],
        {},
        executionContextFor("agent-read-only"),
      );
      const strategy = getExplainStrategy(provider.getCapabilities().explainFormat);
      expect(strategy).not.toBeNull();
      expect(composeEstimatingExplain(type, "SELECT 1").sql).toBe(strategy!.buildSql("SELECT 1", "estimate")!);
    },
  );

  test("influxdb3 declares no EXPLAIN strategy, and its estimating plan is DataFusion's plain EXPLAIN", async () => {
    const provider = await createDatabaseProvider(
      CENSUS_CONNECTION.influxdb3,
      {},
      executionContextFor("agent-read-only"),
    );
    expect(provider.getCapabilities().supportsExplain).toBe(false);
    expect(provider.getCapabilities().explainFormat).toBeUndefined();
    expect(composeEstimatingExplain("influxdb3", "SELECT 1")).toEqual({ sql: "EXPLAIN SELECT 1", mode: "execute" });
    expect(composeEstimatingExplain("influxdb3", "explain SELECT 1").sql).toBe("EXPLAIN SELECT 1");
  });

  test("mssql declares no EXPLAIN, and its estimating plan is the session mode", async () => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION.mssql, {}, executionContextFor("agent-read-only"));
    expect(provider.getCapabilities().supportsExplain).toBe(false);
    expect(provider.getCapabilities().explainFormat).toBeUndefined();
    expect(composeEstimatingExplain("mssql", "SELECT 1")).toEqual({ sql: "SELECT 1", mode: "estimate-plan" });
  });
});

describe("defineOverlay", () => {
  interface Fixture {
    readonly copy: string;
    readonly grounding: { readonly omissionAdvice: string; readonly relations?: boolean };
    readonly count: number;
  }
  const base: Fixture = Object.freeze({
    copy: "base copy",
    grounding: Object.freeze({ omissionAdvice: "base advice", relations: true }),
    count: 2,
  });

  test("a value replaces the member, and every member left alone keeps its reference", () => {
    const overlaid = defineOverlay(base, { copy: "engine copy" });
    expect(overlaid.copy).toBe("engine copy");
    expect(overlaid.grounding).toBe(base.grounding);
    expect(overlaid.count).toBe(2);
    expect(Object.isFrozen(overlaid)).toBe(true);
  });

  test("a function receives the base value and its result becomes the member", () => {
    const seen: number[] = [];
    const overlaid = defineOverlay(base, {
      count: (count: number) => {
        seen.push(count);
        return count + 1;
      },
    });
    expect(seen).toEqual([2]);
    expect(overlaid.count).toBe(3);
  });

  test("a record replaces the member whole: there is no deep merge", () => {
    const overlaid = defineOverlay(base, { grounding: { omissionAdvice: "x" } });
    expect(overlaid.grounding).toEqual({ omissionAdvice: "x" });
    expect("relations" in overlaid.grounding).toBe(false);
  });

  test("a member the base lacks appears on the result", () => {
    const dialect = Object.freeze({ profileComposition: "unsupported" as const });
    const overlaid = defineOverlay(base, { dialect });
    expect(overlaid.dialect).toBe(dialect);
    expect(Object.keys(overlaid)).toEqual(["copy", "grounding", "count", "dialect"]);
  });

  test("an empty or absent overlay returns the base itself", () => {
    expect(defineOverlay(base)).toBe(base);
    expect(defineOverlay(base, undefined)).toBe(base);
    expect(defineOverlay(base, {})).toBe(base);
  });
});

describe("dialectOnly", () => {
  test("keeps an overlay's dialect by reference and drops every other key, frozen", () => {
    const dialect = Object.freeze({ catalogRead: "supported" as const });
    const kept = dialectOnly({ dialect, copy: "an engine copy the registries never read" });
    expect(kept).toEqual({ dialect });
    expect(kept.dialect).toBe(dialect);
    expect(Object.isFrozen(kept)).toBe(true);
  });

  test("an overlay with no dialect gives an empty, frozen one", () => {
    const empty = dialectOnly({});
    expect(empty).toEqual({});
    expect(Object.isFrozen(empty)).toBe(true);
  });
});

describe("the resolvers and their readers load alone", () => {
  // A module the overlays reach at load, through a runtime cycle, would read a binding in its temporal dead zone here.
  test.each([
    "src/lib/agent/languages/engines/client.ts",
    "src/lib/agent/languages/engines/server.ts",
    "src/lib/agent/languages/engines/index.ts",
    "src/lib/agent/composed-sql.ts",
    "src/lib/agent/table-profile.ts",
    "src/lib/agent/context-snapshot.ts",
    "src/lib/agent/tools.ts",
    "src/lib/agent/agent-manifest.ts",
    "src/lib/agent/posture.ts",
  ])("%s loads alone in a fresh process", (module) => {
    const run = Bun.spawnSync(
      [process.execPath, "-e", `await import(${JSON.stringify(`${process.cwd()}/${module}`)})`],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });
});
