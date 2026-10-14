/**
 * The agent's grounding walk over a provider's object surface: the kinds whose names it withholds, the containers
 * a scoped walk leaves out or cannot list, and a listing its provider capped, each as the walk records it and as both
 * packers tell a run.
 *
 * The provider is a stub answering the four object methods, so each rule is pinned apart from any engine.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  AGENT_CONTEXT_PACK_MAX_CHARS,
  captureContextSnapshot,
  fingerprintInventory,
  packContextForTask,
  packOperationsInventory,
} from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import type { AgentToolContext } from "@/lib/agent/tools";
import type { AgentContextSnapshot, AgentInventory } from "@/lib/agent/types";
import { QueryError } from "@/lib/db/errors";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type {
  Container,
  DatabaseObject,
  DatabaseProvider,
  KindCount,
  ObjectKindSpec,
  ProviderCapabilities,
} from "@/lib/db/types";
import type { QueryResult } from "@/lib/types";
import { TABLE_LABELS } from "../../../fixtures/provider-labels";

const frozenClock = () => 1_000;

const BASE: ProviderCapabilities = {
  queryLanguage: "json",
  supportsExplain: false,
  supportsExternalQueryLimiting: false,
  supportsCreateTable: false,
  supportsInlineRowEdit: false,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: false,
  defaultPort: null,
  schemaRefreshPattern: "manual",
  containerLevels: [{ id: "schema", label: "Namespace", labelPlural: "Namespaces" }],
};

const POD: ObjectKindSpec = { id: "pods", role: "config", label: "Pod", labelPlural: "Pods" };
const SECRET: ObjectKindSpec = {
  id: "secrets",
  role: "config",
  label: "Secret",
  labelPlural: "Secrets",
  machineNames: "withheld",
};

/** A planted Secret name: it must reach no part of the capture and no packing. */
const SECRET_NAME = "secret/db-password-marker";

interface Stub {
  readonly kinds?: readonly ObjectKindSpec[];
  /** Further capability declarations, such as a walk scope. */
  readonly extra?: Partial<ProviderCapabilities>;
  readonly containers?: readonly Container[];
  /** A tree of more than one level: the containers under a parent, the root's where none is given. */
  readonly containersUnder?: (parent?: readonly string[]) => readonly Container[];
  readonly counts?: (container: readonly string[]) => Record<string, KindCount>;
  readonly objects?: (container: readonly string[], kind: string) => readonly DatabaseObject[];
}

function stub(options: Stub = {}) {
  const listObjects = mock(
    async (container: readonly string[], kind: string) =>
      options.objects?.(container, kind) ?? [
        kind === "secrets"
          ? { path: [...container, SECRET_NAME], name: SECRET_NAME, kind }
          : { path: [...container, "pod/web"], name: "pod/web", kind },
      ],
  );
  const countObjects = mock(
    async (container: readonly string[]) =>
      options.counts?.(container) ?? { pods: { count: 1 }, secrets: { count: 2 } },
  );
  const listContainers = mock(
    async (parent?: readonly string[]) =>
      options.containersUnder?.(parent) ??
      options.containers ?? [
        { path: ["default"], name: "default", level: 0, isSessionDefault: true },
        { path: ["shop"], name: "shop", level: 0 },
      ],
  );
  const describeObjects = mock(async (_container: readonly string[], _kind: string) => ({ details: [] }));
  const provider = { listObjects, countObjects, listContainers, describeObjects } as unknown as DatabaseProvider;
  const context: AgentToolContext = {
    runId: "run-1",
    modelId: "unmeasured-model-for-tests",
    mode: "planning",
    workflowType: "investigation",
    actor: { sessionId: "session-1", role: "user" },
    connection: { id: "conn-1", name: "Cluster", type: "mongodb", createdAt: new Date(0) },
    capabilities: {
      ...BASE,
      objectKinds: options.kinds ?? [POD, SECRET],
      ...options.extra,
    },
    labels: TABLE_LABELS,
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope("conn-1"),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2, frozenClock),
    repairs: new AgentRepairLedger(),
    acquireProvider: mock(async () => provider),
    clock: frozenClock,
  };
  return { context, listObjects, countObjects, listContainers, describeObjects };
}

async function captured(
  options: Stub = {},
): Promise<{ snapshot: AgentContextSnapshot; harness: ReturnType<typeof stub> }> {
  const harness = stub(options);
  const capture = await captureContextSnapshot(harness.context);
  if (capture.kind !== "captured") throw new Error(`expected a capture, got ${capture.kind}`);
  return { snapshot: capture.snapshot, harness };
}

