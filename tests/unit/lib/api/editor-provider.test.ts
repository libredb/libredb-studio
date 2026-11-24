import { describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const opened: { connection: DatabaseConnection; context: unknown; wait: unknown[] }[] = [];
let connected: DatabaseProvider;

mock.module("@/lib/db", () => ({
  getOrCreateProvider: mock(
    async (connection: DatabaseConnection, _options: unknown, context: unknown, ...wait: unknown[]) => {
      opened.push({ connection, context, wait });
      return connected;
    },
  ),
}));

/** The writable cache by key, as `findCachedProvider` reads it. */
const cachedByKey = new Map<string, DatabaseProvider>();
/** Every open of a metadata session, as `getOrCreateMetadataProvider` receives it. */
const openedMetadata: { connection: DatabaseConnection; options: unknown; context: unknown; rest: unknown[] }[] = [];
let metadataSession: DatabaseProvider;
mock.module("@/lib/db/factory", () => ({
  findCachedProvider: (key: string) => cachedByKey.get(key) ?? null,
  getOrCreateMetadataProvider: async (
    connection: DatabaseConnection,
    options: unknown,
    context: unknown,
    ...rest: unknown[]
  ) => {
    openedMetadata.push({ connection, options, context, rest });
    return metadataSession;
  },
}));

const { cachedEditorProvider, editorProvider, metadataProvider } = await import("@/lib/api/editor-provider");

const connection = { id: "c", name: "c", type: "postgres", host: "h", database: "" } as DatabaseConnection;
const session = (role: string) => ({ role });

function providerOf(capabilities: Record<string, unknown>, sessions: Record<string, DatabaseProvider> = {}) {
  return {
    type: "postgres",
    config: connection,
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

  test("an editor request's open wait reaches the factory", async () => {
    connected = providerOf({});
    opened.length = 0;
    const wait = { signal: new AbortController().signal };

    expect(await editorProvider(session("user"), connection, undefined, wait)).toBe(connected);
    expect(await editorProvider(session("user"), connection, undefined)).toBe(connected);
    expect(opened[0]?.wait).toEqual([wait]);
    expect(opened[0]?.wait[0]).toBe(wait);
    expect(opened[1]?.wait).toEqual([undefined]);
  });

  test("a catalog runs on that database's session, and a connection without sessions refuses one", async () => {
    const shop = providerOf({});
    connected = providerOf({ catalogSessions: true }, { shop });
    expect(await editorProvider(session("user"), connection, "shop")).toBe(shop);

    connected = providerOf({});
    await expect(editorProvider(session("user"), connection, "shop")).rejects.toThrow(DatabaseConfigError);
  });
});

/** The connection's metadata session, under the editor's posture, as the maintenance route runs a kill on it (C-66). */
describe("metadataProvider", () => {
  test("opens the connection's metadata session with the editor's connection and posture, and without a catalog runs on it", async () => {
    metadataSession = providerOf({});
    connected = providerOf({});
    openedMetadata.length = 0;
    opened.length = 0;

    expect(await metadataProvider(session("admin"), connection, undefined)).toBe(metadataSession);
    expect(await metadataProvider(session("user"), connection, undefined)).toBe(metadataSession);
    await editorProvider(session("admin"), connection, undefined);
    await editorProvider(session("user"), connection, undefined);

    expect(openedMetadata.map((open) => open.context)).toEqual([
      { allowExternalFileAccess: true },
      { allowExternalFileAccess: false },
    ]);
    // Each the context editorProvider hands the editor's open for the same session.
    expect(openedMetadata.map((open) => open.context)).toEqual(opened.map((open) => open.context));
    expect(openedMetadata.map((open) => open.options)).toEqual([{}, {}]);
    expect(openedMetadata.map((open) => open.rest)).toEqual([[], []]);
    expect(openedMetadata[0].connection).toBe(connection);
  });

  test("a catalog runs on that database's session of the metadata session, and a connection without sessions refuses one", async () => {
    const shop = providerOf({});
    const editorShop = providerOf({});
    connected = providerOf({ catalogSessions: true }, { shop: editorShop });
    metadataSession = providerOf({ catalogSessions: true }, { shop });
    expect(await metadataProvider(session("admin"), connection, "shop")).toBe(shop);

    metadataSession = providerOf({});
    await expect(metadataProvider(session("admin"), connection, "shop")).rejects.toThrow(DatabaseConfigError);
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
  }, 60_000);
});
