import { afterEach, describe, expect, test } from "bun:test";
import type { EditorExecutionContext, ProviderExecutionContext } from "@/exports/types";
import { createDatabaseProvider, getOrCreateProvider, clearProviderCache } from "@/exports/providers";
import type { DatabaseConnection } from "@/lib/types";

/**
 * What an embedder of `@libredb/studio/providers` needs to keep DuckDB's file access (B1 / K1).
 *
 * The factories take a server-side execution context, and an ABSENT one denies DuckDB's file access:
 * a handle opens with `enable_external_access: 'false'`, so `read_csv`, `COPY`, `ATTACH` of a file and
 * `INSTALL` are refused. That is the fail-closed default, and it changed what an existing call does,
 * so the opt-in has to be nameable from the package: both context types are exported, and the
 * assignments below are checked by `bun run typecheck`. This file reads `src/exports/`, not the built
 * `dist/`; `bun run build:lib` and `bun run attw` cover the packed types.
 */

const SETTING = "SELECT current_setting('enable_external_access') AS v";

function duckdb(id: string): DatabaseConnection {
  return { id, name: id, type: "duckdb", database: ":memory:", createdAt: new Date(0) };
}

afterEach(async () => {
  await clearProviderCache();
});

describe("the DuckDB file-access opt-in a package consumer can name (B1/K1)", () => {
  test("createDatabaseProvider denies file access without a context and keeps it with the opt-in", async () => {
    const full: ProviderExecutionContext = { allowExternalFileAccess: true };
    const denied = await createDatabaseProvider(duckdb("embedder-default"));
    const allowed = await createDatabaseProvider(duckdb("embedder-opt-in"), {}, full);
    await denied.connect();
    await allowed.connect();
    try {
      expect((await denied.query(SETTING)).rows).toEqual([{ v: false }]);
      expect((await allowed.query(SETTING)).rows).toEqual([{ v: true }]);
    } finally {
      await denied.disconnect();
      await allowed.disconnect();
    }
  });

  test("getOrCreateProvider takes the narrower editor context, with the same default and opt-in", async () => {
    const full: EditorExecutionContext = { allowExternalFileAccess: true };

    expect((await (await getOrCreateProvider(duckdb("embedder-cached"))).query(SETTING)).rows).toEqual([{ v: false }]);
    expect((await (await getOrCreateProvider(duckdb("embedder-cached"), {}, full)).query(SETTING)).rows).toEqual([
      { v: true },
    ]);
  });
});