const packings = (snapshot: AgentContextSnapshot): readonly string[] => [
  packContextForTask(snapshot, "why do pods restart"),
  packOperationsInventory(snapshot),
];

describe("a kind whose names are withheld", () => {
  test("is counted and never listed, and its names reach neither the capture nor either packing", async () => {
    const { snapshot, harness } = await captured();

    expect(harness.listObjects.mock.calls.map((call) => call[1])).toEqual(["pods", "pods"]);
    expect(snapshot.kinds?.find((kind) => kind.id === "secrets")?.withheldCount).toBe(4);
    expect(snapshot.objects.every((object) => object.kind === "pods")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("db-password-marker");
    for (const packed of packings(snapshot)) {
      expect(packed).not.toContain("db-password-marker");
      expect(packed).toContain(
        "The names of the Secrets are withheld from this inventory: this server counted 4 of them in what it read, and none is listed below.",
      );
    }
  });

  test("a refused count carries the provider's sentence and still lists nothing", async () => {
    const refusal = "Listing Secrets in default is forbidden for this identity";
    const { snapshot, harness } = await captured({
      containers: [{ path: ["default"], name: "default", level: 0, isSessionDefault: true }],
      counts: () => ({ pods: { count: 1 }, secrets: { unavailable: refusal } }),
    });

    expect(harness.listObjects.mock.calls.map((call) => call[1])).toEqual(["pods"]);
    const secrets = snapshot.kinds?.find((kind) => kind.id === "secrets");
    expect(secrets?.unavailable).toBe(refusal);
    expect(secrets?.withheldCount).toBeUndefined();
  });

  test("a sampled count is said as a floor", async () => {
    const { snapshot } = await captured({
      containers: [{ path: ["default"], name: "default", level: 0, isSessionDefault: true }],
      counts: () => ({ pods: { count: 1 }, secrets: { count: 7, sampledFrom: "one bounded page" } }),
    });

    for (const packed of packings(snapshot)) expect(packed).toContain("this server counted at least 7 of them");
  });

  test("a kind counted as none everywhere carries no count and no note", async () => {
    const { snapshot } = await captured({ counts: () => ({ pods: { count: 1 }, secrets: { count: 0 } }) });

    expect(snapshot.kinds?.find((kind) => kind.id === "secrets")?.withheldCount).toBeUndefined();
    for (const packed of packings(snapshot)) expect(packed).not.toContain("withheld");
  });

  test("a kind with no count is never listed, and the run is told its names are withheld and were not counted", async () => {
    const { snapshot, harness } = await captured({ counts: () => ({ pods: { count: 1 } }) });

    expect(harness.listObjects.mock.calls.map((call) => call[1])).toEqual(["pods", "pods"]);
    expect(JSON.stringify(snapshot)).not.toContain("db-password-marker");
    const secrets = snapshot.kinds?.find((kind) => kind.id === "secrets");
    expect(secrets?.withheldUncounted).toBe(true);
    expect(secrets?.withheldCount).toBeUndefined();
    for (const packed of packings(snapshot)) {
      expect(packed).toContain(
        "The names of the Secrets are withheld from this inventory and were not counted: none is listed below.",
      );
    }
  });

  test("a count in one container and none in another is said as a floor", async () => {
    const { snapshot } = await captured({
      counts: (container): Record<string, KindCount> =>
        container[0] === "default" ? { pods: { count: 1 }, secrets: { count: 3 } } : { pods: { count: 1 } },
    });

    for (const packed of packings(snapshot)) expect(packed).toContain("this server counted at least 3 of them");
  });

  test("a count in one container and a refusal in another is said as a floor beside the provider's sentence", async () => {
    const refusal = "Listing Secrets in shop is forbidden for this identity";
    const { snapshot } = await captured({
      counts: (container): Record<string, KindCount> =>
        container[0] === "default"
          ? { pods: { count: 1 }, secrets: { count: 3 } }
          : { pods: { count: 1 }, secrets: { unavailable: refusal } },
    });

    for (const packed of packings(snapshot)) {
      expect(packed).toContain(`The Secrets could not be read: ${refusal}.`);
      expect(packed).toContain("this server counted at least 3 of them");
    }
  });
});

describe("a listing its provider capped", () => {
  test("a sampled count over 1,000 listed objects is said as a floor in both packings, and the walk adds no bound of its own", async () => {
    const floor = "the first 1,000 objects of the folder";
    const { snapshot } = await captured({
      kinds: [POD],
      containers: [{ path: ["default"], name: "default", level: 0, isSessionDefault: true }],
      counts: () => ({ pods: { count: 1000, sampledFrom: floor } }),
      objects: (container, kind) =>
        Array.from({ length: 1000 }, (_unused, index) => ({
          path: [...container, `pod/web-${index}`],
          name: `pod/web-${index}`,
          kind,
        })),
    });

    expect(snapshot.objects).toHaveLength(1000);
    expect(snapshot.truncated).toBeUndefined();
    expect(snapshot.kinds?.[0]?.sampledFrom).toBe(floor);
    for (const packed of packings(snapshot)) {
      expect(packed).toContain(
        `The Pods below are at least what is shown and never a total: they were counted from ${floor}.`,
      );
    }
  });
});

describe("a scoped walk", () => {
  const containers: readonly Container[] = [
    { path: ["Cluster"], name: "Cluster", level: 0 },
    { path: ["default"], name: "default", level: 0, isSessionDefault: true },
    { path: ["shop"], name: "shop", level: 0 },
    { path: ["billing"], name: "billing", level: 0 },
  ];

  test("reads the session-default container and the ones the provider names, and says how many it did not", async () => {
    const { snapshot, harness } = await captured({
      kinds: [POD],
      containers,
      extra: { agentWalkScope: { mode: "session-default", alsoWalk: [["Cluster"]] } },
    });

    expect(harness.countObjects.mock.calls.map((call) => call[0])).toEqual([["Cluster"], ["default"]]);
    expect(snapshot.unreadContainers).toEqual({
      count: 2,
      label: "Namespace",
      labelPlural: "Namespaces",
      read: ["Cluster", "default"],
    });
    for (const packed of packings(snapshot)) {
      expect(packed).toContain(
        'Not read: 2 other Namespaces. This inventory covers only what it read in ("Cluster", "default"), so an object in any other Namespace is not listed below.',
      );
    }
  });

  test("a read that lists nothing still names the containers it read", async () => {
    const { snapshot } = await captured({
      containers: containers.slice(0, 3),
      counts: () => ({ pods: { count: 0 }, secrets: { count: 2 } }),
      extra: { agentWalkScope: { mode: "session-default", alsoWalk: [["Cluster"]] } },
    });

    expect(snapshot.objects).toEqual([]);
    for (const packed of packings(snapshot)) {
      expect(packed).toContain(
        'Not read: 1 other Namespace. This inventory covers only what it read in ("Cluster", "default"),',
      );
    }
  });

  test("the containers read are named, not counted under the level's label, since a named one may not be of it", async () => {
    const { snapshot } = await captured({
      kinds: [POD],
      containers: containers.slice(1, 3),
      extra: { agentWalkScope: { mode: "session-default" } },
    });

    for (const packed of packings(snapshot)) {
      expect(packed).toContain('This inventory covers only what it read in ("default"),');
      expect(packed).not.toContain("Namespace it read");
    }
  });

  test("one container left out is named in the singular", async () => {
    const { snapshot } = await captured({
      kinds: [POD],
      containers: containers.slice(0, 3),
      extra: { agentWalkScope: { mode: "session-default", alsoWalk: [["Cluster"]] } },
    });

    for (const packed of packings(snapshot)) expect(packed).toContain("Not read: 1 other Namespace.");
  });

  test("no scope reads every container and carries no note", async () => {
    const { snapshot, harness } = await captured({ kinds: [POD], containers });

    expect(harness.countObjects).toHaveBeenCalledTimes(4);
    expect(snapshot.unreadContainers).toBeUndefined();
    for (const packed of packings(snapshot)) expect(packed).not.toContain("Not read:");
  });

  test("a scope that keeps every container carries no note", async () => {
    const { snapshot } = await captured({
      kinds: [POD],
      containers: containers.slice(0, 2),
      extra: { agentWalkScope: { mode: "session-default", alsoWalk: [["Cluster"]] } },
    });

    expect(snapshot.unreadContainers).toBeUndefined();
  });
});

describe("a scoped walk over two levels with no deepest default", () => {
  const TABLE: ObjectKindSpec = { id: "table", role: "relation", label: "Table", labelPlural: "Tables" };
  const schemas = (database: string, ...names: string[]): Container[] =>
    names.map((name) => ({ path: [database, name], name, level: 1, isSessionDefault: false }));
  // Shaped like Snowflake with a Database and no Schema: the database is marked, no schema is.
  const containersUnder = (parent?: readonly string[]): readonly Container[] =>
    parent === undefined
      ? [
          { path: ["OTHER"], name: "OTHER", level: 0, isSessionDefault: false },
          { path: ["SALES"], name: "SALES", level: 0, isSessionDefault: true },
        ]
      : parent[0] === "SALES"
        ? schemas("SALES", "INFORMATION_SCHEMA", "PUBLIC", "RAW")
        : schemas("OTHER", "PUBLIC");
  const twoLevels: Partial<ProviderCapabilities> = {
    containerLevels: [
      { id: "catalog", label: "Database", labelPlural: "Databases" },
      { id: "schema", label: "Schema", labelPlural: "Schemas" },
    ],
  };
  const table = (container: readonly string[], kind: string): readonly DatabaseObject[] => [
    { path: [...container, "ORDERS"], name: "ORDERS", kind },
  ];

  test("with the fallback, reads the configured database's schemas minus the skipped, and counts the rest", async () => {
    const { snapshot, harness } = await captured({
      kinds: [TABLE],
      containersUnder,
      counts: () => ({ table: { count: 1 } }),
      objects: table,
      extra: {
        ...twoLevels,
        agentWalkScope: {
          mode: "session-default",
          whenNoDefault: { walk: "parent-default-children", skip: ["INFORMATION_SCHEMA"] },
        },
      },
    });

    expect(harness.countObjects.mock.calls.map((call) => call[0])).toEqual([
      ["SALES", "PUBLIC"],
      ["SALES", "RAW"],
    ]);
    expect(harness.listObjects.mock.calls.map((call) => call[0])).toEqual([
      ["SALES", "PUBLIC"],
      ["SALES", "RAW"],
    ]);
    expect(harness.describeObjects.mock.calls.map((call) => call[0])).toEqual([
      ["SALES", "PUBLIC"],
      ["SALES", "RAW"],
    ]);
    expect(snapshot.objects.map((object) => object.path)).toEqual([
      ["SALES", "PUBLIC", "ORDERS"],
      ["SALES", "RAW", "ORDERS"],
    ]);
    expect(snapshot.unreadContainers).toEqual({
      count: 2,
      label: "Schema",
      labelPlural: "Schemas",
      read: ["SALES.PUBLIC", "SALES.RAW"],
    });
  });

  test("without the fallback, reads no container and counts every one, as before", async () => {
    const { snapshot, harness } = await captured({
      kinds: [TABLE],
      containersUnder,
      counts: () => ({ table: { count: 1 } }),
      objects: table,
      extra: { ...twoLevels, agentWalkScope: { mode: "session-default" } },
    });

    expect(harness.countObjects).not.toHaveBeenCalled();
    expect(snapshot.objects).toEqual([]);
    expect(snapshot.unreadContainers?.count).toBe(4);
  });

  test("with the fallback and two databases marked, reads no container, as with no default", async () => {
    const { snapshot, harness } = await captured({
      kinds: [TABLE],
      containersUnder: (parent) =>
        parent === undefined
          ? [
              { path: ["OTHER"], name: "OTHER", level: 0, isSessionDefault: true },
              { path: ["SALES"], name: "SALES", level: 0, isSessionDefault: true },
            ]
          : containersUnder(parent),
      counts: () => ({ table: { count: 1 } }),
      objects: table,
      extra: {
        ...twoLevels,
        agentWalkScope: {
          mode: "session-default",
          whenNoDefault: { walk: "parent-default-children", skip: ["INFORMATION_SCHEMA"] },
        },
      },
    });

    expect(harness.countObjects).not.toHaveBeenCalled();
    expect(snapshot.objects).toEqual([]);
    expect(snapshot.unreadContainers?.count).toBe(4);
  });
});

describe("a scoped walk over two levels where a catalog's namespaces cannot be listed", () => {
  const TABLE: ObjectKindSpec = { id: "table", role: "relation", label: "Table", labelPlural: "Tables" };
  const twoLevels: Partial<ProviderCapabilities> = {
    containerLevels: [
      { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
      { id: "schema", label: "Namespace", labelPlural: "Namespaces" },
    ],
  };
  const scoped: Partial<ProviderCapabilities> = {
    ...twoLevels,
    agentWalkScope: { mode: "session-default", whenNoDefault: { walk: "parent-default-children" } },
  };
  /** The provider's sentence for a configured catalog it cannot load. */
  const NOT_LOADED = "[CATALOG_NOT_FOUND] The catalog `studio_unloaded` cannot be loaded.";
  const notLoaded = () => new QueryError(NOT_LOADED, "spark");

  /**
   * A tree shaped like Apache Spark's: the first catalog is the session's and its `default` namespace the session's
   * namespace. A catalog mapped to an error raises it when its namespaces are listed.
   */
  const sparkShaped =
    (tree: Readonly<Record<string, readonly string[] | Error>>) =>
    (parent?: readonly string[]): readonly Container[] => {
      const [session] = Object.keys(tree);
      if (parent === undefined) {
        return Object.keys(tree).map(
          (name): Container =>
            name === session
              ? { path: [name], name, level: 0, isSessionDefault: true }
              : { path: [name], name, level: 0 },
        );
      }
      const listing = tree[parent[0]];
      if (listing instanceof Error) throw listing;
      return listing.map(
        (name): Container =>
          parent[0] === session && name === "default"
            ? { path: [parent[0], name], name, level: 1, isSessionDefault: true }
            : { path: [parent[0], name], name, level: 1 },
      );
    };
  const walk = (tree: Readonly<Record<string, readonly string[] | Error>>, extra: Partial<ProviderCapabilities>) => ({
    kinds: [TABLE],
    containersUnder: sparkShaped(tree),
    counts: () => ({ table: { count: 1 } }),
    objects: (container: readonly string[], kind: string): readonly DatabaseObject[] => [
      { path: [...container, "ORDERS"], name: "ORDERS", kind },
    ],
    extra,
  });
  /** The scope's note in a packing: every line that says what the walk read in. */
  const scopeNotes = (packed: string): readonly string[] =>
    packed.split("\n").filter((line) => line.includes("This inventory covers only what it read in"));

  /** A capture that ended unavailable, as every failed listing ended one before a scope could leave it out. */
  async function refusedCapture(options: Stub) {
    const harness = stub(options);
    const capture = await captureContextSnapshot(harness.context);
    expect(capture).toStrictEqual({
      kind: "unavailable",
      reasonCode: "CATALOG_READ_REFUSED",
      detail: expect.any(String),
      modelText: expect.any(String),
      charged: { statements: 1, elapsedMs: expect.any(Number) },
    });
    return { capture, harness };
  }

  test("every listing answering: the walk, its count and its note are exactly what they were", async () => {
    const { snapshot, harness } = await captured(
      walk({ spark_catalog: ["default", "staging"], studio_unloaded: ["raw"], warehouse: ["raw"] }, scoped),
    );

    expect(harness.listContainers.mock.calls).toStrictEqual([
      [],
      [["spark_catalog"]],
      [["studio_unloaded"]],
      [["warehouse"]],
    ]);
    expect(harness.countObjects.mock.calls).toStrictEqual([[["spark_catalog", "default"]]]);
    expect(snapshot.objects.map((object) => object.path)).toStrictEqual([["spark_catalog", "default", "ORDERS"]]);
    expect(snapshot.unreadContainers).toStrictEqual({
      count: 3,
      label: "Namespace",
      labelPlural: "Namespaces",
      read: ["spark_catalog.default"],
    });
    for (const packed of packings(snapshot)) {
      expect(scopeNotes(packed)).toStrictEqual([
        'Not read: 3 other Namespaces. This inventory covers only what it read in ("spark_catalog.default"), so an object in any other Namespace is not listed below. Do not read its absence as an absence in the database.',
      ]);
    }
  });

  test("a catalog the scope does not read is named as not read with the provider's sentence, and the walk goes on", async () => {
    const { snapshot, harness } = await captured(
      walk({ spark_catalog: ["default", "staging"], studio_unloaded: notLoaded(), warehouse: ["raw"] }, scoped),
    );

    expect(harness.listContainers.mock.calls).toStrictEqual([
      [],
      [["spark_catalog"]],
      [["studio_unloaded"]],
      [["warehouse"]],
    ]);
    expect(harness.countObjects.mock.calls).toStrictEqual([[["spark_catalog", "default"]]]);
    expect(harness.listObjects.mock.calls).toStrictEqual([[["spark_catalog", "default"], "table"]]);
    expect(snapshot.objects.map((object) => object.path)).toStrictEqual([["spark_catalog", "default", "ORDERS"]]);
    expect(snapshot.unreadContainers).toStrictEqual({
      count: 2,
      label: "Namespace",
      labelPlural: "Namespaces",
      read: ["spark_catalog.default"],
      unlistedParents: [{ path: "studio_unloaded", label: "Catalog", reason: NOT_LOADED }],
    });
    for (const packed of packings(snapshot)) {
      expect(scopeNotes(packed)).toStrictEqual([
        'Not read: 2 other Namespaces. The Catalog "studio_unloaded" was not read: listing its Namespaces failed with "[CATALOG_NOT_FOUND] The catalog `studio_unloaded` cannot be loaded.". This inventory covers only what it read in ("spark_catalog.default"), so an object in any other Namespace is not listed below. Do not read its absence as an absence in the database.',
      ]);
    }
  });

  test("where the failed catalog is all the walk left out, the note names it alone", async () => {
    const { snapshot } = await captured(walk({ spark_catalog: ["default"], studio_unloaded: notLoaded() }, scoped));

    expect(snapshot.unreadContainers).toStrictEqual({
      count: 0,
      label: "Namespace",
      labelPlural: "Namespaces",
      read: ["spark_catalog.default"],
      unlistedParents: [{ path: "studio_unloaded", label: "Catalog", reason: NOT_LOADED }],
    });
    for (const packed of packings(snapshot)) {
      expect(scopeNotes(packed)).toStrictEqual([
        'The Catalog "studio_unloaded" was not read: listing its Namespaces failed with "[CATALOG_NOT_FOUND] The catalog `studio_unloaded` cannot be loaded.". This inventory covers only what it read in ("spark_catalog.default"), so an object in any other Namespace is not listed below. Do not read its absence as an absence in the database.',
      ]);
    }
  });

  test("each failed catalog is named in walk order, its sentence on one line and cut at 200 code points", async () => {
    const { snapshot } = await captured(
      walk(
        {
          spark_catalog: ["default"],
          lakehouse: new QueryError(
            `\n  Spark could not load the catalog.\n\tCaused by:   ${"x".repeat(300)}`,
            "spark",
          ),
          // A character outside the Basic Multilingual Plane is two UTF-16 units: the cut keeps it whole.
          studio_unloaded: new QueryError(`${"a".repeat(199)}${"\u{1D538}".repeat(3)}`, "spark"),
        },
        scoped,
      ),
    );

    expect(snapshot.unreadContainers?.unlistedParents).toStrictEqual([
      {
        path: "lakehouse",
        label: "Catalog",
        reason: `${"Spark could not load the catalog. Caused by: ".padEnd(200, "x")}...`,
      },
      { path: "studio_unloaded", label: "Catalog", reason: `${"a".repeat(199)}\u{1D538}...` },
    ]);
  });

  // A character outside the Basic Multilingual Plane is two UTF-16 units and one code point: the bound counts code
  // points, and the cut never splits one.
  test.each([
    ["199 code points is kept whole", "a".repeat(199), "a".repeat(199)],
    ["200 code points is kept whole", "a".repeat(200), "a".repeat(200)],
    ["201 code points is cut at 200 and marked", "a".repeat(201), `${"a".repeat(200)}...`],
    [
      "200 code points ending outside the Basic Multilingual Plane is kept whole",
      `${"a".repeat(199)}\u{1D538}`,
      `${"a".repeat(199)}\u{1D538}`,
    ],
    [
      "201 code points whose 200th is outside the Basic Multilingual Plane keeps that one whole",
      `${"a".repeat(199)}\u{1D538}b`,
      `${"a".repeat(199)}\u{1D538}...`,
    ],
    [
      "201 code points whose 201st is outside the Basic Multilingual Plane leaves that one out whole",
      `${"a".repeat(200)}\u{1D538}`,
      `${"a".repeat(200)}...`,
    ],
  ])("a sentence of %s", async (_case, message, reason) => {
    const { snapshot } = await captured(
      walk({ spark_catalog: ["default"], lakehouse: new QueryError(message, "spark") }, scoped),
    );

    expect(snapshot.unreadContainers?.unlistedParents).toStrictEqual([{ path: "lakehouse", label: "Catalog", reason }]);
  });

  describe("more catalogs failing than the inventory names", () => {
    /** The provider's sentence for a configured catalog named `name` that it cannot load. */
    const notLoadedSentence = (name: string) => `[CATALOG_NOT_FOUND] The catalog \`${name}\` cannot be loaded.`;
    /** The session's catalog and its `default` namespace, then each named catalog failing to load, in this order. */
    const failing = (names: readonly string[]) => ({
      spark_catalog: ["default"],
      ...Object.fromEntries(names.map((name) => [name, new QueryError(notLoadedSentence(name), "spark")])),
    });
    const named = (names: readonly string[]) =>
      names.map((name) => ({ path: name, label: "Catalog", reason: notLoadedSentence(name) }));
    /** What the note says of one catalog it names. */
    const namedNote = (name: string) =>
      `The Catalog "${name}" was not read: listing its Namespaces failed with ${JSON.stringify(notLoadedSentence(name))}.`;
    const COVERS =
      'This inventory covers only what it read in ("spark_catalog.default"), so an object in any other Namespace is not listed below. Do not read its absence as an absence in the database.';
    // Walk order is not name order, so a note that sorted or picked by name would name the wrong five.
    const FIVE = ["lake_e", "lake_d", "lake_c", "lake_b", "lake_a"];

    test("five are each named in walk order, and the note is what it was", async () => {
      const { snapshot } = await captured(walk(failing(FIVE), scoped));

      expect(snapshot.unreadContainers).toStrictEqual({
        count: 0,
        label: "Namespace",
        labelPlural: "Namespaces",
        read: ["spark_catalog.default"],
        unlistedParents: named(FIVE),
      });
      for (const packed of packings(snapshot)) {
        expect(scopeNotes(packed)).toStrictEqual([[...FIVE.map(namedNote), COVERS].join(" ")]);
      }
    });

    test("past five, the first five the walk met are named and the rest are counted", async () => {
      const names = [...FIVE, "lake_z", "lake_y", "lake_x"];
      const { snapshot, harness } = await captured(walk(failing(names), scoped));

      // The bound is on what the inventory names: every catalog is still asked for its namespaces.
      expect(harness.listContainers.mock.calls).toStrictEqual([
        [],
        ...["spark_catalog", ...names].map((name): [readonly string[]] => [[name]]),
      ]);
      expect(snapshot.unreadContainers).toStrictEqual({
        count: 0,
        label: "Namespace",
        labelPlural: "Namespaces",
        read: ["spark_catalog.default"],
        unlistedParents: named(FIVE),
        unlistedParentsNotNamed: { count: 3, label: "Catalog", labelPlural: "Catalogs" },
      });
      for (const packed of packings(snapshot)) {
        expect(scopeNotes(packed)).toStrictEqual([
          [
            ...FIVE.map(namedNote),
            "3 more Catalogs were not read: listing their Namespaces failed as well, and they are not named here.",
            COVERS,
          ].join(" "),
        ]);
      }
    });

    test("one past five is counted in the singular", async () => {
      const { snapshot } = await captured(walk(failing([...FIVE, "lake_z"]), scoped));

      expect(snapshot.unreadContainers?.unlistedParents).toStrictEqual(named(FIVE));
      expect(snapshot.unreadContainers?.unlistedParentsNotNamed).toStrictEqual({
        count: 1,
        label: "Catalog",
        labelPlural: "Catalogs",
      });
      for (const packed of packings(snapshot)) {
        expect(scopeNotes(packed)).toStrictEqual([
          [
            ...FIVE.map(namedNote),
            "1 more Catalog was not read: listing its Namespaces failed as well, and it is not named here.",
            COVERS,
          ].join(" "),
        ]);
      }
    });

    test("forty failing with sentences at the cut: the whole inventory names the first five and counts 35, and both packings stay inside their bound, holding the session's rows", async () => {
      // Every one named, their notes alone were about twice the bound, and no row fitted beside them.
      const tree = {
        spark_catalog: ["default"],
        ...Object.fromEntries(
          Array.from({ length: 40 }, (_unused, index) => [
            `lake_${index}`,
            new QueryError(`Spark could not load the catalog lake_${index}: ${"x".repeat(300)}`, "spark"),
          ]),
        ),
      };
      const { snapshot } = await captured(walk(tree, scoped));

      // The first five the walk met, each sentence cut at 200 code points; the other 35 counted; no namespace left out.
      const inventory: AgentInventory = {
        objects: [
          {
            path: ["spark_catalog", "default", "ORDERS"],
            name: "spark_catalog.default.ORDERS",
            kind: "table",
            columns: [],
            indexes: [],
            foreignKeys: [],
            label: "ORDERS",
          },
        ],
        kinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
        unreadContainers: {
          count: 0,
          label: "Namespace",
          labelPlural: "Namespaces",
          read: ["spark_catalog.default"],
          unlistedParents: Array.from({ length: 5 }, (_unused, index) => ({
            path: `lake_${index}`,
            label: "Catalog",
            reason: `${`Spark could not load the catalog lake_${index}: `.padEnd(200, "x")}...`,
          })),
          unlistedParentsNotNamed: { count: 35, label: "Catalog", labelPlural: "Catalogs" },
        },
        defaultContainer: ["spark_catalog", "default"],
      };
      expect(snapshot).toStrictEqual({
        connectionId: "conn-1",
        fingerprint: fingerprintInventory(inventory),
        capturedAtMs: 1_000,
        ...inventory,
        readVia: "provider-inventory",
      });
      for (const packed of packings(snapshot)) {
        expect(packed.length).toBeLessThanOrEqual(AGENT_CONTEXT_PACK_MAX_CHARS);
        expect(packed).toContain("spark_catalog.default.ORDERS");
        expect(packed).toContain(
          "35 more Catalogs were not read: listing their Namespaces failed as well, and they are not named here.",
        );
      }
    });

    test("five whose sentences are mostly control characters leave both packings inside their bound, holding the rows", async () => {
      // The note quotes a sentence as JSON, which writes a control character as six: read as they came, five such
      // sentences at the cut were more than the bound on their own.
      const { snapshot } = await captured(
        walk(
          {
            spark_catalog: ["default"],
            ...Object.fromEntries(
              FIVE.map((name) => [
                name,
                new QueryError(`Spark could not load the catalog ${name}:${"\u0001".repeat(300)}`, "spark"),
              ]),
            ),
          },
          scoped,
        ),
      );

      expect(snapshot.unreadContainers?.unlistedParents).toStrictEqual(
        FIVE.map((name) => ({ path: name, label: "Catalog", reason: `Spark could not load the catalog ${name}:` })),
      );
      for (const packed of packings(snapshot)) {
        expect(packed.length).toBeLessThanOrEqual(AGENT_CONTEXT_PACK_MAX_CHARS);
        expect(packed).toContain("spark_catalog.default.ORDERS");
      }
    });
  });

  test("a control character in the sentence is read as a space, and a lone surrogate as the replacement character", async () => {
    const { snapshot } = await captured(
      walk(
        {
          spark_catalog: ["default"],
          lakehouse: new QueryError("\u0000Spark\u0007could not\u001f load\u0085 the catalog \uD800.\u007f", "spark"),
        },
        scoped,
      ),
    );

    expect(snapshot.unreadContainers?.unlistedParents).toStrictEqual([
      { path: "lakehouse", label: "Catalog", reason: "Spark could not load the catalog \uFFFD." },
    ]);
  });

  test("the session's catalog failing to list ends the capture, as before", async () => {
    const { capture, harness } = await refusedCapture(walk({ spark_catalog: notLoaded(), warehouse: ["raw"] }, scoped));

    expect(capture.kind === "unavailable" && capture.detail.includes(NOT_LOADED)).toBe(true);
    expect(harness.listContainers.mock.calls).toStrictEqual([[], [["spark_catalog"]]]);
    expect(harness.countObjects).not.toHaveBeenCalled();
  });

  test("a catalog on the path of a container the scope names failing to list ends the capture, as before", async () => {
    const { harness } = await refusedCapture(
      walk(
        { spark_catalog: ["default"], warehouse: notLoaded() },
        { ...twoLevels, agentWalkScope: { mode: "session-default", alsoWalk: [["warehouse", "raw"]] } },
      ),
    );

    expect(harness.countObjects).not.toHaveBeenCalled();
  });

  test("with no scope, any catalog failing to list ends the capture, as before", async () => {
    const { harness } = await refusedCapture(
      walk({ spark_catalog: ["default"], studio_unloaded: notLoaded() }, twoLevels),
    );

    expect(harness.countObjects).not.toHaveBeenCalled();
  });

  test("a failure that is not the provider's answer ends the capture whatever the scope", async () => {
    const { harness } = await refusedCapture(
      walk({ spark_catalog: ["default"], studio_unloaded: new TypeError("listing is not iterable") }, scoped),
    );

    expect(harness.countObjects).not.toHaveBeenCalled();
  });
});

describe("an object with no columns", () => {
  const TABLE: ObjectKindSpec = { id: "tables", role: "relation", label: "Table", labelPlural: "Tables" };

  test("a kind that is not a relation carries no column clause; a relation still says none was derivable", async () => {
    const { snapshot } = await captured({
      kinds: [POD, TABLE],
      counts: () => ({ pods: { count: 1 }, tables: { count: 1 } }),
      objects: (container, kind) =>
        kind === "tables"
          ? [{ path: [...container, "orders"], name: "orders", kind }]
          : [{ path: [...container, "pod/web"], name: "pod/web", kind }],
    });
    // The task packer's lines: the operations packer lists names and indexes only, never columns.
    const lines = packContextForTask(snapshot, "why do pods restart").split("\n");
    expect(lines.find((line) => line.includes("pod/web"))).toMatch(/pod\/web \(Pod\)$/);
    expect(lines.find((line) => line.includes("orders"))).toMatch(
      /orders \(Table\): no columns derivable from the stored definition$/,
    );
  });
});
