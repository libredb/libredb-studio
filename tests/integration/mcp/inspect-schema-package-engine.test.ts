/**
 * inspect_schema on an engine an admitted provider package serves (docs/providers/CONTRACT.md, clauses C-66, C-107,
 * C-109 and C-112): where the engine's register row offers it to MCP, the tool reads the engine's tables through the
 * real host core and tree facade on the record's metadata session, opened once per key through the package's own
 * `open` in the provider factory's real metadata cache, never under an execution profile; a database named on the call
 * is refused before any open; a failure of the package's open or of its tree read is answered by the record's grant of
 * its own words and logged once; a failure Studio raised after the open is answered as Studio's own; and a stopped wait
 * releases the call at its deadline while the package's open runs on.
 *
 * The packages are written into a scratch providers directory and admitted by Studio's boot admission
 * (tests/helpers/package-session-fixture.ts); each function calls the hook a case sets. The connection is handed to the
 * tool in memory, through a context whose visible list the case sets (`PlantedContext`); the open checks, Vault, the
 * scrub and the metadata session are the real ones. Paths are built with `path.join` by the fixture, no file mode, link
 * or line ending is read, and no case awaits a timer before it asserts on a promise: a held open signals the case when
 * the open reaches it, and the case releases it by its own call.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TreeRequest } from "@libredb/provider-sdk/calls";
import type { ObjectModel } from "@libredb/provider-sdk/manifest";
import { PACKAGE_DEFECT_PREFIX } from "@/lib/api/package-errors";
import { clearProviderCache, getExecutionProfileCacheStats, getProviderCacheStats } from "@/lib/db/factory";
import { PACKAGE_SENTENCE_WITHHELD, PROVIDER_TEXT_WITHHELD } from "@/lib/db/operations/provider-text";
import { forgetServerCatalog, servedEngineRecord } from "@/lib/db/server-catalog";
import { logger } from "@/lib/logger";
import { McpConnectionContext, type MCP_CONNECTIONS_UNREADABLE } from "@/lib/mcp/context";
import { databaseContentNotice, MCP_ENGINE_ERROR_PREFIX } from "@/lib/mcp/output";
import { InspectSchemaInputSchema, inspectSchema } from "@/lib/mcp/tools/inspect-schema";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import type { ManagedConnection } from "@/lib/seed";
import { languageDataSha256 } from "@/lib/db/language-digest";
import { mcpPackageLanguageRow, withMcpPackageLanguage } from "../../helpers/agent-package-catalog";
import { acmereadData } from "../../helpers/declared-agent-language";
import { pinMcpTestEnvironment, resetMcpTestState } from "../../helpers/mcp-fixtures";
import type { EditableEngine } from "../../helpers/package-catalog";
import { admitSessionPackages, setHooks } from "../../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../../helpers/provider-artifacts";

pinMcpTestEnvironment();

/** A tree with one container level and one kind of objects with columns: names no engine of Studio's. */
const TREE_MODEL: ObjectModel = {
  containerLevels: [{ id: "schema", label: "Folder", labelPlural: "Folders" }],
  containerPathShapes: "exact",
  containerNameSpelling: null,
  objectKinds: [
    {
      id: "item",
      role: "relation",
      label: "Item",
      labelPlural: "Items",
      hasSource: false,
      sourceLanguage: null,
      hasColumns: true,
      acceptsSourceEdits: false,
      childKinds: [],
      attachedTo: null,
      acceptsRowWrites: false,
      enumeratedBy: null,
      countIsListing: false,
      machineNames: null,
      group: null,
    },
  ],
  rowActions: [],
  containersNameKinds: false,
  tablesNeedContainer: false,
  tablesAreDerivedGroupings: false,
  agentWalkScope: null,
  schemaDiffScope: null,
  maskedNameKinds: [],
};

/**
 * A package offering the tree, granted no words; one granted its words; one offering no tree; and one granted its own
 * declared language, whose MCP statement tool reads engines that hold no table.
 */
const TREE = "acmemcptree";
const WORDS = "acmemcpwords";
const BARE = "acmemcpbare";
const LANG = "acmemcplang";
const LANG_DATA = acmereadData("acmemcplangql", "run_acmemcplang_read");
const exposed = (engine: EditableEngine) => {
  engine.mcp = { ...engine.mcp, exposable: true };
};
const withTree = {
  offered: ["objects.tree"],
  edit: (engine: EditableEngine) => {
    exposed(engine);
    (engine as Record<string, unknown>).objects = structuredClone(TREE_MODEL);
  },
};
/** A row offering the engine to MCP and requiring neither an agent credential, read roots nor full file access. */
const ROW = {
  exposable: true,
  agentCredentialRequired: false,
  readRootsRequired: false,
  deniedFileAccessRefusal: null,
} as const;
const providers = scratchDirectory("studio-mcp-inspect-package-");

