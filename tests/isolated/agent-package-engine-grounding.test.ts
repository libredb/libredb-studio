/**
 * An agent run's grounding on an engine an admitted provider package serves: the run's context is built as the drive
 * builds it (`agentEngineDeclarations` for its engine facts, `sessions.metadataTree` over the real `metadataTreeTarget`
 * for its tree), and the grounding walk reads the package's objects through the host core's tree facade on the
 * record's metadata session, opened once through the package's own `open` in the provider factory's real metadata
 * cache. The run's acquirer, which opens a legacy provider only, fails the case if called. A sentence the package wrote
 * reaches the run only as its record grants the package its words; a failure of its open or of its tree read is answered
 * by the record and logged once; a Studio error is Studio's own; and an agent credential or a grounding under the
 * execution profile is refused by name before the package opens.
 *
 * The packages are written into a scratch providers directory and admitted by Studio's boot admission
 * (tests/helpers/package-session-fixture.ts), each function calling the hook a case sets; the ledger is a local world in
 * a scratch directory and the model a scripted transport (tests/isolated/fixtures/agent-scripted-model.ts). Paths are
 * built with `path.join`, no file mode, link or line ending is read, and no case awaits a timer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TreeRequest } from "@libredb/provider-sdk/calls";
import type { ObjectModel } from "@libredb/provider-sdk/manifest";
import { createLocalWorld } from "@workflow/world-local";
import { persistedRunFacts, workflowAvailability } from "@/lib/agent/agent-manifest";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { agentEngineDeclarations } from "@/lib/agent/engine-view";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { type AgentToolResources, runInvestigation } from "@/lib/agent/investigation";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import type { AgentRunEvent, AgentRunMode, AgentRunWorkflowType } from "@/lib/agent/types";
import { metadataTreeTarget } from "@/lib/api/editor-provider";
import { StudioProfileRefusal } from "@/lib/db/errors";
import { clearProviderCache } from "@/lib/db/factory";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { PACKAGE_SENTENCE_WITHHELD } from "@/lib/db/operations/provider-text";
import { type EngineConnection, forgetServerCatalog, servedEngineRecord } from "@/lib/db/server-catalog";
import { logger } from "@/lib/logger";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import type { QueryResult } from "@/lib/types";
import type { EditableEngine } from "../helpers/package-catalog";
import { admitSessionPackages, setHooks } from "../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../helpers/provider-artifacts";
import { answersProse, modelOver, promptText, scriptedModel } from "./fixtures/agent-scripted-model";

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

/** A package offering the tree, whose row grants no words; one whose row grants its words; one offering no tree. */
const TREE = "acmeagenttree";
const WORDS = "acmeagentwords";
const BARE = "acmeagentbare";
const withModel = (engine: EditableEngine) => {
  (engine as Record<string, unknown>).objects = structuredClone(TREE_MODEL);
};
/** A row that opens the engine for a caller whose file access is denied, the run's actor being no administrator. */
const ROW = { deniedFileAccessRefusal: null } as const;
const providers = scratchDirectory("studio-agent-package-grounding-");
const dataDirs: string[] = [];

beforeAll(async () => {
  installHostCore(createHostCore(), "test");
  await admitSessionPackages(
    providers,
    [
      { name: "acme-agent-tree", engine: TREE, offered: ["objects.tree"], edit: withModel },
      { name: "acme-agent-words", engine: WORDS, offered: ["objects.tree"], edit: withModel },
      // States a model and offers no tree: its session answers no tree read.
      { name: "acme-agent-bare", engine: BARE, edit: withModel },
    ],
    { [TREE]: ROW, [WORDS]: { ...ROW, ownWords: "scrubbed" }, [BARE]: ROW },
  );
});

afterEach(async () => {
  forgetHeldSnapshots();
  await clearProviderCache();
});

