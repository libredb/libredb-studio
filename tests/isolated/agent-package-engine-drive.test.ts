/**
 * An agent run on an engine an admitted provider package serves, driven from its ledger by the composition root
 * (`driveAgentRunOutcome` in src/lib/agent/runtime.ts): the drive resolves the run's connection through the served
 * resolve under the run's persisted actor, grounds a plan-mode run through the package's metadata session, refuses by
 * name before its first model turn an agent-mode run whose workflow sends statements and a run recorded with a database
 * its engine offers no catalog session for.
 *
 * The packages are written into a scratch providers directory and admitted by Studio's boot admission
 * (tests/helpers/package-session-fixture.ts), each function calling the hook a case sets; the ledger is a local world in
 * a scratch directory, the model a scripted transport (tests/isolated/fixtures/agent-scripted-model.ts), and the run's
 * connection the one a case sets. Each replaced module spreads the real module captured before its replacement, and
 * each recorder calls the captured function. Paths are built with `path.join`, no file mode, link or line ending is
 * read, and no case awaits a timer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TreeRequest } from "@libredb/provider-sdk/calls";
import type { ObjectModel } from "@libredb/provider-sdk/manifest";
import { createLocalWorld } from "@workflow/world-local";
import { statementSessionRefusal } from "@/lib/agent/agent-manifest";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import type { AgentModel } from "@/lib/agent/model-adapter";
import type { AgentRunEvent, AgentRunMode, AgentRunWorkflowType } from "@/lib/agent/types";
import { StudioProfileRefusal } from "@/lib/db/errors";
import { type EngineConnection, servedEngineRecord } from "@/lib/db/server-catalog";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import { configureAgentModel, restoreAgentModel } from "../helpers/agent-model-env";
import { type EditableEngine, withLoosestClaims } from "../helpers/package-catalog";
import { admitSessionPackages, setHooks } from "../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../helpers/provider-artifacts";
import { servedResolveOver } from "../helpers/served-resolve";
import {
  answersProse,
  callsTool,
  modelOver,
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
 * A package whose row grants the health reading; one with no register row; and one whose row grants `sql` and agent
 * execution and reviews no grammar (its manifest states SQL text, its row no digest).
 */
const READS = "acmedrivereads";
const BARE = "acmedrivebare";
const EXEC = "acmedriveexec";
const withModel = (engine: EditableEngine) => {
  (engine as Record<string, unknown>).objects = structuredClone(TREE_MODEL);
};
/** The tree model and a request of the health reading. */
const withModelAndHealth = (engine: EditableEngine) => {
  withModel(engine);
  engine.facets = { ...engine.facets, agentReadings: ["health"] };
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
      { name: "acme-drive-reads", engine: READS, offered: ["objects.tree"], edit: withModelAndHealth },
      { name: "acme-drive-bare", engine: BARE, offered: ["objects.tree"], edit: withModel },
      { name: "acme-drive-exec", engine: EXEC, offered: ["objects.tree", "monitoring.panel"], edit: withLoosestClaims },
    ],
    {
      [READS]: HEALTH,
      [EXEC]: { ...OPEN, statementLanguage: "sql", agentExecution: true },
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

/** Hooks for `engine`'s package: a fresh handle per open, and the two-collection tree. */
function hooksFor(engine: string): Seen {
  const seen: Seen = [];
  setHooks(engine, {
    open: () => {
      seen.push("open");
      return Promise.resolve({ handle: { session: randomUUID() } });
    },
    close: () => Promise.resolve(),
    tree: (_handle: unknown, request: unknown) => {
      seen.push("tree");
      return Promise.resolve(treeAnswer(request as TreeRequest));
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
 * A run planted in the ledger as the start route would record it on `on`, with the engine's id and `catalog` where
 * one is named, then driven from its ledger by the composition root with `turns` as its model.
 */
async function drive(
  on: EngineConnection,
  mode: AgentRunMode,
  workflowType: AgentRunWorkflowType,
  turns: readonly ScriptedTurn[],
  catalog?: string,
): Promise<Driven> {
  const service = await getAgentRunService();
  const { runId } = await service.start({
    mode,
    workflowType,
    engine: on.type,
    actor: { sessionId: "sess_1", role: "user" },
    connectionId: on.id,
    ...(catalog === undefined ? {} : { catalog }),
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

  test("an agent-mode run whose workflow sends statements on a package engine is refused by name before its first model turn, and its package never opens", async () => {
    for (const engine of [BARE, EXEC]) {
      const seen = hooksFor(engine);
      // oxlint-disable-next-line no-await-in-loop -- one drive at a time, each reading the recorders the one before cleared.
      const run = await drive(connectionOf(engine), "agent", "investigation", [answersProse("No report.")]);

      expect(run.outcome?.kind, engine).toBe("failed");
      const error = run.outcome?.kind === "failed" ? run.outcome.error : undefined;
      expect(error, engine).toBeInstanceOf(StudioProfileRefusal);
      expect((error as StudioProfileRefusal).reasonCode, engine).toBe("PROFILE_UNSUPPORTED_BY_PROVIDER");
      expect((error as Error).message, engine).toBe(statementSessionRefusal(servedEngineRecord(engine).displayName));
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

  test("a package engine whose row reviews no grammar reaches neither the fence nor a query event while agent mode sends it no statement", async () => {
    const record = servedEngineRecord(EXEC);
    // Vacuity: the row grants the language and agent execution, and reviews no grammar.
    expect(record.grants).toMatchObject({ statementLanguage: "sql", agentExecution: true, reviewedGrammar: false });
    expect(record.offers.executionProfiles).toBe(false);
    const seen = hooksFor(EXEC);
    const select = callsTool("run_read_query", { sql: "SELECT * FROM main.orders" }, "call_read");
    for (const workflowType of [
      "investigation",
      "query-optimization",
      "database-assessment",
      "data-analysis",
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one drive at a time.
      const run = await drive(connectionOf(EXEC), "agent", workflowType, [select, answersProse("No report.")]);
      expect(run.outcome?.kind, workflowType).toBe("failed");
      expect(finishedOf(run.events), workflowType).toMatchObject({ status: "failed", reason: "engine-unsupported" });
      expect(run.turns, workflowType).toEqual([]);
    }
    expect(inspected).not.toHaveBeenCalled();
    expect(built).not.toHaveBeenCalled();
    expect(recorded).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
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
});
