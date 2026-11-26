/**
 * The hints `inspect_schema` carries on one token's tools/list (#2252, part 3): the legacy rows' review of the engines
 * whose metadata read changes state the engine keeps, and the helper that reads its grant by the engines a token
 * reaches.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { UnknownProviderError } from "@/lib/db/errors";
import { unknownTypeSentence } from "@/lib/db/type-id";
import { MCP_READ_ONLY_ANNOTATIONS } from "@/lib/mcp/output";
import { metadataReadAnnotations } from "@/lib/mcp/tools/annotations";
import { getDBConfig } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";
import { namedLabels } from "../../helpers/repo-text-scope";
import { legacyRegisterTable } from "../../helpers/legacy-register";

const exposable = legacyRegisterTable("exposable");
const metadataReadChangesState = legacyRegisterTable("metadataReadChangesState");

const ROOT = join(import.meta.dir, "..", "..", "..");

const STATE_CHANGING = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const TRUE_ROWS = SHIPPED_DATABASE_TYPES.filter((type) => metadataReadChangesState[type]);

describe("the legacy rows' metadata read that changes state", () => {
  test("holds true only where MCP offers the engine", () => {
    expect(TRUE_ROWS.length).toBeGreaterThan(0);
    for (const type of TRUE_ROWS) expect(exposable[type]).toBe(true);
  });

  test("its true rows are the engines docs/MCP.md names for the hint", () => {
    const lines = readFileSync(join(ROOT, "docs", "MCP.md"), "utf8")
      .split("\n")
      .filter((line) => line.includes("`destructiveHint: false`"));
    expect(lines).toHaveLength(1);
    const labels = SHIPPED_DATABASE_TYPES.map((type) => getDBConfig(type).label);
    expect(namedLabels(lines[0] ?? "", labels).sort()).toEqual(TRUE_ROWS.map((type) => getDBConfig(type).label).sort());
  });
});

describe("metadataReadAnnotations", () => {
  test("without a reach answers the read-only hints the full handler registers", () => {
    expect(metadataReadAnnotations()).toBe(MCP_READ_ONLY_ANNOTATIONS);
  });

  test("answers the read-only hints for an empty reach and for a reach of engines whose rows are false", () => {
    expect(metadataReadAnnotations(new Set())).toBe(MCP_READ_ONLY_ANNOTATIONS);
    expect(metadataReadAnnotations(new Set<DatabaseType>(["postgres", "redis"]))).toBe(MCP_READ_ONLY_ANNOTATIONS);
  });

  test("answers not read-only and not destructive, closed-world, for a reach holding an engine whose row is true", () => {
    for (const type of TRUE_ROWS) {
      expect(metadataReadAnnotations(new Set<DatabaseType>(["postgres", type]))).toEqual(STATE_CHANGING);
    }
  });

  test("reads the grants of the reader it is given", () => {
    const changed =
      (change: Partial<Record<DatabaseType, boolean>>) =>
      (type: DatabaseType): { metadataReadChangesState: boolean } => ({
        metadataReadChangesState: change[type] ?? metadataReadChangesState[type],
      });
    expect(metadataReadAnnotations(new Set<DatabaseType>(["postgres"]), changed({ postgres: true }))).toEqual(
      STATE_CHANGING,
    );
    expect(
      metadataReadAnnotations(
        new Set<DatabaseType>(["databend", "libredb"]),
        changed({ databend: false, libredb: false }),
      ),
    ).toBe(MCP_READ_ONLY_ANNOTATIONS);
  });

  // A reach is built from listed connections MCP can serve, which leaves out a type that names no provider (FND-1); one
  // that holds such a type anyway is refused by name rather than read as a row of the table, inherited keys included.
  test("refuses a reach that holds a type that is no type id", () => {
    for (const type of ["acmefoo", "constructor"]) {
      expect(() => metadataReadAnnotations(new Set([type]) as ReadonlySet<DatabaseType>)).toThrow(UnknownProviderError);
      expect(() => metadataReadAnnotations(new Set(["postgres", type]) as ReadonlySet<DatabaseType>)).toThrow(
        unknownTypeSentence(type),
      );
    }
  });

  test("sets no idempotentHint in either answer", () => {
    expect(metadataReadAnnotations(new Set<DatabaseType>(["postgres"]))).not.toHaveProperty("idempotentHint");
    expect(metadataReadAnnotations(new Set<DatabaseType>(TRUE_ROWS))).not.toHaveProperty("idempotentHint");
  });
});