beforeAll(async () => {
  installHostCore(createHostCore(), "test");
  await admitSessionPackages(
    providers,
    [
      { name: "acme-mcp-tree", engine: TREE, ...withTree },
      { name: "acme-mcp-words", engine: WORDS, ...withTree },
      { name: "acme-mcp-bare", engine: BARE, edit: exposed },
      { name: "acme-mcp-lang", engine: LANG, honours: ["readOnly"], edit: withMcpPackageLanguage(LANG_DATA) },
    ],
    {
      [TREE]: ROW,
      [WORDS]: { ...ROW, ownWords: "scrubbed" },
      [BARE]: ROW,
      [LANG]: { ...ROW, ...mcpPackageLanguageRow(LANG_DATA.name, languageDataSha256(LANG_DATA)) },
    },
  );
});

afterEach(async () => {
  await resetMcpTestState();
});

afterAll(async () => {
  await clearProviderCache();
  forgetServerCatalog();
  forgetHostCore();
  removeScratch(providers);
});

/** A context whose visible connections are `listed`, every other member the real context's. */
class PlantedContext extends McpConnectionContext {
  constructor(private readonly listed: readonly ManagedConnection[]) {
    super({ username: "alice", role: "admin" });
  }

  override visibleConnections(): Promise<readonly ManagedConnection[] | typeof MCP_CONNECTIONS_UNREADABLE> {
    return Promise.resolve(this.listed);
  }
}

/** A listed connection of `engine` with its own id and a generated secret. */
function listedOf(engine: string): ManagedConnection {
  const id = `seed:${randomUUID()}`;
  return {
    id,
    name: "Acme",
    type: engine,
    host: "tree.local",
    password: randomUUID(),
    createdAt: new Date(0),
    managed: true,
    roles: ["*"],
    seedId: id.slice("seed:".length),
    mcp: true,
  } as unknown as ManagedConnection;
}

interface Inspected {
  readonly isError?: boolean;
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly structuredContent?: Record<string, unknown>;
}

/** inspect_schema on `listed`, through a context that lists it alone. */
async function inspect(listed: ManagedConnection, args: Record<string, unknown> = {}): Promise<Inspected> {
  const context = new PlantedContext([listed]);
  return (await inspectSchema(InspectSchemaInputSchema.parse({ connection_id: listed.id, ...args }), {
    context,
    signal: new AbortController().signal,
  })) as Inspected;
}

/** What one package's hooks saw, by call name. */
interface Seen {
  readonly calls: { name: string; args: unknown[] }[];
}

/** The answer a tree hook gives each action unless a case gives its own. */
function answerOf(request: TreeRequest): unknown {
  switch (request.action) {
    case "containers":
      return {
        containers: [
          { path: ["s1"], name: "s1", level: 0, isSessionDefault: true },
          { path: ["s2"], name: "s2", level: 0 },
        ],
      };
    case "count":
      return { counts: { item: { count: 1 } } };
    case "list":
      return { objects: [{ path: [...request.container, "thing"], name: "thing", kind: "item" }] };
    case "describe":
      return {
        detail: {
          path: request.path,
          columns: [{ name: "id", type: "int", nullable: false, isPrimary: true }],
          indexes: [{ name: "thing_pk", columns: ["id"], unique: true }],
          foreignKeys: [{ columnName: "id", referencedTable: "other", referencedColumn: "oid" }],
        },
      };
    case "describeMany":
      return { details: [] };
  }
}

/** Hooks for `engine`'s package that open a fresh handle, close, and answer each tree request with `tree`. */
function hooksFor(
  engine: string,
  options: { open?: () => Promise<unknown>; tree?: (request: TreeRequest) => Promise<unknown> } = {},
): Seen {
  const seen: Seen = { calls: [] };
  const push =
    (name: string, answer: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      seen.calls.push({ name, args });
      return answer(...args);
    };
  setHooks(engine, {
    open: push("open", options.open ?? (() => Promise.resolve({ handle: { session: randomUUID() } }))),
    close: push("close", () => Promise.resolve()),
    tree: push("tree", (_handle, request) =>
      (options.tree ?? ((asked: TreeRequest) => Promise.resolve(answerOf(asked))))(request as TreeRequest),
    ),
  });
  return seen;
}

/** The names of the calls `seen` recorded. */
const names = (seen: Seen) => seen.calls.map(({ name }) => name);