afterAll(async () => {
  await clearProviderCache();
  forgetServerCatalog();
  forgetHostCore();
  removeScratch(providers);
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** The answer a tree hook gives each action unless a case gives its own: two collections in one folder. */
function answerOf(request: TreeRequest): unknown {
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

/** Hooks for `engine`'s package that open a fresh handle, close, and answer each tree request with `tree`. */
function hooksFor(
  engine: string,
  options: { open?: () => Promise<unknown>; tree?: (request: TreeRequest) => Promise<unknown> } = {},
): Seen {
  const seen: Seen = [];
  setHooks(engine, {
    open: (...args: unknown[]) => {
      seen.push("open");
      return (options.open ?? (() => Promise.resolve({ handle: { session: randomUUID() } })))(...(args as []));
    },
    close: () => Promise.resolve(),
    tree: (_handle: unknown, request: unknown) => {
      seen.push("tree");
      return (options.tree ?? ((asked: TreeRequest) => Promise.resolve(answerOf(asked))))(request as TreeRequest);
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
    host: "tree.local",
    password: randomUUID(),
    createdAt: new Date(0),
    ...agent,
  };
}

/** A run of `connection` opened on a fresh ledger, and the resources the drive builds for it. */
async function openRun(
  connection: EngineConnection,
  mode: AgentRunMode,
  workflowType: AgentRunWorkflowType,
  facts: { readonly statementLanguage?: "mongo" } = {},
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-package-grounding-"));
  dataDirs.push(dataDir);
  const store = new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }) });
  const tracker = new ExecutionBudgetTracker();
  const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 });
  const service = new AgentRunService({ store, resources: { tracker, artifacts } });
  const engine = servedEngineRecord(connection.type);
  const base = {
    mode,
    workflowType,
    actor: { sessionId: "sess_1", role: "user" as const },
    connectionId: connection.id,
  };
  let started: { readonly runId: string };
  if (facts.statementLanguage === undefined) {
    const availability = workflowAvailability(mode, workflowType, engine);
    if (!availability.open) throw new Error(`a ${mode} ${workflowType} run does not open on ${connection.type}`);
    started = await service.start({
      ...base,
      ...persistedRunFacts(mode, workflowType, connection.type, availability),
      objective: "Which collections hold the orders?",
    });
  } else {
    // A run recorded with a statement language of its own, which no entry point opens on a package engine yet: the
    // drive's grounding is what refuses it.
    started = await service.start({
      ...base,
      engine: connection.type,
      statementLanguage: facts.statementLanguage,
      objective: "Which collections hold the orders?",
    });
  }
  const { capabilities, labels } = await agentEngineDeclarations(engine, connection, {});
  const acquireProvider = mock(async () => {
    throw new Error(
      "the run's acquirer opens a legacy provider only, and this run is a package engine's: a test defect",
    );
  });
  const resources: AgentToolResources = {
    connection,
    capabilities,
    labels,
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(connection.id),
    tracker,
    artifacts,
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS[workflowType].runDeadlineMs, () => 10_000),
    repairs: new AgentRepairLedger(),
    sessions: { metadataTree: () => metadataTreeTarget({ role: "user" }, connection, engine) },
    acquireProvider,
  };
  return { store, service, runId: started.runId, resources, acquireProvider };
}

async function eventsOf(store: AgentRunStore, runId: string): Promise<readonly AgentRunEvent[]> {
  const view = await store.read(runId);
  if (!view) throw new Error(`run ${runId} has no ledger`);
  return view.record.events;
}

/** A plan-mode investigation of `connection` driven to its end: its events and the prompts the model was sent. */
async function planRun(connection: EngineConnection, closing = "No plan.") {
  const run = await openRun(connection, "planning", "investigation");
  const script = scriptedModel(answersProse(closing), answersProse(closing));
  await runInvestigation(run.runId, {
    service: run.service,
    model: await modelOver(script.fetch),
    resources: run.resources,
  });
  return { ...run, events: await eventsOf(run.store, run.runId), turns: script.turns };
}

/** The calls of a logger spy whose line is `line`. */
function linesOf(spy: { readonly mock: { readonly calls: readonly unknown[][] } }, line: string): unknown[][] {
  return spy.mock.calls.filter(([logged]) => logged === line);
}

