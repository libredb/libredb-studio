/**
 * An agent run on an engine an admitted provider package serves, driven from its ledger by the composition root
 * (`driveAgentRunOutcome` in src/lib/agent/runtime.ts): the drive resolves the run's connection through the served
 * resolve under the run's persisted actor, grounds a plan-mode run through the package's metadata session, refuses by
 * name before its first model turn an agent-mode run whose workflow sends statements where availability closes it, and
 * a run recorded with a database its engine offers no catalog session for, grounds and sends the statements of an
 * agent-mode run in the package's own declared language through the package's read-only statement session, a failure
 * of its statement repairable as a legacy engine's, and reads the operations workflow's granted readings on the
 * package's metadata session, a reading's failure answered by the engine's record and logged once.
 *
 * The packages are written into a scratch providers directory and admitted by Studio's boot admission
 * (tests/helpers/package-session-fixture.ts), each function calling the hook a case sets; the ledger is a local world in
 * a scratch directory, the model a scripted transport (tests/isolated/fixtures/agent-scripted-model.ts), and the run's
 * connection the one a case sets. Each replaced module spreads the real module captured before its replacement, and
 * each recorder calls the captured function. Paths are built with `path.join`, no file mode, link or line ending is
 * read, and no case awaits a timer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CallContext, ExecuteRequest, OpenContext, TreeRequest } from "@libredb/provider-sdk/calls";
import type { ObjectModel } from "@libredb/provider-sdk/manifest";
import { createLocalWorld } from "@workflow/world-local";
import { noStatementSessionSentence, notReviewedSentence } from "@/lib/agent/agent-manifest";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { noAdapterSentence } from "@/lib/agent/posture";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import type { AgentModel } from "@/lib/agent/model-adapter";
import type { AgentRunEvent, AgentRunMode, AgentRunWorkflowType } from "@/lib/agent/types";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { ConnectionError, StudioProfileRefusal } from "@/lib/db/errors";
import { languageDataSha256 } from "@/lib/db/language-digest";
import { PROVIDER_TEXT_WITHHELD } from "@/lib/db/operations/provider-text";
import { type EngineConnection, servedEngineRecord } from "@/lib/db/server-catalog";
import { logger } from "@/lib/logger";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import { configureAgentModel, restoreAgentModel } from "../helpers/agent-model-env";
import { acmereadData } from "../helpers/declared-agent-language";
import { type EditableEngine, withLoosestClaims, withStatementLanguageData } from "../helpers/package-catalog";
import { admitSessionPackages, setHooks } from "../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../helpers/provider-artifacts";
import { servedResolveOver } from "../helpers/served-resolve";
import {
  answersProse,
  callsTool,
  modelOver,
  promptText,
  reportCitingWhatWasOffered,
  reportOnAll,
  type ScriptedTurn,
  scriptedModel,
  type Turn,
} from "./fixtures/agent-scripted-model";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-package-engine-drive-"));
const world = createLocalWorld({ dataDir, recoverActiveRuns: false });

/** The connection the run's drive resolves to, set by a case; null outside a drive. */
let connection: EngineConnection | null = null;
/** The model the drive builds, set by a case; null outside a drive. */
let model: Promise<AgentModel> | null = null;

const realRunStore = { ...(await import("@/lib/agent/run-store")) };
const realModelAdapter = { ...(await import("@/lib/agent/model-adapter")) };
const realResolve = { ...(await import("@/lib/seed/resolve-connection")) };
const realGuard = { ...(await import("@/lib/db/operations/statement-guard")) };
const realBuild = { ...(await import("@/lib/query-events/build")) };
const realSink = { ...(await import("@/lib/query-events/sink")) };
const realFactory = { ...(await import("@/lib/db/factory")) };
const realInspect = realGuard.inspectAgentStatement;
const realBuildQueryEvent = realBuild.buildQueryEvent;
const realRecordQueryEvent = realSink.recordQueryEvent;
const realAcquire = realFactory.acquireExecutionProfileProvider;

