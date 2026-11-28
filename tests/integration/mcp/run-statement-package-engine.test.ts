/**
 * A provider package's engine served on MCP by the statement tool of its own declared statement language
 * (docs/providers/CONTRACT.md, clauses C-78, C-107, C-109, C-112, M-85, M-87 and M-88): where its register row grants it
 * that language, agent execution and every MCP claim, and its package honours `readOnly`, the tool sends each admitted
 * statement through the package's read-only statement session, opened once per key through the package's own `open` by
 * the provider factory's real profiled cache, under the host core's read-only execute; a request the language's form
 * refuses, and a connection whose agent credential the package's open cannot receive, are refused before any open; a
 * package arm names no next offset and reports no page limit; a failure of the package's open or execute is answered by
 * the record's grant of its own words and logged once; Studio's own failures are answered as Studio's; and a stopped
 * wait releases the call at its deadline while the package's open runs on.
 *
 * The packages are written into a scratch providers directory and admitted by Studio's boot admission
 * (tests/helpers/package-session-fixture.ts); each function calls the hook a case sets. The connection is handed to the
 * tool in memory, through a context whose visible list the case sets (`PlantedContext`); the open checks, Vault, the
 * scrub, the opener and the facade are the real ones. Paths are built with `path.join` by the fixture, no file mode,
 * link or line ending is read, and no case awaits a timer before it asserts on a promise: a held open signals the case
 * when the open reaches it, the call's own answer is awaited plainly, and the case releases the open by its own call.
 * Every password and marker is generated at run time.
 */
// oxlint-disable no-await-in-loop -- each package is called after the one before, so its hooks read one call at a time.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CallContext, ExecuteRequest, OpenContext } from "@libredb/provider-sdk/calls";
import { getServerAuditBuffer } from "@/lib/audit";
import { clearProviderCache, getExecutionProfileCacheStats } from "@/lib/db/factory";
import { languageDataSha256 } from "@/lib/db/language-digest";
import { engineAuthor, PROVIDER_TEXT_WITHHELD } from "@/lib/db/operations/provider-text";
import { forgetServerCatalog, servedEngineRecord } from "@/lib/db/server-catalog";
import { logger } from "@/lib/logger";
import { McpConnectionContext, type MCP_CONNECTIONS_UNREADABLE } from "@/lib/mcp/context";
import {
  databaseContentNotice,
  MCP_ENGINE_ERROR_PREFIX,
  MCP_PROVIDER_BYTE_CAP,
  MCP_PROVIDER_ROW_CAP,
} from "@/lib/mcp/output";
import { profileRefusalText, timeoutText } from "@/lib/mcp/tools/read-query-limits";
import { type McpStatementInput, runStatement } from "@/lib/mcp/tools/run-statement";
import { type McpStatementArm, mcpStatementArm, type McpStatementTool } from "@/lib/mcp/tools/statement-arms";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import type { ManagedConnection } from "@/lib/seed";
import { mcpPackageLanguageRow, withMcpPackageLanguage } from "../../helpers/agent-package-catalog";
import { acmereadData } from "../../helpers/declared-agent-language";
import { pinMcpTestEnvironment, resetMcpTestState } from "../../helpers/mcp-fixtures";
import { admitSessionPackages, setHooks } from "../../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../../helpers/provider-artifacts";

pinMcpTestEnvironment();

/** A package whose row grants no words of its own, and one whose row grants them, each with its own language. */
const CODE = "acmemcprun";
const WORDS = "acmemcprunwords";
const CODE_DATA = acmereadData("acmemcprunql", "run_acmemcprun_read");
const WORDS_DATA = acmereadData("acmemcprunwordsql", "run_acmemcprunwords_read");
const PACKAGES = { [CODE]: "acme-mcp-run", [WORDS]: "acme-mcp-run-words" } as const;
/** The row's grants beside the language's: an admin's full file access read with no refusal. */
const OPEN = { deniedFileAccessRefusal: null } as const;
const providers = scratchDirectory("studio-mcp-run-package-");

beforeAll(async () => {
  installHostCore(createHostCore(), "test");
  await admitSessionPackages(
    providers,
    [
      { name: PACKAGES[CODE], engine: CODE, honours: ["readOnly"], edit: withMcpPackageLanguage(CODE_DATA) },
      { name: PACKAGES[WORDS], engine: WORDS, honours: ["readOnly"], edit: withMcpPackageLanguage(WORDS_DATA) },
    ],
    {
      [CODE]: { ...OPEN, ...mcpPackageLanguageRow(CODE_DATA.name, languageDataSha256(CODE_DATA)) },
      [WORDS]: {
        ...OPEN,
        ...mcpPackageLanguageRow(WORDS_DATA.name, languageDataSha256(WORDS_DATA)),
        ownWords: "scrubbed",
      },
    },
  );
});

