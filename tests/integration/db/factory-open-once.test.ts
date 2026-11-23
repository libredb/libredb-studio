/**
 * One open in flight per cache key, against the real DuckDB engine (docs/providers/CONTRACT.md, clause C-44): two
 * concurrent first requests for one DuckDB connection share one provider, so both writes reach the file.
 *
 * Before the factory shared an open in flight, each concurrent first call built and connected its own handle on the
 * file and the second replaced the first in the cache; the handle left out checkpointed its own copy of the catalog
 * over the file when it closed, so one of the two committed rows was lost. Measured at the function on 2026-11-23,
 * before the fix: 5 of 5 rounds lost a row, each with two providers built and one cached.
 *
 * Each round uses its own file under a fresh temporary directory, opens through `getOrCreateProvider` the way a route
 * does, closes every handle with `clearProviderCache()` before a fresh handle counts the rows, and closes that one too
 * before the next round, so no two rounds share a handle on any platform.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearProviderCache, getOrCreateProvider, getProviderCacheStats } from "@/lib/db/factory";
import type { DatabaseConnection, DatabaseProvider } from "@/lib/db/types";

const ROUNDS = 5;
const directory = mkdtempSync(path.join(tmpdir(), "factory-open-once-"));
/** The editor posture a trusted caller opens DuckDB under; the file lies outside the data directory. */
const TRUSTED = { allowExternalFileAccess: true } as const;

afterAll(async () => {
  await clearProviderCache();
  rmSync(directory, { recursive: true, force: true });
});

function duckdbConnection(round: number): DatabaseConnection {
  return {
    id: `open-once-duckdb-${round}`,
    name: `Open once ${round}`,
    type: "duckdb",
    database: path.join(directory, `round-${round}.duckdb`),
    createdAt: new Date(),
  } as DatabaseConnection;
}

/** Opens the connection as a route does and writes one row, answering the provider it wrote through. */
async function writeRow(connection: DatabaseConnection, value: number): Promise<DatabaseProvider> {
  const provider = await getOrCreateProvider(connection, {}, TRUSTED);
  await provider.query("CREATE TABLE IF NOT EXISTS writes (value INTEGER)");
  await provider.query(`INSERT INTO writes VALUES (${value})`);
  return provider;
}

/** One round: two concurrent first writes, every handle closed, then a fresh handle counts the rows and closes. */
async function concurrentWritesRound(round: number): Promise<number> {
  const connection = duckdbConnection(round);
  await Promise.all([writeRow(connection, 1), writeRow(connection, 2)]);
  await clearProviderCache();
  const reader = await getOrCreateProvider(connection, {}, TRUSTED);
  const result = await reader.query("SELECT count(*) AS n FROM writes");
  await clearProviderCache();
  return Number(result.rows[0]?.n);
}

describe("one open in flight per cache key on DuckDB", () => {
  test("two concurrent first writes for one DuckDB connection both reach the file", async () => {
    const counts: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each round must see every handle closed before the next opens one.
      counts.push(await concurrentWritesRound(round));
    }
    expect(counts).toEqual(Array.from({ length: ROUNDS }, () => 2));
  });

  test("one provider serves both writers", async () => {
    const connection = duckdbConnection(ROUNDS);
    const [first, second] = await Promise.all([
      getOrCreateProvider(connection, {}, TRUSTED),
      getOrCreateProvider(connection, {}, TRUSTED),
    ]);
    expect(first).toBe(second);
    expect(getProviderCacheStats().size).toBe(1);
    await first.query("CREATE TABLE writes (value INTEGER)");
    await Promise.all([first.query("INSERT INTO writes VALUES (1)"), second.query("INSERT INTO writes VALUES (2)")]);
    expect(getProviderCacheStats().size).toBe(1);
    await clearProviderCache();
  });
});
