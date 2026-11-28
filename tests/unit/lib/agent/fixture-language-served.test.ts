/**
 * The out-of-tree fixture's own statement language (tests/fixtures/out-of-tree-provider), served by Studio's real
 * composers when a register row planted here grants it, and by none of them when that row's language digest is one
 * byte off.
 *
 * The fixture's own source is bundled in process with esbuild's API and the options of its own build (build.mjs:
 * bundle, esm, platform node, target node24), against the workspace's SDK, and placed as the pack step places it: its
 * package.json and manifest copied beside the bundle at the manifest's `runtime.entry`, in a scratch providers
 * directory with a lock written by Studio's serializer. Nothing imports a file of the fixture: the bundle is a scratch
 * file, read by Studio's boot admission and, for the provider's own reader, by a dynamic import of that scratch file.
 * The package, its engine, its language and the connection's name are read from the fixture's own files
 * (`readFixture` in scripts/out-of-tree-acceptance.ts and its manifest), so no engine id or language name is written
 * here.
 *
 * A process admits a package's engine once, so the package is admitted once, under the granted register, and each case
 * composes that admission under its own register and installs it. The planted row grants the language under the digest
 * of the manifest's language data, with every MCP claim, `decidesAlone` and `readsSqlText: false` (an engine with no SQL
 * text has its statements decided by its language row alone only under both); every other member is the row's
 * restrictive value, so the manifest's file-posture refusal stands and the one connection is an operator's seed limited
 * to the admin role, read by an admin on all three surfaces: the query route by its seed id, an agent-mode run driven
 * from its ledger by the composition root, and the language's MCP statement tool through the real MCP context.
 *
 * Replaced modules: `@/lib/auth` (an admin session), `@/lib/agent/run-store` (the ledger a local world in a scratch
 * directory) and `@/lib/agent/model-adapter` (the model a scripted transport,
 * tests/isolated/fixtures/agent-scripted-model.ts), each spreading the real module captured before its replacement.
 * Paths are built with `path.join`, no file mode, link or line ending is read, so each step is the same on Linux, macOS
 * and Windows, where esbuild's API runs alike; no case awaits a timer.
 */
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseGrantRegister } from "@libredb/grant-register";
import {
  type CallContext,
  encodedRowBytes,
  type ExecuteAnswer,
  type ExecuteRequest,
  type OpenContext,
  type ProviderModule,
} from "@libredb/provider-sdk/calls";
import type { StatementLanguageData } from "@libredb/provider-sdk/manifest";
import { createLocalWorld } from "@workflow/world-local";
import { notReviewedSentence, workflowAvailability } from "@/lib/agent/agent-manifest";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { agentLanguageMcpFacets, MODULE_MCP_TOOLS } from "@/lib/agent/languages/mcp";
import { servedAvailabilityTables, servedClientPacks } from "@/lib/agent/languages/server";
import type { AgentModel } from "@/lib/agent/model-adapter";
import type { AgentRunEvent } from "@/lib/agent/types";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { languageDataSha256 } from "@/lib/db/language-digest";
import { admitDeclaredRequest } from "@/lib/db/operations/declared-request-form";
import { engineAuthor } from "@/lib/db/operations/provider-text";
import { forgetServerCatalog, installServerCatalog, servedEngineRecord } from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { McpConnectionContext } from "@/lib/mcp/context";
import { databaseContentNotice } from "@/lib/mcp/output";
import type { McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { runStatement } from "@/lib/mcp/tools/run-statement";
import {
  mcpStatementArm,
  mcpStatementSurface,
  mcpStatementToolFor,
  type McpStatementTool,
} from "@/lib/mcp/tools/statement-arms";
import { type BootAdmission, bootAdmission, PROVIDER_IMPORT_DEADLINE_MS } from "@/lib/provider-host/boot";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import type { DatabaseType } from "@/lib/types";
import { MANIFEST_FILE_NAME } from "@/lib/provider-host/provider-artifact";
import { build } from "esbuild";
import { readFixture } from "../../../../scripts/out-of-tree-acceptance";
import { configureAgentModel, restoreAgentModel } from "../../../helpers/agent-model-env";
import { mcpPackageLanguageRow, offByOneByte } from "../../../helpers/agent-package-catalog";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../../helpers/mcp-fixtures";
import { packageRow } from "../../../helpers/package-catalog";
import {
  artifactDirectoryOf,
  type FixturePackage,
  lockEntryOf,
  removeScratch,
  scratchDirectory,
  writeLock,
} from "../../../helpers/provider-artifacts";
import {
  callsTool,
  modelOver,
  reportCitingWhatWasOffered,
  scriptedModel,
} from "../../../isolated/fixtures/agent-scripted-model";

pinMcpTestEnvironment();
const SESSION = { role: "admin" as const, username: "admin", iat: 1_700_000_000 };
const realAuth = { ...(await import("@/lib/auth")) };
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => SESSION),
  readSession: mock(async () => ({ kind: "authenticated", session: SESSION })),
}));
const ledger = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-language-served-"));
const world = createLocalWorld({ dataDir: ledger, recoverActiveRuns: false });
/** The model the drive builds, set by the agent case; null outside a drive. */
let model: Promise<AgentModel> | null = null;
const realRunStore = { ...(await import("@/lib/agent/run-store")) };
const realModelAdapter = { ...(await import("@/lib/agent/model-adapter")) };
const createAgentModel = mock(async () => {
  if (model === null) throw new Error("no drive is in flight");
  return model;
});
mock.module("@/lib/agent/run-store", () => ({ ...realRunStore, resolveAgentLedgerWorld: async () => world }));
mock.module("@/lib/agent/model-adapter", () => ({ ...realModelAdapter, createAgentModel }));
const { POST: query } = await import("@/app/api/db/query/route");
const { POST: startRun } = await import("@/app/api/agent/runs/route");
const { driveAgentRunOutcome, getAgentRunService } = await import("@/lib/agent/runtime");
const { clearProviderCache } = await import("@/lib/db/factory");

