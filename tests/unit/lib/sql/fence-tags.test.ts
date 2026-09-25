import { describe, expect, test } from "bun:test";
import { fenceTagEngine, isQueryFenceTag } from "@/lib/sql/fence-tags";
import type { DatabaseType } from "@/lib/types";

/**
 * The two questions a fence's info string answers, and why they are two (#396 review).
 *
 * `isQueryFenceTag` asks whether the block holds a query at all — it decides whether a
 * surface offers the editor. `fenceTagEngine` asks WHICH engine the model named, which
 * is the question the first one cannot answer: it says yes to `mysql` on a PostgreSQL
 * connection, and a reader that then stamps the block with the connection's own dialect
 * has relabelled the model's MySQL as PostgreSQL.
 */

describe("fenceTagEngine", () => {
  test("a canonical type-id names its own engine", () => {
    const engines = [
      "postgres",
      "mysql",
      "sqlite",
      "mongodb",
      "redis",
      "oracle",
      "mssql",
      "libredb",
      "couchbase",
      "clickhouse",
      "druid",
      "trino",
      "cassandra",
      "duckdb",
      "prometheus",
      "kafka",
    ] satisfies DatabaseType[];

    for (const engine of engines) expect(fenceTagEngine(engine)).toBe(engine);
  });

  test("an alias names the engine it is an alias for", () => {
    expect(fenceTagEngine("postgresql")).toBe("postgres");
    expect(fenceTagEngine("pgsql")).toBe("postgres");
    expect(fenceTagEngine("mariadb")).toBe("mysql");
    expect(fenceTagEngine("sqlite3")).toBe("sqlite");
    expect(fenceTagEngine("plsql")).toBe("oracle");
    expect(fenceTagEngine("tsql")).toBe("mssql");
    expect(fenceTagEngine("sqlserver")).toBe("mssql");
    expect(fenceTagEngine("mongo")).toBe("mongodb");
    expect(fenceTagEngine("n1ql")).toBe("couchbase");
    // The product name a model is likelier to write than the protocol's: a block
    // tagged `turso` holds a statement for a libSQL connection.
    expect(fenceTagEngine("turso")).toBe("libsql");
  });

  test("no alias is registered for duckdb, because every candidate names something else", () => {
    // `ddb` is DynamoDB in most of the material a model has read and `duck` names no
    // language at all. An alias that names the WRONG engine is worse here than a
    // missing one: `fenceTagEngine` is what decides whether a plan's deliverable was
    // written for this connection.
    expect(fenceTagEngine("ddb")).toBeNull();
    expect(fenceTagEngine("duck")).toBeNull();
    expect(isQueryFenceTag("ddb")).toBe(false);
  });

  test("a generic tag and an absent one name no engine, so they contradict none", () => {
    // `sql` is the tag a model writes when it is not saying which engine. Mapping it to
    // the connection's would turn a generic tag into a claim the model never made.
    expect(fenceTagEngine("sql")).toBeNull();
    expect(fenceTagEngine(undefined)).toBeNull();
  });

  test("a tag naming no query language at all names no engine", () => {
    expect(fenceTagEngine("bash")).toBeNull();
    expect(fenceTagEngine("json")).toBeNull();
  });

  test("naming an engine and holding a query are different questions", () => {
    // The pair that motivated the split: `sql` holds a query and names no engine.
    expect(isQueryFenceTag("sql")).toBe(true);
    expect(fenceTagEngine("sql")).toBeNull();
    // And the inverse ordering: a tag that names an engine always holds a query.
    expect(isQueryFenceTag("mysql")).toBe(true);
    expect(fenceTagEngine("mysql")).toBe("mysql");
  });

  test("cql names a language, so it holds a query without naming an engine", () => {
    // The `sql` case again, one language down: CQL is a language rather than a product,
    // and ScyllaDB speaks it too, so reading `cql` as "written for Cassandra" would put
    // a claim in the model's mouth. Registering it in `QUERY_FENCE_ALIASES` only —
    // never in `ALIAS_ENGINES` — is what keeps the offer of the editor separate from
    // the claim about which connection the block was drafted for.
    expect(isQueryFenceTag("cql")).toBe(true);
    expect(fenceTagEngine("cql")).toBeNull();
    // The product name is the tag that DOES name the engine, and the canonical-engine
    // walk above asserts it.
    expect(isQueryFenceTag("cassandra")).toBe(true);
  });

  test("promql is a language tag that still names one engine, because one type-id runs PromQL", () => {
    // An alias names the type-id a block's text runs on, not a product: `mariadb` names `mysql`
    // and `turso` names `libsql`. Every PromQL server this product reaches, VictoriaMetrics
    // included, connects through `prometheus` (#1085), so a ```promql block on any other
    // connection was written for another engine. Naming none would let it pass there as the run's
    // deliverable, the `mysql`-on-PostgreSQL case `fenceTagEngine` exists to catch.
    expect(fenceTagEngine("promql")).toBe("prometheus");
    // Naming an engine does not stop the block holding a query, so the editor is still offered it.
    expect(isQueryFenceTag("promql")).toBe(true);
    // The control: the canonical tag names the same engine, so the two spellings cannot disagree.
    expect(isQueryFenceTag("prometheus")).toBe(true);
    expect(fenceTagEngine("prometheus")).toBe("prometheus");
  });
});
