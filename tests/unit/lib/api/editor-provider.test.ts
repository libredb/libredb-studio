import { describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const opened: { connection: DatabaseConnection; context: unknown }[] = [];
let connected: DatabaseProvider;

mock.module("@/lib/db", () => ({
  getOrCreateProvider: mock(async (connection: DatabaseConnection, _options: unknown, context: unknown) => {
    opened.push({ connection, context });
    return connected;
  }),
}));

/** The writable cache by key, as `findCachedProvider` reads it. */
const cachedByKey = new Map<string, DatabaseProvider>();
mock.module("@/lib/db/factory", () => ({
  findCachedProvider: (key: string) => cachedByKey.get(key) ?? null,
}));

const { cachedEditorProvider, editorProvider } = await import("@/lib/api/editor-provider");

const connection = { id: "c", name: "c", type: "postgres", host: "h", database: "" } as DatabaseConnection;
const session = (role: string) => ({ role });

function providerOf(capabilities: Record<string, unknown>, sessions: Record<string, DatabaseProvider> = {}) {
  return {
    type: "postgres",
    getCapabilities: () => capabilities,
    forCatalog: async (catalog: string) => sessions[catalog],
  } as unknown as DatabaseProvider;
}

/** The one provider an editor request runs on (#1530). */
describe("editorProvider", () => {
  test("opens the connection under the session's editor posture, and without a catalog runs on it", async () => {
    connected = providerOf({});
    opened.length = 0;

    expect(await editorProvider(session("admin"), connection, undefined)).toBe(connected);
    expect(await editorProvider(session("user"), connection, undefined)).toBe(connected);
    expect(opened.map((open) => open.context)).toEqual([
      { allowExternalFileAccess: true },
      { allowExternalFileAccess: false },
    ]);
    expect(opened[0].connection).toBe(connection);
  });

  test("a catalog runs on that database's session, and a connection without sessions refuses one", async () => {
    const shop = providerOf({});
    connected = providerOf({ catalogSessions: true }, { shop });
    expect(await editorProvider(session("user"), connection, "shop")).toBe(shop);

    connected = providerOf({});
    await expect(editorProvider(session("user"), connection, "shop")).rejects.toThrow(DatabaseConfigError);
  });
});

/**
 * The provider an earlier editor request ran on, found again by the key it resolved
 * (docs/GOVERNANCE.md#per-user-providers).
 */
describe("cachedEditorProvider", () => {
  test("answers the provider cached under the key, in the catalog editorProvider scoped, and opens nothing", async () => {
    const shop = providerOf({});
    const server = providerOf({ catalogSessions: true }, { shop });
    cachedByKey.set("key-of-the-write-credential", server);
    opened.length = 0;

    expect(await cachedEditorProvider("key-of-the-write-credential", undefined)).toBe(server);
    expect(await cachedEditorProvider("key-of-the-write-credential", "shop")).toBe(shop);
    // Nothing is cached under another key: the idle sweep or a disconnect removed it, or it was never opened.
    expect(await cachedEditorProvider("key-of-the-read-credential", undefined)).toBeNull();
    expect(opened).toEqual([]);
  });
});

/**
 * Scoping is decided in one place. A route that scoped by hand could open the provider under another
 * posture, or skip the catalog check, and nothing else would notice. MCP is the one other caller: its
 * provider comes from its own context, not from an editor request.
 */
describe("catalog scoping call sites", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  test("only the editor provider and the MCP database choice call scopeToCatalog", () => {
    const callers = sources("src")
      .filter((path) => readFileSync(path, "utf8").includes("scopeToCatalog("))
      .map((path) => path.replaceAll("\\", "/"))
      .sort();
    expect(callers).toEqual([
      "src/lib/api/editor-provider.ts",
      "src/lib/db/catalog-scope.ts",
      "src/lib/mcp/tools/database-choice.ts",
    ]);
  });
});