const ROOT = path.resolve(import.meta.dir, "../../../..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "out-of-tree-provider");
const fixture = readFixture(FIXTURE, (file) => fs.readFileSync(file, "utf8"));
const engine = (fixture.engines[0] as { id: string; displayName: string }).id;
const displayName = (fixture.engines[0] as { id: string; displayName: string }).displayName;
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, MANIFEST_FILE_NAME), "utf8")) as {
  engines: { statementLanguageData: NonNullable<StatementLanguageData> }[];
};
const data = (manifest.engines[0] as { statementLanguageData: NonNullable<StatementLanguageData> })
  .statementLanguageData;
const language = data.name;
const tool = (data.agent as NonNullable<typeof data.agent>).mcp?.tool as McpStatementTool;
const [listed, read] = fixture.acceptance.statements as readonly [
  (typeof fixture.acceptance.statements)[number],
  (typeof fixture.acceptance.statements)[number],
];
/** The name the second statement of acceptance.json reads, as its console text names it. */
const readName = read.statement.split(/\s+/)[1] as string;
const SEED = "fixture";
const CONNECTION_ID = `seed:${SEED}`;
const pkg: FixturePackage = { name: fixture.name, version: fixture.version, engines: [engine], entry: fixture.entry };

const providers = scratchDirectory("fixture-language-served-providers-");
const seeds = scratchDirectory("fixture-language-served-seeds-");
let admission: Extract<BootAdmission, { read: true }> | null = null;
let packageDigest = "";
let bundle = "";

/** The register of the planted row: the language granted under `languageDigest`, with every MCP claim. */
function registerOf(languageDigest: string) {
  return parseGrantRegister(
    [
      packageRow({ name: fixture.name, version: fixture.version, digest: packageDigest }, engine, {
        ...mcpPackageLanguageRow(language, languageDigest),
        decidesAlone: true,
        readsSqlText: false,
      }),
    ],
    LEGACY_ENGINE_IDS,
  );
}