/** Each call of the run's connection resolve, with the arguments it was given. */
const resolved = mock(async () => {
  if (connection === null) throw new Error("no drive is in flight");
  return connection;
});
const createAgentModel = mock(async () => {
  if (model === null) throw new Error("no drive is in flight");
  return model;
});
const inspected = mock((...args: Parameters<typeof realInspect>) => realInspect(...args));
const built = mock((...args: Parameters<typeof realBuildQueryEvent>) => realBuildQueryEvent(...args));
const recorded = mock((...args: Parameters<typeof realRecordQueryEvent>) => realRecordQueryEvent(...args));
const acquired = mock((...args: Parameters<typeof realAcquire>) => realAcquire(...args));

mock.module("@/lib/agent/run-store", () => ({ ...realRunStore, resolveAgentLedgerWorld: async () => world }));
mock.module("@/lib/agent/model-adapter", () => ({ ...realModelAdapter, createAgentModel }));
mock.module("@/lib/seed/resolve-connection", () => ({
  ...realResolve,
  resolveServedConnection: servedResolveOver(resolved),
}));
mock.module("@/lib/db/operations/statement-guard", () => ({ ...realGuard, inspectAgentStatement: inspected }));
mock.module("@/lib/query-events/build", () => ({ ...realBuild, buildQueryEvent: built }));
mock.module("@/lib/query-events/sink", () => ({ ...realSink, recordQueryEvent: recorded }));
mock.module("@/lib/db/factory", () => ({ ...realFactory, acquireExecutionProfileProvider: acquired }));

const { driveAgentRunOutcome, getAgentRunService } = await import("@/lib/agent/runtime");

