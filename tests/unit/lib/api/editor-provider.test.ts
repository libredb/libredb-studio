import { describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { CachedSession } from "@/lib/db/factory";
import type { EngineConnection, EngineRecord } from "@/lib/db/server-catalog";
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
/** Every open of an editor session, as `getOrCreateEditorSession` receives it, and the entry the case sets it to answer. */
const openedEditor: { connection: EngineConnection; engine: EngineRecord; context: unknown; rest: unknown[] }[] = [];
let editorEntry: CachedSession;
mock.module("@/lib/db/factory", () => ({
  findCachedProvider: (key: string) => cachedByKey.get(key) ?? null,
  getOrCreateEditorSession: async (
    connection: EngineConnection,
    engine: EngineRecord,
    context: unknown,
    ...rest: unknown[]
  ) => {
    openedEditor.push({ connection, engine, context, rest });
    return editorEntry;
  },
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

const { cachedEditorProvider, editorProvider, editorTarget, metadataProvider } = await import(
  "@/lib/api/editor-provider"
);

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

/** What the query route runs one statement on, for any record: the editor's session of the record, opened once. */
describe("editorTarget", () => {
  const legacyEngine = { id: "postgres", offers: { legacyProvider: true } } as unknown as EngineRecord;
  const packageEngine = { id: "acmeps", offers: { legacyProvider: false } } as unknown as EngineRecord;
  const packageConnection = { id: "p", name: "p", type: "acmeps", queryTimeout: 1234 } as unknown as EngineConnection;
  /** A provider package's session entry, its session and environment stand-ins the case reads back by reference. */
  function sessionEntry() {
    const session = { calls: {}, marker: randomUUID() };
    const env = { marker: randomUUID() };
    const entry = { opened: { form: "session", session, env }, engine: packageEngine, running: 0 } as unknown;
    return { entry: entry as CachedSession, session, env };
  }

  test("editorTarget opens any record's editor session under the session's editor posture: a legacy provider in the request's catalog, and a package's session with its entry and the connection's statement timeout", async () => {
    const shop = providerOf({});
    const server = providerOf({ catalogSessions: true }, { shop });
    editorEntry = { opened: { form: "provider", provider: server }, engine: legacyEngine } as unknown as CachedSession;
    openedEditor.length = 0;
    const wait = { signal: new AbortController().signal };

    const legacy = await editorTarget(session("admin"), connection, legacyEngine, "shop", wait);
    expect(legacy.form).toBe("provider");
    expect(legacy.form === "provider" && legacy.provider).toBe(shop);
    const whole = await editorTarget(session("user"), connection, legacyEngine, undefined);
    expect(whole.form === "provider" && whole.provider).toBe(server);

    const { entry, session: packageSession, env } = sessionEntry();
    editorEntry = entry;
    const target = await editorTarget(session("user"), packageConnection, packageEngine, undefined, wait);
    expect(target as unknown).toEqual({ form: "session", session: packageSession, env, entry, queryTimeout: 1234 });
    expect(target.form === "session" && target.entry).toBe(entry);

    // One open per call, of the record handed, under the editor posture of the session, with the request's own wait.
    expect(openedEditor.map((open) => [open.connection, open.engine, open.context])).toEqual([
      [connection, legacyEngine, { allowExternalFileAccess: true }],
      [connection, legacyEngine, { allowExternalFileAccess: false }],
      [packageConnection, packageEngine, { allowExternalFileAccess: false }],
    ]);
    expect(openedEditor[0]?.rest[0]).toBe(wait);
    expect(openedEditor[1]?.rest).toEqual([undefined]);
    expect(openedEditor[2]?.rest[0]).toBe(wait);
  });

  test("a catalog handed with a provider package's session is a host defect, raised by name before any run", async () => {
    editorEntry = sessionEntry().entry;
    openedEditor.length = 0;

    await expect(editorTarget(session("user"), packageConnection, packageEngine, "shop")).rejects.toThrow(
      "A provider package's session was handed a catalog, which the query route refuses before any open for an engine whose record offers none: a host defect.",
    );
    expect(openedEditor).toHaveLength(1);
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
