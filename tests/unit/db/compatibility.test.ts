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
  verifiedEngineCount,
  SHIPPED_DATABASE_TYPES,
} from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";
import { isQueryFenceTag } from "@/lib/sql/fence-tags";

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

  test("verifiedEngineCount is the shipped drivers plus the verified relatives", () => {
    expect(verifiedEngineCount()).toBe(SHIPPED_DATABASE_TYPES.length + WIRE_COMPATIBLE_ENGINES.length);
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

  test("caveats are one-line strings, because they render inline in the connection dialog", () => {
    for (const engine of WIRE_COMPATIBLE_ENGINES) {
      for (const caveat of engine.caveats) {
        expect(caveat).not.toContain("\n");
        expect(caveat.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