/** One container level and one relation kind, in words no engine of Studio's uses. */
const TREE_MODEL: ObjectModel = {
  containerLevels: [{ id: "schema", label: "Folder", labelPlural: "Folders" }],
  containerPathShapes: "exact",
  containerNameSpelling: null,
  objectKinds: [
    {
      id: "collection",
      role: "relation",
      label: "Collection",
      labelPlural: "Collections",
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
 * A package whose row grants the health reading; the same with its words granted; one with no register row; one whose
 * row grants `sql` and agent execution and reviews no grammar (its manifest states SQL text, its row no digest); and one
 * declaring the crafted language `acmeread` (tests/helpers/declared-agent-language.ts), its row granting it under the
 * digest of its data and agent execution, its package honouring `readOnly` and its row reading no read roots, so the
 * factory opens its read-only statement session; and one declaring the same language whose row grants none, so Studio
 * has not reviewed its statement path.
 */
const READS = "acmedrivereads";
const WORDS = "acmedrivewords";
const BARE = "acmedrivebare";
const EXEC = "acmedriveexec";
const LANG = "acmedrivelang";
const UNREVIEWED = "acmedriveunreviewed";
const LANGUAGE_DATA = acmereadData();
const withModel = (engine: EditableEngine) => {
  (engine as Record<string, unknown>).objects = structuredClone(TREE_MODEL);
};
/** The tree model and the crafted language, requested as the engine's agent statement language. */
const withModelAndLanguage = (engine: EditableEngine) => {
  withModel(engine);
  engine.agent = { statementLanguage: LANGUAGE_DATA.name, overlay: { dialect: null, grounding: null } };
  withStatementLanguageData(engine, LANGUAGE_DATA);
};
/** The tree model, the active sessions panel, and a request of the health and sessions readings. */
const withModelAndReadings = (engine: EditableEngine) => {
  withModel(engine);
  engine.facets = {
    ...engine.facets,
    monitoring: { ...(engine.facets.monitoring as Record<string, unknown>), activeSessions: "offered" },
    agentReadings: ["health", "sessions"],
  };
};
/** Opens the engine for a caller whose file access is denied, the run's actor being no administrator. */
const OPEN = { deniedFileAccessRefusal: null } as const;
const HEALTH = { ...OPEN, agentReadings: Object.freeze(["health"] as const) };
const providers = scratchDirectory("studio-agent-package-drive-");

beforeAll(async () => {
  installHostCore(createHostCore(), "test");
  await admitSessionPackages(
    providers,
    [
      {
        name: "acme-drive-reads",
        engine: READS,
        offered: ["objects.tree", "monitoring.panel"],
        edit: withModelAndReadings,
      },
      {
        name: "acme-drive-words",
        engine: WORDS,
        offered: ["objects.tree", "monitoring.panel"],
        edit: withModelAndReadings,
      },
      { name: "acme-drive-bare", engine: BARE, offered: ["objects.tree"], edit: withModel },
      { name: "acme-drive-exec", engine: EXEC, offered: ["objects.tree", "monitoring.panel"], edit: withLoosestClaims },
      {
        name: "acme-drive-lang",
        engine: LANG,
        offered: ["objects.tree"],
        honours: ["readOnly"],
        edit: withModelAndLanguage,
      },
      {
        name: "acme-drive-unreviewed",
        engine: UNREVIEWED,
        offered: ["objects.tree"],
        honours: ["readOnly"],
        edit: withModelAndLanguage,
      },
    ],
    {
      [READS]: HEALTH,
      [WORDS]: { ...HEALTH, ownWords: "scrubbed" },
      [EXEC]: { ...OPEN, statementLanguage: "sql", agentExecution: true },
      [LANG]: {
        ...OPEN,
        statementLanguage: LANGUAGE_DATA.name,
        languageSha256: languageDataSha256(LANGUAGE_DATA),
        agentExecution: true,
        readRootsRequired: false,
      },
      [UNREVIEWED]: { ...OPEN, readRootsRequired: false },
    },
  );
});

beforeEach(() => {
  configureAgentModel();
});

afterEach(async () => {
  forgetHeldSnapshots();
  await realFactory.clearProviderCache();
  restoreAgentModel();
  connection = null;
  model = null;
  for (const recorder of [resolved, createAgentModel, inspected, built, recorded, acquired]) recorder.mockClear();
});

afterAll(async () => {
  await realFactory.clearProviderCache();
  forgetHostCore();
  removeScratch(providers);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** The answer a tree hook gives each action: two collections in one folder. */
function treeAnswer(request: TreeRequest): unknown {
  switch (request.action) {
    case "containers":
      return { containers: [{ path: ["main"], name: "main", level: 0, isSessionDefault: true }] };
    case "count":
      return { counts: { collection: { count: 2 } } };
    case "list":
      return {
        objects: ["orders", "users"].map((name) => ({ path: [...request.container, name], name, kind: "collection" })),
      };
    case "describe":
      return { detail: { path: request.path, columns: [], indexes: [], foreignKeys: [] } };
    case "describeMany":
      return {
        details: ["orders", "users"].map((name) => ({
          path: [...request.container, name],
          columns: [{ name: "id", type: "int", nullable: false, isPrimary: true }],
          indexes: [],
          foreignKeys: [],
        })),
      };
  }
}

/** The names of the package's functions a case's hooks were called by, in order. */
type Seen = string[];

/**
 * Hooks for `engine`'s package: `open`'s answer or a fresh handle per open, handed the open's context, the
 * two-collection tree, `health`, and `execute`'s answer, handed the request and the call's context, where a case sets
 * one.
 */
function hooksFor(
  engine: string,
  options: {
    open?: (ctx: OpenContext) => Promise<unknown>;
    health?: () => Promise<unknown>;
    execute?: (request: ExecuteRequest, ctx: CallContext) => Promise<unknown>;
  } = {},
): Seen {
  const seen: Seen = [];
  setHooks(engine, {
    open: (ctx: unknown) => {
      seen.push("open");
      return (options.open ?? (() => Promise.resolve({ handle: { session: randomUUID() } })))(ctx as OpenContext);
    },
    execute: (_handle: unknown, request: unknown, ctx: unknown) => {
      seen.push("execute");
      if (options.execute === undefined) throw new Error("this case's package answers no execute");
      return options.execute(request as ExecuteRequest, ctx as CallContext);
    },
    close: () => Promise.resolve(),
    tree: (_handle: unknown, request: unknown) => {
      seen.push("tree");
      return Promise.resolve(treeAnswer(request as TreeRequest));
    },
    health: () => {
      seen.push("health");
      return (
        options.health ??
        (() =>
          Promise.resolve({
            activeConnections: 3,
            databaseSize: "1 MB",
            cacheHitRatio: "99%",
            slowQueries: [],
            activeSessions: [],
          }))
      )();
    },
    panel: () => {
      seen.push("panel");
      return Promise.resolve({ tables: [] });
    },
  });
  return seen;
}

/** A connection of `engine` with its own id and a generated secret, and the agent credential `agent` names. */
function connectionOf(engine: string, agent: { agentUser?: string; agentPassword?: string } = {}): EngineConnection {
  return {
    id: `seed:${randomUUID()}`,
    name: "Acme",
    type: engine,
    host: "drive.local",
    password: randomUUID(),
    createdAt: new Date(0),
    ...agent,
  };
}

/** What one drive answered: its outcome, the run's ledger events and the prompts the model was sent. */
interface Driven {
  readonly outcome: Awaited<ReturnType<typeof driveAgentRunOutcome>> | undefined;
  readonly thrown: unknown;
  readonly events: readonly AgentRunEvent[];
  readonly turns: readonly Turn[];
}

/**
 * A run planted in the ledger as the start route would record it on `on`, with the engine's id, and `catalog` and
 * `statementLanguage` where one is named, then driven from its ledger by the composition root with `turns` as its
 * model.
 */
async function drive(
  on: EngineConnection,
  mode: AgentRunMode,
  workflowType: AgentRunWorkflowType,
  turns: readonly ScriptedTurn[],
  catalog?: string,
  statementLanguage?: string,
): Promise<Driven> {
  const service = await getAgentRunService();
  const { runId } = await service.start({
    mode,
    workflowType,
    engine: on.type,
    actor: { sessionId: "sess_1", role: "user" },
    connectionId: on.id,
    ...(catalog === undefined ? {} : { catalog }),
    ...(statementLanguage === undefined ? {} : { statementLanguage: statementLanguage as never }),
    objective: "Is the engine healthy?",
  });
  const script = scriptedModel(...turns);
  connection = on;
  model = modelOver(script.fetch);
  let outcome: Driven["outcome"];
  let thrown: unknown;
  try {
    outcome = await driveAgentRunOutcome(runId);
  } catch (error) {
    thrown = error;
  }
  const report = await service.status(runId);
  if (report === null) throw new Error(`run ${runId} has no ledger`);
  return { outcome, thrown, events: report.record.events, turns: script.turns };
}

/** The run's settled ending. */
function finishedOf(events: readonly AgentRunEvent[]): Extract<AgentRunEvent, { kind: "run-finished" }> {
  const finished = events.find((event) => event.kind === "run-finished");
  if (finished?.kind !== "run-finished") throw new Error("the run did not finish");
  return finished;
}

/** Every prompt the model was sent, as prose. */
const transcriptOf = (turns: readonly Turn[]): string => turns.map((turn) => promptText(turn)).join("\n");

/** The calls of a logger spy whose line is `line`. */
function linesOf(spy: { readonly mock: { readonly calls: readonly unknown[][] } }, line: string): unknown[][] {
  return spy.mock.calls.filter(([logged]) => logged === line);
}

describe("an agent run's drive on a provider package's engine", () => {
  test("a plan-mode run on a package engine is driven from its ledger through the served resolve, and grounds through its package's metadata session", async () => {
    const seen = hooksFor(READS);
    const on = connectionOf(READS);
    const run = await drive(on, "planning", "investigation", [answersProse("No plan."), answersProse("No plan.")]);

    expect(run.thrown).toBeUndefined();
    expect(run.outcome?.kind).toBe("finished");
    // Resolved once, through the served resolve, under the run's persisted actor.
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith({ connectionId: on.id }, { role: "user", username: "sess_1" });
    expect(run.events.find((event) => event.kind === "context-captured")).toMatchObject({
      tableCount: 2,
      snapshot: { readVia: "provider-inventory" },
    });
    expect(seen.filter((call) => call === "open")).toEqual(["open"]);
    expect(acquired).not.toHaveBeenCalled();
    expect(finishedOf(run.events)).toMatchObject({ status: "succeeded" });
  });

  test("an agent-mode run whose workflow sends statements on a package engine its availability closes is refused by name before its first model turn, and its package never opens", async () => {
    // A package that requests no language, and one granted sql whose package takes no read-only execute: each refused
    // in the start route's sentence.
    const sentences: Record<string, (label: string) => string> = {
      [BARE]: (label) => noAdapterSentence(label, false),
      [EXEC]: (label) => noStatementSessionSentence(label, false),
    };
    for (const engine of [BARE, EXEC]) {
      const seen = hooksFor(engine);
      // oxlint-disable-next-line no-await-in-loop -- one drive at a time, each reading the recorders the one before cleared.
      const run = await drive(connectionOf(engine), "agent", "investigation", [answersProse("No report.")]);

      expect(run.outcome?.kind, engine).toBe("failed");
      const error = run.outcome?.kind === "failed" ? run.outcome.error : undefined;
      expect(error, engine).toBeInstanceOf(StudioProfileRefusal);
      expect((error as StudioProfileRefusal).reasonCode, engine).toBe("PROFILE_UNSUPPORTED_BY_PROVIDER");
      expect((error as Error).message, engine).toBe(
        (sentences[engine] as (label: string) => string)(servedEngineRecord(engine).displayName),
      );
      expect(finishedOf(run.events), engine).toMatchObject({ status: "failed", reason: "engine-unsupported" });
      expect(createAgentModel, engine).not.toHaveBeenCalled();
      expect(run.turns, engine).toEqual([]);
      expect(seen, engine).toEqual([]);
      expect(acquired, engine).not.toHaveBeenCalled();
      createAgentModel.mockClear();
    }

    // The operations workflow and plan mode send no statement, so the drive refuses neither: it builds their model.
    for (const [engine, mode, workflowType] of [
      [READS, "agent", "operations"],
      [EXEC, "planning", "investigation"],
    ] as const) {
      hooksFor(engine);
      // oxlint-disable-next-line no-await-in-loop -- one drive at a time.
      await drive(connectionOf(engine), mode, workflowType, [answersProse("No report."), answersProse("No report.")]);
      expect(createAgentModel, `${mode} ${workflowType}`).toHaveBeenCalledTimes(1);
      createAgentModel.mockClear();
    }
  });

  test("an agent-mode run whose workflow sends statements on a package engine that requests a language its row does not grant is refused as not reviewed before its first model turn, and its package never opens", async () => {
    // Vacuity: the declaration requests the crafted language, the row grants none.
    expect(servedEngineRecord(UNREVIEWED).grants).toMatchObject({
      requestsStatementLanguage: true,
      statementLanguage: null,
    });
    const seen = hooksFor(UNREVIEWED);
    const run = await drive(connectionOf(UNREVIEWED), "agent", "investigation", [answersProse("No report.")]);

    expect(run.outcome?.kind).toBe("failed");
    const error = run.outcome?.kind === "failed" ? run.outcome.error : undefined;
    expect(error).toBeInstanceOf(StudioProfileRefusal);
    expect((error as StudioProfileRefusal).reasonCode).toBe("PROFILE_ENGINE_NOT_REVIEWED");
    expect((error as Error).message).toBe(notReviewedSentence(servedEngineRecord(UNREVIEWED).displayName, false));
    expect(finishedOf(run.events)).toMatchObject({ status: "failed", reason: "engine-unsupported" });
    expect(createAgentModel).not.toHaveBeenCalled();
    expect(run.turns).toEqual([]);
    expect(seen).toEqual([]);
    expect(acquired).not.toHaveBeenCalled();
  });

  test("a plan-mode run on a package engine whose row grants its own declared language is driven in that language from its ledger, reaching no fence, query event or execution profile", async () => {
    const seen = hooksFor(LANG);
    // Vacuity: the record grants its own language and agent execution, and offers no execution profiles.
    expect(servedEngineRecord(LANG).grants).toMatchObject({ statementLanguage: "acmeread", agentExecution: true });
    expect(servedEngineRecord(LANG).offers.executionProfiles).toBe(false);
    const objective = (LANGUAGE_DATA.agent as NonNullable<typeof LANGUAGE_DATA.agent>).text.investigation
      .objective as string;
    const run = await drive(
      connectionOf(LANG),
      "planning",
      "investigation",
      [answersProse("No plan."), answersProse("No plan.")],
      undefined,
      LANGUAGE_DATA.name,
    );

    expect(run.thrown).toBeUndefined();
    expect(run.outcome?.kind).toBe("finished");
    expect(finishedOf(run.events)).toMatchObject({ status: "succeeded" });
    // The first model turn's system prompt states the declared investigation objective.
    expect(JSON.stringify(run.turns[0]?.body)).toContain(objective);
    expect(run.events.find((event) => event.kind === "context-captured")).toMatchObject({
      tableCount: 2,
      snapshot: { readVia: "provider-inventory" },
    });
    expect(seen.filter((call) => call === "open")).toEqual(["open"]);
    expect(inspected).not.toHaveBeenCalled();
    expect(built).not.toHaveBeenCalled();
    expect(recorded).not.toHaveBeenCalled();
    expect(acquired).not.toHaveBeenCalled();
  });

  test("an agent-mode run in a package's own declared language is driven from its ledger, grounds and sends its statements through the package's read-only statement session", async () => {
    const budgets = AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets;
    const opens: OpenContext[] = [];
    const executes: ExecuteRequest[] = [];
    /** One row under one column, answered for every execute. */
    const answered = () =>
      Promise.resolve({
        results: [
          {
            columns: [{ name: "topic" }],
            next: () => Promise.resolve({ rows: [["orders"]], done: true }),
            close: () => Promise.resolve(),
          },
        ],
        warnings: [],
        executionTimeMs: 1,
        pageApplied: false,
      });
    const seen = hooksFor(LANG, {
      open: (ctx) => {
        opens.push(ctx);
        return Promise.resolve({ handle: { session: randomUUID() } });
      },
      execute: (request) => {
        executes.push(request);
        return answered();
      },
    });
    const run = await drive(
      connectionOf(LANG),
      "agent",
      "investigation",
      [
        callsTool("run_read_query", { statement: '{"read":"topics"}' }, "call_read"),
        reportCitingWhatWasOffered("The engine holds one topic."),
      ],
      undefined,
      LANGUAGE_DATA.name,
    );

    expect(run.thrown).toBeUndefined();
    expect(run.outcome?.kind).toBe("finished");
    expect(finishedOf(run.events)).toMatchObject({ status: "succeeded" });
    // One read-only statement session, opened once through the package, for the walk and the statement alike.
    expect(seen.filter((call) => call === "open")).toEqual(["open"]);
    expect(opens.map(({ policy }) => policy)).toEqual([
      expect.objectContaining({ readOnly: true, sendsStatements: true }),
    ]);
    expect(run.events.find((event) => event.kind === "context-captured")).toMatchObject({
      tableCount: 2,
      snapshot: { readVia: "provider-inventory" },
    });
    // The statement reaches the package as admitted, under the investigation's budget, one row past it as its page.
    expect(executes).toEqual([
      {
        statement: '{"read":"topics"}',
        page: { limit: budgets.maxResultRows + 1, offset: 0 },
        readOnly: { budget: { maxRows: budgets.maxResultRows, maxBytes: budgets.maxResultBytes } },
      },
    ]);
    expect(run.events).toContainEqual(
      expect.objectContaining({
        kind: "tool-completed",
        artifact: expect.objectContaining({ operationId: "acmeread.query.read" }),
      }),
    );
    for (const recorder of [acquired, inspected, built, recorded]) expect(recorder).not.toHaveBeenCalled();

    // A package's failure of the statement is a repairable statement failure in Studio's sentence, its words in the
    // log only; the run repairs it with a differently written request and reports.
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      const marker = randomUUID();
      let calls = 0;
      hooksFor(LANG, {
        execute: () => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error(`the read lost ${marker}`)) : answered();
        },
      });
      const repaired = await drive(
        connectionOf(LANG),
        "agent",
        "investigation",
        [
          callsTool("run_read_query", { statement: '{"read":"topics"}' }, "call_read"),
          callsTool("run_read_query", { statement: '{"read":"topics","limit":1}' }, "call_again"),
          reportCitingWhatWasOffered("The engine holds one topic."),
        ],
        undefined,
        LANGUAGE_DATA.name,
      );
      expect(repaired.thrown).toBeUndefined();
      expect(finishedOf(repaired.events)).toMatchObject({ status: "succeeded" });
      expect(calls).toBe(2);
      const told = transcriptOf(repaired.turns);
      expect(told).toContain(
        `The provider package's execute failed (${ApiErrorCode.INTERNAL_ERROR}); the server's log holds its words.`,
      );
      expect(told).not.toContain(marker);
      expect(JSON.stringify(repaired.events)).not.toContain(marker);
      expect(linesOf(error, "A provider package's execute failed")).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  test("a run recorded with a database on an engine whose record offers no catalog session no longer resolves, refused by name before anything opens", async () => {
    const seen = hooksFor(READS);
    const on = connectionOf(READS);
    const run = await drive(on, "planning", "investigation", [answersProse("No plan.")], "shop");

    expect(run.outcome).toBeUndefined();
    expect(run.thrown).toBeInstanceOf(SeedConnectionError);
    expect((run.thrown as SeedConnectionError).statusCode).toBe(409);
    expect((run.thrown as Error).message).toBe(
      `This run reads the database "shop" of connection "${on.id}", and its engine, ${servedEngineRecord(READS).displayName}, offers no catalog session in this LibreDB Studio, so the run's connection no longer resolves.`,
    );
    expect(finishedOf(run.events)).toMatchObject({ status: "failed", reason: "connection-unresolvable" });
    expect(createAgentModel).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    expect(acquired).not.toHaveBeenCalled();
  });

  test("the operations workflow reads a package engine's granted readings through its package, and refuses every other by name", async () => {
    const seen = hooksFor(READS);
    const run = await drive(connectionOf(READS), "agent", "operations", [
      callsTool("inspect_operations", { kind: "health" }, "call_health"),
      callsTool("inspect_operations", { kind: "sessions" }, "call_sessions"),
      reportOnAll("The engine answers three connections."),
    ]);

    expect(run.thrown).toBeUndefined();
    // The health reading is answered by the package's health call and stored as an artifact of one row.
    expect(seen.filter((call) => call === "health")).toEqual(["health"]);
    expect(run.events).toContainEqual(
      expect.objectContaining({
        kind: "tool-completed",
        artifact: expect.objectContaining({
          operationId: "db.operations.read",
          summary: expect.objectContaining({
            rowCount: 1,
            columnNames: ["activeConnections", "databaseSize", "cacheHitRatio"],
          }),
        }),
      }),
    );
    // A reading the record does not grant is refused by name, naming the engine by its record.
    expect(transcriptOf(run.turns)).toContain(
      `"sessions" is not a reading the ${servedEngineRecord(READS).displayName} connection offers agent mode; it offers health.`,
    );
    // One metadata session, opened once through the package, for the walk and the reading alike; no legacy acquisition.
    expect(seen.filter((call) => call === "open")).toEqual(["open"]);
    expect(acquired).not.toHaveBeenCalled();
  });

  test("a package engine's reading failure is answered by its record and logged once, and an agent credential is refused by name before its package opens", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      // A code-only row: Studio's sentence reaches the run, the package's words only the log, once, even words that
      // carry the connection's password.
      const marker = randomUUID();
      const coded = connectionOf(READS);
      hooksFor(READS, {
        health: () => Promise.reject(new Error(`the health probe lost ${marker} as ${coded.password as string}`)),
      });
      const refused = await drive(coded, "agent", "operations", [
        callsTool("inspect_operations", { kind: "health" }, "call_health"),
        answersProse("No report."),
      ]);
      const told = transcriptOf(refused.turns);
      expect(told).toContain(
        `The provider package's health failed (${ApiErrorCode.INTERNAL_ERROR}); the server's log holds its words.`,
      );
      for (const words of [marker, coded.password as string]) {
        expect(told).not.toContain(words);
        expect(JSON.stringify(refused.events)).not.toContain(words);
      }
      expect(linesOf(error, "A provider package's health failed")).toHaveLength(1);
      expect(linesOf(error, "A provider package's health failed")[0]?.[2]).toEqual({
        route: "agent/inspect_operations",
      });

      // A row granting its words: the package's own sentence reaches the run, through the scrub of its connection.
      error.mockClear();
      const own = randomUUID();
      const words = connectionOf(WORDS);
      hooksFor(WORDS, { health: () => Promise.reject(new Error(`the health probe lost ${own}`)) });
      const granted = await drive(words, "agent", "operations", [
        callsTool("inspect_operations", { kind: "health" }, "call_health"),
        answersProse("No report."),
      ]);
      expect(transcriptOf(granted.turns)).toContain(own);
      expect(linesOf(error, "A provider package's health failed")).toHaveLength(1);

      // The same row, its words carrying the connection's password: the run is told the scrubbed form, never the
      // password, and the package's failure is logged once.
      error.mockClear();
      const leaked = randomUUID();
      const leaking = connectionOf(WORDS);
      hooksFor(WORDS, {
        health: () => Promise.reject(new Error(`the health probe lost ${leaked} as ${leaking.password as string}`)),
      });
      const scrubbed = await drive(leaking, "agent", "operations", [
        callsTool("inspect_operations", { kind: "health" }, "call_health"),
        answersProse("No report."),
      ]);
      const heard = transcriptOf(scrubbed.turns);
      expect(heard).toContain(PROVIDER_TEXT_WITHHELD);
      for (const words of [leaked, leaking.password as string]) {
        expect(heard).not.toContain(words);
        expect(JSON.stringify(scrubbed.events)).not.toContain(words);
      }
      expect(linesOf(error, "A provider package's health failed")).toHaveLength(1);

      // The package's open fails: the reading is answered by the record as a failed open, before its call is sent, and
      // logged under the reading's route, as the walk's open before it is under the walk's.
      error.mockClear();
      const signIn = randomUUID();
      const failing = hooksFor(READS, {
        open: () => Promise.reject(new Error(`the package could not sign in ${signIn}`)),
      });
      const unopened = await drive(connectionOf(READS), "agent", "operations", [
        callsTool("inspect_operations", { kind: "health" }, "call_health"),
        answersProse("No report."),
      ]);
      expect(failing.filter((call) => call === "health")).toEqual([]);
      // A failed open is the environment's, as a legacy reading's acquisition that cannot connect is: the drive ends.
      const failed = unopened.outcome?.kind === "failed" ? unopened.outcome.error : undefined;
      expect(failed).toBeInstanceOf(ConnectionError);
      expect((failed as Error).message).toStartWith("The provider package's open failed (");
      expect((failed as Error).message).not.toContain(signIn);
      expect(JSON.stringify(unopened.events)).not.toContain(signIn);
      expect(transcriptOf(unopened.turns)).not.toContain(signIn);
      const readingOpens = linesOf(error, "A provider package's open failed").filter(
        ([, , context]) => (context as { route?: unknown } | undefined)?.route === "agent/inspect_operations",
      );
      expect(readingOpens).toHaveLength(1);

      // An agent credential: refused by name before the package opens, for the walk and the reading alike.
      const seen = hooksFor(READS);
      const credentialed = connectionOf(READS, { agentUser: `agent-${randomUUID()}`, agentPassword: randomUUID() });
      const run = await drive(credentialed, "agent", "operations", [
        callsTool("inspect_operations", { kind: "health" }, "call_health"),
        answersProse("No report."),
      ]);
      expect(seen).toEqual([]);
      expect(acquired).not.toHaveBeenCalled();
      expect(run.events).toContainEqual(
        expect.objectContaining({ kind: "context-unavailable", profileReasonCode: "AGENT_CREDENTIAL_NOT_TAKEN" }),
      );
      expect(finishedOf(run.events)).toMatchObject({ status: "failed", reason: "agent-credential-unusable" });
    } finally {
      error.mockRestore();
    }
  });
});
