/**
 * Wire-compatibility registry tests (issue #424, Phase 0).
 *
 * The registry publishes a claim - "this engine works through that driver" - so
 * the tests here are mostly about what the registry is FORBIDDEN to contain. The
 * claim discipline in #424 says a name counts only after a live gate-4 probe, and
 * an unprobed entry is indistinguishable from a probed one to a reader. So the
 * "every entry carries a probed version" test below is not a formality: it is the
 * enforcement mechanism for that rule, moved out of a policy sentence and into CI.
 */
import { describe, test, expect } from "bun:test";
import {
  WIRE_COMPATIBLE_ENGINES,
  compatibleEnginesFor,
  connectableProductCount,
  EXTERNAL_DATABASE_TYPES,
  SHIPPED_DATABASE_TYPES,
} from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";
import { isQueryFenceTag } from "@/lib/sql/fence-tags";
import { parse as parseYaml } from "yaml";

/**
 * The compose service that reproduces each registry entry.
 *
 * The docs section makes this a promise in one sentence - "Reproduce any row with
 * the `compat` profile of the container fixture" - and until now nothing held the
 * fixture to it. That gap has already shipped once on the other half of the file:
 * `redis` was a published engine with no compose service at all, fixed in #426
 * only because someone went looking.
 *
 * The mapping is written out rather than slugged from the name, because not every
 * service is the name lowercased: DragonflyDB runs as `dragonfly` and ScyllaDB as
 * `scylla`, both dropping a suffix the name carries. A slug function would need
 * those exceptions encoded
 * inside it anyway, and it would quietly invent a service name for the next entry
 * instead of failing until a human declares one.
 */
const COMPOSE_SERVICE_BY_ENGINE: Readonly<Record<string, string>> = {
  Citus: "citus",
  CockroachDB: "cockroachdb",
  Materialize: "materialize",
  RisingWave: "risingwave",
  TimescaleDB: "timescaledb",
  YugabyteDB: "yugabytedb",
  "Apache Cloudberry (incubating)": "cloudberry",
  "AlloyDB Omni": "alloydb",
  "Percona Distribution for PostgreSQL": "percona-postgresql",
  ParadeDB: "paradedb",
  OrioleDB: "orioledb",
  MariaDB: "mariadb",
  TiDB: "tidb",
  StarRocks: "starrocks",
  "Apache Doris": "doris",
  "Percona Server for MySQL": "percona-mysql",
  Databend: "databend",
  Vitess: "vitess",
  OceanBase: "oceanbase",
  SingleStore: "singlestore",
  Valkey: "valkey",
  DragonflyDB: "dragonfly",
  KeyDB: "keydb",
  Garnet: "garnet",
  FerretDB: "ferretdb",
  ScyllaDB: "scylla",
};

