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
  MariaDB: "mariadb",
  TiDB: "tidb",
  StarRocks: "starrocks",
  Vitess: "vitess",
  OceanBase: "oceanbase",
  SingleStore: "singlestore",
  Valkey: "valkey",
  DragonflyDB: "dragonfly",
  KeyDB: "keydb",
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