afterEach(async () => {
  await clearProviderCache();
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

/** A listed connection of `engine` with its own id, a generated secret and `fields`. */
function listedOf(engine: string, fields: Record<string, unknown> = {}): ManagedConnection {
  const id = `seed:${randomUUID()}`;
  return {
    id,
    name: "Acme",
    type: engine,
    host: "run.local",
    password: randomUUID(),
    createdAt: new Date(0),
    managed: true,
    roles: ["*"],
    seedId: id.slice("seed:".length),
    mcp: true,
    ...fields,
  } as unknown as ManagedConnection;
}

/** The tool of `engine`'s language, as its arm states it. */
function armOf(engine: string): McpStatementArm {
  const data = engine === CODE ? CODE_DATA : WORDS_DATA;
  return mcpStatementArm(data.agent?.mcp?.tool as McpStatementTool);
}

interface Answered {
  readonly isError?: boolean;
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly structuredContent?: Record<string, unknown>;
}

/** `engine`'s tool on `listed` with `request` and `args`, through a context that lists it alone. */
async function call(
  engine: string,
  listed: ManagedConnection,
  request: string,
  args: Record<string, unknown> = {},
): Promise<Answered> {
  const arm = armOf(engine);
  const parsed = arm.inputSchema.parse({ connection_id: listed.id, [arm.argument]: request, ...args });
  return (await runStatement(arm, parsed as McpStatementInput, {
    context: new PlantedContext([listed]),
    signal: new AbortController().signal,
  })) as Answered;
}

/** What one package's hooks saw. */
interface Seen {
  readonly calls: string[];
  readonly opens: OpenContext[];
  readonly executes: ExecuteRequest[];
}

/** An execute answer of one column, `topic`, holding `rows`, which the package says it paged as `pageApplied`. */
function answerOf(rows: readonly string[], pageApplied = false): unknown {
  return {
    results: [
      {
        columns: [{ name: "topic" }],
        next: () => Promise.resolve({ rows: rows.map((row) => [row]), done: true }),
        close: () => Promise.resolve(),
      },
    ],
    warnings: [],
    executionTimeMs: 1,
    pageApplied,
  };
}

/** Hooks for `engine`'s package: `open`'s answer or a fresh handle, and `execute`'s answer or one row. */
function hooksFor(
  engine: string,
  options: {
    open?: (ctx: OpenContext) => Promise<unknown>;
    execute?: (request: ExecuteRequest, ctx: CallContext) => Promise<unknown>;
  } = {},
): Seen {
  const seen: Seen = { calls: [], opens: [], executes: [] };
  setHooks(engine, {
    open: (ctx: unknown) => {
      seen.calls.push("open");
      seen.opens.push(ctx as OpenContext);
      return (options.open ?? (() => Promise.resolve({ handle: { session: randomUUID() } })))(ctx as OpenContext);
    },
    close: () => {
      seen.calls.push("close");
      return Promise.resolve();
    },
    execute: (_handle: unknown, request: unknown, ctx: unknown) => {
      seen.calls.push("execute");
      seen.executes.push(request as ExecuteRequest);
      return (options.execute ?? (() => Promise.resolve(answerOf(["orders"]))))(
        request as ExecuteRequest,
        ctx as CallContext,
      );
    },
  });
  return seen;
}

/** The author a notice names for `engine`: its record's display name and the package that serves it. */
const authorOf = (engine: string) => engineAuthor(servedEngineRecord(engine));

/** The MCP audit events written since the buffer was last cleared. */
const auditEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation");

/** The lines `spy` logged as `line`. */
const linesOf = (spy: { mock: { calls: unknown[][] } }, line: string) =>
  spy.mock.calls.filter(([logged]) => logged === line);

describe("a provider package's engine on its own language's MCP statement tool", () => {
  test("a package engine's statement is served by its language's tool through its read-only statement session", async () => {
    const seen = hooksFor(CODE, { execute: () => Promise.resolve(answerOf(["orders"], true)) });
    const listed = listedOf(CODE);
    const arm = armOf(CODE);
    getServerAuditBuffer().clear();
    const result = await call(CODE, listed, '{"read":"topics"}');

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe(databaseContentNotice(authorOf(CODE)));
    expect(result.structuredContent).toMatchObject({
      connection_id: listed.id,
      columns: [{ name: "topic" }],
      rows: [{ topic: "orders" }],
      row_count: 1,
      truncated: false,
      truncated_by: null,
      // The package said it applied the page; a package arm asked for none, so it reports no page limit.
      pagination: { offset: 0, limit: 100, hasMore: false, nextOffset: null, wasLimited: false },
      hint: null,
    });
    // One open, through the package, under the read-only statement policy, on the profiled cache.
    expect(seen.calls).toEqual(["open", "execute"]);
    expect(seen.opens.map(({ policy }) => policy)).toEqual([
      expect.objectContaining({ readOnly: true, sendsStatements: true }),
    ]);
    expect(getExecutionProfileCacheStats().connections).toEqual([listed.id]);
    // The statement reaches the package as the language admitted it, under MCP's budgets, one row past the cap.
    expect(seen.executes).toEqual([
      {
        statement: arm.canonicalize('{"read":"topics"}') as string,
        page: { limit: MCP_PROVIDER_ROW_CAP + 1, offset: 0 },
        readOnly: { budget: { maxRows: MCP_PROVIDER_ROW_CAP, maxBytes: MCP_PROVIDER_BYTE_CAP } },
      },
    ]);
    expect(auditEvents()).toEqual([
      expect.objectContaining({ action: arm.tool, target: "mcp/decision", result: "success" }),
      expect.objectContaining({ action: arm.tool, target: "mcp/execution", result: "success" }),
    ]);
    // The next call sends on the cached session: no second open.
    expect((await call(CODE, listed, '{"read":"topics"}')).isError).toBeUndefined();
    expect(seen.calls).toEqual(["open", "execute", "execute"]);
  });

  test("a request its declared form refuses is answered before any open", async () => {
    const seen = hooksFor(CODE);
    const refusal = CODE_DATA.agent?.request.reads[0]?.refuses[0]?.refusal;
    const result = await call(CODE, listedOf(CODE), '{"read":"topics","topic":"orders"}');
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    const fenced = armOf(CODE).fence('{"read":"topics","topic":"orders"}', CODE as never);
    expect(fenced).not.toBeNull();
    expect(result.content[0]?.text).toBe(fenced as string);
    expect(result.content[0]?.text).toContain(refusal?.sentence as string);
    expect(seen.calls).toEqual([]);
  });

  test("a connection configuring an agent credential is refused by name before any open", async () => {
    for (const credential of [{ agentUser: "agent" }, { agentPassword: randomUUID() }]) {
      const seen = hooksFor(CODE);
      const listed = listedOf(CODE, credential);
      const result = await call(CODE, listed, '{"read":"topics"}');
      const arm = armOf(CODE);
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: profileRefusalText(
              `Connection "${listed.id}" configures an agent credential, and its engine's session opens through its provider package with the connection's own credential, which receives no agent credential, so no read-only statement session opens on it.`,
              arm.engines,
              arm.tool,
            ),
          },
        ],
        structuredContent: {
          error: { kind: "studio-profile-refusal", code: "AGENT_CREDENTIAL_NOT_TAKEN", outcome: "not-sent" },
        },
        isError: true,
      });
      if ("agentPassword" in credential) expect(JSON.stringify(result)).not.toContain(credential.agentPassword);
      expect(seen.calls).toEqual([]);
    }
  });

  test("a package arm's answer names no next offset and reports no page limit, whatever the package says it applied", async () => {
    const arm = armOf(CODE);
    for (const pageApplied of [true, false]) {
      hooksFor(CODE, { execute: () => Promise.resolve(answerOf(["a", "b", "c"], pageApplied)) });
      const result = await call(CODE, listedOf(CODE), '{"read":"topics"}', { max_rows: 2 });
      expect(result.isError).toBeUndefined();
      expect([pageApplied, result.structuredContent]).toEqual([
        pageApplied,
        expect.objectContaining({
          rows: [{ topic: "a" }, { topic: "b" }],
          row_count: 2,
          truncated: true,
          truncated_by: "max_rows",
          pagination: { offset: 0, limit: 2, hasMore: true, nextOffset: null, wasLimited: false },
          hint: arm.moreRows(arm.canonicalize('{"read":"topics"}') as string, CODE as never, {
            maxRows: 2,
            shown: 2,
            cut: "max_rows",
          }),
        }),
      ]);
    }
  });

  test("a package's open or execute failure is answered by its grant and logged once", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      for (const engine of [CODE, WORDS]) {
        const granted = engine === WORDS;
        // The open fails in words that carry a marker and the connection's secret.
        error.mockClear();
        const listed = listedOf(engine);
        const marker = randomUUID();
        hooksFor(engine, {
          open: () => Promise.reject(new Error(`could not sign in ${marker} with ${String(listed.password)}`)),
        });
        const opened = await call(engine, listed, '{"read":"topics"}');
        expect(opened.isError).toBe(true);
        expect(JSON.stringify(opened)).not.toContain(String(listed.password));
        if (granted) {
          expect(opened.content.map(({ text }) => text)).toEqual([
            databaseContentNotice(authorOf(engine)),
            `${MCP_ENGINE_ERROR_PREFIX}${PROVIDER_TEXT_WITHHELD}`,
          ]);
        } else {
          expect(opened.content.map(({ text }) => text)).toEqual([
            expect.stringMatching(/^The provider package's open failed \(.+\); the server's log holds its words\.$/),
          ]);
          expect(JSON.stringify(opened)).not.toContain(marker);
        }
        expect(opened.structuredContent).toEqual({
          error: { kind: "connection", code: "CONNECTION_ERROR", outcome: "not-sent" },
        });
        const openLines = linesOf(error, "A provider package's open failed");
        expect(openLines).toHaveLength(1);
        expect(JSON.stringify(openLines)).not.toContain(String(listed.password));

        // The execute fails in the package's words.
        error.mockClear();
        const words = `the read lost ${randomUUID()}`;
        hooksFor(engine, { execute: () => Promise.reject(new Error(words)) });
        const executed = await call(engine, listedOf(engine), '{"read":"topics"}');
        expect(executed.isError).toBe(true);
        if (granted) {
          expect(executed.content.map(({ text }) => text)).toEqual([
            databaseContentNotice(authorOf(engine)),
            `${MCP_ENGINE_ERROR_PREFIX}${words}`,
          ]);
        } else {
          expect(executed.content.map(({ text }) => text)).toEqual([
            expect.stringMatching(/^The provider package's execute failed \(.+\); the server's log holds its words\.$/),
          ]);
          expect(JSON.stringify(executed)).not.toContain(words);
        }
        expect(executed.structuredContent).toEqual({
          error: { kind: "query", code: "QUERY_ERROR", outcome: "unknown" },
        });
        expect(linesOf(error, "A provider package's execute failed")).toHaveLength(1);
      }
    } finally {
      error.mockRestore();
    }
  });

  test("a Studio error after a package's open is answered as Studio's own", async () => {
    const arm = armOf(WORDS);
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      // The open's refinement withdraws readOnly: the opener's refusal, in the tool's own sentence, no notice.
      const withdrawn = hooksFor(WORDS, {
        open: () =>
          Promise.resolve({
            handle: { session: randomUUID() },
            refine: { calls: { console: { execute: { honours: [] } } } },
          }),
      });
      expect(await call(WORDS, listedOf(WORDS), '{"read":"topics"}')).toEqual({
        content: [
          {
            type: "text",
            text: profileRefusalText(
              `The provider package of ${servedEngineRecord(WORDS).displayName} withdrew readOnly from the request fields its session honours when it opened, so Studio opens no read-only statement session on it.`,
              arm.engines,
              arm.tool,
            ),
          },
        ],
        structuredContent: {
          error: { kind: "studio-profile-refusal", code: "PROFILE_UNSUPPORTED_BY_PROVIDER", outcome: "not-sent" },
        },
        isError: true,
      });
      expect(withdrawn.calls).toEqual(["open", "close"]);

      // The package answers one row past MCP's row cap: Studio's budget refusal, in the language's row-cap advice.
      const rows = Array.from({ length: MCP_PROVIDER_ROW_CAP + 1 }, (_, index) => `t${index}`);
      hooksFor(WORDS, { execute: () => Promise.resolve(answerOf(rows)) });
      const tooLarge = await call(WORDS, listedOf(WORDS), '{"read":"topics"}');
      expect(tooLarge.isError).toBe(true);
      expect(tooLarge.content.map(({ text }) => text)).toEqual([
        arm.tooLarge(arm.canonicalize('{"read":"topics"}') as string, WORDS as never).rows as string,
      ]);
      expect(error.mock.calls.filter(([line]) => String(line).startsWith("A provider package's"))).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  test("a stopped wait releases the call at its deadline while the package's open runs on", async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const seen = hooksFor(CODE, {
      open: async () => {
        reached.resolve();
        await release.promise;
        return { handle: { session: randomUUID() } };
      },
    });
    const listed = listedOf(CODE);
    getServerAuditBuffer().clear();
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      const stopped = await call(CODE, listed, '{"read":"topics"}', { timeout_ms: 500 });
      expect(stopped).toEqual({ content: [{ type: "text", text: timeoutText(500) }], isError: true });
      expect(auditEvents().at(-1)).toEqual(expect.objectContaining({ result: "failure", reason: "mcp_timeout" }));
      // The open the call stopped waiting for is the package's own, still held.
      await reached.promise;
      release.resolve();
      expect((await call(CODE, listed, '{"read":"topics"}')).isError).toBeUndefined();
      expect(seen.calls.filter((name) => name === "open")).toEqual(["open"]);
      expect(error.mock.calls.filter(([line]) => String(line).startsWith("A provider package's"))).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });
});
