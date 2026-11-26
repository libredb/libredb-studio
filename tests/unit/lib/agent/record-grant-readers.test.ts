/**
 * The agent readers of a grant read the grant of the engine's record (`servedEngineRecord` in
 * src/lib/db/server-catalog.ts), never a table of Studio's keyed by the engine's type: the engine pack resolver's
 * statement language (`agentEnginePack`), the run ledger's reading check (`RUN_HEADER_VOCABULARY.hasReading`), the
 * readings a run is offered (`agentReadingsOf`) and the review record every statement-sending gate asserts
 * (`assertStatementsReviewed`). So a package engine's grant reaches each of them through its register row
 * (docs/providers/CONTRACT.md, clause M-54), while the resolver still refuses every engine the overlay registry holds no
 * overlay of, which opens with M5.
 *
 * Every catalog here is composed in memory (tests/helpers/package-catalog.ts) and installed by the case that reads it,
 * then forgotten in `finally`, so no case leaves a catalog behind for the next.
 */
import { describe, expect, test } from "bun:test";
import { parseGrantRegister, type RegisterGrants } from "@libredb/grant-register";
import { agentEnginePack } from "@/lib/agent/languages/engines";
import { RUN_HEADER_VOCABULARY } from "@/lib/agent/run-ledger-ids";
import { agentReadingsOf } from "@/lib/agent/tools";
import { legacyEngineGrants } from "@/lib/db/claim-grants";
import { ExecutionProfileError } from "@/lib/db/errors";
import { serverCatalogInstalled } from "@/lib/db/server-catalog";
import { type AdmittedForCatalog, composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { assertStatementsReviewed } from "@/lib/db/statement-review";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import type { DatabaseType } from "@/lib/types";
import {
  admittedFor,
  admittedManifest,
  craftedCatalog,
  generatedDigest,
  packageRow,
  withCatalog,
  withLoosestClaims,
} from "../../../helpers/package-catalog";

/** Settles a call and answers what it threw, or `null`, so the refusal is asserted after it settles. */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
    return null;
  } catch (error) {
    return error;
  }
}

/** The review record's refusal of `type`, as `assertStatementsReviewed` words it. */
function notReviewedSentence(type: string): string {
  return `Provider type "${type}" is not on the review record of engines that run agent and MCP statements, so no statement is sent on it, whatever its provider implements`;
}

/** Expects `error` to be the review record's refusal of `type`. */
function expectNotReviewed(error: unknown, type: string): void {
  expect(error).toBeInstanceOf(ExecutionProfileError);
  expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_ENGINE_NOT_REVIEWED");
  expect((error as ExecutionProfileError).message).toBe(notReviewedSentence(type));
}

describe("the agent readers of a grant", () => {
  test("each agent reader answers the engine record's installed grant, not Studio's table", async () => {
    // Studio's grants, read with nothing installed: what each crafted grant below differs from.
    expect(agentEnginePack("postgres").id).toBe("sql");
    expect(RUN_HEADER_VOCABULARY.hasReading("kafka")).toBe(true);
    expect(agentReadingsOf("kafka" as DatabaseType).length).toBeGreaterThan(0);
    expect(thrownBy(() => assertStatementsReviewed("sqlite"))).toBeNull();
    expectNotReviewed(
      thrownBy(() => assertStatementsReviewed("spark")),
      "spark",
    );

    const catalog = craftedCatalog({
      postgres: { statementLanguage: null },
      kafka: { agentReadings: Object.freeze([]) },
      sqlite: { agentExecution: false },
      spark: { agentExecution: true },
    });
    await withCatalog(catalog, () => {
      expect(thrownBy(() => agentEnginePack("postgres"))).toEqual(
        new Error("no engine pack for postgres: Studio grants it no statement language"),
      );
      expect(RUN_HEADER_VOCABULARY.hasReading("kafka")).toBe(false);
      expect(agentReadingsOf("kafka" as DatabaseType)).toEqual([]);
      expectNotReviewed(
        thrownBy(() => assertStatementsReviewed("sqlite")),
        "sqlite",
      );
      expect(thrownBy(() => assertStatementsReviewed("spark"))).toBeNull();
      // Vacuity: an engine the crafted catalog leaves as it is reads its own grant.
      expect(RUN_HEADER_VOCABULARY.hasReading("redis")).toBe(true);
      expect(agentReadingsOf("redis" as DatabaseType)).toEqual(legacyEngineGrants("redis").agentReadings);
    });
    expect(serverCatalogInstalled()).toBe(false);
  });

  test("an admitted package's engine is read at its register row's grant by the statement review and the agent readings readers, and at each claim's restrictive value where no row or another digest's row exists; the engine pack resolver refuses it", async () => {
    const rowed = admittedFor("acme-rowed", admittedManifest("acmerowed", withLoosestClaims));
    const bare = admittedFor("acme-bare", admittedManifest("acmebare", withLoosestClaims));
    const stale = admittedFor("acme-stale", admittedManifest("acmestale", withLoosestClaims));
    const granted: Partial<RegisterGrants> = {
      agentExecution: true,
      statementLanguage: "sql",
      agentReadings: Object.freeze(["sessions"] as const),
    };
    const register = parseGrantRegister(
      [
        packageRow(rowed, "acmerowed", granted),
        // A row for another digest of the same package and engine grants nothing.
        packageRow({ ...stale, digest: generatedDigest() }, "acmestale", granted),
      ],
      LEGACY_ENGINE_IDS,
    );
    const catalog = composeServerCatalog([rowed, bare, stale] as readonly AdmittedForCatalog[], [], register);

    await withCatalog(catalog, () => {
      // The register row's grant: the readings the request and the row both hold.
      expect(thrownBy(() => assertStatementsReviewed("acmerowed" as DatabaseType))).toBeNull();
      expect(agentReadingsOf("acmerowed" as DatabaseType)).toEqual(["sessions"]);
      expect(RUN_HEADER_VOCABULARY.hasReading("acmerowed")).toBe(true);

      // No row, or a row for another digest: each claim's restrictive value.
      for (const type of ["acmebare", "acmestale"]) {
        expectNotReviewed(
          thrownBy(() => assertStatementsReviewed(type as DatabaseType)),
          type,
        );
        expect(agentReadingsOf(type as DatabaseType)).toEqual([]);
        expect(RUN_HEADER_VOCABULARY.hasReading(type)).toBe(false);
      }

      // The overlay registry holds no package's engine, so the resolver refuses each before its record is read (M5).
      for (const type of ["acmerowed", "acmebare"]) {
        expect(thrownBy(() => agentEnginePack(type as DatabaseType))).toEqual(new Error(`no engine pack for ${type}`));
      }
    });
    expect(serverCatalogInstalled()).toBe(false);
  });
});
