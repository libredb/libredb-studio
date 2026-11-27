/**
 * Every shipped type-id keeps its provider triad (CLAUDE.md, the provider triad under "Rules & patterns"): its code,
 * its doc and its integration test, in exactly one layout, the legacy one or a workspace package
 * `packages/provider-<type-id>/`, plus its agent leg when its granted statement language is non-null.
 *
 * `tests/helpers/provider-layout.ts` says where each leg is and why each refusal exists; this test runs it over the
 * whole type-id list, so a provider that lands without its doc or integration test, or a move that leaves a legacy
 * leg behind, fails here by name.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { REPOSITORY_ROOT } from "../../helpers/planted-package";
import { providerTriad, providerTriadViolations } from "../../helpers/provider-layout";

test("every shipped type-id has its code, doc and integration test in exactly one layout, and its agent leg when it speaks a statement language", () => {
  expect(providerTriadViolations(REPOSITORY_ROOT, SHIPPED_DATABASE_TYPES)).toEqual([]);
});

test("the triad resolves every shipped type-id", () => {
  const triads = SHIPPED_DATABASE_TYPES.map((type) => providerTriad(REPOSITORY_ROOT, type));

  expect(SHIPPED_DATABASE_TYPES.length).toBeGreaterThan(0);
  expect(triads.map((triad) => triad.type)).toEqual([...SHIPPED_DATABASE_TYPES]);
  for (const triad of triads) expect(["legacy", "package"]).toContain(triad.layout);
});

test("a type-id whose statement language is declared as data has no agent leg files, and one whose language is a module of Studio's keeps its leg", () => {
  const declared = (type: string) =>
    JSON.parse(
      readFileSync(path.join(REPOSITORY_ROOT, "src", "lib", "db", "engine-declarations", `${type}.json`), "utf8"),
    ).statementLanguageData;

  // Each engine declaring its language as data: no overlay row and no language directory of Studio's.
  const stating = SHIPPED_DATABASE_TYPES.filter((type) => declared(type) !== null);
  // A census pin: the shipped engines whose declaration states its language as data, a set that leaves with them.
  expect(stating).toEqual(["kafka"]);
  for (const type of stating) {
    const name = declared(type).name;
    expect(typeof name).toBe("string");
    expect({ type, agent: providerTriad(REPOSITORY_ROOT, type).agent }).toEqual({ type, agent: null });
    expect(existsSync(path.join(REPOSITORY_ROOT, "src", "lib", "agent", "languages", name))).toBe(false);
  }
  // Redis's rediscli is still a module of Studio's: its overlay and its language's client overlays stay.
  expect(declared("redis")).toBeNull();
  const redis = providerTriad(REPOSITORY_ROOT, "redis").agent;
  expect(redis).not.toBeNull();
  for (const leg of [redis?.overlay, redis?.client]) expect(existsSync(leg ?? "")).toBe(true);
});
