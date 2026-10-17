import { describe, expect, test } from "bun:test";

import { CENSUS_CONNECTION } from "@/../tests/helpers/census-connection";
import { createDatabaseProvider } from "@/lib/db/factory";
import { SparkplugProvider } from "@/lib/db/providers/industrial/sparkplug/index";

/*
 * THE ONE LINE OF THE REGISTRATION THAT NOTHING WOULD MISS.
 *
 * `createDatabaseProvider` is a `switch` with a `default`, so it is NOT exhaustive: leave the
 * `case` out and the compiler says nothing, `bun run typecheck` stays green, and every gate passes
 * while the engine cannot be built at all. That is the same shape as the connection picker's
 * `selectableTypes`, a hand-maintained list typed as `DatabaseType[]` where any subset compiles, and
 * a sibling session shipped an engine that was registered everywhere and could not be selected.
 *
 * The fleet census in `tests/unit/lib/query-generators.test.ts` does build every provider through
 * the factory, so it would catch this too. This test exists anyway, and deliberately: a guarantee
 * this package depends on should be held inside this package, not borrowed from a file that belongs
 * to another concern and could narrow its own scope tomorrow.
 */
describe("the factory can actually build this provider", () => {
  test("a sparkplug connection builds a SparkplugProvider and not the default branch", async () => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION.sparkplug);
    expect(provider).toBeInstanceOf(SparkplugProvider);
  });

  test("the provider it builds answers as itself, with no connection open", async () => {
    // Everything this provider declares about topics, datatypes and bounds is answered without a
    // broker, so the built instance is useful evidence rather than an empty shell.
    const provider = await createDatabaseProvider(CENSUS_CONNECTION.sparkplug);
    const capabilities = provider.getCapabilities();
    expect(capabilities.queryLanguage).toBe("json");
    expect(capabilities.enforcesReadOnly).toBe(true);
  });
});