/** Composes the one admission under the register of the row granting the language under `languageDigest`. */
function install(languageDigest: string): void {
  if (admission === null) throw new Error("the fixture was not admitted");
  forgetServerCatalog();
  installServerCatalog(composeServerCatalog(admission.admitted, admission.refused, registerOf(languageDigest)));
}

const rowsOf = (columns: readonly string[], rows: readonly (readonly unknown[])[]) =>
  rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));

beforeAll(async () => {
  installHostCore(createHostCore(), "test");
  const artifact = artifactDirectoryOf(providers, pkg);
  fs.mkdirSync(artifact, { recursive: true });
  for (const file of ["package.json", MANIFEST_FILE_NAME]) {
    fs.copyFileSync(path.join(FIXTURE, file), path.join(artifact, file));
  }
  bundle = path.join(artifact, ...fixture.entry.split("/"));
  await build({
    entryPoints: [path.join(FIXTURE, fixture.acceptance.entrySource)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outfile: bundle,
    logLevel: "silent",
  });
  const lock = lockEntryOf(providers, pkg);
  packageDigest = lock.digest;
  writeLock(providers, [lock]);
  const answer = await bootAdmission(
    providers,
    PROVIDER_IMPORT_DEADLINE_MS,
    registerOf(languageDataSha256(data)),
    MODULE_MCP_TOOLS,
  );
  if (!answer.read) throw new Error(`the fixture's lock was refused: ${answer.refusal.sentence}`);
  if (answer.refused.length > 0 || answer.admitted.length !== 1) {
    throw new Error(`the fixture was not admitted: ${JSON.stringify(answer.refused)}`);
  }
  admission = answer;
  writeSeedFile(seeds, [{ id: SEED, type: engine, name: fixture.acceptance.connection.name as string }]);
  configureAgentModel();
});

afterEach(async () => {
  forgetHeldSnapshots();
  await clearProviderCache();
  await resetMcpTestState();
});

const savedSeedPath = process.env.SEED_CONFIG_PATH;
afterAll(() => {
  restoreAgentModel();
  if (savedSeedPath === undefined) delete process.env.SEED_CONFIG_PATH;
  else process.env.SEED_CONFIG_PATH = savedSeedPath;
  forgetServerCatalog();
  forgetHostCore();
  removeScratch(providers);
  removeScratch(seeds);
  fs.rmSync(ledger, { recursive: true, force: true });
});

/** The query route's answer to `statement` on the seed connection, asking to be confirmed when `confirmation` says so. */
async function gate(statement: string, confirmation: "ask") {
  clearRateLimitState();
  const response = await query(
    new Request("http://localhost:3000/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: CONNECTION_ID, sql: statement, confirmation }),
    }) as never,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The language's MCP statement tool's answer to `request` on the seed connection, called by an admin. */
async function mcp(request: string) {
  const arm = mcpStatementArm(tool);
  const args = arm.inputSchema.parse({ connection_id: CONNECTION_ID, [arm.argument]: request });
  return runStatement(arm, args as McpStatementInput, {
    context: new McpConnectionContext({ username: SESSION.username, role: SESSION.role }),
    signal: new AbortController().signal,
  });
}

test("the out-of-tree fixture's own language, granted by a planted row, is served on the confirmation gate, in agent mode and on MCP with no composer change", async () => {
  install(languageDataSha256(data));
  const record = servedEngineRecord(engine);
  // The premise: the row grants what the manifest requests, and the package honours the read-only execute.
  expect(record.grants).toMatchObject({
    statementLanguage: language,
    agentExecution: true,
    exposable: true,
    statementRead: true,
    decidesAlone: true,
    readsSqlText: false,
  });
  expect(record.offers.readOnlyStatements).toBe(true);
  expect(Object.keys(servedClientPacks())).toContain(language);
  expect(agentLanguageMcpFacets()[language as keyof ReturnType<typeof agentLanguageMcpFacets>]?.tool).toBe(tool);
  expect(mcpStatementToolFor(engine as DatabaseType)).toBe(tool);
  expect(workflowAvailability("agent", "investigation", record, servedAvailabilityTables())).toMatchObject({
    open: true,
    statementLanguage: language,
  });

  // The confirmation gate: the language row decides alone, so the console statement runs unconfirmed.
  const gated = await gate(listed.statement, "ask");
  expect(gated.status).toBe(200);
  expect(gated.body.rows).toEqual(rowsOf(listed.columns, listed.rows));
  expect(gated.body.confirmation).toBeUndefined();

  // Agent mode: a run recorded in the language sends its request form through the read-only statement session.
  const service = await getAgentRunService();
  const { runId } = await service.start({
    mode: "agent",
    workflowType: "investigation",
    engine,
    actor: { sessionId: SESSION.username, role: SESSION.role },
    connectionId: CONNECTION_ID,
    statementLanguage: language as never,
    objective: "Which names does the store hold?",
  });
  const script = scriptedModel(
    callsTool("run_read_query", { statement: JSON.stringify({ read: "list" }) }, "call_read"),
    reportCitingWhatWasOffered("The store holds the names it listed."),
  );
  model = modelOver(script.fetch);
  try {
    await driveAgentRunOutcome(runId);
  } finally {
    model = null;
  }
  const report = await service.status(runId);
  const events: readonly AgentRunEvent[] = report?.record.events ?? [];
  const kinds = events.map((event) => event.kind);
  expect(kinds.indexOf("context-unavailable")).toBeGreaterThan(-1);
  expect(kinds.indexOf("context-unavailable")).toBeLessThan(kinds.indexOf("tool-completed"));
  const completed = events.find((event) => event.kind === "tool-completed");
  expect(completed).toMatchObject({
    artifact: { operationId: `${language}.query.read`, summary: { rowCount: listed.rows.length } },
  });
  expect(events.find((event) => event.kind === "run-finished")).toMatchObject({
    status: "succeeded",
    goalVerdict: { outcome: "answered" },
  });

  // MCP: the language's own statement tool answers the request form's get read, behind the package's notice.
  const answered = await mcp(JSON.stringify({ read: "get", name: readName }));
  expect(answered.isError).toBeUndefined();
  expect(answered.content[0]).toEqual({ type: "text", text: databaseContentNotice(engineAuthor(record)) });
  const body = JSON.parse((answered.content[1] as { text: string }).text) as { rows: unknown };
  expect(body.rows).toEqual(rowsOf(read.columns, read.rows));
});

test("with the row's digest off by one byte it is served on none", async () => {
  install(offByOneByte(languageDataSha256(data)));
  const record = servedEngineRecord(engine);
  expect(record.grants).toMatchObject({ statementLanguage: null, decidesAlone: false, readsSqlText: true });
  expect(Object.keys(servedClientPacks())).not.toContain(language);
  expect(agentLanguageMcpFacets()[language as keyof ReturnType<typeof agentLanguageMcpFacets>]).toBeUndefined();
  expect(mcpStatementToolFor(engine as DatabaseType)).toBeNull();
  expect(mcpStatementSurface().declared.map((arm) => arm.tool)).not.toContain(tool);
  expect(workflowAvailability("agent", "investigation", record, servedAvailabilityTables())).toEqual({
    open: false,
    cause: "not-reviewed",
  });

  const gated = await gate(listed.statement, "ask");
  expect([gated.status, gated.body.code]).toEqual([428, "CONFIRMATION_REQUIRED"]);

  clearRateLimitState();
  const built = createAgentModel.mock.calls.length;
  const started = await startRun(
    new Request("http://localhost:3000/api/agent/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "agent",
        workflowType: "investigation",
        objective: "Which names does the store hold?",
        connectionId: CONNECTION_ID,
      }),
    }) as never,
  );
  expect(started.status).toBe(400);
  expect(await started.json()).toEqual({
    error: notReviewedSentence(displayName, false),
    refused: "engine-unsupported",
  });
  expect(createAgentModel.mock.calls.length).toBe(built);
});

