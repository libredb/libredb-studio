/**
 * Cassandra driver seam guard (issue #424, Phase 4)
 *
 * This provider's seam is a PACKAGE rather than a protocol, which makes the rule
 * simpler than Trino's and the stake different. `cassandra-driver` is the only
 * runtime dependency #424 has added, and the whole reason the provider is worth
 * having it is that everything above `driver-transport.ts` is written against a
 * neutral interface: the schema reads, the monitoring reads and the provider itself
 * would keep working over any other client, and the integration suite already runs
 * them over a session that is not the driver's.
 *
 * So the guard is one assertion with two directions: the driver is imported in
 * `driver-transport.ts`, and nowhere else in the provider. It reads the directory
 * from disk rather than from a list, so it keeps holding as the provider grows.
 *
 * A second rule rides along, and it is the one a reader is most likely to break by
 * accident: nothing above the adapter may name a driver VALUE CLASS. `Long`,
 * `BigDecimal`, `Duration` and `Vector` are the driver's own types, and the neutral
 * result carries their values as strings and arrays precisely so that no consumer has
 * to know them.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabaseProvider } from "@/lib/db/factory";
import { QueryError } from "@/lib/db/errors";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PROVIDER_DIR = join(ROOT, "src", "lib", "db", "providers", "sql", "cassandra");

/** The single file allowed to know the driver. */
const ADAPTER_FILE = "driver-transport.ts";

/** The package itself, and the driver-only vocabulary that comes with it. */
const DRIVER_TOKENS = [
  "cassandra-driver",
  // The client class and the session methods it publishes: `execute`, `shutdown` and
  // `eachRow` all belong behind the adapter.
  "eachRow",
  "shutdown",
  // Driver value classes. A consumer that names one has stopped reading the neutral
  // result, where a bigint is already an exact string and a vector already an array.
  "BigDecimal",
  "LocalDate",
  "LocalTime",
  "InetAddress",
  "TimeUuid",
  // Protocol-level knobs the seam deliberately does not expose. `prepare:` carries
  // its colon because `prepareQuery` is the provider's own method - a guard that
  // cries wolf on an ordinary name is a guard the next contributor deletes. The seam
  // does name a consistency of its own, the agent's `consistency: "local-one"`, so it
  // is the driver's map of levels that is guarded, and the retry policies beside it.
  "consistencies",
  "RetryPolicy",
  "prepare:",
  "traceQuery",
];

function providerSources(): string[] {
  return readdirSync(PROVIDER_DIR, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

function readProviderSource(file: string): string {
  return readFileSync(join(PROVIDER_DIR, file), "utf8");
}

/**
 * The lines of `file` that name `token` in CODE.
 *
 * Comments are stripped first, and deliberately: the prose in these files quotes the
 * driver's own error classes and knobs constantly - that is what records the
 * measurements - and a guard that fired on prose would be a guard the next
 * contributor deletes. What matters is that no code depends on them.
 */
function codeLinesNaming(file: string, token: string): string[] {
  return readProviderSource(file)
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .filter((line) => line.includes(token));
}

describe("the Cassandra driver stays behind one file", () => {
  const sources = providerSources();

  test("the guard scans the whole provider directory", () => {
    expect(sources).toContain(ADAPTER_FILE);
    expect(sources.length).toBeGreaterThan(1);
  });

  // A detector that finds nothing anywhere is indistinguishable from a broken one, so
  // the file that is SUPPOSED to speak to the driver must light it up.
  test("the adapter itself imports the driver, proving the detector reads real code", () => {
    expect(codeLinesNaming(ADAPTER_FILE, "cassandra-driver").length).toBeGreaterThan(0);
    expect(codeLinesNaming(ADAPTER_FILE, "BigDecimal").length).toBeGreaterThan(0);
  });

  test.each(DRIVER_TOKENS)("no file above the adapter names %s in code", (token) => {
    const offenders = sources
      .filter((file) => file !== ADAPTER_FILE)
      .flatMap((file) => codeLinesNaming(file, token).map((line) => `${file}: ${line.trim()}`));

    expect(offenders).toEqual([]);
  });

  test("the neutral seam declares no driver type at all", () => {
    // `transport.ts` is what a second implementation would be written against, so it
    // is the file where a driver import would be most damaging and least visible. Its
    // PROSE names the driver constantly - that is where the measurements are recorded
    // - so this asks about code, like every check above.
    expect(codeLinesNaming("transport.ts", "cassandra-driver")).toEqual([]);
    expect(codeLinesNaming("transport.ts", "import")).toEqual([]);
  });
});

/**
 * The page-two refusal, and the capability that must agree with it (#816).
 *
 * Cassandra is the engine the whole `supportsResultPagination` design exists for.
 * `supportsExternalQueryLimiting` is `true` here — a bound CAN be injected — and
 * `prepareQuery` still throws on any positive offset, because CQL has no `OFFSET`
 * clause. Reading the old flag as "can be paged" is exactly the mistake that would put
 * a Load More on this provider, so both are asserted together: the two flags disagree,
 * on purpose, and the new one is the one the grid reads.
 *
 * It sits in this file because the issue's Tests section names it. Nothing here scans
 * source text, and the refusal's own message and message-shape coverage stays in
 * `tests/integration/db/cassandra-provider.test.ts`.
 */
describe("Cassandra refuses page two, and says so in its capabilities", () => {
  const provider = async () => await createDatabaseProvider(CENSUS_CONNECTION.cassandra);

  test("a bound can be injected, and the first page still gets one", async () => {
    const caps = (await provider()).getCapabilities();
    expect(caps.supportsExternalQueryLimiting).toBe(true);

    const pageOne = (await provider()).prepareQuery("SELECT * FROM t", { limit: 50, offset: 0 });
    expect(pageOne.query).toBe("SELECT * FROM t LIMIT 50");
    expect(pageOne.wasLimited).toBe(true);
  });

  test("a positive offset is refused rather than answered with page one", async () => {
    const p = await provider();
    expect(() => p.prepareQuery("SELECT * FROM t", { limit: 50, offset: 50 })).toThrow(QueryError);
  });

  test("the capability agrees with the refusal", async () => {
    expect((await provider()).getCapabilities().supportsResultPagination).toBe(false);
  });
});
