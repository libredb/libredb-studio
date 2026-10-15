import { afterEach, describe, expect, test } from "bun:test";
import type { EditorExecutionContext, ProviderExecutionContext } from "@/exports/types";
import { createDatabaseProvider, getOrCreateProvider, clearProviderCache } from "@/exports/providers";
import type { DatabaseConnection } from "@/lib/types";

/**
 * What an embedder of `@libredb/studio/providers` needs to keep DuckDB's file access (non-admin DuckDB file access).
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

describe("the DuckDB file-access opt-in a package consumer can name (non-admin DuckDB file access)", () => {
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

/**
 * Per-user providers (docs/GOVERNANCE.md#per-user-providers). Studio names the owner only under governance, and an
 * embedder that keeps a provider per user names it the same way: `owner` and `ownerPoolMax` are optional fields of both
 * published context types, and the assignments below are checked by `bun run typecheck`.
 */
describe("the owner of a per-user provider a package consumer can name", () => {
  test("EditorExecutionContext publishes owner and ownerPoolMax as optional fields", async () => {
    const alice: EditorExecutionContext = { allowExternalFileAccess: true, owner: "alice-subject", ownerPoolMax: 3 };
    const bob: EditorExecutionContext = { allowExternalFileAccess: true, owner: "bob-subject", ownerPoolMax: 3 };
    const shared: EditorExecutionContext = { allowExternalFileAccess: true };
    const built: ProviderExecutionContext = { owner: "alice-subject", ownerPoolMax: 3 };
    const connection: DatabaseConnection = {
      id: "embedder-owned",
      name: "embedder-owned",
      type: "sqlite",
      database: ":memory:",
      createdAt: new Date(0),
    };

    const providers = [
      await getOrCreateProvider(connection, {}, alice),
      await getOrCreateProvider(connection, {}, bob),
      await getOrCreateProvider(connection, {}, shared),
    ];

    // One provider per owner, and the one without an owner shared apart from both.
    expect(new Set(providers).size).toBe(3);
    expect(await getOrCreateProvider(connection, {}, alice)).toBe(providers[0]);
    expect((await createDatabaseProvider(connection, {}, built)).type).toBe("sqlite");
  });
});
