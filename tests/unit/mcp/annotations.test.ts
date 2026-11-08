/**
 * The hints `inspect_schema` carries on one token's tools/list (#2252, part 3): the record of the engines whose
 * metadata read changes state the engine keeps, and the helper that reads it by the engines a token reaches.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { MCP_EXPOSABLE, MCP_METADATA_READ_CHANGES_STATE, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { MCP_READ_ONLY_ANNOTATIONS } from "@/lib/mcp/output";
import { metadataReadAnnotations } from "@/lib/mcp/tools/annotations";
import { getDBConfig } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";
import { namedLabels } from "../../helpers/repo-text-scope";

const ROOT = join(import.meta.dir, "..", "..", "..");

const STATE_CHANGING = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const TRUE_ROWS = SHIPPED_DATABASE_TYPES.filter((type) => MCP_METADATA_READ_CHANGES_STATE[type]);

describe("MCP_METADATA_READ_CHANGES_STATE", () => {
  test("answers for every shipped type-id and for nothing else", () => {
    expect(Object.keys(MCP_METADATA_READ_CHANGES_STATE).sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
  });

  test("is frozen, so no reader can change it at run time", () => {
    expect(Object.isFrozen(MCP_METADATA_READ_CHANGES_STATE)).toBe(true);
  });

  test("holds true only where MCP offers the engine", () => {
    expect(TRUE_ROWS.length).toBeGreaterThan(0);
    for (const type of TRUE_ROWS) expect(MCP_EXPOSABLE[type]).toBe(true);
  });

  test("its true rows are the engines docs/MCP.md names for the hint", () => {
    const lines = readFileSync(join(ROOT, "docs", "MCP.md"), "utf8")
      .split("\n")
      .filter((line) => line.includes("`destructiveHint: false`"));
    expect(lines).toHaveLength(1);
    const labels = SHIPPED_DATABASE_TYPES.map((type) => getDBConfig(type).label);
    expect(namedLabels(lines[0] ?? "", labels).sort()).toEqual(TRUE_ROWS.map((type) => getDBConfig(type).label).sort());
  });

  test("the provider doc of each engine whose row is true states the hint, and no other provider doc does", () => {
    const stating = [...new Bun.Glob("docs/providers/*.md").scanSync(ROOT)]
      .filter((file) => readFileSync(join(ROOT, file), "utf8").includes("`readOnlyHint: false`"))
      .map((file) => basename(file, ".md"))
      .sort();
    expect(stating).toEqual([...TRUE_ROWS].sort());
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

  test("reads the record it is given", () => {
    expect(
      metadataReadAnnotations(new Set<DatabaseType>(["postgres"]), {
        ...MCP_METADATA_READ_CHANGES_STATE,
        postgres: true,
      }),
    ).toEqual(STATE_CHANGING);
    expect(
      metadataReadAnnotations(new Set<DatabaseType>(["databend", "libredb"]), {
        ...MCP_METADATA_READ_CHANGES_STATE,
        databend: false,
        libredb: false,
      }),
    ).toBe(MCP_READ_ONLY_ANNOTATIONS);
  });

  test("sets no idempotentHint in either answer", () => {
    expect(metadataReadAnnotations(new Set<DatabaseType>(["postgres"]))).not.toHaveProperty("idempotentHint");
    expect(metadataReadAnnotations(new Set<DatabaseType>(TRUE_ROWS))).not.toHaveProperty("idempotentHint");
  });
});
