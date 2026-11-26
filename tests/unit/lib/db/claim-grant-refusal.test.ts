/**
 * `assertClaimsGranted` (src/lib/db/open-check.ts): an engine whose claims leave a refusal no grant covers, a
 * single-writer file request that is not Studio's grant (docs/providers/CONTRACT.md, clause M-54), is refused at every
 * open by name, read from its record's `grants.ungrantedRefusals`, which for a legacy engine is its row of
 * `UNGRANTED_CLAIM_REFUSALS` in src/lib/db/claim-grants.ts. The record is crafted here; the four entry points that raise
 * it are held by tests/isolated/claim-grant-open-refusal.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { UNGRANTED_SINGLE_WRITER_FILE_SENTENCE } from "@/lib/db/claim-grants";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { DatabaseConfigError, UnknownProviderError } from "@/lib/db/errors";
import { assertClaimsGranted } from "@/lib/db/open-check";
import { type EngineRecord, legacyProviderEngine } from "@/lib/db/server-catalog";

/** The record of `type` with `ungrantedRefusals` set to `refusal`. */
function refusing(type: string, refusal: string): EngineRecord {
  const engine = legacyProviderEngine(type, "open");
  return Object.freeze({ ...engine, grants: Object.freeze({ ...engine.grants, ungrantedRefusals: refusal }) });
}

describe("the open refusal of an engine whose claims no grant covers", () => {
  test("assertClaimsGranted refuses an engine whose claims leave a refusal at open, naming the type, and passes one with none", () => {
    let thrown: unknown;
    try {
      assertClaimsGranted(refusing("duckdb", UNGRANTED_SINGLE_WRITER_FILE_SENTENCE));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DatabaseConfigError);
    expect((thrown as DatabaseConfigError).message).toBe(UNGRANTED_SINGLE_WRITER_FILE_SENTENCE);
    expect((thrown as DatabaseConfigError).provider).toBe("duckdb");
    expect(() => assertClaimsGranted(legacyProviderEngine("postgres", "open"))).not.toThrow();
    // The bundled records refuse no shipped engine.
    for (const type of SHIPPED_DATABASE_TYPES) {
      expect(() => assertClaimsGranted(legacyProviderEngine(type, "open"))).not.toThrow();
    }
    // A type outside the union is refused by name before any record is read.
    expect(() => assertClaimsGranted(legacyProviderEngine("acmefoo", "open"))).toThrow(UnknownProviderError);
  });
});