/** The author a notice names for `engine`'s package: its display name and the package that serves it. */
function authorOf(engine: string, pkg: string): string {
  return `${servedEngineRecord(engine).displayName} provider, from the provider package ${pkg} 1.0.0`;
}

describe("inspect_schema on a provider package's engine", () => {
  test("inspect_schema reads a package engine's tables through its package's metadata session", async () => {
    const seen = hooksFor(TREE);
    const listed = listedOf(TREE);
    const result = await inspect(listed, {
      include_indexes: true,
      include_foreign_keys: true,
      include_schema_names: true,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe(databaseContentNotice(authorOf(TREE, "acme-mcp-tree")));
    expect(result.structuredContent).toEqual({
      connection_id: listed.id,
      schema: "s1",
      schema_names: ["s1", "s2"],
      schema_names_omitted: 0,
      total_tables: 1,
      offset: 0,
      limit: 50,
      has_more: false,
      next_offset: null,
      tables: [
        {
          name: "thing",
          kind: "item",
          columns: [{ name: "id", data_type: "int", is_nullable: false, default_value: null, is_primary_key: true }],
          columns_omitted: 0,
          indexes: [{ name: "thing_pk", columns: ["id"], is_unique: true }],
          indexes_omitted: 0,
          foreign_keys: [{ column: "id", referenced_table: "other", referenced_column: "oid" }],
          foreign_keys_omitted: 0,
        },
      ],
    });
    // One open, through the package, on the metadata session: no editor entry, no execution profile.
    expect(names(seen).filter((name) => name === "open")).toEqual(["open"]);
    expect(getProviderCacheStats().connections).not.toContain(listed.id);
    expect(getExecutionProfileCacheStats().size).toBe(0);
    // The next call reads the cached session.
    expect((await inspect(listed)).isError).toBeUndefined();
    expect(names(seen).filter((name) => name === "open")).toEqual(["open"]);
  });

  test("a package's sentence in a schema answer reaches the client by its record's grant of its own words", async () => {
    for (const engine of [TREE, WORDS]) {
      const listed = listedOf(engine);
      const own = `the index read is busy ${randomUUID()}`;
      const sentence = (request: TreeRequest) =>
        request.action === "describe"
          ? { detail: { path: request.path, columns: [], indexes: { unavailable: own }, foreignKeys: [] } }
          : answerOf(request);
      hooksFor(engine, { tree: (request) => Promise.resolve(sentence(request)) });
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        const result = await inspect(listed, { include_indexes: true });
        const [table] = (result.structuredContent?.tables ?? []) as { indexes?: unknown }[];
        const granted = engine === WORDS;
        expect(table?.indexes).toEqual({ unavailable: granted ? own : PACKAGE_SENTENCE_WITHHELD });
        const logged = warn.mock.calls.filter(([line]) => line === "A provider package's answer gave a reason");
        expect(logged.map(([, payload]) => payload)).toEqual(granted ? [] : [{ route: "/api/mcp", reason: own }]);
      } finally {
        warn.mockRestore();
      }
    }
  });

  test("a database named on a package engine's connection is refused before any open", async () => {
    const seen = hooksFor(TREE);
    const result = await inspect(listedOf(TREE), { database: "other" });
    expect(result).toEqual({
      content: [
        { type: "text", text: "This connection reads only the database it names; call again without database." },
      ],
      isError: true,
    });
    expect(names(seen)).toEqual([]);
  });

  test("a package's open or tree failure is answered by its grant and logged once", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      for (const engine of [TREE, WORDS]) {
        const granted = engine === WORDS;
        const author = authorOf(engine, granted ? "acme-mcp-words" : "acme-mcp-tree");

        // The open fails in words that hold the connection's secret, and in plain words.
        for (const secret of [true, false]) {
          error.mockClear();
          const listed = listedOf(engine);
          const words = secret ? `could not sign in with ${String(listed.password)}` : `away ${randomUUID()}`;
          hooksFor(engine, { open: () => Promise.reject(new Error(words)) });
          const result = await inspect(listed);
          expect(JSON.stringify(result)).not.toContain(String(listed.password));
          expect(result.isError).toBe(true);
          if (granted) {
            expect(result.content.map(({ text }) => text)).toEqual([
              databaseContentNotice(author),
              `${MCP_ENGINE_ERROR_PREFIX}${secret ? PROVIDER_TEXT_WITHHELD : words}`,
            ]);
          } else {
            expect(result.content).toHaveLength(1);
            expect(result.content[0]?.text).toMatch(
              /^The provider package's open failed \(.+\); the server's log holds its words\.$/,
            );
          }
          expect(result.structuredContent).toEqual({
            error: { kind: "connection", code: "CONNECTION_ERROR", outcome: "not-sent" },
          });
          expect(error.mock.calls.filter(([line]) => line === "A provider package's open failed")).toHaveLength(1);
        }

        // The tree read fails in the package's words.
        error.mockClear();
        const words = `the folder is gone ${randomUUID()}`;
        hooksFor(engine, { tree: () => Promise.reject(new Error(words)) });
        const failed = await inspect(listedOf(engine));
        if (granted) {
          expect(failed.content.map(({ text }) => text)).toEqual([
            databaseContentNotice(author),
            `${MCP_ENGINE_ERROR_PREFIX}${words}`,
          ]);
        } else {
          expect(failed.content.map(({ text }) => text)).toEqual([
            expect.stringMatching(
              /^The provider package's tree read failed \(.+\); the server's log holds its words\.$/,
            ),
          ]);
        }
        expect(error.mock.calls.filter(([line]) => line === "A provider package's tree read failed")).toHaveLength(1);

        // A tree answer outside its action's form: the package's defect, logged once.
        error.mockClear();
        hooksFor(engine, { tree: () => Promise.resolve({ containers: "none" }) });
        const malformed = await inspect(listedOf(engine));
        expect(malformed.isError).toBe(true);
        expect(malformed.content.at(-1)?.text).toContain(PACKAGE_DEFECT_PREFIX);
        expect(error.mock.calls.filter(([line]) => line === "A provider package's tree read failed")).toHaveLength(1);
      }
    } finally {
      error.mockRestore();
    }
  });

  test("a Studio error after a package engine's open is answered as Studio's own, never as the package's", async () => {
    // A session whose package offers no tree: the facade refuses it when built, before any read, and the package's
    // tree is never called. The refusal is Studio's sentence: no notice, no database-failure prefix, no package author.
    const seen = hooksFor(BARE);
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      expect(await inspect(listedOf(BARE))).toEqual({
        content: [
          {
            type: "text",
            text: "This connection's provider package does not offer objects.tree, so Studio did not call it.",
          },
        ],
        structuredContent: { error: { kind: "not-offered", code: "FACET_NOT_OFFERED", outcome: "not-sent" } },
        isError: true,
      });
      expect(error.mock.calls.filter(([line]) => String(line).startsWith("A provider package's"))).toEqual([]);
    } finally {
      error.mockRestore();
    }
    expect(names(seen)).toEqual(["open"]);
  });

  test("a tree read error the package raised stays the package's, even in words Studio could have written", async () => {
    // Who raised it decides, never its words: the package rejects with Studio's own sentence for a missing tree.
    const words = "This connection's provider package does not offer objects.tree, so Studio did not call it.";
    hooksFor(WORDS, { tree: () => Promise.reject(new Error(words)) });
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      const result = await inspect(listedOf(WORDS));
      expect(result.isError).toBe(true);
      expect(result.content.map(({ text }) => text)).toEqual([
        databaseContentNotice(authorOf(WORDS, "acme-mcp-words")),
        `${MCP_ENGINE_ERROR_PREFIX}${words}`,
      ]);
      expect(error.mock.calls.filter(([line]) => line === "A provider package's tree read failed")).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  test("a package engine whose language holds no table is refused by name, pointing to its tool", async () => {
    const seen = hooksFor(LANG);
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      expect(await inspect(listedOf(LANG))).toEqual({
        content: [
          {
            type: "text",
            text: `${servedEngineRecord(LANG).displayName} holds no table for inspect_schema to list. Read this connection with ${LANG_DATA.agent?.mcp?.tool}.`,
          },
        ],
        isError: true,
      });
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
    expect(names(seen)).toEqual([]);
  });

  test("a stopped wait releases inspect_schema at its deadline while the package's open runs on", async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const seen = hooksFor(TREE, {
      open: async () => {
        reached.resolve();
        await release.promise;
        return { handle: { session: randomUUID() } };
      },
    });
    const listed = listedOf(TREE);
    const stopped = await inspect(listed, { timeout_ms: 500 });
    expect(stopped).toEqual({
      content: [
        {
          type: "text",
          text: "inspect_schema did not finish within timeout_ms (500 ms), and a read it already sent, or the connection it was opening, may still be running. Call it again with table naming one table or with a smaller limit, or raise timeout_ms up to 30000.",
        },
      ],
      isError: true,
    });
    // The open the call stopped waiting for is the package's own, still held.
    await reached.promise;
    release.resolve();
    expect((await inspect(listed)).isError).toBeUndefined();
    expect(names(seen).filter((name) => name === "open")).toEqual(["open"]);
  });
});
