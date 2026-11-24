/**
 * The statistics read's statements reach their provider exactly as composed (src/lib/api/composed-statement.ts;
 * docs/providers/CONTRACT.md, clause C-80).
 *
 * Plan mode's statistics read runs under the operations profile on every engine whose server dialect reads statistics
 * and captures no catalog: an engine that captures its catalog reads its statistics on the read-only path instead
 * (`groundingStatementsUnderExecutionProfile` in src/lib/agent/tools.ts). The dialects are read from the engines'
 * server dialects, never listed here, so an engine that gains statistics is held as soon as it does. Each provider is
 * built through the real `createDatabaseProvider`, unconnected, with its plain `query` replaced on the instance by a
 * recorder, and each composed statement, the availability probe where the dialect has one and the estimates, runs
 * through `runComposedStatement` on the real host core: the recorder must receive exactly that statement and nothing
 * beside it, where the console session's prepare would append a page bound.
 *
 * It lives under `tests/isolated/` for the reason `object-source-declarations.test.ts` gives: it needs the real
 * factory, which every file under `tests/api/` mocks, and the runner gives each test file a process of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { composeCatalogRead, composeStatisticsAvailabilityProbe } from "@/lib/agent/composed-sql";
import { engineServerDialect } from "@/lib/agent/languages/engines/server";
import { runComposedStatement } from "@/lib/api/composed-statement";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import type { DatabaseType, QueryResult } from "@/lib/types";
import { CENSUS_CONNECTION } from "../helpers/census-connection";

beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

const ALL: readonly DatabaseType[] = [...EXTERNAL_DATABASE_TYPES, "libredb"];

/** The dialects whose statistics read runs under the operations profile: statistics, and no catalog capture. */
const OPERATIONS_STATISTICS = ALL.filter((type) => {
  const dialect = engineServerDialect(type);
  return dialect.statistics !== "unsupported" && dialect.catalogCapture === "unsupported";
});

describe("the statistics read's composed statements", () => {
  test("every dialect that reads statistics under the operations profile hands its provider the composed statement unchanged", async () => {
    const sent: { readonly type: DatabaseType; readonly args: unknown[] }[] = [];
    const expected: { readonly type: DatabaseType; readonly args: unknown[] }[] = [];

    for (const type of OPERATIONS_STATISTICS) {
      // oxlint-disable-next-line no-await-in-loop -- one engine at a time, so each recorded call is its own.
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      provider.query = async (...args: unknown[]): Promise<QueryResult> => {
        sent.push({ type, args });
        return { rows: [], fields: [], rowCount: 0, executionTime: 0 };
      };
      const probe = composeStatisticsAvailabilityProbe(type);
      const statements = [...(probe === null ? [] : [probe]), composeCatalogRead(type, { kind: "statistics" })];
      for (const statement of statements) {
        expected.push({ type, args: [statement] });
        // oxlint-disable-next-line no-await-in-loop -- one statement at a time, in the order the read sends them.
        await runComposedStatement(provider, {
          statement,
          deadline: Date.now() + 10_000,
          timeRefusal: () => new Error(`the ${type} statistics read did not answer in time`),
          route: "composed-statistics-census",
          holdUntilSettled: () => {},
        });
      }
    }

    expect(OPERATIONS_STATISTICS.length).toBeGreaterThan(0);
    expect(sent).toEqual(expected);
  });
});
