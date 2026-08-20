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
  // cries wolf on an ordinary name is a guard the next contributor deletes.
  "consistency",
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