test("the fixture's provider reads a read-only execute as one request of its language's agent request form, admitting exactly what the declared form admits, refuses an estimating mode or an answer past its budget, and keeps its console form on a plain execute", async () => {
  const loaded = (await import(pathToFileURL(bundle).href)) as { default: ProviderModule };
  const { impl } = loaded.default;
  const { handle } = await impl.open({} as OpenContext);
  const ctx = {} as CallContext;
  const budget = { maxRows: 200, maxBytes: 262_144 };
  const execute = async (request: ExecuteRequest): Promise<ExecuteAnswer | Error> => {
    try {
      return await impl.console.execute(handle, request, ctx);
    } catch (error) {
      return error as Error;
    }
  };
  const readOnly = (statement: string, readBudget = budget) =>
    execute({ statement, page: { limit: 201, offset: 0 }, readOnly: { budget: readBudget } });
  const rowsIn = async (answer: ExecuteAnswer | Error) => {
    if (answer instanceof Error) throw answer;
    const source = answer.results[0];
    if (source === undefined) throw new Error("the answer holds no result");
    const batch = await source.next({ maxRows: 1_000, maxBytes: 1_048_576, measure: encodedRowBytes });
    return { columns: source.columns.map((column) => column.name), rows: batch.rows };
  };

  const form = (data.agent as NonNullable<typeof data.agent>).request;
  const corpus = [
    '{"read":"list"}',
    '{"read": "get", "name": "beta"}',
    '{"name":"zeta","read":"get"}',
    "",
    "  ",
    "list",
    "[]",
    "null",
    '"list"',
    "{}",
    '{"read":"count"}',
    '{"read":"list","name":"beta"}',
    '{"read":"get"}',
    '{"read":"get","name":"Beta"}',
    '{"read":"get","name":""}',
    `{"read":"get","name":"${"a".repeat(33)}"}`,
    '{"read":"list","read":"get"}',
    '{"read":"list","extra":1}',
    '{"read":5}',
    '{"__proto__":1}',
    '{"read":"get","name":7}',
  ];
  const answers = await Promise.all(corpus.map((text) => readOnly(text)));
  const disagreements = corpus.flatMap((text, index) => {
    const declared = admitDeclaredRequest(form, text) === null;
    const answered = !(answers[index] instanceof Error);
    return declared === answered ? [] : [`${JSON.stringify(text)}: declared ${declared}, provider ${answered}`];
  });
  expect(disagreements).toEqual([]);
  expect(corpus.filter((text) => admitDeclaredRequest(form, text) === null)).toHaveLength(3);

  expect(await rowsIn(await readOnly(JSON.stringify({ read: "list" })))).toEqual({
    columns: [...listed.columns],
    rows: listed.rows,
  });
  expect(await rowsIn(await readOnly(JSON.stringify({ read: "get", name: readName })))).toEqual({
    columns: [...read.columns],
    rows: read.rows,
  });

  const estimating = await execute({
    statement: JSON.stringify({ read: "list" }),
    page: { limit: 201, offset: 0 },
    readOnly: { budget, mode: "estimate-plan" },
  });
  expect(estimating).toBeInstanceOf(Error);
  const smallestRow = Math.min(...listed.rows.map((row) => encodedRowBytes(row)));
  expect(await readOnly(JSON.stringify({ read: "list" }), { ...budget, maxRows: 1 })).toBeInstanceOf(Error);
  expect(await readOnly(JSON.stringify({ read: "list" }), { ...budget, maxBytes: smallestRow - 1 })).toBeInstanceOf(
    Error,
  );

  const plainJson = await execute({ statement: JSON.stringify({ read: "list" }), page: { limit: 201, offset: 0 } });
  expect(plainJson).toBeInstanceOf(Error);
  expect((plainJson as Error).message).toBe(fixture.acceptance.refused.packageWords);
  expect(await rowsIn(await execute({ statement: listed.statement, page: { limit: 201, offset: 0 } }))).toEqual({
    columns: [...listed.columns],
    rows: listed.rows,
  });
});