describe("wire-compatibility registry", () => {
  test("the shipped list holds every database type the product declares", () => {
    // SHIPPED_DATABASE_TYPES used to be a hand-written `readonly DatabaseType[]`,
    // which made the count test below a tautology: both sides read the same
    // constant, so forgetting a newly added type-id undercounted silently. It is
    // now derived from an exhaustive Record, so the COMPILER refuses an omission.
    // This test guards the other direction - a stale entry for a type-id that no
    // longer exists - by cross-checking against an independently maintained
    // exhaustive record over the same union.
    for (const type of SHIPPED_DATABASE_TYPES) {
      expect(isQueryFenceTag(type)).toBe(true);
    }
    expect(SHIPPED_DATABASE_TYPES.length).toBe(new Set(SHIPPED_DATABASE_TYPES).size);
  });

  test("ScyllaDB is recorded as a partial Cassandra relative, on what the probe measured", () => {
    // The entry exists because the gate-4 probe ran (2026-08-21/22, #424 Phase 4) and
    // not because `cassandra-driver` connects - that would be the "connects, therefore
    // supported" claim this registry refuses. What it measured: ten of the fifteen
    // surfaces answer, and the five that do not - overview, health, performance
    // metrics, active sessions, monitoring - all fail with the one verbatim error
    // `Keyspace system_views does not exist`, which also takes Test Connection down
    // because it calls getHealth(). That is `partial` and not `query-only`, because the
    // object browser, column metadata and index metadata all work. The version pinned
    // here is two strings on purpose: `system.local.release_version` publishes the
    // Cassandra compatibility number 3.0.8, and the real build lives in
    // `system.versions`, which the provider does not read. Of the three doubts the
    // provider doc raised, `system_views` and the version shape held; `gossip_generation`
    // does exist on ScyllaDB and answers.
    expect(SHIPPED_DATABASE_TYPES).toContain("cassandra");
    const relatives = compatibleEnginesFor("cassandra");
    expect(relatives.map((engine) => engine.name)).toEqual(["ScyllaDB"]);
    const scylla = relatives[0];
    expect(scylla?.via).toBe("cassandra");
    expect(scylla?.tier).toBe("partial");
    expect(scylla?.probedVersion).toBe("ScyllaDB 2026.2.4-0.20260810.e54224b8cebb (advertises Cassandra 3.0.8)");
    expect(scylla?.caveats.some((caveat) => caveat.includes("system_views"))).toBe(true);
    expect(WIRE_COMPATIBLE_ENGINES.map((engine) => engine.name.toLowerCase())).toContain("scylladb");
  });

  test("Apache Doris is recorded as a partial MySQL relative, on what the probe measured", () => {
    // Probed 2026-08-26 against `apache/doris:all-in-one-4.1.3` (#424 Phase 0). The entry
    // exists because StarRocks - already registered here - is a FORK of Doris, and this
    // registry had been carrying the fork while missing the original. It is not a copy of
    // that row: thirteen of the fifteen surfaces answer where StarRocks manages eleven,
    // and the numbers are the sharp difference. StarRocks reports hard zeros; Doris reports
    // 2000 rows and 10187 bytes for a table holding exactly that, so the object browser and
    // the table-statistics panel are trustworthy here.
    //
    // Two surfaces fail, both on ONE statement form: `SHOW STATUS LIKE '...'` is a parse
    // error in the Doris grammar while a bare `SHOW STATUS` is accepted (and answers zero
    // rows), which takes the overview and health panels. That cause is ours rather than the
    // engine's and is filed as a backlog defect - the tier records what a user gets today,
    // not what a fix could give them.
    const relatives = compatibleEnginesFor("mysql");
    const doris = relatives.find((engine) => engine.name === "Apache Doris");
    expect(doris).toBeDefined();
    expect(doris?.via).toBe("mysql");
    expect(doris?.tier).toBe("partial");
    expect(doris?.probedVersion).toBe("Apache Doris 4.1.3-rc02-7126cf65d96 (version() reports 5.7.99)");
    // The caveat set has to name the two failures and the two traps, because each one is a
    // thing a reader would otherwise believe works: the fictitious version, the invisible
    // foreign key, the absent indexes, and the statement form that costs two panels.
    const caveats = doris?.caveats.join(" ") ?? "";
    expect(caveats).toContain("SHOW STATUS");
    expect(caveats).toContain("5.7.99");
    expect(caveats).toContain("KEY_COLUMN_USAGE");
    expect(caveats).toContain("information_schema.statistics");
  });

  test("the Doris row is not the StarRocks row, and says so where it matters", () => {
    // A fork's measurements are a PRIOR, never an inheritance. This test pins the one
    // difference that would be tempting to copy across and would be wrong: StarRocks'
    // caveats say the row counts and sizes are hard zeros, and Doris's must not, because
    // the probe read the true numbers there.
    const byName = new Map(WIRE_COMPATIBLE_ENGINES.map((engine) => [engine.name, engine]));
    const starrocks = byName.get("StarRocks");
    const doris = byName.get("Apache Doris");
    expect(starrocks?.caveats.some((caveat) => caveat.includes("Row counts and sizes are always 0"))).toBe(true);
    expect(doris?.caveats.some((caveat) => caveat.includes("always 0"))).toBe(false);
    expect(doris?.caveats.some((caveat) => caveat.includes("2000 rows"))).toBe(true);
  });

  test("QuestDB is NOT in the registry, and the reason is the one a provider probe cannot see", async () => {
    // Probed 2026-08-26 against `questdb/questdb:10.0.1` and REFUSED a row (#424 Phase 0),
    // which is why this test asserts an absence. It is here rather than left implicit
    // because QuestDB is the most re-addable name on that list: it speaks the PostgreSQL
    // wire protocol, and through the provider a statement answers three rows, so every
    // signal short of a browser says "query-only relative, register it".
    //
    // In the product the editor cannot run anything. It always attaches a `queryId`, the
    // provider then issues `SELECT pg_backend_pid()` first, and QuestDB has no such
    // function: `500 unknown function name: pg_backend_pid()`. Measured both ways at the
    // provider boundary - the same call with a queryId fails, without one returns the rows -
    // so the cause is established rather than guessed. A query-editor-only tier claims
    // exactly one thing, and that is the thing that does not work, which makes it the Cloud
    // Spanner case: the number is the finding and the finding lives in the docs.
    expect(WIRE_COMPATIBLE_ENGINES.map((engine) => engine.name)).not.toContain("QuestDB");
    // ...and the reason must be readable beside the table, not only in this test.
    const docs = await Bun.file("docs/providers/README.md").text();
    expect(docs).toContain("Measured, and refused a row");
    const refusedSection = docs.slice(docs.indexOf("Measured, and refused a row"));
    expect(refusedSection).toContain("QuestDB 10.0.1");
    expect(refusedSection).toContain("pg_backend_pid()");
  });

  test("Garnet is a full Redis relative whose own version the product does not show", () => {
    // Probed 2026-08-26 against `ghcr.io/microsoft/garnet:2.1.5` (#424 Phase 0). Every Redis
    // surface answers, so `full` by this registry's own definition - the numbers that are
    // wrong are recorded as caveats, the way Citus's are.
    //
    // What separates this row from the other three Redis relatives: Valkey and DragonflyDB
    // show an emulation level because that is all they publish, and KeyDB publishes nothing
    // of its own at all. Garnet DOES publish `garnet_version:2.1.5` and `server_name:garnet`
    // in INFO, and the product still shows Redis 7.4.3 - the one place where the real
    // version was there to be read and went unread.
    const garnet = compatibleEnginesFor("redis").find((engine) => engine.name === "Garnet");
    expect(garnet).toBeDefined();
    expect(garnet?.tier).toBe("full");
    expect(garnet?.probedVersion).toBe("Garnet 2.1.5 (advertises Redis 7.4.3)");
    const caveats = garnet?.caveats.join(" ") ?? "";
    expect(caveats).toContain("garnet_version");
    // The two numbers a reader must not trust, both from INFO fields Garnet does not publish
    // at all: no `used_memory` (so every size reads 0 B) and no keyspace counters (so the
    // cache hit ratio is the `: 100` fallback D14 already records).
    expect(caveats).toContain("used_memory");
    expect(caveats).toContain("cache hit ratio");
  });

  test("both Percona distributions are full relatives, and they differ in one thing only", () => {
    // Probed 2026-08-26 (#424 Phase 0) against `percona/percona-server:8.4` and
    // `percona/percona-distribution-postgresql:18.6`. Both answer all fifteen surfaces with
    // the correct numbers, which is the expected result for a drop-in build and the reason
    // these two were the cheapest names left on the list.
    //
    // The one difference is worth a test rather than a sentence, because it is the same
    // trap Garnet's row records and it lands on only one of the pair: Percona for
    // PostgreSQL puts its own name in `version()` ("PostgreSQL 18.6 - Percona Server for
    // PostgreSQL 18.6.1"), so the product displays it, while Percona Server for MySQL
    // answers a bare `8.4.11-11` and keeps its identity in `@@version_comment`, which the
    // provider does not read - so that one is indistinguishable from stock MySQL on screen.
    const mysqlSide = compatibleEnginesFor("mysql").find((e) => e.name === "Percona Server for MySQL");
    const pgSide = compatibleEnginesFor("postgres").find((e) => e.name === "Percona Distribution for PostgreSQL");
    expect(mysqlSide?.tier).toBe("full");
    expect(pgSide?.tier).toBe("full");
    expect(mysqlSide?.probedVersion).toBe("Percona Server for MySQL 8.4.11-11 (version() reports 8.4.11-11)");
    expect(pgSide?.probedVersion).toBe("Percona Server for PostgreSQL 18.6.1 on PostgreSQL 18.6");
    expect(mysqlSide?.caveats.some((c) => c.includes("@@version_comment"))).toBe(true);
    // The PostgreSQL side must NOT carry that caveat - it does not have the problem, and a
    // copied caveat is how a pair of rows stops describing two different measurements.
    expect(pgSide?.caveats.some((c) => c.includes("@@version_comment"))).toBe(false);
  });

  test("ParadeDB and OrioleDB are full PostgreSQL relatives that fail for opposite reasons", () => {
    // Probed 2026-08-27 (#424 Phase 0) against `paradedb/paradedb:0.25.4` and
    // `orioledb/orioledb:pg18-nightly-20260824-cc35a80-ubuntu`. Both answer all fifteen
    // surfaces, so both are `full` - and the pair is worth reading together because what
    // each one costs the user is the opposite of the other.
    //
    // ParadeDB's cost is WIDTH: its nine extensions put 41 objects in the object browser
    // for 2 user tables and 74 indexes.
    //
    // That looked like B52 - the grounding capture refusing past 200 rows, as it does on
    // TimescaleDB - and the measurement refuted it, which is why the caveat says so
    // explicitly. The capture reads what the ROLE can see: a superuser sees 539 non-system
    // columns there, an unprivileged role 168, because the tiger geocoder's 425 are not
    // readable. So gate 7 PASSES under a least-privilege role (21 tables read), and what
    // fails as a superuser is the execution profile refusing a superuser - true on any
    // PostgreSQL and not a ParadeDB property at all.
    //
    // OrioleDB's cost is DEPTH: the browser is clean (2 objects for 2 tables) and the row
    // counts are exact, but its own storage is invisible to PostgreSQL's size functions -
    // `pg_indexes_size()` reads 0 - and `pg_statio_user_tables` stays at 0/0, so the cache
    // hit ratio is absent rather than wrong. Absent is the honest reading, which is why it
    // is a caveat and not a defect.
    const relatives = compatibleEnginesFor("postgres");
    const parade = relatives.find((engine) => engine.name === "ParadeDB");
    const oriole = relatives.find((engine) => engine.name === "OrioleDB");
    expect(parade?.tier).toBe("full");
    expect(oriole?.tier).toBe("full");
    expect(parade?.probedVersion).toBe("ParadeDB 0.25.4 on PostgreSQL 18.6");
    expect(oriole?.probedVersion).toBe("OrioleDB beta 16 on PostgreSQL 18.4 (nightly of 2026-08-24)");
    expect(parade?.caveats.some((caveat) => caveat.includes("41 objects"))).toBe(true);
    // The B52 claim must NOT be here: it was measured and refuted (see above).
    expect(parade?.caveats.some((caveat) => caveat.includes("B52"))).toBe(false);
    expect(parade?.caveats.some((caveat) => caveat.includes("168 columns"))).toBe(true);
    expect(oriole?.caveats.some((caveat) => caveat.includes("pg_indexes_size"))).toBe(true);
    // The width caveat must NOT be copied onto the clean engine, and vice versa.
    expect(oriole?.caveats.some((caveat) => caveat.includes("41 objects"))).toBe(false);
    expect(parade?.caveats.some((caveat) => caveat.includes("pg_indexes_size"))).toBe(false);
  });

  test("Databend is query-editor-only because our own reads cannot run there", () => {
    // Probed 2026-08-27 against `datafuselabs/databend:v1.2.925-patch-11`. SQL runs: a
    // 2000-row `count(*)` and a plain `EXPLAIN` both answer, and the catalogs THEMSELVES
    // answer when asked with literal SQL - `information_schema.tables` reported the true
    // 3 and 2000 rows with sizes.
    //
    // The object browser still gets nothing, and the reason is ours: every parameterised
    // read goes through mysql2's prepared protocol and Databend replies
    // `Prepare is not support in Databend`. D8 moved the PARAMETERLESS statements to the
    // text protocol; the ones carrying placeholders - the table list, the schema, sessions,
    // table/index/storage stats - still prepare. So this row is `query-only` for what a
    // user gets today, with the cause recorded as a backlog item rather than as the
    // engine's fault.
    const databend = compatibleEnginesFor("mysql").find((engine) => engine.name === "Databend");
    expect(databend?.tier).toBe("query-only");
    expect(databend?.probedVersion).toBe("Databend v1.2.925-patch-11 (advertises MySQL 8.0.90)");
    const caveats = databend?.caveats.join(" ") ?? "";
    expect(caveats).toContain("Prepare is not support in Databend");
    expect(caveats).toContain("information_schema.tables");
  });

  test("every entry names a driver we actually ship", () => {
    for (const engine of WIRE_COMPATIBLE_ENGINES) {
      expect(SHIPPED_DATABASE_TYPES).toContain(engine.via);
    }
  });

  test("every entry carries the server version a live probe reported", () => {
    for (const engine of WIRE_COMPATIBLE_ENGINES) {
      expect(engine.probedVersion.trim().length).toBeGreaterThan(0);
    }
  });

  test("no engine name is listed twice", () => {
    const names = WIRE_COMPATIBLE_ENGINES.map((e) => e.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  test("compatibleEnginesFor returns only the engines served by that driver", () => {
    for (const type of SHIPPED_DATABASE_TYPES) {
      const engines = compatibleEnginesFor(type);
      expect(engines.every((e) => e.via === type)).toBe(true);
      expect(engines.length).toBe(WIRE_COMPATIBLE_ENGINES.filter((e) => e.via === type).length);
    }
  });

  test("compatibleEnginesFor is empty for a driver with no verified relatives", () => {
    // sqlite has no wire protocol at all, so it can never gain an entry here.
    expect(compatibleEnginesFor("sqlite")).toEqual([]);
  });

  test("compatibleEnginesFor tolerates a type outside the shipped union", () => {
    expect(compatibleEnginesFor("not-a-database" as DatabaseType)).toEqual([]);
  });

  test("duckdb ships as a driver and is a relative of nothing", () => {
    // The negative half is the load-bearing one. DuckDB speaks no wire protocol at all -
    // it is an in-process library reading a file - so no engine can be compatible with
    // it by pretending to be it, and an empty relatives list here is a measured fact
    // rather than work not yet done.
    expect(SHIPPED_DATABASE_TYPES).toContain("duckdb");
    expect(EXTERNAL_DATABASE_TYPES).toContain("duckdb");
    expect(compatibleEnginesFor("duckdb")).toEqual([]);
    // And nothing reaches DuckDB through another driver either.
    for (const engine of WIRE_COMPATIBLE_ENGINES) expect(engine.via).not.toBe("duckdb");
  });

  test("EXTERNAL_DATABASE_TYPES omits the embedded provider and nothing else", () => {
    // The login hero publishes this length as "database engines", so the one thing this
    // list may not contain is the embedded provider: libredb is a store this app carries,
    // not a database a user already runs and points us at. Every other shipped id belongs.
    expect(EXTERNAL_DATABASE_TYPES).not.toContain("libredb");
    expect(EXTERNAL_DATABASE_TYPES.length).toBe(SHIPPED_DATABASE_TYPES.length - 1);
    for (const type of EXTERNAL_DATABASE_TYPES) {
      expect(SHIPPED_DATABASE_TYPES).toContain(type);
    }
  });

  test("connectableProductCount is the external engines plus the verified relatives", () => {
    // Not the shipped drivers plus the relatives, which is what this function counted
    // before and what made it disagree with the number README.md publishes: the embedded
    // provider is a driver we ship and not a product anyone connects to, so counting it
    // here overstated the claim by one.
    expect(connectableProductCount()).toBe(EXTERNAL_DATABASE_TYPES.length + WIRE_COMPATIBLE_ENGINES.length);
    expect(connectableProductCount()).toBe(SHIPPED_DATABASE_TYPES.length + WIRE_COMPATIBLE_ENGINES.length - 1);
  });

  test("a query-only engine always carries a caveat saying so", () => {
    // The live probes forced this distinction: Materialize and RisingWave answer
    // SQL and nothing else, while Citus matches PostgreSQL surface for surface.
    // Publishing both as "compatible" is exactly the overclaim #424 forbids, so a
    // query-only tier is not allowed to be silent about it.
    for (const engine of WIRE_COMPATIBLE_ENGINES.filter((e) => e.tier === "query-only")) {
      expect(engine.caveats.length).toBeGreaterThan(0);
    }
  });

  test("a partial engine names at least one thing that does not work", () => {
    for (const engine of WIRE_COMPATIBLE_ENGINES.filter((e) => e.tier === "partial")) {
      expect(engine.caveats.length).toBeGreaterThan(0);
    }
  });

  test("every entry declares a known tier", () => {
    for (const engine of WIRE_COMPATIBLE_ENGINES) {
      expect(["full", "partial", "query-only"]).toContain(engine.tier);
    }
  });

  test("the docs compatibility table lists every registry entry, with its probed version", async () => {
    // The table is hand-written prose beside machine-readable data, which is how
    // the two drift: an entry gets added to one and not the other, and the docs
    // then publish a claim the registry does not make (or the reverse). This is the
    // provider tri-sync rule applied to a compatible name that has no doc page.
    const docs = await Bun.file("docs/providers/README.md").text();
    for (const engine of WIRE_COMPATIBLE_ENGINES) {
      expect(docs).toContain(engine.name);
      expect(docs).toContain(engine.probedVersion.replace(/ \(.*\)$/, ""));
    }
  });

  test("every registry entry declares the compose service that reproduces it", () => {
    // Keys exactly equal names, in both directions: a new registry entry cannot be
    // added without saying which service brings its engine up, and a service left
    // declared after its entry is deleted fails here too.
    expect(Object.keys(COMPOSE_SERVICE_BY_ENGINE).sort()).toEqual(WIRE_COMPATIBLE_ENGINES.map((e) => e.name).sort());
  });

  test("every declared compose service exists in the fixture under the compat profile", async () => {
    // `compat` is the part that matters. A service present but outside the profile
    // would start on a plain `docker compose up`, which the fixture's own comment
    // promises it does not, and would not start on the documented command at all.
    const fixture = parseYaml(await Bun.file("database-compose.yml").text()) as {
      services: Record<string, { profiles?: readonly string[] }>;
    };
    for (const service of Object.values(COMPOSE_SERVICE_BY_ENGINE)) {
      expect(Object.keys(fixture.services)).toContain(service);
      expect(fixture.services[service]?.profiles ?? []).toContain("compat");
    }
  });

  test("caveats are one-line strings, because they render inline in the connection dialog", () => {
    for (const engine of WIRE_COMPATIBLE_ENGINES) {
      for (const caveat of engine.caveats) {
        expect(caveat).not.toContain("\n");
        expect(caveat.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
