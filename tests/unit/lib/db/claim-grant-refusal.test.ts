/**
 * `assertClaimsGranted` (src/lib/db/factory.ts): an engine whose claims leave a refusal no grant covers, a
 * single-writer file request that is not Studio's grant (docs/providers/CONTRACT.md, clause M-54), is refused at every
 * open by name, read from `UNGRANTED_CLAIM_REFUSALS` in src/lib/db/claim-grants.ts. The table is injected here; the
 * four entry points that raise it are held by tests/isolated/claim-grant-open-refusal.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { UNGRANTED_CLAIM_REFUSALS, UNGRANTED_SINGLE_WRITER_FILE_SENTENCE } from "@/lib/db/claim-grants";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { DatabaseConfigError, UnknownProviderError } from "@/lib/db/errors";
import { assertClaimsGranted } from "@/lib/db/factory";
import type { DatabaseConnection } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";

/** A connection of `type` with no other member the assertion reads. */
function connectionOf(type: string): DatabaseConnection {
  return { id: `claim-${type}`, name: type, type, createdAt: new Date() } as DatabaseConnection;
}

describe("the open refusal of an engine whose claims no grant covers", () => {
  test("assertClaimsGranted refuses an engine whose claims leave a refusal at open, naming the type, and passes one with none", () => {
    const refusals: Readonly<Record<DatabaseType, string | null>> = {
      ...UNGRANTED_CLAIM_REFUSALS,
      duckdb: UNGRANTED_SINGLE_WRITER_FILE_SENTENCE,
    };

    let thrown: unknown;
    try {
      assertClaimsGranted(connectionOf("duckdb"), refusals);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DatabaseConfigError);
    expect((thrown as DatabaseConfigError).message).toBe(UNGRANTED_SINGLE_WRITER_FILE_SENTENCE);
    expect((thrown as DatabaseConfigError).provider).toBe("duckdb");
    expect(() => assertClaimsGranted(connectionOf("postgres"), refusals)).not.toThrow();
    // The bundled table refuses no shipped engine.
    for (const type of SHIPPED_DATABASE_TYPES) {
      expect(() => assertClaimsGranted(connectionOf(type))).not.toThrow();
    }
    // A type outside the union is refused by name before its row is read.
    expect(() => assertClaimsGranted(connectionOf("acmefoo"), refusals)).toThrow(UnknownProviderError);
  });
});