describe("an agent run's grounding on a provider package's engine", () => {
  test("a plan-mode run on a package engine grounds through its package's metadata session and answers", async () => {
    const seen = hooksFor(TREE);
    const closing = "Read the orders collection.\n\n```sql\nSELECT * FROM main.orders\n```";
    const run = await planRun(connectionOf(TREE), closing);

    const captured = run.events.find((event) => event.kind === "context-captured");
    expect(captured).toMatchObject({
      kind: "context-captured",
      tableCount: 2,
      snapshot: {
        readVia: "provider-inventory",
        defaultContainer: ["main"],
        objects: [
          { path: ["main", "orders"], name: "main.orders", kind: "collection" },
          { path: ["main", "users"], name: "main.users", kind: "collection" },
        ],
      },
    });
    // One open, through the package, on the metadata session; the acquirer is never asked.
    expect(seen.filter((call) => call === "open")).toEqual(["open"]);
    expect(run.acquireProvider).not.toHaveBeenCalled();
    // The run's prose names the rows by the package's own noun.
    expect(promptText(run.turns[0] as never)).toContain("2 collection(s)");
    // The closing statement is drafted for the engine by its id.
    expect(run.events.find((event) => event.kind === "plan-statement-drafted")).toMatchObject({
      sql: "SELECT * FROM main.orders",
      dialect: TREE,
    });
    expect(run.events.at(-1)).toMatchObject({ kind: "run-finished", status: "succeeded" });
  });

  test("a package's sentence in a grounding answer reaches the run by its record's grant of its own words", async () => {
    for (const engine of [TREE, WORDS]) {
      const own = `the count was sampled ${randomUUID()}`;
      hooksFor(engine, {
        tree: (request) =>
          Promise.resolve(
            request.action === "count" ? { counts: { collection: { count: 2, sampledFrom: own } } } : answerOf(request),
          ),
      });
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        // oxlint-disable-next-line no-await-in-loop -- one engine at a time, so each case's log spy reads only its run.
        const run = await planRun(connectionOf(engine));
        const granted = engine === WORDS;
        const captured = run.events.find((event) => event.kind === "context-captured");
        expect(captured).toMatchObject({
          snapshot: { kinds: [{ id: "collection", sampledFrom: granted ? own : PACKAGE_SENTENCE_WITHHELD }] },
        });
        expect(linesOf(warn, "A provider package's answer gave a reason").map(([, payload]) => payload)).toEqual(
          granted ? [] : [{ route: "agent/object-inventory", reason: own }],
        );
        if (!granted) expect(run.turns.map((turn) => promptText(turn as never)).join("\n")).not.toContain(own);
      } finally {
        warn.mockRestore();
      }
    }
  });

  test("a package's open or tree failure in the grounding walk is answered by its record and logged once", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      // The open fails in the package's words: an unavailable capture in Studio's words, and the plan run goes on.
      const opened = `the package could not sign in ${randomUUID()}`;
      const seen = hooksFor(TREE, { open: () => Promise.reject(new Error(opened)) });
      const refused = await planRun(connectionOf(TREE));
      expect(seen).toEqual(["open"]);
      const unavailable = refused.events.find((event) => event.kind === "context-unavailable");
      expect(unavailable).toMatchObject({ reasonCode: "CATALOG_READ_REFUSED" });
      expect(JSON.stringify(refused.events)).not.toContain(opened);
      expect(refused.turns.length).toBeGreaterThan(0);
      expect(refused.turns.map((turn) => promptText(turn as never)).join("\n")).not.toContain(opened);
      expect(linesOf(error, "A provider package's open failed")).toHaveLength(1);

      // The tree read fails in the package's words, under no grant of its words: Studio's sentence reaches the run.
      error.mockClear();
      const read = `the folder is gone ${randomUUID()}`;
      hooksFor(TREE, { tree: () => Promise.reject(new Error(read)) });
      const failed = await planRun(connectionOf(TREE));
      const unread = failed.events.find((event) => event.kind === "context-unavailable");
      expect(unread).toMatchObject({ reasonCode: "CATALOG_READ_REFUSED" });
      expect((unread as { detail: string }).detail).toMatch(
        /The provider package's tree read failed \(.+\); the server's log holds its words\./,
      );
      expect(JSON.stringify(failed.events)).not.toContain(read);
      expect(failed.turns.map((turn) => promptText(turn as never)).join("\n")).not.toContain(read);
      expect(linesOf(error, "A provider package's tree read failed")).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  test("a Studio error in the grounding walk on a package engine is Studio's own, never the package's", async () => {
    // A session whose package offers no tree: Studio refuses the tree before any read, after the package's open.
    const seen = hooksFor(BARE);
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      const run = await planRun(connectionOf(BARE));
      expect(seen).toEqual(["open"]);
      expect(run.events.find((event) => event.kind === "context-unavailable")).toMatchObject({
        reasonCode: "CATALOG_READ_REFUSED",
      });
      expect(error.mock.calls.filter(([line]) => String(line).startsWith("A provider package's"))).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  test("a package engine's connection that carries an agent credential is refused by name before its package opens", async () => {
    const seen = hooksFor(TREE);
    const connection = connectionOf(TREE, { agentUser: `agent-${randomUUID()}`, agentPassword: randomUUID() });
    const run = await planRun(connection);
    expect(seen).toEqual([]);
    expect(run.acquireProvider).not.toHaveBeenCalled();
    const unavailable = run.events.find((event) => event.kind === "context-unavailable");
    expect(unavailable).toMatchObject({
      reasonCode: "CATALOG_READ_REFUSED",
      profileReasonCode: "AGENT_CREDENTIAL_NOT_TAKEN",
    });
    expect((unavailable as { detail: string }).detail).toContain(
      "The connection configures an agent credential, and its engine's session opens through its provider package with the connection's own credential, so the agent credential cannot be applied and nothing was read.",
    );
    // A plan run goes on ungrounded.
    expect(run.turns.length).toBeGreaterThan(0);
  });

  test("a grounding under the execution profile on a package engine is refused by name before its package opens", async () => {
    const seen = hooksFor(TREE);
    const connection = connectionOf(TREE);
    const run = await openRun(connection, "agent", "investigation", { statementLanguage: "mongo" });
    const script = scriptedModel(answersProse("No report."));
    const driven = await runInvestigation(run.runId, {
      service: run.service,
      model: await modelOver(script.fetch),
      resources: run.resources,
    }).catch((error: unknown) => error);
    expect(driven).toBeInstanceOf(StudioProfileRefusal);
    expect((driven as StudioProfileRefusal).reasonCode).toBe("PROFILE_UNSUPPORTED_BY_PROVIDER");
    expect((driven as Error).message).toBe(
      "Agent mode opens no execution profile on an engine served by a provider package: its session opens through its package, and Studio opens no read-only statement session through a package yet.",
    );
    expect(seen).toEqual([]);
    expect(run.acquireProvider).not.toHaveBeenCalled();
    // Ended before its first model turn.
    expect(script.turns).toEqual([]);
    expect(await eventsOf(run.store, run.runId)).toContainEqual(
      expect.objectContaining({ kind: "context-unavailable", profileReasonCode: "PROFILE_UNSUPPORTED_BY_PROVIDER" }),
    );
  });
});
